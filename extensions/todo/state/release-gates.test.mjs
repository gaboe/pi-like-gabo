import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  packageAssignmentError,
  registerPackageAssignmentGate,
} from "../../../vendor/pi-tools/extensions/shared/assignment-gate-protocol.ts";
import {
  spawnPackageAssignment,
  validateSubagentAssignment,
} from "../../../vendor/pi-tools/extensions/subagents/index.ts";
import { orchestratorEnabled } from "../config.ts";
import { JobsAdapter } from "../jobs-adapter.ts";
import {
  actionableContinuation,
  hasCompletedBatch,
  TodoScheduler,
} from "../scheduler.ts";
import { applyTaskMutation } from "./state-reducer.ts";
import {
  __resetState,
  commitState,
  getState,
  subscribeState,
} from "./store.ts";
import { registerTodoTool } from "../todo.ts";
import { buildToolResult } from "../tool/response-envelope.ts";
import { SUBAGENT_DELEGATION_STATE_CHANNEL } from "../../../vendor/pi-tools/extensions/shared/subagent-wait-protocol.ts";
import { registerBackgroundSubagentService } from "../../../vendor/pi-tools/extensions/shared/background-subagent-protocol.ts";

const task = (status = "pending", extra = {}) => ({
  id: 1,
  subject: "Package",
  status,
  ...extra,
});

class Bus {
  handlers = new Map();
  on(channel, handler) {
    const handlers = this.handlers.get(channel) ?? new Set();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => handlers.delete(handler);
  }
  emit(channel, value) {
    for (const handler of this.handlers.get(channel) ?? []) handler(value);
  }
}

function owned(status = "in_progress", delegation = "running") {
  return task(status, {
    metadata: {
      preparation: { status: "ready", token: "prep-secret" },
      orchestrator: { mode: "sticky" },
      delegation: {
        status: delegation,
        subagentId: "worker-1",
        subagentIds: ["worker-1"],
        todoId: 1,
        todoToken: "prep-secret",
      },
    },
  });
}

describe("release orchestration gates", () => {
  it("exposes assignment token only in todo get content", async () => {
    const state = {
      tasks: [owned("pending", "settled")],
      nextId: 2,
      revision: 1,
    };
    for (const [action, op] of [
      ["create", { kind: "create", taskId: 1 }],
      [
        "update",
        { kind: "update", id: 1, fromStatus: "pending", toStatus: "pending" },
      ],
      ["list", { kind: "list", includeDeleted: false }],
    ]) {
      const result = buildToolResult(
        action,
        { action, metadata: { preparation: { token: "prep-secret" } } },
        state,
        op,
      );
      assert.doesNotMatch(JSON.stringify(result), /prep-secret|todoToken/);
    }
    const get = buildToolResult("get", { id: 1 }, state, {
      kind: "get",
      task: state.tasks[0],
    });
    assert.match(
      get.content[0].text,
      /  todo_id: 1\n  todo_token: prep-secret/,
    );
    assert.doesNotMatch(JSON.stringify(get.details), /prep-secret|todoToken/);

    __resetState();
    let tool;
    registerTodoTool({
      registerTool(definition) {
        tool = definition;
      },
      appendEntry() {},
    });
    const ctx = { cwd: "/repo" };
    const created = await tool.execute(
      "create",
      { action: "create", subject: "Secret package" },
      undefined,
      undefined,
      ctx,
    );
    const token = getState().tasks[0].metadata.preparation.token;
    assert.equal(JSON.stringify(created).includes(token), false);
    const listed = await tool.execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(JSON.stringify(listed).includes(token), false);
    const updated = await tool.execute(
      "update",
      { action: "update", id: 1, subject: "Renamed" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(JSON.stringify(updated).includes(token), false);
    const rotatedToken = getState().tasks[0].metadata.preparation.token;
    assert.notEqual(rotatedToken, token);
    const fetched = await tool.execute(
      "get",
      { action: "get", id: 1 },
      undefined,
      undefined,
      ctx,
    );
    assert.match(
      fetched.content[0].text,
      new RegExp(`  todo_id: 1\\n  todo_token: ${rotatedToken}`),
    );
    assert.doesNotMatch(fetched.content[0].text, new RegExp(token));
  });

  it("rejects tool mutations of reserved orchestration metadata", async () => {
    __resetState();
    commitState({
      tasks: [
        task("in_progress", {
          metadata: {
            preparation: { status: "ready", token: "prep-secret" },
            orchestrator: { mode: "direct" },
          },
        }),
      ],
      nextId: 2,
      revision: 1,
    });
    let tool;
    registerTodoTool({
      registerTool(definition) {
        tool = definition;
      },
      appendEntry() {},
    });
    const before = structuredClone(getState());
    for (const key of ["delegation", "orchestrator", "preparation"]) {
      const result = await tool.execute(
        "update",
        { action: "update", id: 1, metadata: { [key]: "sticky" } },
        undefined,
        undefined,
        { cwd: "/repo" },
      );
      assert.match(result.content[0].text, new RegExp(`metadata\\.${key} is reserved`));
      assert.deepEqual(getState(), before);
    }
  });

  it("fails package assignment closed while ordinary scouts bypass gate", () => {
    assert.equal(
      validateSubagentAssignment(undefined, undefined, undefined),
      undefined,
    );
    assert.equal(
      validateSubagentAssignment("package_handoff", 1, "prep-secret"),
      "package_handoff assignment gate unavailable.",
    );
    const unregister = registerPackageAssignmentGate(({ todoId, todoToken }) =>
      todoId === 1 && todoToken === "prep-secret" ? undefined : "mismatch",
    );
    try {
      assert.equal(
        validateSubagentAssignment("package_handoff", 1, "prep-secret"),
        undefined,
      );
      assert.equal(
        packageAssignmentError({ todoId: 2, todoToken: "wrong" }),
        "mismatch",
      );
    } finally {
      unregister();
    }
  });

  it("requires live matching orchestration and reopens after manual resume", () => {
    __resetState();
    commitState({
      tasks: [
        task("pending", {
          metadata: {
            preparation: { status: "ready", token: "prep-secret" },
            orchestrator: { mode: "provisional" },
          },
        }),
      ],
      nextId: 2,
      revision: 1,
      orchestrator: { setting: "auto", sticky: false },
    });
    const adapter = new JobsAdapter(new Bus());
    const scheduler = new TodoScheduler(
      { appendEntry() {}, sendMessage() {} },
      adapter,
      () => {},
    );
    scheduler.activate({});
    assert.equal(
      scheduler.packageAssignmentError(1, "prep-secret", "auto"),
      undefined,
    );
    assert.match(
      scheduler.packageAssignmentError(1, "wrong", "auto"),
      /ready matching/,
    );
    for (const status of [
      "queued",
      "running",
      "failed",
      "insufficient",
      "not_needed",
    ]) {
      commitState({
        ...getState(),
        tasks: [
          task("pending", {
            metadata: {
              preparation: { status, token: "prep-secret" },
              orchestrator: { mode: "provisional" },
            },
          }),
        ],
        revision: getState().revision + 1,
      });
      assert.match(
        scheduler.packageAssignmentError(1, "prep-secret", "auto"),
        /ready matching/,
      );
    }
    commitState({
      ...getState(),
      tasks: [
        task("pending", {
          metadata: {
            preparation: { status: "ready", token: "prep-secret" },
            orchestrator: { mode: "provisional" },
          },
        }),
      ],
      revision: getState().revision + 1,
    });
    scheduler.pauseAutomation();
    assert.match(
      scheduler.packageAssignmentError(1, "prep-secret", "auto"),
      /paused/,
    );
    scheduler.resumeAutomation();
    assert.equal(
      scheduler.packageAssignmentError(1, "prep-secret", "auto"),
      undefined,
    );
    assert.match(
      scheduler.packageAssignmentError(1, "prep-secret", "off"),
      /orchestrator setting is off/,
    );
    scheduler.dispose();
    adapter.dispose();
  });

  it("rejects a direct target despite a sticky sibling before dispatch body", async () => {
    __resetState();
    commitState({
      tasks: [
        task("pending", {
          metadata: {
            preparation: { status: "ready", token: "direct-token" },
            orchestrator: { mode: "direct", requiresOrchestration: false },
          },
        }),
        {
          ...task("pending", {
            metadata: {
              preparation: { status: "ready", token: "sticky-token" },
              orchestrator: { mode: "sticky", requiresOrchestration: true },
            },
          }),
          id: 2,
        },
      ],
      nextId: 3,
      revision: 1,
      orchestrator: { setting: "auto", sticky: true },
    });
    const adapter = new JobsAdapter(new Bus());
    const scheduler = new TodoScheduler(
      { appendEntry() {}, sendMessage() {} },
      adapter,
      () => {},
    );
    scheduler.activate({});
    const unregister = registerPackageAssignmentGate(({ todoId, todoToken }) =>
      scheduler.packageAssignmentError(todoId, todoToken, "auto"),
    );
    const bodies = { manager: 0, spawn: 0, cancel: 0 };
    try {
      assert.match(
        scheduler.packageAssignmentError(1, "direct-token", "auto"),
        /target TODO is direct.*Execute it in the parent/,
      );
      assert.equal(
        scheduler.packageAssignmentError(2, "sticky-token", "auto"),
        undefined,
      );
      await assert.rejects(
        spawnPackageAssignment(
          { todoId: 1, todoToken: "direct-token" },
          {
            async getManager() {
              bodies.manager++;
              return {};
            },
            async spawn() {
              bodies.spawn++;
              return { id: "must-not-spawn" };
            },
            async cancel() {
              bodies.cancel++;
            },
          },
        ),
        /target TODO is direct.*Execute it in the parent/,
      );
      assert.deepEqual(bodies, { manager: 0, spawn: 0, cancel: 0 });
    } finally {
      unregister();
      scheduler.dispose();
      adapter.dispose();
    }
  });

  it("queues same-TODO spawn handshakes and retains concurrent disjoint package owners", async () => {
    __resetState();
    commitState({
      tasks: [
        task("pending", {
          metadata: {
            preparation: { status: "ready", token: "prep-secret" },
            orchestrator: { mode: "sticky" },
          },
        }),
      ],
      nextId: 2,
      revision: 1,
      orchestrator: { setting: "auto", sticky: true },
    });
    const bus = new Bus();
    const adapter = new JobsAdapter(bus);
    const scheduler = new TodoScheduler(
      { events: bus, appendEntry() {}, sendMessage() {} },
      adapter,
      () => {},
    );
    scheduler.activate({});
    const unregister = registerPackageAssignmentGate(
      ({ todoId, todoToken }) =>
        scheduler.packageAssignmentError(todoId, todoToken, "auto"),
      ({ todoId, todoToken, subagentId }) =>
        scheduler.authorizePackageAssignment(todoId, todoToken, subagentId),
    );
    const request = { todoId: 1, todoToken: "prep-secret" };
    let releaseAlpha;
    let alphaSpawned;
    const alphaStarted = new Promise((resolve) => {
      alphaSpawned = resolve;
    });
    const alphaBlocked = new Promise((resolve) => {
      releaseAlpha = resolve;
    });
    let betaSpawnCalls = 0;
    try {
      const alpha = spawnPackageAssignment(request, {
        async getManager() {
          return {};
        },
        async spawn() {
          alphaSpawned();
          await alphaBlocked;
          return { id: "worker-alpha" };
        },
        async cancel() {},
      });
      await alphaStarted;
      const beta = spawnPackageAssignment(request, {
        async getManager() {
          return {};
        },
        async spawn() {
          betaSpawnCalls++;
          return { id: "worker-beta" };
        },
        async cancel() {},
      });
      assert.equal(betaSpawnCalls, 0);

      releaseAlpha();
      assert.deepEqual(
        (await Promise.all([alpha, beta])).map(({ id }) => id),
        ["worker-alpha", "worker-beta"],
      );
      assert.equal(betaSpawnCalls, 1);

      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "worker-alpha", todo_id: 1, todo_token: "prep-secret" },
          { id: "worker-beta", todo_id: 1, todo_token: "prep-secret" },
        ],
      });
      assert.equal(getState().tasks[0].metadata.delegation.status, "running");
      assert.deepEqual(getState().tasks[0].metadata.delegation.subagentIds, [
        "worker-alpha",
        "worker-beta",
      ]);
    } finally {
      releaseAlpha?.();
      unregister();
      scheduler.dispose();
      adapter.dispose();
    }
  });

  it("persists ownership before manager start despite throwing state observers", async () => {
    __resetState();
    commitState({
      tasks: [
        task("pending", {
          metadata: {
            preparation: { status: "ready", token: "prep-secret" },
            orchestrator: { mode: "sticky" },
          },
        }),
      ],
      nextId: 2,
      revision: 1,
      orchestrator: { setting: "auto", sticky: true },
    });
    const bus = new Bus();
    const snapshots = [];
    const adapter = new JobsAdapter(bus);
    const scheduler = new TodoScheduler(
      {
        events: bus,
        appendEntry(_type, data) {
          snapshots.push(data);
        },
        sendMessage() {},
      },
      adapter,
      () => {},
    );
    scheduler.activate({});
    const stopThrowingObserver = subscribeState(() => {
      throw new Error("subscriber notification failed");
    });
    const unregister = registerPackageAssignmentGate(
      ({ todoId, todoToken }) =>
        scheduler.packageAssignmentError(todoId, todoToken, "auto"),
      ({ todoId, todoToken, subagentId }) =>
        scheduler.authorizePackageAssignment(todoId, todoToken, subagentId),
    );
    let started = false;
    try {
      const assigned = await spawnPackageAssignment(
        { todoId: 1, todoToken: "prep-secret" },
        {
          async getManager() {
            return {};
          },
          async spawn() {
            return { id: "worker-persisted" };
          },
          async start() {
            started = true;
            const delegation = getState().tasks[0].metadata.delegation;
            assert.equal(delegation.status, "running");
            assert.deepEqual(delegation.subagentIds, ["worker-persisted"]);
            assert.deepEqual(
              snapshots.at(-1).upsertedTasks[0].metadata.delegation.subagentIds,
              ["worker-persisted"],
            );
          },
          async cancel() {},
        },
      );
      assert.equal(assigned.id, "worker-persisted");
      assert.equal(started, true);
      assert.deepEqual(getState().tasks[0].metadata.delegation.subagentIds, [
        "worker-persisted",
      ]);
    } finally {
      unregister();
      stopThrowingObserver();
      scheduler.dispose();
      adapter.dispose();
    }
  });

  it("hydrates reload interruption intent and authorizes explicit id reuse", () => {
    __resetState();
    commitState({
      tasks: [owned()],
      nextId: 2,
      revision: 1,
      orchestrator: { setting: "auto", sticky: true },
    });
    const bus = new Bus();
    const adapter = new JobsAdapter(bus);
    const scheduler = new TodoScheduler(
      { events: bus, appendEntry() {}, sendMessage() {} },
      adapter,
      () => {},
    );
    scheduler.activate({});
    assert.equal(getState().tasks[0].metadata.delegation.status, "interrupted");

    bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
      delegations: [{ id: "worker-1", todo_id: 1, todo_token: "prep-secret" }],
    });
    bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, { delegations: [] });
    assert.equal(getState().tasks[0].metadata.delegation.status, "interrupted");

    scheduler.authorizePackageAssignment(1, "prep-secret", "worker-1");
    bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
      delegations: [{ id: "worker-1", todo_id: 1, todo_token: "prep-secret" }],
    });
    assert.equal(getState().tasks[0].metadata.delegation.status, "running");
    scheduler.dispose();
    adapter.dispose();
  });

  it("preserves interruption intent across late live then empty events", () => {
    __resetState();
    commitState({
      tasks: [owned()],
      nextId: 2,
      revision: 1,
      orchestrator: { setting: "auto", sticky: true },
    });
    const bus = new Bus();
    const adapter = new JobsAdapter(bus);
    const scheduler = new TodoScheduler(
      { events: bus, appendEntry() {}, sendMessage() {} },
      adapter,
      () => {},
    );
    bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
      delegations: [{ id: "worker-1", todo_id: 1, todo_token: "prep-secret" }],
    });
    scheduler.pauseAutomation();
    assert.equal(getState().tasks[0].metadata.delegation.status, "interrupted");
    bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
      delegations: [{ id: "worker-1", todo_id: 1, todo_token: "prep-secret" }],
    });
    bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, { delegations: [] });
    assert.equal(getState().tasks[0].metadata.delegation.status, "interrupted");
    scheduler.dispose();
    adapter.dispose();
  });

  it("blocks raw terminal ownership, then cancels it before one completion review", async () => {
    for (const status of ["running", "interrupted"]) {
      const state = {
        tasks: [owned("completed", status)],
        nextId: 2,
        revision: 1,
      };
      assert.equal(hasCompletedBatch(state), false);
      assert.equal(applyTaskMutation(state, "clear", {}).op.kind, "error");
    }
    const waiting = {
      tasks: [
        task("waiting:jobs", {
          wait: {
            kind: "jobs",
            jobIds: ["job-1"],
            mode: "all",
            deadline: 10,
            settled: {},
          },
        }),
      ],
      nextId: 2,
      revision: 1,
    };
    const completion = applyTaskMutation(waiting, "update", {
      id: 1,
      status: "completed",
    });
    assert.equal(completion.op.kind, "error");
    assert.match(completion.op.message, /jobs wait remains active/);
    assert.equal(completion.state.tasks[0].status, "waiting:jobs");
    assert.equal(hasCompletedBatch(completion.state), false);
    assert.equal(
      applyTaskMutation(completion.state, "clear", {}).op.kind,
      "error",
    );

    __resetState();
    commitState({ tasks: [owned()], nextId: 2, revision: 1 });
    const bus = new Bus();
    const sent = [];
    const cancelled = [];
    const unregister = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      async cancel(ids) {
        cancelled.push([...ids]);
      },
    });
    const adapter = new JobsAdapter(bus);
    const scheduler = new TodoScheduler(
      {
        events: bus,
        appendEntry() {},
        sendMessage(message) {
          sent.push(message);
        },
      },
      adapter,
      () => {},
    );
    bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
      delegations: [{ id: "worker-1", todo_id: 1, todo_token: "prep-secret" }],
    });
    commitState({
      ...getState(),
      tasks: [{ ...getState().tasks[0], status: "completed" }],
      revision: getState().revision + 1,
    });
    scheduler.stateChanged();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(cancelled, [["worker-1"]]);
    assert.equal(getState().tasks[0].metadata.delegation.status, "cancelled");
    assert.equal(
      sent.filter(
        (message) => message.customType === "rpiv-todo:completion-review",
      ).length,
      1,
    );
    bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
      delegations: [{ id: "worker-1", todo_id: 1, todo_token: "prep-secret" }],
    });
    assert.equal(getState().tasks[0].metadata.delegation.status, "cancelling");
    await new Promise((resolve) => setImmediate(resolve));
    bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, { delegations: [] });
    assert.equal(getState().tasks[0].metadata.delegation.status, "cancelled");
    assert.equal(
      sent.filter(
        (message) => message.customType === "rpiv-todo:completion-review",
      ).length,
      1,
    );
    assert.equal(applyTaskMutation(getState(), "clear", {}).op.kind, "clear");
    scheduler.dispose();
    adapter.dispose();
    unregister();
  });

  it("only latest expanded cancellation generation can confirm completion", async () => {
    __resetState();
    commitState({
      tasks: [owned("completed")],
      nextId: 2,
      revision: 1,
    });
    const bus = new Bus();
    const sent = [];
    const requests = [];
    const pending = [];
    const unregister = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      cancel(ids) {
        requests.push([...ids]);
        return new Promise((resolve, reject) =>
          pending.push({ resolve, reject }),
        );
      },
    });
    const adapter = new JobsAdapter(bus);
    const scheduler = new TodoScheduler(
      {
        events: bus,
        appendEntry() {},
        sendMessage(message) {
          sent.push(message);
        },
      },
      adapter,
      () => {},
    );
    try {
      scheduler.activate({});
      assert.deepEqual(requests, [["worker-1"]]);
      assert.equal(
        getState().tasks[0].metadata.delegation.cancellationGeneration,
        1,
      );

      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "worker-z", todo_id: 1, todo_token: "prep-secret" },
          { id: "worker-1", todo_id: 1, todo_token: "prep-secret" },
        ],
      });
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "worker-z", todo_id: 1, todo_token: "prep-secret" },
          { id: "worker-a", todo_id: 1, todo_token: "prep-secret" },
          { id: "worker-1", todo_id: 1, todo_token: "prep-secret" },
        ],
      });
      assert.deepEqual(requests, [
        ["worker-1"],
        ["worker-1", "worker-z"],
        ["worker-1", "worker-a", "worker-z"],
      ]);
      let delegation = getState().tasks[0].metadata.delegation;
      assert.equal(delegation.cancellationGeneration, 3);
      assert.deepEqual(delegation.subagentIds, [
        "worker-1",
        "worker-a",
        "worker-z",
      ]);
      assert.equal(applyTaskMutation(getState(), "clear", {}).op.kind, "error");

      pending[0].reject(new Error("stale failure"));
      pending[1].resolve();
      await new Promise((resolve) => setImmediate(resolve));
      delegation = getState().tasks[0].metadata.delegation;
      assert.equal(delegation.status, "cancelling");
      assert.equal(delegation.cancellationGeneration, 3);
      assert.equal(delegation.cancellationError, undefined);
      assert.equal(hasCompletedBatch(), false);
      assert.equal(sent.length, 0);
      assert.equal(applyTaskMutation(getState(), "clear", {}).op.kind, "error");

      pending[2].resolve();
      await new Promise((resolve) => setImmediate(resolve));
      delegation = getState().tasks[0].metadata.delegation;
      assert.equal(delegation.status, "cancelled");
      assert.equal(delegation.cancellationGeneration, 3);
      assert.equal(hasCompletedBatch(), true);
      assert.equal(
        sent.filter(
          ({ customType }) => customType === "rpiv-todo:completion-review",
        ).length,
        1,
      );
      assert.equal(applyTaskMutation(getState(), "clear", {}).op.kind, "clear");
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("reload cancels completed and deleted owners and late events cannot restore authority", async () => {
    __resetState();
    const completed = owned("completed");
    const deleted = {
      ...owned("deleted"),
      id: 2,
      metadata: {
        ...owned("deleted").metadata,
        preparation: { status: "ready", token: "prep-deleted" },
        delegation: {
          status: "running",
          subagentId: "worker-2",
          subagentIds: ["worker-2"],
          todoId: 2,
          todoToken: "prep-deleted",
        },
      },
    };
    commitState({ tasks: [completed, deleted], nextId: 3, revision: 1 });
    const bus = new Bus();
    const cancelled = [];
    const snapshots = [];
    const sent = [];
    const unregister = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      async cancel(ids) {
        cancelled.push([...ids]);
      },
    });
    const adapter = new JobsAdapter(bus);
    const scheduler = new TodoScheduler(
      {
        events: bus,
        appendEntry(type, data) {
          snapshots.push({ type, data });
        },
        sendMessage(message) {
          sent.push(message);
        },
      },
      adapter,
      () => {},
    );
    try {
      scheduler.activate({});
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(
        new Set(cancelled.flat()),
        new Set(["worker-1", "worker-2"]),
      );
      assert.deepEqual(
        getState().tasks.map(
          (candidate) => candidate.metadata.delegation.status,
        ),
        ["cancelled", "cancelled"],
      );
      const persisted = new Map();
      for (const snapshot of snapshots)
        for (const candidate of
          snapshot.data.tasks ?? snapshot.data.upsertedTasks ?? [])
          persisted.set(candidate.id, candidate);
      assert.deepEqual(
        [...persisted.values()].map(
          (candidate) => candidate.metadata.delegation.status,
        ),
        ["cancelled", "cancelled"],
      );
      assert.equal(
        sent.filter(
          (message) => message.customType === "rpiv-todo:completion-review",
        ).length,
        1,
      );

      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "worker-1", todo_id: 1, todo_token: "prep-secret" },
          { id: "worker-2", todo_id: 2, todo_token: "prep-deleted" },
        ],
      });
      assert.deepEqual(
        getState().tasks.map(
          (candidate) => candidate.metadata.delegation.status,
        ),
        ["cancelling", "cancelling"],
      );
      await new Promise((resolve) => setImmediate(resolve));
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, { delegations: [] });
      assert.deepEqual(
        getState().tasks.map(
          (candidate) => candidate.metadata.delegation.status,
        ),
        ["cancelled", "cancelled"],
      );
      assert.equal(
        sent.filter(
          (message) => message.customType === "rpiv-todo:completion-review",
        ).length,
        1,
      );
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("retains failed cancellation evidence and retries it on reload", async () => {
    __resetState();
    commitState({ tasks: [owned("completed")], nextId: 2, revision: 1 });
    const bus = new Bus();
    let calls = 0;
    const unregister = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      async cancel() {
        calls++;
        if (calls === 1)
          throw new Error("manager unavailable: " + "x".repeat(800));
      },
    });
    const adapter = new JobsAdapter(bus);
    const scheduler = new TodoScheduler(
      { events: bus, appendEntry() {}, sendMessage() {} },
      adapter,
      () => {},
    );
    try {
      scheduler.activate({});
      await new Promise((resolve) => setImmediate(resolve));
      let delegation = getState().tasks[0].metadata.delegation;
      assert.equal(delegation.status, "cancelling");
      assert.equal(delegation.cancellationGeneration, 1);
      assert.deepEqual(delegation.subagentIds, ["worker-1"]);
      assert.match(delegation.cancellationError, /manager unavailable/);
      assert.ok(delegation.cancellationError.length <= 512);
      assert.equal(hasCompletedBatch(), false);

      scheduler.activate({});
      await new Promise((resolve) => setImmediate(resolve));
      delegation = getState().tasks[0].metadata.delegation;
      assert.equal(calls, 2);
      assert.equal(delegation.status, "cancelled");
      assert.equal(delegation.cancellationGeneration, 1);
      assert.equal(delegation.cancellationAttempts, 2);
      assert.deepEqual(delegation.subagentIds, ["worker-1"]);
      assert.equal(hasCompletedBatch(), true);
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("deduplicates completion review across state change and agent settlement", () => {
    __resetState();
    commitState({ tasks: [owned()], nextId: 2, revision: 1 });
    const bus = new Bus();
    const sent = [];
    const adapter = new JobsAdapter(bus);
    const scheduler = new TodoScheduler(
      {
        events: bus,
        appendEntry() {},
        sendMessage(message) {
          sent.push(message);
        },
      },
      adapter,
      () => {},
    );
    scheduler.activate({});
    scheduler.onAgentStart();
    const current = getState().tasks[0];
    commitState({
      ...getState(),
      tasks: [
        {
          ...current,
          status: "completed",
          metadata: {
            ...current.metadata,
            delegation: { ...current.metadata.delegation, status: "cancelled" },
          },
        },
      ],
      revision: getState().revision + 1,
    });
    scheduler.stateChanged();
    scheduler.onAgentSettled({});
    assert.equal(
      sent.filter(({ content }) => content.includes("All visible TODOs"))
        .length,
      1,
    );
    assert.deepEqual(
      sent.map(({ customType }) => customType),
      ["rpiv-todo:completion-review"],
    );
    scheduler.dispose();
    adapter.dispose();
  });

  it("cancels stale Package Workers after effective dependency changes only", async () => {
    __resetState();
    const cancelled = [];
    const unregister = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      async cancel(ids) {
        cancelled.push([...ids]);
      },
    });
    const bus = new Bus();
    const adapter = new JobsAdapter(bus);
    const scheduler = new TodoScheduler(
      { events: bus, appendEntry() {}, sendMessage() {} },
      adapter,
      () => {},
    );
    try {
      commitState({
        tasks: [owned(), { ...task(), id: 2, subject: "Dependency" }],
        nextId: 3,
        revision: 1,
      });
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "worker-1", todo_id: 1, todo_token: "prep-secret" },
        ],
      });
      const runtime = applyTaskMutation(getState(), "update", {
        id: 1,
        status: "pending",
      }).state;
      commitState(runtime);
      scheduler.stateChanged();
      assert.deepEqual(cancelled, []);

      const added = applyTaskMutation(getState(), "update", {
        id: 1,
        addBlockedBy: [2],
      }).state;
      const addToken = added.tasks[0].metadata.preparation.token;
      assert.notEqual(addToken, "prep-secret");
      assert.equal(added.tasks[0].metadata.delegation, undefined);
      commitState(added);
      scheduler.stateChanged();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(cancelled, [["worker-1"]]);
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "worker-1", todo_id: 1, todo_token: "prep-secret" },
        ],
      });
      assert.equal(getState().tasks[0].metadata.delegation, undefined);

      scheduler.authorizePackageAssignment(1, addToken, "worker-2");
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [{ id: "worker-2", todo_id: 1, todo_token: addToken }],
      });
      const removed = applyTaskMutation(getState(), "update", {
        id: 1,
        removeBlockedBy: [2],
      }).state;
      const removeToken = removed.tasks[0].metadata.preparation.token;
      assert.notEqual(removeToken, addToken);
      commitState(removed);
      scheduler.stateChanged();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(cancelled.at(-1), ["worker-2"]);
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [{ id: "worker-2", todo_id: 1, todo_token: addToken }],
      });
      assert.equal(getState().tasks[0].metadata.delegation, undefined);

      const noOp = applyTaskMutation(getState(), "update", {
        id: 1,
        removeBlockedBy: [2],
      }).state;
      assert.equal(noOp.tasks[0].metadata.preparation.token, removeToken);
      assert.equal(noOp, getState());
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("uses recovery-only guidance after bounded preparation failure", () => {
    const state = {
      tasks: [
        task("pending", {
          metadata: {
            preparation: {
              status: "failed",
              code: "preparation_failed",
            },
          },
        }),
      ],
      nextId: 2,
      revision: 1,
    };
    const guidance = actionableContinuation(state);
    assert.match(guidance, /failed after two attempts/);
    assert.match(guidance, /Do not continue implementation/);
    assert.doesNotMatch(guidance, /Continue actionable TODO/);
  });

  it("keeps rollout disabled unless config explicitly opts in", () => {
    assert.equal(orchestratorEnabled(undefined), false);
    assert.equal(orchestratorEnabled({}), false);
    assert.equal(
      orchestratorEnabled({ orchestrator: { enabled: false } }),
      false,
    );
    assert.equal(
      orchestratorEnabled({ orchestrator: { enabled: true } }),
      true,
    );
  });
});
