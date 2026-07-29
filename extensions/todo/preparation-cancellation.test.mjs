import { strict as assert } from "node:assert";
import { it } from "node:test";
import { registerBackgroundSubagentService } from "../../vendor/pi-tools/extensions/shared/background-subagent-protocol.ts";
import { isTaskActionable } from "./state/waits.ts";
import { registerTodoTool } from "./todo.ts";
import { __resetState, getState } from "./state/store.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await flush();
  }
  assert.ok(predicate(), "condition did not become true");
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
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

function setup(cancel = async () => {}) {
  __resetState();
  let tool;
  const cancelled = [];
  const analyses = [];
  const classifiers = [];
  const unregister = registerBackgroundSubagentService({
    async run() { throw new Error("hooks own workers"); },
    async cancel(ids) { cancelled.push([...ids]); await cancel(ids); },
  });
  registerTodoTool(
    {
      registerTool(definition) { tool = definition; },
      appendEntry() {},
    },
    {
      preparation: {
        analyze: async (_ctx, raw, _policy, onSpawn, onProgress) => {
          const run = { id: `analyst-${analyses.length + 1}`, raw, ...deferred(), onSpawn, onProgress };
          analyses.push(run);
          onSpawn?.(run.id);
          return run.promise;
        },
        classify: async (_ctx, raw, prepared, onSpawn) => {
          const run = { id: `classifier-${classifiers.length + 1}`, raw, prepared, ...deferred(), onSpawn };
          classifiers.push(run);
          onSpawn?.(run.id);
          return run.promise;
        },
      },
    },
  );
  return {
    tool,
    cancelled,
    analyses,
    classifiers,
    unregister,
    ctx: { cwd: "/repo", isProjectTrusted: () => true, modelRegistry: {} },
  };
}

it("cancels edited incarnation, starts one fresh pipeline, and rejects stale callbacks", async () => {
  const h = setup();
  try {
    await h.tool.execute("call", { action: "create", subject: "old scope" }, undefined, undefined, h.ctx);
    await flush();
    const oldToken = getState().tasks[0].metadata.preparation.token;
    assert.deepEqual(getState().tasks[0].metadata.preparation.activeWorkerIds, ["classifier-1", "analyst-1"]);

    await h.tool.execute("call", { action: "update", id: 1, activeForm: "working", owner: "parent" }, undefined, undefined, h.ctx);
    assert.equal(getState().tasks[0].metadata.preparation.token, oldToken);
    assert.equal(h.analyses.length, 1);

    await h.tool.execute("call", { action: "update", id: 1, subject: "new scope" }, undefined, undefined, h.ctx);
    await flush();
    const freshToken = getState().tasks[0].metadata.preparation.token;
    assert.notEqual(freshToken, oldToken);
    assert.equal(getState().tasks[0].owner, "parent");
    assert.equal(h.analyses.length, 2);
    assert.equal(h.classifiers.length, 2);
    assert.match(h.analyses[1].raw, /new scope/);
    assert.deepEqual(new Set(h.cancelled[0]), new Set(["classifier-1", "analyst-1"]));

    h.classifiers[0].onSpawn?.("late-old-classifier");
    h.analyses[0].onProgress?.({ id: "late-old-analyst", stage: "late", at: 1, subject: "stale subject" });
    h.classifiers[0].resolve({ requiresOrchestration: true, signals: ["stale"] });
    h.analyses[0].resolve(dossier("stale dossier"));
    await flush();
    assert.equal(getState().tasks[0].subject, "new scope");
    assert.equal(getState().tasks[0].metadata.preparation.summary, undefined);
    assert.equal(getState().tasks[0].metadata.preparation.token, freshToken);

    h.classifiers[1].resolve({ requiresOrchestration: false, signals: [] });
    h.analyses[1].resolve(dossier("fresh dossier"));
    await flush();
    assert.equal(h.analyses.length, 2);
    assert.equal(h.classifiers.length, 3);
    assert.equal(getState().tasks[0].metadata.preparation.status, "ready");
    assert.equal(getState().tasks[0].metadata.preparation.classifier.status, "pending");
    assert.equal(isTaskActionable(getState().tasks[0], getState().tasks), true);

    h.classifiers[2].resolve({ requiresOrchestration: false, signals: [] });
    await flush();
    assert.equal(getState().tasks[0].metadata.preparation.summary, "fresh dossier");
    assert.equal(getState().tasks[0].metadata.preparation.classifier.status, "ready");
    assert.equal(h.analyses.length, 2);
    assert.equal(h.classifiers.length, 3);
  } finally {
    h.unregister();
  }
});

it("serializes rapid edits until cancellation settles and skips stale queued incarnations", async () => {
  const cancellation = deferred();
  const h = setup(() => cancellation.promise);
  try {
    await h.tool.execute("call", { action: "create", subject: "old scope" }, undefined, undefined, h.ctx);
    await flush();
    assert.equal(h.analyses.length, 1);

    await h.tool.execute("call", { action: "update", id: 1, subject: "middle scope" }, undefined, undefined, h.ctx);
    await h.tool.execute("call", { action: "update", id: 1, subject: "latest scope" }, undefined, undefined, h.ctx);
    await flush();
    assert.equal(h.analyses.length, 1);
    assert.equal(h.classifiers.length, 3);

    cancellation.resolve();
    await waitFor(() => h.analyses.length === 2);
    assert.equal(h.classifiers.length, 3);
    assert.match(h.analyses[1].raw, /latest scope/);
    assert.doesNotMatch(h.analyses[1].raw, /middle scope/);

    h.classifiers[0].resolve({ requiresOrchestration: true, signals: ["stale"] });
    h.classifiers[1].resolve({ requiresOrchestration: true, signals: ["stale middle"] });
    h.analyses[0].resolve(dossier("stale dossier"));
    h.classifiers[2].resolve({ requiresOrchestration: false, signals: [] });
    h.analyses[1].resolve(dossier("latest dossier"));
    await waitFor(() => h.classifiers.length === 4);
    h.classifiers[3].resolve({ requiresOrchestration: false, signals: [] });
    await flush();
    assert.equal(getState().tasks[0].subject, "latest scope");
    assert.equal(getState().tasks[0].metadata.preparation.summary, "latest dossier");
  } finally {
    h.unregister();
  }
});

it("keeps unrelated TODO preparation ahead of a fresh edited incarnation", async () => {
  const h = setup();
  try {
    await h.tool.execute("call", { action: "create", subject: "first old" }, undefined, undefined, h.ctx);
    await flush();
    await h.tool.execute("call", { action: "create", subject: "unrelated second" }, undefined, undefined, h.ctx);
    await h.tool.execute("call", { action: "update", id: 1, subject: "first fresh" }, undefined, undefined, h.ctx);
    await flush();

    assert.equal(h.analyses.length, 2);
    assert.match(h.analyses[1].raw, /unrelated second/);
    h.classifiers[1].resolve({ requiresOrchestration: false, signals: [] });
    h.analyses[1].resolve(dossier("second dossier"));
    await waitFor(() => h.classifiers.length === 4);
    h.classifiers[3].resolve({ requiresOrchestration: false, signals: [] });
    await waitFor(() => h.analyses.length === 3);

    assert.equal(h.analyses.length, 3);
    assert.match(h.analyses[2].raw, /first fresh/);
    assert.equal(h.analyses.filter((run) => /first fresh/.test(run.raw)).length, 1);

    h.classifiers[0].resolve({ requiresOrchestration: true, signals: ["stale"] });
    h.analyses[0].resolve(dossier("stale first dossier"));
    h.classifiers[2].resolve({ requiresOrchestration: false, signals: [] });
    h.analyses[2].resolve(dossier("fresh first dossier"));
    await waitFor(() => h.classifiers.length === 5);
    h.classifiers[4].resolve({ requiresOrchestration: false, signals: [] });
    await flush();
    assert.equal(getState().tasks[0].metadata.preparation.summary, "fresh first dossier");
  } finally {
    h.unregister();
  }
});

it("rotates only effective dependency changes and rejects stale preparation callbacks", async () => {
  const h = setup();
  try {
    await h.tool.execute("call", { action: "create", subject: "dependency" }, undefined, undefined, h.ctx);
    await flush();
    h.classifiers[0].resolve({ requiresOrchestration: false, signals: [] });
    h.analyses[0].resolve(dossier("dependency dossier"));
    await flush();
    h.classifiers[1].resolve({ requiresOrchestration: false, signals: [] });
    await flush();

    await h.tool.execute("call", { action: "create", subject: "target" }, undefined, undefined, h.ctx);
    await flush();
    const oldToken = getState().tasks[1].metadata.preparation.token;
    const staleTargetAnalyst = h.analyses[1];
    const staleTargetClassifier = h.classifiers[2];

    await h.tool.execute("call", { action: "update", id: 2, addBlockedBy: [1] }, undefined, undefined, h.ctx);
    await flush();
    const addToken = getState().tasks[1].metadata.preparation.token;
    assert.notEqual(addToken, oldToken);
    assert.equal(h.analyses.length, 3);
    assert.equal(h.classifiers.length, 4);
    assert.deepEqual(new Set(h.cancelled.at(-1)), new Set(["classifier-3", "analyst-2"]));

    staleTargetClassifier.resolve({ requiresOrchestration: true, signals: ["stale"] });
    staleTargetAnalyst.resolve(dossier("stale add dossier"));
    await flush();
    assert.equal(getState().tasks[1].metadata.preparation.token, addToken);
    assert.equal(getState().tasks[1].metadata.preparation.summary, undefined);

    const staleAddAnalyst = h.analyses[2];
    const staleAddClassifier = h.classifiers[3];
    await h.tool.execute("call", { action: "update", id: 2, removeBlockedBy: [1] }, undefined, undefined, h.ctx);
    await flush();
    const removeToken = getState().tasks[1].metadata.preparation.token;
    assert.notEqual(removeToken, addToken);
    assert.equal(h.analyses.length, 4);
    assert.equal(h.classifiers.length, 5);
    assert.deepEqual(new Set(h.cancelled.at(-1)), new Set(["classifier-4", "analyst-3"]));

    staleAddClassifier.resolve({ requiresOrchestration: true, signals: ["stale"] });
    staleAddAnalyst.resolve(dossier("stale remove dossier"));
    await flush();
    assert.equal(getState().tasks[1].metadata.preparation.token, removeToken);
    assert.equal(getState().tasks[1].metadata.preparation.summary, undefined);

    const cancellations = h.cancelled.length;
    await h.tool.execute("call", { action: "update", id: 2, removeBlockedBy: [99] }, undefined, undefined, h.ctx);
    await flush();
    assert.equal(getState().tasks[1].metadata.preparation.token, removeToken);
    assert.equal(h.cancelled.length, cancellations);
    assert.equal(h.analyses.length, 4);
    assert.equal(h.classifiers.length, 5);

    h.classifiers[4].resolve({ requiresOrchestration: false, signals: [] });
    h.analyses[3].resolve(dossier("fresh remove dossier"));
    await flush();
    h.classifiers[5].resolve({ requiresOrchestration: false, signals: [] });
    await flush();
    assert.equal(getState().tasks[1].metadata.preparation.summary, "fresh remove dossier");
  } finally {
    h.unregister();
  }
});

for (const terminal of ["completed", "deleted"]) {
  it(`cancels preparation and classifier separately on ${terminal} and rejects stale callbacks`, async () => {
    const h = setup();
    try {
      await h.tool.execute("call", { action: "create", subject: `${terminal} race` }, undefined, undefined, h.ctx);
      await flush();
      const params = terminal === "deleted"
        ? { action: "delete", id: 1 }
        : { action: "update", id: 1, status: "completed" };
      await h.tool.execute("call", params, undefined, undefined, h.ctx);
      await flush();
      assert.deepEqual(new Set(h.cancelled[0]), new Set(["classifier-1", "analyst-1"]));

      h.classifiers[0].onSpawn?.(`late-${terminal}-classifier`);
      h.analyses[0].onProgress?.({ id: `late-${terminal}-analyst`, stage: "late", at: 1, subject: "stale subject" });
      h.classifiers[0].resolve({ requiresOrchestration: true, signals: ["stale"] });
      h.analyses[0].resolve(dossier("stale dossier"));
      await flush();
      const task = getState().tasks[0];
      assert.equal(task.status, terminal);
      assert.equal(task.subject, `${terminal} race`);
      assert.equal(task.metadata.preparation.summary, undefined);
      assert.equal(h.analyses.length, 1);
      assert.equal(h.classifiers.length, 1);
      assert.ok(h.cancelled.flat().includes(`late-${terminal}-classifier`));
      assert.ok(h.cancelled.flat().includes(`late-${terminal}-analyst`));
    } finally {
      h.unregister();
    }
  });
}
