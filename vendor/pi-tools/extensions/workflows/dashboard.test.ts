import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRunEntries } from "./dashboard.ts";

function writeRun(directory: string, runId: string, workflow: object) {
  const runDir = join(directory, runId);
  writeFileSync(join(runDir, "workflow.json"), JSON.stringify(workflow), {
    encoding: "utf8",
    flag: "w",
  });
}

test("historical dashboard run IDs and entries stay cached across live refreshes", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-dashboard-"));
  try {
    const runId = "wf_history";
    const runDir = join(directory, runId);
    mkdirSync(runDir);
    writeRun(directory, runId, {
      sessionId: "session",
      status: "completed",
      startedAt: 1,
      phases: [],
      agents: [],
    });
    const historical = new Map();
    const knownRunIds = [runId];
    const first = loadRunEntries(
      new Map(),
      "session",
      new Set(),
      historical,
      directory,
      knownRunIds,
    );
    rmSync(directory, { recursive: true, force: true });
    const second = loadRunEntries(
      new Map(),
      "session",
      new Set(),
      historical,
      directory,
      knownRunIds,
    );

    assert.equal(first[0]?.runId, runId);
    assert.equal(second[0]?.details.status, "completed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("paused dashboard artifact round-trips and accepts prior artifact shape", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-dashboard-"));
  try {
    const runId = "wf_paused";
    mkdirSync(join(directory, runId));
    writeRun(directory, runId, {
      sessionId: "session",
      status: "paused",
      paused: { provider: "openai", reason: "Provider quota (rate_limit)" },
      startedAt: 1,
      phases: [],
      agents: [{ index: 1, label: "agent", state: "error", startedAt: 1 }],
    });
    const entry = loadRunEntries(
      new Map(),
      "session",
      new Set(),
      new Map(),
      directory,
    )[0]?.details;
    assert.equal(entry?.status, "paused");
    assert.deepEqual(entry?.paused, {
      provider: "openai",
      reason: "Provider quota (rate_limit)",
    });
    assert.equal(entry?.agents[0]?.attempts, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("former live run reads once and recovers stale state", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-dashboard-"));
  try {
    const runId = "wf_stale";
    const runDir = join(directory, runId);
    mkdirSync(runDir);
    writeRun(directory, runId, {
      sessionId: "session",
      status: "running",
      startedAt: 1,
      phases: [],
      agents: [{ index: 1, label: "agent", state: "running", startedAt: 1 }],
    });
    const live = {
      runId,
      background: false,
      status: "running" as const,
      startedAt: 1,
      phases: [],
      agents: [],
    };
    const historical = new Map();
    assert.equal(
      loadRunEntries(
        new Map([[runId, live]]),
        "session",
        new Set(),
        historical,
        directory,
      )[0]?.live,
      true,
    );
    const recovered = loadRunEntries(
      new Map(),
      "session",
      new Set(),
      historical,
      directory,
    )[0];

    assert.equal(recovered?.details.status, "aborted");
    assert.equal(recovered?.details.agents[0]?.state, "error");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
