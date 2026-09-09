import { strict as assert } from "node:assert";
import { it } from "node:test";
import {
  aggregateOrchestratorMode,
  classifyOrchestration,
  markOrchestrator,
  modeFor,
  orchestratorFooterStatus,
  orchestratorStatus,
  requestOrchestratorClassification,
  stickyOrchestrator,
} from "./orchestrator.ts";
import { registerBackgroundSubagentService } from "../../vendor/pi-tools/extensions/shared/background-subagent-protocol.ts";

it("classifies structural signals, preserves off, and makes execution sticky", () => {
  const classified = classifyOrchestration(
    "Delegate independent parallel work packages with durable handoff",
  );
  assert.equal(classified.requiresOrchestration, true);
  assert.equal(modeFor("off", classified), "direct");
  const provisional = markOrchestrator(
    { id: 1, subject: "x", status: "pending" },
    "auto",
    classified,
    "raw",
  );
  assert.equal("setting" in provisional.metadata.orchestrator, false);
  const sticky = stickyOrchestrator(provisional);
  assert.equal(sticky.metadata.orchestrator.mode, "sticky");
  assert.match(orchestratorStatus([sticky], "auto"), /auto\/sticky/);
  assert.equal(
    orchestratorFooterStatus([sticky], "auto"),
    "orchestrator: sticky",
  );
  assert.equal(orchestratorFooterStatus([], "auto"), undefined);
});

it("does not use step count as a classifier signal", () => {
  assert.equal(
    classifyOrchestration("Do task", { steps: ["one", "two", "three", "four"] })
      .requiresOrchestration,
    false,
  );
});

it("guides non-blocking subagents without banning dependency waits", async () => {
  const { ORCHESTRATOR_GUIDANCE } = await import("./orchestrator.ts");
  assert.match(
    ORCHESTRATOR_GUIDANCE,
    /non-blocking background subagent spawns/,
  );
  assert.match(
    ORCHESTRATOR_GUIDANCE,
    /conflict checks.*safe independent worker capacity.*continue other TODOs/,
  );
  assert.match(
    ORCHESTRATOR_GUIDANCE,
    /only background work remains.*completion delivery/,
  );
  assert.match(
    ORCHESTRATOR_GUIDANCE,
    /subagent_wait only for already-settled collection, non-interactive execution, or a concrete dependency\/result-freshness gate/,
  );
  assert.match(
    ORCHESTRATOR_GUIDANCE,
    /do not blanket-ban waiting when a concrete dependency exists/,
  );
  assert.match(
    ORCHESTRATOR_GUIDANCE,
    /task-local direct TODO remains parent-owned.*aggregate mode is sticky/,
  );
  assert.match(
    ORCHESTRATOR_GUIDANCE,
    /never edit reserved orchestration metadata/,
  );
});

it("calls the classifier for raw and prepared dossiers", async () => {
  const calls = [];
  const unregister = registerBackgroundSubagentService({
    async run(request) {
      calls.push(request);
      return {
        id: "classifier",
        status: "done",
        output: '{"requiresOrchestration":false,"signals":[]}',
      };
    },
  });
  try {
    const ctx = {
      cwd: "/repo",
      isProjectTrusted: () => true,
      modelRegistry: {},
    };
    await requestOrchestratorClassification(ctx, "raw request");
    await requestOrchestratorClassification(
      ctx,
      "api_key=classifier-secret-12345678",
      {
        affectedPaths: ["a"],
        steps: ["x"],
        note: "Bearer classifier-secret-12345678",
      },
    );
    assert.equal(calls.length, 2);
    assert.match(calls[1].prompt, /Prepared dossier/);
    assert.doesNotMatch(calls[1].prompt, /classifier-secret-12345678/);
    assert.match(calls[1].prompt, /\[REDACTED\]/);
  } finally {
    unregister();
  }
});

it("aggregates unresolved classifications, ignores stale/terminal work, and keeps sticky with zero tasks", () => {
  const complex = markOrchestrator(
    { id: 1, subject: "x", status: "pending" },
    "auto",
    { requiresOrchestration: true, signals: ["package"] },
    "raw",
  );
  const direct = markOrchestrator(
    { id: 2, subject: "y", status: "pending" },
    "auto",
    { requiresOrchestration: false, signals: [] },
    "raw",
  );
  assert.equal(
    aggregateOrchestratorMode([complex, direct], "auto"),
    "provisional",
  );
  assert.equal(
    aggregateOrchestratorMode([{ ...complex, status: "completed" }], "auto"),
    "direct",
  );
  assert.equal(aggregateOrchestratorMode([], "auto", true), "sticky");
  assert.equal(aggregateOrchestratorMode([complex], "off", true), "direct");
});
