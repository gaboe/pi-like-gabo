import { strict as assert } from "node:assert";
import { it } from "node:test";
import { registerBackgroundSubagentService } from "../../../vendor/pi-tools/extensions/shared/background-subagent-protocol.ts";
import { applyPreparationCAS } from "../enrichment.ts";
import { JobsAdapter } from "../jobs-adapter.ts";
import { aggregateOrchestratorMode } from "../orchestrator.ts";
import { persistTodoSnapshot, TodoScheduler } from "../scheduler.ts";
import { registerTodoAddCommand } from "../todo.ts";
import { createTodoSnapshot, replayFromBranch, TODO_SNAPSHOT_TYPE } from "./replay.ts";
import { applyTaskMutation } from "./state-reducer.ts";
import { __resetState, commitState, getState } from "./store.ts";
import { applyJobState, recoverInterruptedPreparations } from "./waits.ts";

const task = (id, status = "pending", extra = {}) => ({ id, subject: `Task ${id}`, status, ...extra });
const dossier = (summary) => ({
  status: "ready",
  summary,
  verifiedFacts: [],
  assumptions: [],
  affectedPaths: [],
  steps: [],
  checks: [],
  questions: [],
  risks: [],
  sources: [],
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const bounded = async (promise, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

class Bus {
  handlers = new Map();
  on(channel, handler) {
    const handlers = this.handlers.get(channel) ?? new Set();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => handlers.delete(handler);
  }
}

it("preserves manual off and sticky state through every canonical mutation, persistence, and replay", () => {
  for (const orchestrator of [
    { setting: "off", sticky: false },
    { setting: "auto", sticky: true },
  ]) {
    let state = {
      tasks: [
        task(1, "pending", { metadata: { preparation: { status: "queued", version: 1, token: "prep-1" } } }),
        task(2, "waiting:jobs", {
          wait: { kind: "jobs", jobIds: ["job-1"], mode: "any", deadline: 10_000, settled: {} },
        }),
      ],
      nextId: 3,
      revision: 4,
      orchestrator,
    };
    const preserved = () => assert.deepEqual(state.orchestrator, orchestrator);

    state = applyTaskMutation(state, "create", { subject: "Created" }).state;
    preserved();
    state = applyTaskMutation(state, "update", { id: 3, subject: "Updated" }).state;
    preserved();
    state = applyTaskMutation(state, "delete", { id: 3 }).state;
    preserved();

    const expectedPreparation = state.tasks[0];
    state = applyPreparationCAS(state, expectedPreparation, { status: "ready", summary: "Prepared" });
    preserved();
    state = applyJobState(state, { id: "job-1", status: "wake", settledAt: 5_000 }, 5_000);
    preserved();
    state = applyTaskMutation(state, "update", { id: 1, status: "completed" }).state;
    state = applyTaskMutation(state, "update", { id: 2, status: "completed" }).state;
    state = applyTaskMutation(state, "clear", {}).state;
    preserved();

    const entries = [];
    persistTodoSnapshot({ appendEntry(type, data) { entries.push({ type, data }); } }, state);
    assert.deepEqual(entries.at(-1).data.orchestrator, orchestrator);
    const replayed = replayFromBranch({
      sessionManager: {
        getBranch: () => entries.map(({ type, data }) => ({ type: "custom", customType: type, data })),
      },
    });
    assert.deepEqual(replayed.orchestrator, orchestrator);
  }
});

it("recovers every running delegation independently and does not respawn ready dossiers", async () => {
  __resetState();
  const originalReady = { status: "ready", version: 7, token: "ready", summary: "Keep me" };
  const restored = replayFromBranch({
    sessionManager: {
      getBranch: () => [{
        type: "custom",
        customType: TODO_SNAPSHOT_TYPE,
        data: createTodoSnapshot({
          tasks: [
            task(1, "pending", { metadata: { delegation: { status: "running", subagentId: "worker-none" } } }),
            task(2, "pending", { metadata: { preparation: originalReady, delegation: { status: "running", subagentId: "worker-ready" } } }),
            task(3, "pending", { metadata: { preparation: { status: "queued", version: 2, token: "active" }, delegation: { status: "running", subagentId: "worker-active" } } }),
          ],
          nextId: 4,
          revision: 10,
          orchestrator: { setting: "off", sticky: false },
        }),
      }],
    },
  });
  commitState(restored);

  let spawnCalls = 0;
  const unregister = registerBackgroundSubagentService({ async run() { spawnCalls++; throw new Error("must not respawn"); } });
  const sent = deferred();
  const adapter = new JobsAdapter(new Bus());
  const scheduler = new TodoScheduler(
    { appendEntry() {}, sendMessage() { sent.resolve(); } },
    adapter,
    () => {},
  );
  try {
    scheduler.activate({});
    await sent.promise;
    const [absent, ready, active] = getState().tasks;
    for (const [recovered, worker] of [[absent, "worker-none"], [ready, "worker-ready"], [active, "worker-active"]]) {
      assert.deepEqual(recovered.metadata.delegation, {
        status: "interrupted",
        subagentId: worker,
        error: "Inspect current diff/worktree before redispatch",
      });
    }
    assert.deepEqual(ready.metadata.preparation, originalReady);
    assert.equal(active.metadata.preparation.status, "failed");
    assert.equal(active.metadata.preparation.version, 3);
    assert.equal(spawnCalls, 0);
  } finally {
    scheduler.dispose();
    adapter.dispose();
    unregister();
  }
});

it("ignores completed and deleted sticky metadata before and after clear", () => {
  const completed = task(1, "completed", { metadata: { orchestrator: { mode: "sticky", requiresOrchestration: true } } });
  const state = {
    tasks: [completed, task(2, "deleted", { metadata: { orchestrator: { mode: "sticky" } } })],
    nextId: 3,
    revision: 2,
    orchestrator: { setting: "auto", sticky: false },
  };
  assert.equal(aggregateOrchestratorMode(state.tasks, "auto", false), "direct");
  const cleared = applyTaskMutation(state, "clear", {}).state;
  assert.equal(aggregateOrchestratorMode(cleared.tasks, "auto", cleared.orchestrator.sticky), "direct");
});

it("does not restore global sticky from completed provisional work or assign direct pending work", async () => {
  __resetState();
  const sent = [];
  const adapter = new JobsAdapter(new Bus());
  const scheduler = new TodoScheduler(
    { appendEntry() {}, sendMessage(message) { sent.push(message); } },
    adapter,
    () => {},
  );
  commitState({
    tasks: [
      task(1, "completed", {
        metadata: {
          preparation: { status: "ready", token: "completed-token" },
          orchestrator: { mode: "provisional", requiresOrchestration: true },
        },
      }),
      task(2, "pending", {
        metadata: {
          preparation: { status: "ready", token: "direct-token" },
          orchestrator: { mode: "direct", requiresOrchestration: false },
        },
      }),
    ],
    nextId: 3,
    revision: 1,
    orchestrator: { setting: "auto", sticky: false },
  });
  scheduler.activate({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getState().orchestrator.sticky, false);
  assert.equal(getState().tasks[0].metadata.orchestrator.mode, "provisional");
  assert.equal(getState().tasks[1].metadata.orchestrator.mode, "direct");
  assert.equal(getState().tasks[1].metadata.delegation, undefined);
  assert.match(
    scheduler.packageAssignmentError(2, "direct-token", "auto"),
    /provisional or sticky/,
  );
  assert.equal(sent.length, 1);
  scheduler.dispose();
  adapter.dispose();
});

it("starts raw model classification outside analyst queue and applies it before dossier resolution", async () => {
  __resetState();
  const firstAnalystStarted = deferred();
  const releaseFirstAnalyst = deferred();
  const secondAnalystStarted = deferred();
  const releaseSecondAnalyst = deferred();
  const secondClassifierStarted = deferred();
  const releaseSecondClassifier = deferred();
  const secondRawApplied = deferred();
  const secondPreparedApplied = deferred();
  const calls = [];
  let secondAnalystHasStarted = false;
  let command;

  registerTodoAddCommand(
    {
      registerCommand(_name, definition) { command = definition; },
      appendEntry() {},
    },
    {
      analyze: async (_ctx, raw) => {
        if (raw === "first queued analyst") {
          firstAnalystStarted.resolve();
          await releaseFirstAnalyst.promise;
          return dossier("First prepared");
        }
        secondAnalystHasStarted = true;
        secondAnalystStarted.resolve();
        await releaseSecondAnalyst.promise;
        return dossier("Second prepared");
      },
      classify: async (_ctx, raw, prepared) => {
        calls.push({ raw, phase: prepared ? "prepared" : "raw" });
        if (raw === "second queued analyst" && !prepared) {
          secondClassifierStarted.resolve();
          await releaseSecondClassifier.promise;
          return { requiresOrchestration: true, signals: ["raw-model"] };
        }
        return { requiresOrchestration: !!prepared, signals: prepared ? ["prepared-model"] : [] };
      },
      onStateChanged: () => {
        const second = getState().tasks.find((candidate) => candidate.description === "second queued analyst");
        if ((second?.metadata?.preparation?.classifier?.status) === "raw") secondRawApplied.resolve();
        if ((second?.metadata?.preparation?.classifier?.status) === "ready") secondPreparedApplied.resolve();
      },
    },
  );
  const ctx = { ui: { notify() {} } };
  await command.handler("add first queued analyst", ctx);
  await bounded(firstAnalystStarted.promise, "first analyst");
  await command.handler("add second queued analyst", ctx);
  await bounded(secondClassifierStarted.promise, "second raw classifier");
  assert.equal(secondAnalystHasStarted, false);

  releaseSecondClassifier.resolve();
  await bounded(secondRawApplied.promise, "second raw classification");
  const rawTask = getState().tasks[1];
  assert.equal(rawTask.metadata.preparation.status, "queued");
  assert.equal(rawTask.metadata.orchestrator.phase, "raw");
  assert.equal(rawTask.metadata.orchestrator.mode, "provisional");
  assert.deepEqual(rawTask.metadata.orchestrator.signals, ["raw-model"]);

  releaseFirstAnalyst.resolve();
  await bounded(secondAnalystStarted.promise, "second analyst");
  releaseSecondAnalyst.resolve();
  await bounded(secondPreparedApplied.promise, "second prepared classification");
  assert.deepEqual(calls, [
    { raw: "first queued analyst", phase: "raw" },
    { raw: "second queued analyst", phase: "raw" },
    { raw: "first queued analyst", phase: "prepared" },
    { raw: "second queued analyst", phase: "prepared" },
  ]);
  assert.equal(getState().tasks[1].metadata.orchestrator.phase, "prepared");
});
