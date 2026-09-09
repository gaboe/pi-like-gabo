import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { it } from "node:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { registerBackgroundSubagentService } from "../../vendor/pi-tools/extensions/shared/background-subagent-protocol.ts";
import { isTaskActionable } from "./state/waits.ts";
import {
  adoptTodoPreparationCancellationOwners,
  cancelPreparationWorkers,
  disposeTodoPreparationCancellations,
  hasTodoPreparationCancellationProof,
  rearmTodoPreparationCancellations,
  registerTodoTool,
  retryTodoPreparationCancellations,
  startPreparation,
} from "./todo.ts";
import { reservedCancellationWorkerIds } from "./enrichment.ts";
import { __resetState, commitState, getState } from "./state/store.ts";
import {
  CANCELLATION_CAPACITY_ERROR,
  MAX_CANCELLATION_INTENTS,
} from "./state/state.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
    async run() {
      throw new Error("hooks own workers");
    },
    async cancel(ids) {
      cancelled.push([...ids]);
      await cancel(ids);
    },
  });
  const pi = {
    registerTool(definition) {
      tool = {
        ...definition,
        execute(toolCallId, params, ...rest) {
          return definition.execute(
            toolCallId,
            params.action === "create" ? { ...params, prepare: true } : params,
            ...rest,
          );
        },
      };
    },
    appendEntry() {},
  };
  registerTodoTool(pi, {
    preparation: {
      analyze: async (_ctx, raw, _policy, onSpawn, onProgress) => {
        const run = {
          id: `analyst-${analyses.length + 1}`,
          raw,
          ...deferred(),
          onSpawn,
          onProgress,
        };
        analyses.push(run);
        onSpawn?.(run.id);
        return run.promise;
      },
      classify: async (_ctx, raw, prepared, onSpawn) => {
        const run = {
          id: `classifier-${classifiers.length + 1}`,
          raw,
          prepared,
          ...deferred(),
          onSpawn,
        };
        classifiers.push(run);
        onSpawn?.(run.id);
        return run.promise;
      },
    },
  });
  return {
    tool,
    pi,
    cancelled,
    analyses,
    classifiers,
    unregister() {
      disposeTodoPreparationCancellations(pi);
      unregister();
    },
    ctx: {
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      modelRegistry: {},
    },
  };
}

it("starts preparation for explicitly prepared hooked tool creates", async () => {
  const h = setup();
  try {
    await h.tool.execute(
      "call",
      { action: "create", subject: "prepare hooked create" },
      undefined,
      undefined,
      h.ctx,
    );
    await flush();
    assert.equal(h.analyses.length, 1);
    assert.equal(h.classifiers.length, 1);
    assert.equal(getState().tasks[0].metadata.preparation.status, "running");
    const preparationToken = getState().tasks[0].metadata.preparation.token;
    assert.equal(typeof preparationToken, "string");
    assert.notEqual(preparationToken, "");
  } finally {
    h.unregister();
  }
});

it("persists failed preparation cancellation and retries the exact old incarnation", async () => {
  let attempts = 0;
  const h = setup(async () => {
    attempts++;
    if (attempts === 1) throw new Error("preparation manager unavailable");
  });
  try {
    await h.tool.execute(
      "call",
      { action: "create", subject: "old scope" },
      undefined,
      undefined,
      h.ctx,
    );
    await flush();
    const oldToken = getState().tasks[0].metadata.preparation.token;
    await h.tool.execute(
      "call",
      { action: "update", id: 1, subject: "new scope" },
      undefined,
      undefined,
      h.ctx,
    );
    await flush();
    assert.ok(attempts >= 2);
    if (getState().cancellationIntents.length) {
      assert.equal(getState().cancellationIntents[0].token, oldToken);
      assert.match(
        getState().cancellationIntents[0].error,
        /preparation manager unavailable/,
      );
    }

    await waitMs(60);
    assert.equal(attempts, 3);
    assert.equal(getState().cancellationIntents?.length ?? 0, 0);
  } finally {
    h.unregister();
  }
});

it("stops automatic preparation cancellation at three attempts and only re-arms deliberately", async () => {
  let calls = 0;
  const h = setup(async () => {
    calls++;
    throw new Error("permanent preparation cancellation failure");
  });
  try {
    commitState({
      tasks: [
        {
          id: 1,
          subject: "cancel preparation",
          status: "in_progress",
          metadata: {
            preparation: {
              status: "running",
              token: "exhausted-prep",
              workerGeneration: 1,
              activeWorkerIds: ["exhausted-worker"],
            },
          },
        },
      ],
      nextId: 2,
      revision: 1,
    });
    await cancelPreparationWorkers(h.pi, 1, "exhausted-prep", 1, [
      "exhausted-worker",
    ]);
    await waitMs(150);
    assert.equal(calls, 3);
    assert.equal(getState().cancellationIntents[0].attempts, 3);
    rearmTodoPreparationCancellations(h.pi);
    await flush();
    assert.equal(calls, 4);
    assert.equal(getState().cancellationIntents[0].attempts, 1);
  } finally {
    h.unregister();
  }
});

it("clears a full combined capacity fault after an overflow preparation settles", async () => {
  const h = setup();
  try {
    const primary = Array.from(
      { length: MAX_CANCELLATION_INTENTS },
      (_, index) => ({
        kind: "delegation",
        taskId: index + 100,
        token: `primary-${index}`,
        ids: [`primary-worker-${index}`],
        generation: 1,
        attempts: 0,
      }),
    );
    const overflow = [
      ...Array.from({ length: MAX_CANCELLATION_INTENTS - 1 }, (_, index) => ({
        kind: "delegation",
        taskId: index + 400,
        token: `overflow-${index}`,
        ids: [`overflow-worker-${index}`],
        generation: 1,
        attempts: 0,
      })),
      {
        kind: "preparation",
        taskId: 1,
        token: "overflow-prep",
        ids: ["overflow-prep-worker"],
        generation: 1,
        attempts: 0,
        workerGeneration: 1,
      },
    ];
    commitState({
      tasks: [
        {
          id: 1,
          subject: "overflow preparation",
          status: "completed",
          metadata: {
            preparation: {
              status: "cancelled",
              token: "overflow-prep",
              workerGeneration: 1,
              cancellationIds: ["overflow-prep-worker"],
            },
          },
        },
      ],
      nextId: 2,
      revision: 1,
      cancellationIntents: primary,
      cancellationOverflow: overflow,
      cancellationCapacityError: CANCELLATION_CAPACITY_ERROR,
    });
    retryTodoPreparationCancellations(h.pi);
    await flush();
    assert.deepEqual(h.cancelled, [["overflow-prep-worker"]]);
    assert.equal(
      getState().cancellationIntents.length +
        getState().cancellationOverflow.length,
      MAX_CANCELLATION_INTENTS * 2 - 1,
    );
    assert.equal(getState().cancellationCapacityError, undefined);
  } finally {
    h.unregister();
  }
});

it("retains a missing-task preparation orphan without cancelling its durable ID", async () => {
  const h = setup();
  try {
    await cancelPreparationWorkers(h.pi, 404, "missing-prep", 1, [
      "reused-worker",
    ]);
    await flush();
    assert.deepEqual(h.cancelled, []);
    assert.equal(getState().cancellationIntents?.length, 1);
    retryTodoPreparationCancellations(h.pi);
    await flush();
    assert.deepEqual(h.cancelled, []);
    assert.equal(getState().cancellationIntents?.length, 1);

    commitState({
      tasks: [
        {
          id: 1,
          subject: "Re-prepared task with retained old proof",
          status: "pending",
          metadata: {
            preparation: {
              status: "queued",
              token: "new-prep",
              workerGeneration: 2,
              activeWorkerIds: ["reused-worker"],
              cancellationToken: "old-prep",
              cancellationIds: ["reused-worker"],
              cancellationWorkerGeneration: 1,
            },
          },
        },
      ],
      nextId: 2,
      revision: getState().revision + 1,
      cancellationIntents: [
        {
          kind: "preparation",
          taskId: 1,
          token: "old-prep",
          ids: ["reused-worker"],
          generation: 1,
          attempts: 0,
          workerGeneration: 1,
          orphaned: true,
        },
      ],
    });
    retryTodoPreparationCancellations(h.pi);
    await flush();
    assert.deepEqual(h.cancelled, []);
  } finally {
    h.unregister();
  }
});

it("does not let a same-task re-preparation orphan cancel a reused worker ID", async () => {
  const h = setup();
  try {
    commitState({
      tasks: [
        {
          id: 1,
          subject: "Re-prepared task",
          status: "pending",
          metadata: {
            preparation: {
              status: "queued",
              token: "new-prep",
              workerGeneration: 2,
              activeWorkerIds: ["reused-worker"],
            },
          },
        },
      ],
      nextId: 2,
      revision: 1,
      cancellationIntents: [
        {
          kind: "preparation",
          taskId: 1,
          token: "old-prep",
          ids: ["reused-worker"],
          generation: 1,
          attempts: 0,
          workerGeneration: 1,
          orphaned: true,
        },
      ],
    });
    retryTodoPreparationCancellations(h.pi);
    await flush();
    assert.deepEqual(h.cancelled, []);
    assert.equal(getState().cancellationIntents?.length, 1);
  } finally {
    h.unregister();
  }
});

it("dispatches an explicitly handed-off preparation overflow owner", async () => {
  const h = setup();
  const intent = {
    kind: "preparation",
    taskId: 404,
    token: "handoff-prep",
    ids: ["handoff-worker"],
    generation: 1,
    attempts: 0,
    workerGeneration: 1,
    orphaned: true,
  };
  try {
    commitState({
      tasks: [],
      nextId: 1,
      revision: 1,
      cancellationOverflow: [intent],
    });
    adoptTodoPreparationCancellationOwners(h.pi, [intent]);
    retryTodoPreparationCancellations(h.pi);
    await flush();
    assert.deepEqual(h.cancelled, [["handoff-worker"]]);
    assert.equal(getState().cancellationOverflow?.length ?? 0, 0);
  } finally {
    h.unregister();
  }
});

it("retains failed quarantine preparation cancellation through attempts two and three", async () => {
  let calls = 0;
  const reservedDuringCall = [];
  const h = setup(async (ids) => {
    calls++;
    reservedDuringCall.push(reservedCancellationWorkerIds(h.pi).has(ids[0]));
    throw new Error("quarantine retry failure");
  });
  const intent = {
    kind: "preparation",
    taskId: 405,
    token: "quarantine-prep",
    ids: ["quarantine-worker"],
    generation: 1,
    attempts: 0,
    workerGeneration: 1,
    orphaned: true,
  };
  try {
    commitState({
      tasks: [],
      nextId: 1,
      revision: 1,
      cancellationQuarantine: [intent],
      cancellationCapacityError: CANCELLATION_CAPACITY_ERROR,
    });
    adoptTodoPreparationCancellationOwners(h.pi, [intent]);
    retryTodoPreparationCancellations(h.pi);
    await waitMs(180);
    assert.equal(calls, 3);
    assert.deepEqual(reservedDuringCall, [true, true, true]);
    assert.equal(getState().cancellationQuarantine?.[0].attempts, 3);
    assert.equal(
      reservedCancellationWorkerIds(h.pi).has("quarantine-worker"),
      false,
    );
  } finally {
    h.unregister();
  }
});

it("disposes a preparation cancellation promise without losing durable recovery or ID reuse", async () => {
  const cancellation = deferred();
  const h = setup(() => cancellation.promise);
  try {
    commitState({
      tasks: [
        {
          id: 1,
          subject: "shutdown preparation",
          status: "in_progress",
          metadata: {
            preparation: {
              status: "running",
              token: "shutdown-token",
              activeWorkerIds: ["shutdown-worker"],
            },
          },
        },
      ],
      nextId: 2,
      revision: 1,
    });
    const pending = cancelPreparationWorkers(h.pi, 1, "shutdown-token", 1, [
      "shutdown-worker",
    ]);
    await flush();
    const revision = getState().revision;
    assert.equal(
      reservedCancellationWorkerIds(h.pi).has("shutdown-worker"),
      true,
    );
    const intent = getState().cancellationIntents?.[0];
    adoptTodoPreparationCancellationOwners(h.pi, [intent]);
    assert.equal(hasTodoPreparationCancellationProof(h.pi, intent), true);
    disposeTodoPreparationCancellations(h.pi);
    assert.equal(hasTodoPreparationCancellationProof(h.pi, intent), false);
    assert.equal(
      reservedCancellationWorkerIds(h.pi).has("shutdown-worker"),
      false,
    );
    cancellation.resolve();
    await pending;
    await flush();
    assert.equal(getState().revision, revision);
    assert.equal(getState().cancellationIntents?.length, 1);

    retryTodoPreparationCancellations(h.pi);
    await flush();
    assert.equal(getState().cancellationIntents?.length ?? 0, 0);
    assert.equal(
      reservedCancellationWorkerIds(h.pi).has("shutdown-worker"),
      false,
    );
  } finally {
    h.unregister();
  }
});

it("disposes a preparation cancellation retry timer without redispatching", async () => {
  let calls = 0;
  const h = setup(async () => {
    calls++;
    throw new Error("retry after shutdown");
  });
  try {
    commitState({
      tasks: [
        {
          id: 1,
          subject: "shutdown retry",
          status: "in_progress",
          metadata: {
            preparation: {
              status: "running",
              token: "retry-shutdown-token",
              activeWorkerIds: ["retry-shutdown-worker"],
            },
          },
        },
      ],
      nextId: 2,
      revision: 1,
    });
    await cancelPreparationWorkers(h.pi, 1, "retry-shutdown-token", 1, [
      "retry-shutdown-worker",
    ]);
    await flush();
    assert.equal(calls, 1);
    disposeTodoPreparationCancellations(h.pi);
    await waitMs(60);
    assert.equal(calls, 1);
    assert.equal(getState().cancellationIntents?.[0].attempts, 1);
    assert.equal(
      reservedCancellationWorkerIds(h.pi).has("retry-shutdown-worker"),
      false,
    );
  } finally {
    h.unregister();
  }
});

it("persists explicit review targets before no-context and unresolved preparation exits", async () => {
  const h = setup();
  try {
    const selectedTask = {
      id: 1,
      subject: "external checkout",
      status: "pending",
      metadata: {
        preparation: { status: "queued", version: 1, token: "selected-token" },
      },
    };
    commitState({ tasks: [selectedTask], nextId: 2, revision: 1 });
    startPreparation(
      h.pi,
      undefined,
      `Inspect external checkout ${process.cwd()}`,
      selectedTask,
      {},
    );
    assert.equal(getState().tasks[0].metadata.preparation.status, "failed");
    assert.equal(
      getState().tasks[0].metadata.preparation.reviewTarget.status,
      "selected",
    );
    assert.equal(
      getState().tasks[0].metadata.preparation.reviewTarget.path,
      process.cwd(),
    );

    const unresolvedTask = {
      id: 2,
      subject: "missing checkout",
      status: "pending",
      metadata: {
        preparation: { status: "queued", version: 1, token: "missing-token" },
      },
    };
    commitState({
      tasks: [getState().tasks[0], unresolvedTask],
      nextId: 3,
      revision: getState().revision + 1,
    });
    startPreparation(
      h.pi,
      h.ctx,
      "Inspect external checkout /definitely/missing/checkout",
      unresolvedTask,
      {},
    );
    assert.equal(getState().tasks[1].metadata.preparation.status, "failed");
    assert.equal(
      getState().tasks[1].metadata.preparation.reviewTarget.status,
      "unresolved",
    );
    assert.equal(h.analyses.length, 0);
  } finally {
    h.unregister();
  }
});

it("revalidates a queued explicit checkout before analysis", async () => {
  for (const replacement of [false, true]) {
    const h = setup();
    const parent = await mkdtemp(path.join(tmpdir(), "todo-review-target-"));
    const target = path.join(parent, "target");
    const replacementTarget = path.join(parent, "replacement");
    await mkdir(target);
    await mkdir(replacementTarget);
    execFileSync("git", ["init", "-q", target]);
    execFileSync("git", ["init", "-q", replacementTarget]);
    const gate = deferred();
    let analyses = 0;
    const task = {
      id: 1,
      subject: "queued external target",
      status: "pending",
      metadata: {
        preparation: {
          status: "queued",
          version: 1,
          token: `target-${replacement}`,
        },
      },
    };
    try {
      commitState({ tasks: [task], nextId: 2, revision: 1 });
      startPreparation(
        h.pi,
        h.ctx,
        `Inspect external checkout ${target}`,
        task,
        {
          classify: async () => undefined,
          analyze: async () => {
            analyses++;
            return dossier("unexpected analysis");
          },
        },
        { enqueue: (_id, _token, run) => gate.promise.then(run) },
      );
      await rm(target, { recursive: true, force: true });
      if (replacement) await symlink(replacementTarget, target);
      gate.resolve();
      await waitFor(
        () => getState().tasks[0].metadata.preparation.status === "failed",
      );
      assert.equal(analyses, 0);
      assert.match(
        getState().tasks[0].metadata.preparation.error,
        /target invalidated/,
      );
    } finally {
      h.unregister();
      await rm(parent, { recursive: true, force: true });
    }
  }
});

it("rejects analysis output after same-path checkout replacement", async () => {
  const h = setup();
  const parent = await mkdtemp(path.join(tmpdir(), "todo-review-analysis-"));
  const target = path.join(parent, "target");
  const gate = deferred();
  await mkdir(target);
  execFileSync("git", ["init", "-q", target]);
  const task = {
    id: 1,
    subject: "analysis target",
    status: "pending",
    metadata: {
      preparation: { status: "queued", version: 1, token: "analysis-target" },
    },
  };
  let analyses = 0;
  try {
    commitState({ tasks: [task], nextId: 2, revision: 1 });
    startPreparation(h.pi, h.ctx, `Inspect external checkout ${target}`, task, {
      classify: async () => undefined,
      analyze: async () => {
        analyses++;
        await gate.promise;
        return dossier("stale analysis");
      },
    });
    await waitFor(() => analyses === 1);
    await rm(target, { recursive: true, force: true });
    await mkdir(target);
    execFileSync("git", ["init", "-q", target]);
    gate.resolve();
    await waitFor(
      () => getState().tasks[0].metadata.preparation.status === "failed",
    );
    assert.equal(getState().tasks[0].metadata.preparation.summary, undefined);
    assert.match(
      getState().tasks[0].metadata.preparation.error,
      /target invalidated after preparation analysis/,
    );
  } finally {
    h.unregister();
    await rm(parent, { recursive: true, force: true });
  }
});

it("cancels edited incarnation, starts one fresh pipeline, and rejects stale callbacks", async () => {
  const h = setup();
  try {
    await h.tool.execute(
      "call",
      { action: "create", subject: "old scope" },
      undefined,
      undefined,
      h.ctx,
    );
    await flush();
    const oldToken = getState().tasks[0].metadata.preparation.token;
    assert.deepEqual(getState().tasks[0].metadata.preparation.activeWorkerIds, [
      "classifier-1",
      "analyst-1",
    ]);

    await h.tool.execute(
      "call",
      { action: "update", id: 1, activeForm: "working", owner: "parent" },
      undefined,
      undefined,
      h.ctx,
    );
    assert.equal(getState().tasks[0].metadata.preparation.token, oldToken);
    assert.equal(h.analyses.length, 1);

    await h.tool.execute(
      "call",
      { action: "update", id: 1, subject: "new scope" },
      undefined,
      undefined,
      h.ctx,
    );
    await flush();
    h.classifiers[0].resolve({
      requiresOrchestration: true,
      signals: ["stale"],
    });
    h.analyses[0].resolve(dossier("stale dossier"));
    await waitFor(() => h.classifiers.length >= 2);
    h.classifiers[1].resolve({ requiresOrchestration: false, signals: [] });
    await waitFor(() => h.analyses.length === 2);
    const freshToken = getState().tasks[0].metadata.preparation.token;
    assert.notEqual(freshToken, oldToken);
    assert.equal(
      getState().tasks[0].metadata.preparation.cancellationToken,
      undefined,
    );
    assert.equal(
      getState().tasks[0].metadata.preparation.cancellationWorkerGeneration,
      undefined,
    );
    assert.equal(
      getState().tasks[0].metadata.preparation.cancellationIds,
      undefined,
    );
    assert.equal(getState().tasks[0].owner, "parent");
    assert.equal(h.analyses.length, 2);
    assert.equal(h.classifiers.length, 2);
    assert.match(h.analyses[1].raw, /new scope/);
    assert.deepEqual(
      new Set(h.cancelled.flat()),
      new Set(["classifier-1", "analyst-1"]),
    );

    h.classifiers[0].onSpawn?.("late-old-classifier");
    h.analyses[0].onProgress?.({
      id: "late-old-analyst",
      stage: "late",
      at: 1,
      subject: "stale subject",
    });
    await flush();
    assert.equal(getState().tasks[0].subject, "new scope");
    assert.equal(getState().tasks[0].metadata.preparation.summary, undefined);
    assert.equal(getState().tasks[0].metadata.preparation.token, freshToken);

    h.classifiers[1].resolve({ requiresOrchestration: false, signals: [] });
    h.analyses[1].resolve(dossier("fresh dossier"));
    await waitFor(() => h.classifiers.length >= 3);
    await flush();
    assert.equal(h.analyses.length, 2);
    assert.equal(h.classifiers.length, 3);
    assert.equal(getState().tasks[0].metadata.preparation.status, "ready");
    assert.equal(
      getState().tasks[0].metadata.preparation.classifier.status,
      "pending",
    );
    assert.equal(
      isTaskActionable(getState().tasks[0], getState().tasks),
      false,
    );

    h.classifiers[2].resolve({ requiresOrchestration: false, signals: [] });
    await flush();
    assert.equal(
      getState().tasks[0].metadata.preparation.summary,
      "fresh dossier",
    );
    assert.equal(
      getState().tasks[0].metadata.preparation.classifier.status,
      "ready",
    );
    assert.equal(h.analyses.length, 2);
    assert.equal(h.classifiers.length, 3);
    assert.equal(isTaskActionable(getState().tasks[0], getState().tasks), true);
  } finally {
    h.unregister();
  }
});

it("serializes rapid edits until cancellation settles and skips stale queued incarnations", async () => {
  const cancellation = deferred();
  const h = setup(() => cancellation.promise);
  try {
    await h.tool.execute(
      "call",
      { action: "create", subject: "old scope" },
      undefined,
      undefined,
      h.ctx,
    );
    await flush();
    assert.equal(h.analyses.length, 1);

    await h.tool.execute(
      "call",
      { action: "update", id: 1, subject: "middle scope" },
      undefined,
      undefined,
      h.ctx,
    );
    await h.tool.execute(
      "call",
      { action: "update", id: 1, subject: "latest scope" },
      undefined,
      undefined,
      h.ctx,
    );
    await flush();
    assert.equal(h.analyses.length, 1);
    assert.equal(h.classifiers.length, 3);

    cancellation.resolve();
    h.classifiers[0].resolve({
      requiresOrchestration: true,
      signals: ["stale"],
    });
    h.analyses[0].resolve(dossier("stale dossier"));
    await waitFor(() => h.analyses.length === 2);
    assert.equal(h.classifiers.length, 3);
    assert.match(h.analyses[1].raw, /latest scope/);
    assert.doesNotMatch(h.analyses[1].raw, /middle scope/);

    h.classifiers[0].resolve({
      requiresOrchestration: true,
      signals: ["stale"],
    });
    h.classifiers[1].resolve({
      requiresOrchestration: true,
      signals: ["stale middle"],
    });
    h.analyses[0].resolve(dossier("stale dossier"));
    h.classifiers[2].resolve({ requiresOrchestration: false, signals: [] });
    h.analyses[1].resolve(dossier("latest dossier"));
    await waitFor(() => h.classifiers.length >= 4);
    h.classifiers[3].resolve({ requiresOrchestration: false, signals: [] });
    await flush();
    assert.equal(getState().tasks[0].subject, "latest scope");
    assert.equal(
      getState().tasks[0].metadata.preparation.summary,
      "latest dossier",
    );
  } finally {
    h.unregister();
  }
});

it("keeps the active analysis slot until blocked work settles after cancellation", async () => {
  for (const rejectsCancellation of [false, true]) {
    const h = setup(async () => {
      if (rejectsCancellation) throw new Error("cancellation rejected");
    });
    try {
      await h.tool.execute(
        "call",
        { action: "create", subject: "blocked old scope" },
        undefined,
        undefined,
        h.ctx,
      );
      await flush();
      assert.equal(h.analyses.length, 1);

      await h.tool.execute(
        "call",
        { action: "update", id: 1, subject: "queued fresh scope" },
        undefined,
        undefined,
        h.ctx,
      );
      await flush();
      assert.equal(
        h.analyses.length,
        1,
        `cancellation ${rejectsCancellation ? "rejection" : "acknowledgement"} must not release the active slot`,
      );

      for (const run of h.classifiers)
        run.resolve({ requiresOrchestration: false, signals: [] });
      h.analyses[0].resolve(dossier("stale old dossier"));
      await waitFor(() => h.analyses.length === 2);
      assert.match(h.analyses[1].raw, /queued fresh scope/);

      h.analyses[1].resolve(dossier("fresh dossier"));
      for (const run of h.classifiers)
        run.resolve({ requiresOrchestration: false, signals: [] });
      await flush();
    } finally {
      h.unregister();
    }
  }
});

it("persists preparation cancellation before completion and token replacement can replay", async () => {
  const cancellation = deferred();
  const h = setup(() => cancellation.promise);
  try {
    await h.tool.execute(
      "call",
      { action: "create", subject: "old scope" },
      undefined,
      undefined,
      h.ctx,
    );
    await flush();
    const oldToken = getState().tasks[0].metadata.preparation.token;
    await h.tool.execute(
      "call",
      { action: "update", id: 1, subject: "new scope" },
      undefined,
      undefined,
      h.ctx,
    );
    assert.ok(
      getState().cancellationIntents.some(
        (intent) => intent.token === oldToken,
      ),
    );
    assert.deepEqual(
      getState()
        .cancellationIntents.filter((intent) => intent.token === oldToken)
        .flatMap((intent) => intent.ids)
        .sort(),
      ["analyst-1", "classifier-1"],
    );
    const freshToken = getState().tasks[0].metadata.preparation.token;
    assert.notEqual(freshToken, oldToken);
    assert.equal(
      getState().tasks[0].metadata.preparation.cancellationToken,
      undefined,
    );

    cancellation.resolve();
    h.classifiers[0].resolve({
      requiresOrchestration: true,
      signals: ["stale"],
    });
    h.analyses[0].resolve(dossier("stale dossier"));
    await waitFor(() => h.classifiers.length >= 2);
    h.classifiers[1].resolve({
      requiresOrchestration: true,
      signals: ["stale"],
    });
    await waitFor(() => h.analyses.length === 2);
    await h.tool.execute(
      "call",
      { action: "update", id: 1, status: "in_progress" },
      undefined,
      undefined,
      h.ctx,
    );
    await h.tool.execute(
      "call",
      {
        action: "update",
        id: 1,
        status: "completed",
        result: "done",
        evidence: ["verified"],
      },
      undefined,
      undefined,
      h.ctx,
    );
    assert.ok(
      getState().cancellationIntents.some(
        (intent) => intent.token === freshToken,
      ),
    );
  } finally {
    h.unregister();
  }
});

it("keeps unrelated TODO preparation ahead of a fresh edited incarnation", async () => {
  const h = setup();
  try {
    await h.tool.execute(
      "call",
      { action: "create", subject: "first old" },
      undefined,
      undefined,
      h.ctx,
    );
    await flush();
    h.classifiers[0].resolve({ requiresOrchestration: false, signals: [] });
    h.analyses[0].resolve(dossier("old first dossier"));
    await waitFor(() => h.classifiers.length >= 2);
    h.classifiers[1].resolve({ requiresOrchestration: false, signals: [] });
    await flush();
    await h.tool.execute(
      "call",
      { action: "create", subject: "unrelated second" },
      undefined,
      undefined,
      h.ctx,
    );
    await h.tool.execute(
      "call",
      { action: "update", id: 1, subject: "first fresh" },
      undefined,
      undefined,
      h.ctx,
    );
    await flush();

    assert.equal(h.analyses.length, 2);
    assert.match(h.analyses[1].raw, /unrelated second/);
    h.classifiers[2].resolve({ requiresOrchestration: false, signals: [] });
    h.classifiers[3].resolve({ requiresOrchestration: false, signals: [] });
    h.analyses[1].resolve(dossier("second dossier"));
    await waitFor(() => h.classifiers.length >= 5);
    h.classifiers[4].resolve({ requiresOrchestration: false, signals: [] });
    await waitFor(() => h.analyses.length === 3);

    assert.equal(h.analyses.length, 3);
    assert.match(h.analyses[2].raw, /first fresh/);
    assert.equal(
      h.analyses.filter((run) => /first fresh/.test(run.raw)).length,
      1,
    );

    h.classifiers[0].resolve({
      requiresOrchestration: true,
      signals: ["stale"],
    });
    h.analyses[0].resolve(dossier("stale first dossier"));
    h.analyses[2].resolve(dossier("fresh first dossier"));
    await waitFor(() => h.classifiers.length === 6);
    h.classifiers[5].resolve({ requiresOrchestration: false, signals: [] });
    await flush();
    assert.equal(
      getState().tasks[0].metadata.preparation.summary,
      "fresh first dossier",
    );
  } finally {
    h.unregister();
  }
});

it("rotates only effective dependency changes and rejects stale preparation callbacks", async () => {
  const h = setup();
  try {
    await h.tool.execute(
      "call",
      { action: "create", subject: "dependency" },
      undefined,
      undefined,
      h.ctx,
    );
    await flush();
    h.classifiers[0].resolve({ requiresOrchestration: false, signals: [] });
    h.analyses[0].resolve(dossier("dependency dossier"));
    await flush();
    h.classifiers[1].resolve({ requiresOrchestration: false, signals: [] });
    await flush();

    await h.tool.execute(
      "call",
      { action: "create", subject: "target" },
      undefined,
      undefined,
      h.ctx,
    );
    await flush();
    const oldToken = getState().tasks[1].metadata.preparation.token;
    const staleTargetAnalyst = h.analyses[1];
    const staleTargetClassifier = h.classifiers[2];

    await h.tool.execute(
      "call",
      { action: "update", id: 2, addBlockedBy: [1] },
      undefined,
      undefined,
      h.ctx,
    );
    await flush();
    const addToken = getState().tasks[1].metadata.preparation.token;
    assert.notEqual(addToken, oldToken);
    assert.equal(h.analyses.length, 2);
    assert.equal(h.classifiers.length, 4);
    assert.deepEqual(
      new Set(h.cancelled.slice(-2).flat()),
      new Set(["classifier-3", "analyst-2"]),
    );

    staleTargetClassifier.resolve({
      requiresOrchestration: true,
      signals: ["stale"],
    });
    staleTargetAnalyst.resolve(dossier("stale add dossier"));
    await waitFor(() => h.analyses.length === 3);
    assert.equal(getState().tasks[1].metadata.preparation.token, addToken);
    assert.equal(getState().tasks[1].metadata.preparation.summary, undefined);

    const staleAddAnalyst = h.analyses[2];
    const staleAddClassifier = h.classifiers[3];
    await h.tool.execute(
      "call",
      { action: "update", id: 2, removeBlockedBy: [1] },
      undefined,
      undefined,
      h.ctx,
    );
    await flush();
    const removeToken = getState().tasks[1].metadata.preparation.token;
    assert.notEqual(removeToken, addToken);
    assert.equal(h.analyses.length, 3);
    assert.equal(h.classifiers.length, 5);
    assert.deepEqual(
      new Set(h.cancelled.slice(-2).flat()),
      new Set(["classifier-4", "analyst-3"]),
    );

    staleAddClassifier.resolve({
      requiresOrchestration: true,
      signals: ["stale"],
    });
    staleAddAnalyst.resolve(dossier("stale remove dossier"));
    await flush();
    assert.equal(getState().tasks[1].metadata.preparation.token, removeToken);
    assert.equal(getState().tasks[1].metadata.preparation.summary, undefined);

    const cancellations = h.cancelled.length;
    await h.tool.execute(
      "call",
      { action: "update", id: 2, removeBlockedBy: [99] },
      undefined,
      undefined,
      h.ctx,
    );
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
    assert.equal(
      getState().tasks[1].metadata.preparation.summary,
      "fresh remove dossier",
    );
  } finally {
    h.unregister();
  }
});

for (const terminal of ["completed"]) {
  it(`cancels preparation and classifier separately on ${terminal} and rejects stale callbacks`, async () => {
    const h = setup();
    try {
      await h.tool.execute(
        "call",
        { action: "create", subject: `${terminal} race` },
        undefined,
        undefined,
        h.ctx,
      );
      await flush();
      await h.tool.execute(
        "call",
        {
          action: "update",
          id: 1,
          status: "completed",
          result: "done",
          evidence: ["verified"],
        },
        undefined,
        undefined,
        h.ctx,
      );
      await flush();
      assert.deepEqual(
        new Set(h.cancelled.flat()),
        new Set(["classifier-1", "analyst-1"]),
      );

      h.classifiers[0].onSpawn?.(`late-${terminal}-classifier`);
      h.analyses[0].onProgress?.({
        id: `late-${terminal}-analyst`,
        stage: "late",
        at: 1,
        subject: "stale subject",
      });
      h.classifiers[0].resolve({
        requiresOrchestration: true,
        signals: ["stale"],
      });
      h.analyses[0].resolve(dossier("stale dossier"));
      await flush();
      const task = getState().tasks[0];
      assert.equal(task.status, terminal);
      assert.equal(task.subject, `${terminal} race`);
      assert.equal(task.metadata.preparation.status, "cancelled");
      assert.deepEqual(task.metadata.preparation.activeWorkerIds, []);
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

it("rejects late callbacks after a preparation incarnation is cancelled", async () => {
  const h = setup();
  try {
    await h.tool.execute(
      "call",
      { action: "create", subject: "cancel race" },
      undefined,
      undefined,
      h.ctx,
    );
    await flush();
    const current = getState().tasks[0];
    const preparation = current.metadata.preparation;
    commitState({
      ...getState(),
      tasks: [
        {
          ...current,
          metadata: {
            ...current.metadata,
            preparation: {
              ...preparation,
              status: "cancelled",
              activeWorkerIds: [],
            },
          },
        },
      ],
      revision: getState().revision + 1,
    });
    h.classifiers[0].resolve({
      requiresOrchestration: true,
      signals: ["late"],
    });
    h.analyses[0].resolve(dossier("late dossier"));
    await flush();
    assert.equal(getState().tasks[0].metadata.preparation.status, "cancelled");
    assert.equal(getState().tasks[0].metadata.preparation.summary, undefined);
  } finally {
    h.unregister();
  }
});

it("rejects deletion while preparation is running without cancelling its workers", async () => {
  const h = setup();
  try {
    await h.tool.execute(
      "call",
      { action: "create", subject: "delete race" },
      undefined,
      undefined,
      h.ctx,
    );
    await flush();
    const response = await h.tool.execute(
      "call",
      { action: "delete", id: 1 },
      undefined,
      undefined,
      h.ctx,
    );
    await flush();

    assert.match(JSON.stringify(response), /cannot delete unresolved #1/);
    assert.equal(getState().tasks[0].status, "pending");
    assert.equal(getState().tasks[0].metadata.preparation.status, "running");
    assert.equal(h.cancelled.length, 0);
  } finally {
    h.unregister();
  }
});
