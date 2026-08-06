import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  boundedArtifactTranscript,
  createWorkflowPersistence,
  finalizeWorkflowPersistence,
  persistWorkflowJson,
} from "./artifacts.ts";
import {
  emptyUsage,
  type TranscriptEntry,
  type WorkflowDetails,
} from "./model.ts";

function workflowDetails(): WorkflowDetails {
  return {
    runId: "wf_fixture",
    sessionId: "session_fixture",
    background: false,
    status: "running",
    startedAt: 1,
    phases: [],
    agents: [],
  };
}

test("artifact transcript keeps the initial prompt, marker, and newest entries", () => {
  const prompt = `initial:${"p".repeat(70)}`;
  const transcript = [
    { role: "user" as const, text: prompt },
    ...Array.from({ length: 5 }, (_, index) => ({
      role: "assistant" as const,
      text: `entry-${index}:${String(index).repeat(70)}`,
    })),
  ];

  const bounded = boundedArtifactTranscript(transcript, {
    maxBytes: 256,
    entryMaxBytes: 80,
  });

  assert.equal(bounded[0]?.role, "user");
  assert.equal(bounded[0]?.text, prompt);
  assert.match(bounded[1]?.text ?? "", /artifact transcript truncated/);
  assert.equal(bounded.at(-1)?.text, transcript.at(-1)?.text);
  assert.equal(
    bounded.some((entry) => entry.text.startsWith("entry-0:")),
    false,
  );
  assert.ok(
    bounded.reduce(
      (total, entry) => total + Buffer.byteLength(entry.text, "utf8"),
      0,
    ) <= 256,
  );
});

test("live artifact persistence includes current agents and transcripts", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-artifacts-"));
  try {
    const details = workflowDetails();
    details.agents.push({
      index: 1,
      label: "running-fixture",
      state: "running",
      startedAt: 2,
      preview: "working",
      usage: emptyUsage(),
      transcript: [
        { role: "user", text: "current prompt" },
        {
          role: "tool",
          name: "fixture",
          toolCallId: "call-fixture",
          text: "{}",
          startedAt: 10,
          finishedAt: 25,
          durationMs: 15,
        },
      ],
    });

    persistWorkflowJson(directory, details);

    const workflow = JSON.parse(
      readFileSync(join(directory, "workflow.json"), "utf8"),
    ) as WorkflowDetails;
    const transcripts = JSON.parse(
      readFileSync(join(directory, "transcripts.json"), "utf8"),
    ) as Record<string, TranscriptEntry[]>;
    assert.equal(workflow.agents.length, 1);
    assert.equal(workflow.agents[0]?.label, "running-fixture");
    assert.equal(transcripts["1"]?.[0]?.text, "current prompt");
    assert.deepEqual(
      {
        toolCallId: transcripts["1"]?.[1]?.toolCallId,
        startedAt: transcripts["1"]?.[1]?.startedAt,
        finishedAt: transcripts["1"]?.[1]?.finishedAt,
        durationMs: transcripts["1"]?.[1]?.durationMs,
      },
      {
        toolCallId: "call-fixture",
        startedAt: 10,
        finishedAt: 25,
        durationMs: 15,
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("final flush persists the exact latest workflow state", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-artifacts-"));
  try {
    const details = workflowDetails();
    details.agents.push({
      index: 1,
      label: "fixture",
      state: "running",
      startedAt: 2,
      preview: "working",
      usage: emptyUsage(),
      transcript: [{ role: "user", text: "first" }],
    });
    const persistence = createWorkflowPersistence(directory, details);
    persistence.checkpoint({ immediate: true });

    details.status = "completed";
    details.finishedAt = 3;
    details.result = { output: "final" };
    details.agents[0]!.transcript = [
      { role: "user", text: "first" },
      { role: "assistant", text: "final" },
    ];
    persistence.flush();

    assert.deepEqual(
      JSON.parse(readFileSync(join(directory, "result.json"), "utf8")),
      { output: "final" },
    );
    assert.equal(
      (
        JSON.parse(
          readFileSync(join(directory, "transcripts.json"), "utf8"),
        ) as Record<string, TranscriptEntry[]>
      )["1"]?.[1]?.text,
      "final",
    );
    const workflow = JSON.parse(
      readFileSync(join(directory, "workflow.json"), "utf8"),
    ) as WorkflowDetails;
    assert.equal(workflow.status, "completed");
    assert.equal(workflow.finishedAt, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workflow checkpoints throttle updates and support immediate/final flushes", async () => {
  const details = workflowDetails();
  const snapshots: WorkflowDetails[] = [];
  const persistence = createWorkflowPersistence("fixture", details, {
    intervalMs: 15,
    persist: (_runDir, current) => snapshots.push(structuredClone(current)),
  });

  details.currentPhase = "Scan";
  persistence.checkpoint();
  details.currentPhase = "Review";
  persistence.checkpoint();
  assert.equal(snapshots.length, 0);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.currentPhase, "Review");

  details.status = "completed";
  persistence.checkpoint({ immediate: true });
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1]?.status, "completed");

  details.finishedAt = 3;
  persistence.flush();
  assert.equal(snapshots.length, 3);
  assert.equal(snapshots[2]?.finishedAt, 3);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(snapshots.length, 3);
});

test("terminal artifact flush failure persists and seals coherent failed recovery", () => {
  const details = workflowDetails();
  let flushes = 0;
  const seals: string[] = [];
  const persistence = {
    markDirty() {},
    flush() {
      if (++flushes === 1) throw new Error("injected flush");
    },
  };
  const status = finalizeWorkflowPersistence(
    details,
    "completed",
    persistence,
    {
      generation: () => 1,
      event: () => true,
      seal: (reason) => {
        seals.push(reason);
      },
    },
  );
  assert.equal(status, "failed");
  assert.equal(details.status, "failed");
  assert.deepEqual(seals, ["failed"]);
});

test("terminal artifact hard failure leaves journal unsealed", () => {
  const details = workflowDetails();
  let sealed = false;
  assert.throws(
    () =>
      finalizeWorkflowPersistence(
        details,
        "completed",
        {
          markDirty() {},
          flush() {
            throw new Error("injected flush");
          },
        },
        {
          generation: () => 1,
          event: () => true,
          seal: () => {
            sealed = true;
          },
        },
      ),
    /journal left unsealed/,
  );
  assert.equal(details.status, "failed");
  assert.equal(sealed, false);
});
