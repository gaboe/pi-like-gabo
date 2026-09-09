import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  CANCELLATION_CAPACITY_ERROR,
  MAX_CANCELLATION_INTENTS,
} from "./state.ts";
import {
  __resetState,
  commitState,
  getState,
  replaceState,
  subscribeState,
} from "./store.ts";
import { registerTodoTool } from "../todo.ts";
import {
  cancelPreparationWorkers,
  retryTodoPreparationCancellations,
} from "../todo.ts";
import {
  reservedCancellationWorkerIds,
  resolveTodoReviewTarget,
  todoReviewTargetIdentityBinding,
} from "../enrichment.ts";
import { buildToolResult } from "../tool/response-envelope.ts";
import { SUBAGENT_DELEGATION_STATE_CHANNEL } from "../../../vendor/pi-tools/extensions/shared/subagent-wait-protocol.ts";
import { registerBackgroundSubagentService } from "../../../vendor/pi-tools/extensions/shared/background-subagent-protocol.ts";

const approvedReview = () => ({
  status: "approved",
  generation: 1,
  token: "review-token",
  completionRevision: 1,
  requestedAt: 1,
  dispatchedAt: 2,
  reviewer: {
    id: "todo-completion-reviewer",
    model: "openai-codex/gpt-5.6-luna",
  },
  feedback: "verified",
});
const currentExecutionTarget = resolveTodoReviewTarget(
  `external checkout "${process.cwd()}"`,
);
const currentTargetBinding = todoReviewTargetIdentityBinding(
  currentExecutionTarget?.identity,
);
const assignmentError = (scheduler, todoId, token, setting = "auto") =>
  scheduler.packageAssignmentError(
    todoId,
    token,
    setting,
    currentExecutionTarget.path,
    currentTargetBinding,
  );

const task = (status = "pending", extra = {}) => ({
  id: 1,
  subject: "Package",
  status,
  ...(status === "completed" ? { result: "done", evidence: ["verified"] } : {}),
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

function approvedPreparation(token) {
  return {
    status: "ready",
    token,
    approvalRequired: false,
    approval: "granted",
    analysisCwd:
      currentExecutionTarget?.status === "selected"
        ? currentExecutionTarget.path
        : process.cwd(),
    ...(currentExecutionTarget?.status === "selected"
      ? {
          analysisCwdIdentity: currentExecutionTarget.identity,
          hostAssignment: {
            source: "host",
            version: 1,
            token,
            targetBinding: currentTargetBinding,
          },
        }
      : {}),
  };
}

function owned(status = "in_progress", delegation = "running") {
  return task(status, {
    ...(status === "completed"
      ? { result: "done", evidence: ["verified"], review: approvedReview() }
      : {}),
    metadata: {
      preparation: approvedPreparation("prep-secret"),
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
  it("never exposes assignment fencing in ordinary TODO output", async () => {
    const ordinary = owned("pending", "settled");
    delete ordinary.metadata.preparation.hostAssignment;
    const state = {
      tasks: [ordinary],
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
    assert.doesNotMatch(
      get.content[0].text,
      /targetBinding|todo_token|prep-secret/,
    );
    assert.doesNotMatch(JSON.stringify(get.details), /prep-secret|todoToken/);
    const directTask = {
      ...state.tasks[0],
      metadata: {
        ...state.tasks[0].metadata,
        orchestrator: { mode: "direct" },
      },
    };
    const directGet = buildToolResult(
      "get",
      { id: 1 },
      { ...state, tasks: [directTask] },
      { kind: "get", task: directTask },
    );
    assert.doesNotMatch(
      directGet.content[0].text,
      /targetBinding|todo_token|prep-secret/,
    );

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
      { action: "create", subject: "Delegate package worker" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(getState().tasks[0].metadata?.preparation, undefined);
    assert.doesNotMatch(JSON.stringify(created), /targetBinding|todoToken/);
    const listed = await tool.execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      ctx,
    );
    assert.doesNotMatch(JSON.stringify(listed), /targetBinding|todoToken/);
    const updated = await tool.execute(
      "update",
      { action: "update", id: 1, subject: "Renamed" },
      undefined,
      undefined,
      ctx,
    );
    const rotatedToken = getState().tasks[0].metadata.preparation.token;
    assert.doesNotMatch(JSON.stringify(updated), /targetBinding|todoToken/);
    assert.equal(typeof rotatedToken, "string");
    const fetched = await tool.execute(
      "get",
      { action: "get", id: 1 },
      undefined,
      undefined,
      ctx,
    );
    assert.doesNotMatch(fetched.content[0].text, /targetBinding|todo_token/);
    assert.doesNotMatch(fetched.content[0].text, new RegExp(rotatedToken));
  });

  it("rejects tool mutations of reserved orchestration metadata", async () => {
    __resetState();
    commitState({
      tasks: [
        task("in_progress", {
          metadata: {
            preparation: approvedPreparation("prep-secret"),
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
      assert.match(
        result.content[0].text,
        new RegExp(`metadata\\.${key} is reserved`),
      );
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
      "package_handoff assignment requires a canonical worker cwd and target binding.",
    );
    const unregister = registerPackageAssignmentGate(
      ({ todoId, todoToken }) =>
        todoId === 1 && todoToken === "prep-secret" ? undefined : "mismatch",
      () => undefined,
      () => undefined,
    );
    try {
      assert.equal(
        validateSubagentAssignment(
          "package_handoff",
          1,
          "prep-secret",
          currentExecutionTarget.path,
          currentTargetBinding,
        ),
        undefined,
      );
      assert.equal(
        packageAssignmentError({
          todoId: 2,
          todoToken: "wrong",
          workerCwd: currentExecutionTarget.path,
          targetBinding: currentTargetBinding,
        }),
        "mismatch",
      );
    } finally {
      unregister();
    }
  });

  it("pre-admits delegation cleanup before terminal task mutation", async () => {
    const recovery = (count) =>
      Array.from({ length: count }, (_, index) => ({
        kind: "delegation",
        taskId: 1000 + index,
        token: `recovery-${index}`,
        ids: [`recovery-worker-${index}`],
        generation: 1,
        attempts: 0,
      }));
    const bus = new Bus();
    const adapter = new JobsAdapter(bus);
    const scheduler = new TodoScheduler(
      { events: bus, appendEntry() {}, sendMessage() {} },
      adapter,
      () => {},
    );
    try {
      for (const count of [512, 511]) {
        __resetState();
        commitState({
          tasks: [owned("in_progress", "running")],
          nextId: 2,
          revision: 1,
          cancellationIntents: recovery(count).slice(
            0,
            MAX_CANCELLATION_INTENTS,
          ),
          ...(count > MAX_CANCELLATION_INTENTS
            ? {
                cancellationOverflow: recovery(count).slice(
                  MAX_CANCELLATION_INTENTS,
                ),
              }
            : {}),
        });
        let tool;
        registerTodoTool(
          {
            registerTool(definition) {
              tool = definition;
            },
            appendEntry() {},
          },
          {
            preparation: {
              getGeneration: () => 1,
              admitDelegationCancellation: (state, previousTask, generation) =>
                scheduler.admitDelegationCancellation(
                  state,
                  previousTask,
                  generation,
                ),
            },
          },
        );
        const before = structuredClone(getState());
        const response = await tool.execute(
          "terminal",
          {
            action: "update",
            id: 1,
            status: "completed",
            result: "done",
            evidence: ["verified"],
          },
          undefined,
          undefined,
          { cwd: process.cwd() },
        );
        if (count === 512) {
          assert.match(
            response.content[0].text,
            /Cancellation recovery capacity reached/,
          );
          assert.deepEqual(getState(), before);
        } else {
          assert.equal(getState().tasks[0].status, "completed");
          assert.ok(
            [
              ...(getState().cancellationIntents ?? []),
              ...(getState().cancellationOverflow ?? []),
            ].some(
              (intent) =>
                intent.kind === "delegation" && intent.ids.includes("worker-1"),
            ),
          );
        }
      }
    } finally {
      scheduler.dispose();
      adapter.dispose();
    }
  });

  it("requires live matching orchestration and reopens after manual resume", () => {
    __resetState();
    commitState({
      tasks: [
        task("pending", {
          metadata: {
            preparation: approvedPreparation("prep-secret"),
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
    assert.equal(assignmentError(scheduler, 1, "prep-secret"), undefined);

    commitState({
      ...getState(),
      tasks: [
        task("pending", {
          metadata: {
            preparation: {
              ...approvedPreparation("prep-secret"),
              token: "prep-secret",
              approvalRequired: true,
            },
            orchestrator: { mode: "provisional" },
          },
        }),
      ],
      revision: getState().revision + 1,
    });
    assert.equal(assignmentError(scheduler, 1, "prep-secret"), undefined);
    commitState({
      ...getState(),
      tasks: [
        task("pending", {
          metadata: {
            preparation: approvedPreparation("prep-secret"),
            orchestrator: { mode: "provisional" },
          },
        }),
      ],
      revision: getState().revision + 1,
    });
    assert.equal(assignmentError(scheduler, 1, "prep-secret"), undefined);
    assert.match(assignmentError(scheduler, 1, "wrong"), /ready matching/);
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
        assignmentError(scheduler, 1, "prep-secret"),
        /ready matching/,
      );
    }
    commitState({
      ...getState(),
      tasks: [
        task("pending", {
          metadata: {
            preparation: approvedPreparation("prep-secret"),
            orchestrator: { mode: "provisional" },
          },
        }),
      ],
      revision: getState().revision + 1,
    });
    scheduler.pauseAutomation();
    assert.match(assignmentError(scheduler, 1, "prep-secret"), /paused/);
    scheduler.resumeAutomation();
    assert.equal(assignmentError(scheduler, 1, "prep-secret"), undefined);
    assert.match(
      assignmentError(scheduler, 1, "prep-secret", "off"),
      /orchestrator setting is off/,
    );
    scheduler.dispose();
    adapter.dispose();
  });

  it("keeps replayed prepared workers executable without a TODO approval gate", () => {
    __resetState();
    commitState({
      tasks: [
        task("pending", {
          metadata: {
            preparation: {
              ...approvedPreparation("replay-token"),
              token: "replay-token",
              approvalRequired: true,
            },
            orchestrator: { mode: "sticky" },
          },
        }),
      ],
      nextId: 2,
      revision: 1,
      orchestrator: { setting: "auto", sticky: true },
    });
    const adapter = new JobsAdapter(new Bus());
    const scheduler = new TodoScheduler(
      { appendEntry() {}, sendMessage() {} },
      adapter,
      () => {},
    );
    try {
      scheduler.activate({});
      assert.equal(assignmentError(scheduler, 1, "replay-token"), undefined);
      scheduler.authorizePackageAssignment(
        1,
        "replay-token",
        "worker-replay",
        currentExecutionTarget.path,
        currentTargetBinding,
      );
      assert.equal(getState().tasks[0].metadata.delegation.status, "running");

      commitState({
        ...getState(),
        tasks: [
          task("pending", {
            metadata: {
              preparation: approvedPreparation("replay-token"),
              orchestrator: { mode: "sticky" },
            },
          }),
        ],
        revision: getState().revision + 1,
      });
      scheduler.activate({});
      assert.equal(assignmentError(scheduler, 1, "replay-token"), undefined);
      scheduler.authorizePackageAssignment(
        1,
        "replay-token",
        "worker-replay",
        currentExecutionTarget.path,
        currentTargetBinding,
      );
      assert.equal(getState().tasks[0].metadata.delegation.status, "running");
    } finally {
      scheduler.dispose();
      adapter.dispose();
    }
  });

  it("requeues replayed ready checkout targets before approval, package spawn, or direct continuation", async () => {
    for (const mode of ["approval", "package", "direct"]) {
      __resetState();
      const parent = await mkdtemp(path.join(tmpdir(), "todo-gate-target-"));
      const target = path.join(parent, "checkout");
      await mkdir(target);
      execFileSync("git", ["init", "-q", target]);
      const selected = resolveTodoReviewTarget(`external checkout "${target}"`);
      assert.equal(selected?.status, "selected");
      const adapter = new JobsAdapter(new Bus());
      const scheduler = new TodoScheduler(
        { appendEntry() {}, sendMessage() {} },
        adapter,
        () => {},
      );
      try {
        commitState({
          tasks: [
            task(mode === "direct" ? "in_progress" : "pending", {
              metadata: {
                preparation: {
                  ...approvedPreparation(`${mode}-token`),
                  reviewTarget: selected,
                  analysisCwd: selected.path,
                  hostAssignment: {
                    source: "host",
                    version: 1,
                    token: `${mode}-token`,
                    targetBinding: todoReviewTargetIdentityBinding(
                      selected.identity,
                    ),
                  },
                },
                orchestrator: { mode: "sticky" },
              },
            }),
          ],
          nextId: 2,
          revision: 1,
        });
        if (mode === "approval") {
          await rm(target, { recursive: true, force: true });
          await mkdir(target);
          execFileSync("git", ["init", "-q", target]);
        }
        scheduler.activate({ cwd: target });
        if (mode === "package") {
          const binding = todoReviewTargetIdentityBinding(selected.identity);
          assert.equal(
            scheduler.packageAssignmentError(
              1,
              `${mode}-token`,
              "auto",
              selected.path,
              binding,
            ),
            undefined,
          );
          assert.match(
            scheduler.packageAssignmentError(
              1,
              `${mode}-token`,
              "auto",
              parent,
              binding,
            ) ?? "",
            /canonical prepared target cwd/,
          );
        }
        if (mode !== "approval") {
          await rm(target, { recursive: true, force: true });
          await mkdir(target);
          execFileSync("git", ["init", "-q", target]);
        }
        if (mode === "package") {
          assert.match(
            scheduler.packageAssignmentError(
              1,
              `${mode}-token`,
              "auto",
              selected.path,
              todoReviewTargetIdentityBinding(selected.identity),
            ) ?? "",
            /identity changed/,
          );
          assert.equal(
            getState().tasks[0].metadata.preparation.status,
            "queued",
          );
          assert.throws(
            () =>
              scheduler.authorizePackageAssignment(
                1,
                `${mode}-token`,
                "package-worker",
                selected.path,
                todoReviewTargetIdentityBinding(selected.identity),
              ),
            /ownership or approval changed|ready matching|current prepared target identity/,
          );
        } else if (mode === "direct") {
          scheduler.onAgentStart();
          scheduler.onAgentSettled({});
          assert.equal(
            getState().tasks[0].metadata.preparation.status,
            "queued",
          );
        } else {
          assert.equal(
            getState().tasks[0].metadata.preparation.status,
            "queued",
          );
        }
      } finally {
        scheduler.dispose();
        adapter.dispose();
        await rm(parent, { recursive: true, force: true });
      }
    }
  });

  it("reconciles only current approved prepared delegation owners", async () => {
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
    const pi = { events: bus, appendEntry() {}, sendMessage() {} };
    const scheduler = new TodoScheduler(pi, adapter, () => {});
    const awaitingQuestion = "TODO #1 prepared plan approval";
    try {
      scheduler.activate({});
      commitState({
        tasks: [
          task("waiting:user", {
            wait: { kind: "user", questions: [awaitingQuestion] },
            metadata: {
              preparation: {
                status: "awaiting_approval",
                approval: "awaiting_approval",
                approvalQuestion: awaitingQuestion,
                approvalRequired: true,
                token: "awaiting-token",
              },
            },
          }),
          {
            ...task("pending"),
            id: 2,
            metadata: {
              preparation: {
                status: "queued",
                approvalRequired: true,
                token: "reprepared-token",
              },
            },
          },
          {
            ...task("pending"),
            id: 3,
            metadata: {
              preparation: approvedPreparation("current-token"),
            },
          },
          {
            ...task("pending"),
            id: 4,
            metadata: {
              preparation: approvedPreparation("granted-token"),
            },
          },
        ],
        nextId: 5,
        revision: 1,
      });

      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "worker-awaiting", todo_id: 1, todo_token: "awaiting-token" },
        ],
      });
      await new Promise((resolve) => setImmediate(resolve));
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          {
            id: "worker-reprepared",
            todo_id: 2,
            todo_token: "reprepared-token",
          },
        ],
      });
      await new Promise((resolve) => setImmediate(resolve));
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "worker-stale", todo_id: 3, todo_token: "old-token" },
        ],
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(getState().tasks[0].metadata.delegation, undefined);
      assert.equal(getState().tasks[1].metadata.delegation, undefined);
      assert.equal(getState().tasks[2].metadata.delegation, undefined);
      assert.deepEqual(cancelled.flat(), [
        "worker-awaiting",
        "worker-reprepared",
        "worker-stale",
      ]);

      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "worker-granted", todo_id: 4, todo_token: "granted-token" },
        ],
      });
      assert.equal(getState().tasks[3].metadata.delegation.status, "running");
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("blocks package spawn when replay restores the full primary and overflow ledger", async () => {
    __resetState();
    const adapter = new JobsAdapter(new Bus());
    const scheduler = new TodoScheduler(
      { appendEntry() {}, sendMessage() {} },
      adapter,
      () => {},
    );
    const bodies = { manager: 0, spawn: 0, cancel: 0 };
    const intent = (index) => ({
      kind: "delegation",
      taskId: 1000 + index,
      token: `replay-token-${index}`,
      ids: [`replay-worker-${index}`],
      generation: 1,
      attempts: 3,
    });
    try {
      scheduler.activate({});
      commitState({
        tasks: [
          task("pending", {
            metadata: {
              preparation: {
                ...approvedPreparation("full-ledger-token"),
                status: "ready",
              },
              orchestrator: { mode: "sticky" },
            },
          }),
        ],
        nextId: 2,
        revision: 1,
        cancellationIntents: Array.from(
          { length: MAX_CANCELLATION_INTENTS },
          (_, index) => intent(index),
        ),
        cancellationOverflow: Array.from(
          { length: MAX_CANCELLATION_INTENTS },
          (_, index) => intent(index + MAX_CANCELLATION_INTENTS),
        ),
      });
      assert.match(
        assignmentError(scheduler, 1, "full-ledger-token"),
        /Cancellation recovery capacity reached/,
      );
      assert.throws(
        () =>
          scheduler.authorizePackageAssignment(
            1,
            "full-ledger-token",
            "new-package-worker",
            currentExecutionTarget.path,
            currentTargetBinding,
          ),
        /Cancellation recovery capacity reached/,
      );
      const unregister = registerPackageAssignmentGate(
        ({ todoId, todoToken }) =>
          assignmentError(scheduler, todoId, todoToken),
        () => undefined,
        () => undefined,
      );
      try {
        await assert.rejects(
          spawnPackageAssignment(
            {
              todoId: 1,
              todoToken: "full-ledger-token",
              workerCwd: currentExecutionTarget.path,
              targetBinding: currentTargetBinding,
            },
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
          /Cancellation recovery capacity reached/,
        );
      } finally {
        unregister();
      }
      assert.deepEqual(bodies, { manager: 0, spawn: 0, cancel: 0 });
      assert.equal(getState().tasks[0].metadata.delegation, undefined);
    } finally {
      scheduler.dispose();
      adapter.dispose();
    }
  });

  it("reconciles the complete provider snapshot per task and cancels per-task overflow", async () => {
    __resetState();
    const cancelled = [];
    const unregister = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      async cancel(ids) {
        cancelled.push(...ids);
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
      scheduler.activate({});
      commitState({
        tasks: [
          task("in_progress", {
            metadata: {
              preparation: approvedPreparation("token-1"),
              delegation: {
                status: "running",
                todoId: 1,
                todoToken: "token-1",
                subagentIds: Array.from(
                  { length: 64 },
                  (_, index) => `task1-${index}`,
                ),
                subagentId: "task1-0",
              },
            },
          }),
          {
            ...task("in_progress", {
              id: 2,
              metadata: { preparation: approvedPreparation("token-2") },
            }),
            id: 2,
          },
        ],
        nextId: 3,
        revision: 1,
      });
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          ...Array.from({ length: 64 }, (_, index) => ({
            id: `task1-${index}`,
            todo_id: 1,
            todo_token: "token-1",
          })),
          { id: "task1-overflow", todo_id: 1, todo_token: "token-1" },
          { id: "task1-0", todo_id: 1, todo_token: "token-1" },
          { id: "task2-worker", todo_id: 2, todo_token: "token-2" },
        ],
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        getState().tasks[0].metadata.delegation.subagentIds.length,
        63,
      );
      assert.deepEqual(getState().tasks[1].metadata.delegation.subagentIds, [
        "task2-worker",
      ]);
      assert.deepEqual(cancelled.sort(), ["task1-0", "task1-overflow"]);
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("rejects a 65th distinct package worker before durable publication", () => {
    __resetState();
    const adapter = new JobsAdapter(new Bus());
    const scheduler = new TodoScheduler(
      { appendEntry() {}, sendMessage() {} },
      adapter,
      () => {},
    );
    try {
      scheduler.activate({});
      commitState({
        tasks: [
          task("in_progress", {
            metadata: {
              preparation: approvedPreparation("capacity-token"),
              delegation: {
                status: "running",
                todoId: 1,
                todoToken: "capacity-token",
                subagentId: "worker-0",
                subagentIds: Array.from(
                  { length: 64 },
                  (_, index) => `worker-${index}`,
                ),
              },
            },
          }),
        ],
        nextId: 2,
        revision: 1,
      });
      assert.throws(
        () =>
          scheduler.authorizePackageAssignment(
            1,
            "capacity-token",
            "worker-64",
            currentExecutionTarget.path,
            currentTargetBinding,
          ),
        /maximum of 64 workers/,
      );
      assert.equal(
        getState().tasks[0].metadata.delegation.subagentIds.length,
        64,
      );
      assert.equal(
        getState().tasks[0].metadata.delegation.subagentIds.includes(
          "worker-64",
        ),
        false,
      );
    } finally {
      scheduler.dispose();
      adapter.dispose();
    }
  });

  it("retains a replayed provider worker beyond the per-task cap as durable cancellation", async () => {
    __resetState();
    let resolveCancellation;
    const cancelled = [];
    const unregister = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      async cancel(ids) {
        cancelled.push([...ids]);
        return new Promise((resolve) => {
          resolveCancellation = resolve;
        });
      },
    });
    const bus = new Bus();
    const adapter = new JobsAdapter(bus);
    const scheduler = new TodoScheduler(
      { events: bus, appendEntry() {}, sendMessage() {} },
      adapter,
      () => {},
    );
    const ids = Array.from(
      { length: 65 },
      (_, index) => `legacy-worker-${index}`,
    );
    try {
      scheduler.activate({});
      commitState({
        tasks: [
          task("in_progress", {
            metadata: {
              preparation: approvedPreparation("legacy-token"),
              delegation: {
                status: "running",
                todoId: 1,
                todoToken: "legacy-token",
                subagentId: ids[0],
                subagentIds: ids.slice(0, 64),
              },
            },
          }),
        ],
        nextId: 2,
        revision: 1,
      });
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: ids.map((id) => ({
          id,
          todo_id: 1,
          todo_token: "legacy-token",
        })),
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(cancelled, [[ids[64]]]);
      assert.deepEqual(
        getState().tasks[0].metadata.delegation.subagentIds,
        ids.slice(0, 64),
      );
      assert.deepEqual(
        getState().tasks[0].metadata.delegation.cancellationIds,
        [ids[64]],
      );
      assert.equal(
        [
          ...(getState().cancellationIntents ?? []),
          ...(getState().cancellationOverflow ?? []),
        ].some((intent) => intent.taskId === 1 && intent.ids.includes(ids[64])),
        true,
      );
    } finally {
      resolveCancellation?.();
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("does not re-adopt a cancelled owner after completion-review rejection", async () => {
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
        tasks: [
          task("pending", {
            review: {
              ...approvedReview(),
              status: "rejected",
              feedback: "remediate",
            },
            metadata: {
              preparation: approvedPreparation("rejected-token"),
              delegation: {
                status: "cancelled",
                todoId: 1,
                todoToken: "rejected-token",
                subagentId: "late-rejected-worker",
                subagentIds: ["late-rejected-worker"],
              },
            },
          }),
        ],
        nextId: 2,
        revision: 1,
      });
      scheduler.activate({});
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          {
            id: "late-rejected-worker",
            todo_id: 1,
            todo_token: "rejected-token",
          },
        ],
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(getState().tasks[0].metadata.delegation.status, "cancelled");
      assert.deepEqual(cancelled, [["late-rejected-worker"]]);
      assert.equal(
        getState().tasks[0].metadata.delegation.subagentIds,
        undefined,
      );
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("does not cancel a valid reused id when its old task becomes terminal", async () => {
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
    const pi = { events: bus, appendEntry() {}, sendMessage() {} };
    const scheduler = new TodoScheduler(pi, adapter, () => {});
    try {
      commitState({
        tasks: [
          task("in_progress", {
            metadata: {
              preparation: approvedPreparation("old-token"),
              orchestrator: { mode: "sticky" },
            },
          }),
          {
            ...task("pending", {
              metadata: {
                preparation: approvedPreparation("new-token"),
                orchestrator: { mode: "sticky" },
              },
            }),
            id: 2,
          },
        ],
        nextId: 3,
        revision: 1,
      });
      scheduler.activate({});
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "reused-worker", todo_id: 1, todo_token: "old-token" },
        ],
      });
      const old = getState().tasks[0];
      commitState({
        ...getState(),
        tasks: [{ ...old, status: "completed" }, getState().tasks[1]],
        revision: getState().revision + 1,
      });
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "reused-worker", todo_id: 2, todo_token: "new-token" },
        ],
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(cancelled, []);
      assert.equal(getState().tasks[0].metadata.delegation.status, "cancelled");
      assert.equal(getState().tasks[1].metadata.delegation.status, "running");
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("does not cancel an old-token event against a newer interrupted incarnation", async () => {
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
    const pi = { events: bus, appendEntry() {}, sendMessage() {} };
    const scheduler = new TodoScheduler(pi, adapter, () => {});
    try {
      commitState({
        tasks: [owned("in_progress", "interrupted")],
        nextId: 2,
        revision: 1,
      });
      scheduler.activate({});
      assert.deepEqual(cancelled, [["worker-1"]]);
      cancelled.length = 0;
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [{ id: "worker-1", todo_id: 1, todo_token: "old-token" }],
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(cancelled, []);
      assert.equal(getState().tasks[0].metadata.delegation.status, "cancelled");
      assert.equal(getState().cancellationIntents?.length ?? 0, 0);
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("binds pause cancellation to identity across delayed worker reuse", async () => {
    __resetState();
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
    const bus = new Bus();
    const adapter = new JobsAdapter(bus);
    const pi = { events: bus, appendEntry() {}, sendMessage() {} };
    const scheduler = new TodoScheduler(pi, adapter, () => {});
    let replacement;
    try {
      commitState({
        tasks: [
          task("in_progress", {
            metadata: {
              preparation: approvedPreparation("old-token"),
              orchestrator: { mode: "sticky" },
            },
          }),
        ],
        nextId: 2,
        revision: 1,
      });
      scheduler.activate({});
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "reused-worker", todo_id: 1, todo_token: "old-token" },
        ],
      });
      scheduler.pauseAutomation();
      assert.deepEqual(requests, [["reused-worker"]]);
      assert.equal(
        getState().tasks[0].metadata.delegation.status,
        "cancelling",
      );
      scheduler.activate({});
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(requests, [["reused-worker"]]);

      commitState({
        ...getState(),
        tasks: [
          getState().tasks[0],
          {
            ...task("pending", {
              metadata: {
                preparation: approvedPreparation("new-token"),
                orchestrator: { mode: "sticky" },
              },
            }),
            id: 2,
          },
        ],
        nextId: 3,
        revision: getState().revision + 1,
      });
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "reused-worker", todo_id: 2, todo_token: "new-token" },
        ],
      });
      assert.deepEqual(requests, [["reused-worker"]]);
      assert.equal(getState().tasks[1].metadata.delegation, undefined);
      assert.throws(
        () =>
          scheduler.authorizePackageAssignment(
            2,
            "new-token",
            "reused-worker",
            currentExecutionTarget.path,
            currentTargetBinding,
          ),
        /reserved until cancellation settles/,
      );
      scheduler.dispose();
      assert.equal(
        reservedCancellationWorkerIds(pi).has("reused-worker"),
        false,
      );
      replacement = new TodoScheduler(
        { events: bus, appendEntry() {}, sendMessage() {} },
        adapter,
        () => {},
      );
      replacement.activate({});
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(requests, [["reused-worker"], ["reused-worker"]]);
      pending[0].resolve();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        getState().tasks[0].metadata.delegation.status,
        "cancelling",
      );
      assert.equal(getState().tasks[1].metadata.delegation, undefined);
      pending[1].resolve();
      await new Promise((resolve) => setImmediate(resolve));
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "reused-worker", todo_id: 2, todo_token: "new-token" },
        ],
      });
      assert.equal(getState().tasks[1].metadata.delegation.status, "running");
    } finally {
      pending.forEach(({ resolve }) => resolve());
      scheduler.dispose();
      replacement?.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("records pause cancellation failure and retries it after replay", async () => {
    __resetState();
    const requests = [];
    const unregister = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      async cancel(ids) {
        requests.push([...ids]);
        if (requests.length === 1) throw new Error("temporary cancel failure");
      },
    });
    const bus = new Bus();
    const adapter = new JobsAdapter(bus);
    const pi = { events: bus, appendEntry() {}, sendMessage() {} };
    const scheduler = new TodoScheduler(pi, adapter, () => {});
    try {
      commitState({
        tasks: [
          task("in_progress", {
            metadata: {
              preparation: approvedPreparation("retry-token"),
              orchestrator: { mode: "sticky" },
            },
          }),
        ],
        nextId: 2,
        revision: 1,
      });
      scheduler.activate({});
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "retry-worker", todo_id: 1, todo_token: "retry-token" },
        ],
      });
      scheduler.pauseAutomation();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        getState().tasks[0].metadata.delegation.status,
        "cancelling",
      );
      assert.match(
        getState().tasks[0].metadata.delegation.cancellationError,
        /temporary/,
      );
      commitState({
        ...getState(),
        tasks: [
          getState().tasks[0],
          {
            ...task("pending"),
            id: 2,
            metadata: {
              preparation: approvedPreparation("new-token"),
              orchestrator: { mode: "sticky" },
            },
          },
        ],
        nextId: 3,
        revision: getState().revision + 1,
      });
      assert.throws(
        () =>
          scheduler.authorizePackageAssignment(
            2,
            "new-token",
            "retry-worker",
            currentExecutionTarget.path,
            currentTargetBinding,
          ),
        /reserved until cancellation settles/,
      );
      scheduler.dispose();
      adapter.dispose();

      const replayBus = new Bus();
      const replayAdapter = new JobsAdapter(replayBus);
      const replay = new TodoScheduler(
        { events: replayBus, appendEntry() {}, sendMessage() {} },
        replayAdapter,
        () => {},
      );
      replay.activate({});
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(requests, [["retry-worker"], ["retry-worker"]]);
      assert.equal(getState().tasks[0].metadata.delegation.status, "cancelled");
      replay.authorizePackageAssignment(
        2,
        "new-token",
        "retry-worker",
        currentExecutionTarget.path,
        currentTargetBinding,
      );
      assert.equal(getState().tasks[1].metadata.delegation.status, "running");
      replay.dispose();
      replayAdapter.dispose();
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("cleans a cancellation retry timer and reservation on dispose", async () => {
    __resetState();
    const requests = [];
    const unregister = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      async cancel(ids) {
        requests.push([...ids]);
        throw new Error("temporary cancel failure");
      },
    });
    const bus = new Bus();
    const adapter = new JobsAdapter(bus);
    const pi = { events: bus, appendEntry() {}, sendMessage() {} };
    const scheduler = new TodoScheduler(pi, adapter, () => {});
    const nativeSetTimeout = globalThis.setTimeout;
    const retryCallbacks = [];
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay !== 25) return nativeSetTimeout(callback, delay, ...args);
      const handle = nativeSetTimeout(() => {}, 60_000);
      retryCallbacks.push(callback);
      return handle;
    };
    try {
      commitState({
        tasks: [
          task("in_progress", {
            metadata: {
              preparation: approvedPreparation("dispose-token"),
              orchestrator: { mode: "sticky" },
            },
          }),
        ],
        nextId: 2,
        revision: 1,
      });
      scheduler.activate({});
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "dispose-worker", todo_id: 1, todo_token: "dispose-token" },
        ],
      });
      scheduler.pauseAutomation();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(requests.length, 1);
      assert.equal(retryCallbacks.length, 1);
      assert.equal(
        reservedCancellationWorkerIds(pi).has("dispose-worker"),
        true,
      );
      const revision = getState().revision;
      scheduler.dispose();
      assert.equal(
        reservedCancellationWorkerIds(pi).has("dispose-worker"),
        false,
      );
      for (const callback of retryCallbacks) callback();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(requests.length, 1);
      assert.equal(getState().revision, revision);
    } finally {
      globalThis.setTimeout = nativeSetTimeout;
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("persists stale delegated cancellation through task removal and retries by identity", async () => {
    __resetState();
    const requests = [];
    const unregister = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      async cancel(ids) {
        requests.push([...ids]);
        if (requests.length === 1) throw new Error("stale owner unavailable");
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
        tasks: [
          task("in_progress", {
            metadata: {
              preparation: approvedPreparation("old-token"),
              delegation: {
                status: "running",
                todoId: 1,
                todoToken: "old-token",
                subagentIds: ["orphan-worker"],
                subagentId: "orphan-worker",
              },
              orchestrator: { mode: "sticky" },
            },
          }),
        ],
        nextId: 2,
        revision: 1,
      });
      scheduler.activate({});
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "orphan-worker", todo_id: 1, todo_token: "old-token" },
        ],
      });
      commitState({
        ...getState(),
        tasks: [
          {
            ...getState().tasks[0],
            metadata: {
              ...getState().tasks[0].metadata,
              preparation: approvedPreparation("new-token"),
            },
          },
        ],
        revision: getState().revision + 1,
      });
      scheduler.stateChanged();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(getState().cancellationIntents?.length ?? 0, 1);
      const intent = getState().cancellationIntents[0];
      assert.equal(intent.taskId, 1);
      assert.equal(intent.token, "old-token");
      assert.deepEqual(intent.ids, ["orphan-worker"]);
      commitState({
        ...getState(),
        tasks: [],
        revision: getState().revision + 1,
      });
      scheduler.dispose();
      adapter.dispose();

      const replayBus = new Bus();
      const replayAdapter = new JobsAdapter(replayBus);
      const replay = new TodoScheduler(
        { events: replayBus, appendEntry() {}, sendMessage() {} },
        replayAdapter,
        () => {},
      );
      replay.activate({});
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(requests, [["orphan-worker"]]);
      assert.equal(getState().cancellationIntents?.length ?? 0, 1);
      replay.dispose();
      replayAdapter.dispose();
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("rejects terminal stale cancellation intents and protects same-ID live owners", async () => {
    for (const terminal of ["completed", "deleted"]) {
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
        const old = owned(terminal);
        old.metadata.delegation = {
          status: "cancelling",
          subagentId: "reused-worker",
          subagentIds: ["reused-worker"],
          cancellationIds: ["reused-worker"],
          cancellationGeneration: 2,
          todoId: 1,
          todoToken: "new-token",
        };
        const live = {
          ...owned("in_progress"),
          id: 2,
          metadata: {
            preparation: approvedPreparation("live-token"),
            delegation: {
              status: "running",
              subagentId: "reused-worker",
              subagentIds: ["reused-worker"],
              todoId: 2,
              todoToken: "live-token",
            },
          },
        };
        scheduler.activate({});
        commitState({
          tasks: [old, live],
          nextId: 3,
          revision: 1,
          cancellationIntents: [
            {
              kind: "delegation",
              taskId: 1,
              token: "old-token",
              ids: ["reused-worker"],
              generation: 1,
              attempts: 0,
              orphaned: true,
            },
          ],
        });
        bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
          delegations: [
            { id: "reused-worker", todo_id: 2, todo_token: "live-token" },
          ],
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(cancelled, []);
        assert.equal(
          getState().tasks[0].metadata.delegation.status,
          "cancelled",
        );
        assert.equal(
          getState().cancellationIntents?.some(
            (intent) => intent.token === "old-token",
          ),
          true,
        );
      } finally {
        scheduler.dispose();
        adapter.dispose();
        unregister();
      }
    }
  });

  it("discards an active new-token orphan delegation intent", async () => {
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
        tasks: [
          task("in_progress", {
            metadata: {
              preparation: approvedPreparation("new-token"),
            },
          }),
        ],
        nextId: 2,
        revision: 1,
        cancellationIntents: [
          {
            kind: "delegation",
            taskId: 1,
            token: "old-token",
            ids: ["old-worker"],
            generation: 1,
            attempts: 0,
            orphaned: true,
          },
        ],
      });
      scheduler.activate({});
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(cancelled, []);
      assert.equal(getState().cancellationIntents?.length ?? 0, 0);
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "new-worker", todo_id: 1, todo_token: "new-token" },
        ],
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        getState().tasks[0].metadata.delegation.todoToken,
        "new-token",
      );
      assert.equal(getState().tasks[0].metadata.delegation.status, "running");
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("does not exempt a target ID from protection held by another live task", async () => {
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
      const target = task("in_progress", {
        metadata: {
          preparation: approvedPreparation("target-token"),
          delegation: {
            status: "cancelling",
            subagentId: "shared-worker",
            subagentIds: ["shared-worker"],
            cancellationIds: ["shared-worker"],
            cancellationGeneration: 1,
            todoId: 1,
            todoToken: "target-token",
          },
        },
      });
      const live = {
        ...task("in_progress", {
          metadata: {
            preparation: approvedPreparation("live-token"),
            delegation: {
              status: "running",
              subagentId: "shared-worker",
              subagentIds: ["shared-worker"],
              todoId: 2,
              todoToken: "live-token",
            },
          },
        }),
        id: 2,
      };
      scheduler.activate({});
      commitState({
        tasks: [target, live],
        nextId: 3,
        revision: 1,
        cancellationIntents: [
          {
            kind: "delegation",
            taskId: 1,
            token: "target-token",
            ids: ["shared-worker"],
            generation: 1,
            attempts: 0,
          },
        ],
      });
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "shared-worker", todo_id: 2, todo_token: "live-token" },
        ],
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(cancelled, []);
      assert.equal(getState().cancellationIntents?.length, 1);
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("defers preparation and delegation cancellation across shared worker-kind reuse", async () => {
    __resetState();
    const requests = [];
    const unregister = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      async cancel(ids) {
        requests.push([...ids]);
      },
    });
    const pi = { appendEntry() {} };
    try {
      commitState({
        tasks: [
          task("completed", {
            metadata: {
              preparation: {
                status: "cancelled",
                token: "old-prep",
                activeWorkerIds: ["shared-worker"],
              },
            },
          }),
          {
            ...task("in_progress", {
              metadata: {
                preparation: approvedPreparation("live-delegation"),
                delegation: {
                  status: "running",
                  todoId: 2,
                  todoToken: "live-delegation",
                  subagentIds: ["shared-worker"],
                  subagentId: "shared-worker",
                },
              },
            }),
            id: 2,
          },
        ],
        nextId: 3,
        revision: 1,
      });
      await cancelPreparationWorkers(pi, 1, "old-prep", 1, ["shared-worker"]);
      assert.deepEqual(requests, []);
      assert.equal(getState().cancellationIntents.length, 1);
      commitState({
        ...getState(),
        tasks: [
          getState().tasks[0],
          {
            ...getState().tasks[1],
            metadata: {
              ...getState().tasks[1].metadata,
              delegation: {
                ...getState().tasks[1].metadata.delegation,
                status: "settled",
              },
            },
          },
        ],
        revision: getState().revision + 1,
      });
      retryTodoPreparationCancellations(pi);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(requests, [["shared-worker"]]);

      requests.length = 0;
      __resetState();
      const bus = new Bus();
      const adapter = new JobsAdapter(bus);
      const scheduler = new TodoScheduler(
        { events: bus, appendEntry() {}, sendMessage() {} },
        adapter,
        () => {},
      );
      commitState({
        tasks: [
          task("in_progress", {
            metadata: {
              preparation: approvedPreparation("new-delegation"),
              delegation: {
                status: "running",
                todoId: 1,
                todoToken: "old-delegation",
                subagentIds: ["shared-worker"],
                subagentId: "shared-worker",
              },
            },
          }),
          {
            ...task("pending", {
              metadata: {
                preparation: {
                  status: "running",
                  token: "live-prep",
                  activeWorkerIds: ["shared-worker"],
                },
              },
            }),
            id: 2,
          },
        ],
        nextId: 3,
        revision: 1,
      });
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "shared-worker", todo_id: 1, todo_token: "old-delegation" },
        ],
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(requests, []);
      assert.equal(
        getState().cancellationIntents.some(
          (intent) => intent.kind === "delegation",
        ),
        true,
      );
      commitState({
        ...getState(),
        tasks: [
          getState().tasks[0],
          {
            ...getState().tasks[1],
            metadata: {
              ...getState().tasks[1].metadata,
              preparation: {
                ...getState().tasks[1].metadata.preparation,
                status: "cancelled",
                activeWorkerIds: [],
              },
            },
          },
        ],
        revision: getState().revision + 1,
      });
      scheduler.stateChanged();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(requests, [["shared-worker"]]);
      scheduler.dispose();
      adapter.dispose();
    } finally {
      unregister();
    }
  });

  it("keeps mixed sibling cancellation outcomes independently replayable", async () => {
    __resetState();
    const requests = [];
    const failed = new Set(["prep-b", "delegation-b"]);
    const unregister = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      async cancel(ids) {
        requests.push([...ids]);
        if (failed.has(ids[0])) throw new Error(`${ids[0]} failed`);
      },
    });
    const pi = { appendEntry() {} };
    try {
      commitState({
        tasks: [
          task("in_progress", {
            metadata: {
              preparation: {
                status: "running",
                token: "prep-token",
                workerGeneration: 1,
                activeWorkerIds: ["prep-a", "prep-b"],
              },
            },
          }),
        ],
        nextId: 2,
        revision: 1,
      });
      await Promise.all([
        cancelPreparationWorkers(pi, 1, "prep-token", 1, ["prep-a"]),
        cancelPreparationWorkers(pi, 1, "prep-token", 1, ["prep-b"]),
      ]);
      assert.deepEqual(
        getState().cancellationIntents.map((intent) => intent.ids),
        [["prep-b"]],
      );
      failed.delete("prep-b");
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(getState().cancellationIntents?.length ?? 0, 0);

      __resetState();
      const bus = new Bus();
      const adapter = new JobsAdapter(bus);
      const scheduler = new TodoScheduler(
        { events: bus, appendEntry() {}, sendMessage() {} },
        adapter,
        () => {},
      );
      try {
        commitState({
          tasks: [
            task("in_progress", {
              metadata: {
                preparation: approvedPreparation("current-token"),
                orchestrator: { mode: "sticky" },
              },
            }),
          ],
          nextId: 2,
          revision: 1,
        });
        scheduler.activate({});
        bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
          delegations: [
            { id: "delegation-a", todo_id: 1, todo_token: "stale-token" },
            { id: "delegation-b", todo_id: 1, todo_token: "stale-token" },
          ],
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(
          getState().cancellationIntents.map((intent) => intent.ids),
          [["delegation-b"]],
        );
        failed.delete("delegation-b");
        scheduler.activate({});
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(getState().cancellationIntents?.length ?? 0, 0);
        assert.deepEqual(
          requests.filter((ids) => ids[0].startsWith("delegation")),
          [["delegation-a"], ["delegation-b"]],
        );
      } finally {
        scheduler.dispose();
        adapter.dispose();
      }
    } finally {
      unregister();
    }
  });

  it("does not cancel valid reassigned ids from stale delegated or interrupted maps", async () => {
    __resetState();
    const cancelled = [];
    const unregister = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      async cancel(ids) {
        cancelled.push(...ids);
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
        tasks: [
          task("in_progress", {
            metadata: {
              preparation: approvedPreparation("old-1"),
              orchestrator: { mode: "sticky" },
            },
          }),
          {
            ...task("in_progress", {
              metadata: {
                preparation: approvedPreparation("old-2"),
                orchestrator: { mode: "sticky" },
              },
            }),
            id: 2,
          },
        ],
        nextId: 3,
        revision: 1,
      });
      scheduler.activate({});
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "reused-delegated", todo_id: 1, todo_token: "old-1" },
          { id: "reused-interrupted", todo_id: 2, todo_token: "old-2" },
        ],
      });
      scheduler.pauseAutomation();
      await new Promise((resolve) => setImmediate(resolve));
      cancelled.length = 0;

      commitState({
        tasks: [
          {
            ...task("in_progress", {
              metadata: {
                preparation: approvedPreparation("new-3"),
                orchestrator: { mode: "sticky" },
              },
            }),
            id: 3,
          },
          {
            ...task("in_progress", {
              metadata: {
                preparation: approvedPreparation("new-4"),
                orchestrator: { mode: "sticky" },
              },
            }),
            id: 4,
          },
        ],
        nextId: 5,
        revision: getState().revision + 1,
      });
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "reused-delegated", todo_id: 3, todo_token: "new-3" },
          { id: "reused-interrupted", todo_id: 4, todo_token: "new-4" },
        ],
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(cancelled, []);
      assert.equal(getState().tasks[0].metadata.delegation.status, "running");
      assert.equal(getState().tasks[1].metadata.delegation.status, "running");
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("settles stale delegation metadata when cancellation resolves immediately", async () => {
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
        tasks: [
          task("in_progress", {
            metadata: {
              preparation: approvedPreparation("new-token"),
              delegation: {
                status: "running",
                todoId: 1,
                todoToken: "old-token",
                subagentId: "stale-worker",
                subagentIds: ["stale-worker"],
              },
            },
          }),
        ],
        nextId: 2,
        revision: 1,
      });
      scheduler.activate({});
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "stale-worker", todo_id: 1, todo_token: "old-token" },
        ],
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(cancelled, [["stale-worker"]]);
      assert.equal(getState().tasks[0].metadata.delegation.status, "cancelled");
      assert.equal(getState().cancellationIntents?.length ?? 0, 0);
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("cancels more than 64 terminal owners as replayable one-worker intents", async () => {
    __resetState();
    const firstCalls = [];
    const unregister = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      async cancel(ids) {
        firstCalls.push([...ids]);
        throw new Error("retryable cancellation failure");
      },
    });
    const bus = new Bus();
    const adapter = new JobsAdapter(bus);
    const scheduler = new TodoScheduler(
      { events: bus, appendEntry() {}, sendMessage() {} },
      adapter,
      () => {},
    );
    const workerIds = Array.from(
      { length: 70 },
      (_, index) => `terminal-worker-${index}`,
    );
    try {
      commitState({
        tasks: [
          task("completed", {
            metadata: {
              preparation: approvedPreparation("terminal-token"),
              delegation: {
                status: "running",
                todoId: 1,
                todoToken: "terminal-token",
                subagentId: workerIds[0],
                subagentIds: workerIds.slice(0, 64),
                cancellationIds: workerIds.slice(64),
              },
            },
          }),
        ],
        nextId: 2,
        revision: 1,
      });
      scheduler.activate({});
      assert.ok(firstCalls.length >= 70);
      assert.deepEqual(new Set(firstCalls.flat()), new Set(workerIds));
      assert.equal(
        getState().tasks[0].metadata.delegation.subagentIds.length,
        64,
      );
      assert.equal(
        getState().tasks[0].metadata.delegation.cancellationIds.length,
        6,
      );
      assert.equal(
        (getState().cancellationIntents?.length ?? 0) +
          (getState().cancellationOverflow?.length ?? 0),
        70,
      );
      scheduler.dispose();
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
    const replayCalls = [];
    const unregisterReplay = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      async cancel(ids) {
        replayCalls.push([...ids]);
      },
    });
    const replayBus = new Bus();
    const replayAdapter = new JobsAdapter(replayBus);
    const replayScheduler = new TodoScheduler(
      { events: replayBus, appendEntry() {}, sendMessage() {} },
      replayAdapter,
      () => {},
    );
    try {
      replayScheduler.activate({});
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(replayCalls.length, 70);
      assert.deepEqual(replayCalls.flat().sort(), [...workerIds].sort());
      assert.equal(getState().tasks[0].metadata.delegation.status, "cancelled");
      assert.equal(getState().cancellationIntents?.length ?? 0, 0);
      assert.equal(getState().cancellationOverflow?.length ?? 0, 0);
    } finally {
      replayScheduler.dispose();
      replayAdapter.dispose();
      unregisterReplay();
    }
  });

  it("settles replayed legacy singular and cancellationIds delegation owners", async () => {
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
      { appendEntry() {}, sendMessage() {} },
      adapter,
      () => {},
    );
    try {
      commitState({
        tasks: [
          task("in_progress", {
            metadata: {
              preparation: approvedPreparation("legacy-token"),
              delegation: {
                status: "cancelling",
                todoId: 1,
                todoToken: "legacy-token",
                cancellationGeneration: 1,
                subagentId: "legacy-worker",
                cancellationIds: ["legacy-worker"],
              },
            },
          }),
        ],
        nextId: 2,
        revision: 1,
        cancellationIntents: [
          {
            kind: "delegation",
            taskId: 1,
            token: "legacy-token",
            ids: ["legacy-worker"],
            generation: 1,
            attempts: 0,
          },
        ],
      });
      scheduler.activate({});
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(cancelled, [["legacy-worker"]]);
      const delegation = getState().tasks[0].metadata.delegation;
      assert.equal(delegation.status, "cancelled");
      assert.equal(delegation.subagentId, undefined);
      assert.equal(delegation.cancellationIds, undefined);
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("unions disjoint delegation worker fields through protection, cancellation, and settlement", async () => {
    __resetState();
    const cancelled = [];
    const resolvers = [];
    const unregister = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      async cancel(ids) {
        cancelled.push([...ids]);
        return new Promise((resolve) => resolvers.push(resolve));
      },
    });
    const bus = new Bus();
    const adapter = new JobsAdapter(bus);
    const scheduler = new TodoScheduler(
      { events: bus, appendEntry() {}, sendMessage() {} },
      adapter,
      () => {},
    );
    const workerIds = [
      "worker-subagent-list",
      "worker-cancellation-list",
      "worker-singular",
    ];
    try {
      commitState({
        tasks: [
          task("in_progress", {
            metadata: {
              preparation: approvedPreparation("union-token"),
              delegation: {
                status: "running",
                todoId: 1,
                todoToken: "union-token",
                subagentIds: [workerIds[0]],
                cancellationIds: [workerIds[1]],
                subagentId: workerIds[2],
              },
            },
          }),
        ],
        nextId: 2,
        revision: 1,
      });
      scheduler.activate({});
      commitState({
        ...getState(),
        tasks: [
          {
            ...getState().tasks[0],
            status: "completed",
            result: "done",
            review: approvedReview(),
          },
        ],
        revision: getState().revision + 1,
      });
      scheduler.stateChanged(false);
      for (
        let attempt = 0;
        attempt < 20 && cancelled.length < workerIds.length;
        attempt++
      )
        await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(cancelled.flat().sort(), workerIds.slice().sort());
      const retained = getState().tasks[0].metadata.delegation;
      assert.equal(retained.status, "cancelling");
      assert.deepEqual(retained.subagentIds, [workerIds[0]]);
      assert.deepEqual(
        [
          ...(retained.subagentIds ?? []),
          ...(retained.cancellationIds ?? []),
          ...(retained.subagentId ? [retained.subagentId] : []),
        ].sort(),
        workerIds.slice().sort(),
      );
      assert.equal(
        (getState().cancellationIntents?.length ?? 0) +
          (getState().cancellationOverflow?.length ?? 0),
        workerIds.length,
      );
      for (const resolve of resolvers) resolve();
      for (
        let attempt = 0;
        attempt < 30 &&
        getState().tasks[0].metadata.delegation.status !== "cancelled";
        attempt++
      )
        await new Promise((resolve) => setImmediate(resolve));
      assert.equal(getState().tasks[0].metadata.delegation.status, "cancelled");
      assert.equal(
        getState().tasks[0].metadata.delegation.subagentId,
        undefined,
      );
      assert.equal(
        getState().tasks[0].metadata.delegation.cancellationIds,
        undefined,
      );
      assert.equal(
        (getState().cancellationIntents?.length ?? 0) +
          (getState().cancellationOverflow?.length ?? 0),
        0,
      );
      assert.deepEqual(cancelled.flat().sort(), workerIds.slice().sort());
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("records the newly authorized worker and compares delegation IDs as a set", () => {
    __resetState();
    const adapter = new JobsAdapter(new Bus());
    const scheduler = new TodoScheduler(
      { appendEntry() {}, sendMessage() {} },
      adapter,
      () => {},
    );
    try {
      commitState({
        tasks: [
          task("pending", {
            metadata: {
              preparation: approvedPreparation("authorize-order-token"),
              orchestrator: { mode: "sticky" },
              delegation: {
                status: "running",
                todoId: 1,
                todoToken: "authorize-order-token",
                subagentIds: ["worker-old", "worker-existing"],
                subagentId: "worker-old",
              },
            },
          }),
        ],
        nextId: 2,
        revision: 1,
      });
      scheduler.authorizePackageAssignment(
        1,
        "authorize-order-token",
        "worker-new",
        currentExecutionTarget.path,
        currentTargetBinding,
      );
      const delegation = getState().tasks[0].metadata.delegation;
      assert.equal(delegation.subagentId, "worker-new");
      assert.deepEqual(
        new Set(delegation.subagentIds),
        new Set(["worker-old", "worker-existing", "worker-new"]),
      );
    } finally {
      scheduler.dispose();
      adapter.dispose();
    }
  });

  it("rejects package assignment for every non-execution task status", () => {
    __resetState();
    const adapter = new JobsAdapter(new Bus());
    const scheduler = new TodoScheduler(
      { appendEntry() {}, sendMessage() {} },
      adapter,
      () => {},
    );
    try {
      scheduler.activate({});
      for (const [index, status] of [
        "waiting:user",
        "waiting:jobs",
        "completed",
        "deleted",
      ].entries()) {
        const id = index + 1;
        commitState({
          tasks: [
            {
              ...task(status, {
                metadata: {
                  preparation: approvedPreparation(`status-${id}`),
                  orchestrator: { mode: "sticky" },
                },
                ...(status === "completed" || status === "deleted"
                  ? {
                      result: "done",
                      evidence: ["verified"],
                      review: approvedReview(),
                    }
                  : {}),
                ...(status === "waiting:user"
                  ? { wait: { kind: "user", questions: ["answer"] } }
                  : status === "waiting:jobs"
                    ? {
                        wait: {
                          kind: "jobs",
                          jobIds: ["job-1"],
                          mode: "all",
                          deadline: Date.now() + 10_000,
                          settled: {},
                        },
                      }
                    : {}),
              }),
              id,
            },
          ],
          nextId: id + 1,
          revision: getState().revision + 1,
        });
        assert.match(
          assignmentError(scheduler, id, `status-${id}`),
          /ready matching/,
        );
        assert.throws(
          () =>
            scheduler.authorizePackageAssignment(
              id,
              `status-${id}`,
              `worker-${id}`,
              currentExecutionTarget.path,
              currentTargetBinding,
            ),
          /ownership or approval changed/,
        );
      }
      for (const status of ["pending", "in_progress"]) {
        commitState({
          tasks: [
            task(status, {
              metadata: {
                preparation: approvedPreparation("eligible"),
                orchestrator: { mode: "sticky" },
              },
            }),
          ],
          nextId: 2,
          revision: getState().revision + 1,
        });
        assert.equal(assignmentError(scheduler, 1, "eligible"), undefined);
      }
    } finally {
      scheduler.dispose();
      adapter.dispose();
    }
  });

  it("does not churn a migrated prepared state on repeated state changes", () => {
    __resetState();
    const question = "TODO #1 prepared plan approval";
    commitState({
      tasks: [
        task("waiting:user", {
          wait: { kind: "user", questions: [question] },
          metadata: {
            preparation: {
              status: "ready",
              approval: "awaiting_approval",
              approvalQuestion: question,
              approvalRequired: true,
              token: "stable-token",
              analysisCwd: currentExecutionTarget.path,
              analysisCwdIdentity: currentExecutionTarget.identity,
            },
          },
        }),
      ],
      nextId: 2,
      revision: 7,
    });
    let snapshots = 0;
    const adapter = new JobsAdapter(new Bus());
    const scheduler = new TodoScheduler(
      {
        appendEntry() {
          snapshots++;
        },
        sendMessage() {},
      },
      adapter,
      () => {},
    );
    try {
      scheduler.activate({});
      const before = getState();
      scheduler.stateChanged(false);
      scheduler.stateChanged(false);
      assert.equal(getState(), before);
      assert.equal(getState().revision, 8);
      assert.equal(snapshots, 1);
    } finally {
      scheduler.dispose();
      adapter.dispose();
    }
  });

  it("rejects a direct target despite a sticky sibling before dispatch body", async () => {
    __resetState();
    commitState({
      tasks: [
        task("pending", {
          metadata: {
            preparation: approvedPreparation("direct-token"),
            orchestrator: { mode: "direct", requiresOrchestration: false },
          },
        }),
        {
          ...task("pending", {
            metadata: {
              preparation: approvedPreparation("sticky-token"),
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
    const unregister = registerPackageAssignmentGate(
      ({ todoId, todoToken }) => assignmentError(scheduler, todoId, todoToken),
      () => undefined,
      () => undefined,
    );
    const bodies = { manager: 0, spawn: 0, cancel: 0 };
    try {
      assert.match(
        assignmentError(scheduler, 1, "direct-token"),
        /target TODO is direct.*Execute it in the parent/,
      );
      assert.equal(assignmentError(scheduler, 2, "sticky-token"), undefined);
      await assert.rejects(
        spawnPackageAssignment(
          {
            todoId: 1,
            todoToken: "direct-token",
            workerCwd: currentExecutionTarget.path,
            targetBinding: currentTargetBinding,
          },
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

  it("carries the validated execution cwd into direct continuations", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "todo-direct-target-"));
    const external = path.join(parent, "checkout");
    await mkdir(external);
    execFileSync("git", ["init", "-q", external]);
    const selected = resolveTodoReviewTarget(`external checkout "${external}"`);
    assert.equal(selected?.status, "selected");
    try {
      for (const [target, reviewTarget] of [
        [currentExecutionTarget.path, undefined],
        [selected.path, selected],
      ]) {
        __resetState();
        const sent = [];
        commitState({
          tasks: [
            task("in_progress", {
              metadata: {
                preparation: {
                  ...approvedPreparation("direct-target-token"),
                  ...(reviewTarget ? { reviewTarget } : {}),
                  analysisCwd: target,
                  analysisCwdIdentity:
                    reviewTarget?.identity ?? currentExecutionTarget.identity,
                },
                orchestrator: { mode: "direct" },
              },
            }),
          ],
          nextId: 2,
          revision: 1,
        });
        const adapter = new JobsAdapter(new Bus());
        const scheduler = new TodoScheduler(
          {
            appendEntry() {},
            sendMessage(message) {
              sent.push(message);
            },
          },
          adapter,
          () => {},
        );
        try {
          scheduler.activate({ cwd: currentExecutionTarget.path });
          scheduler.onAgentEnd();
          assert.ok(
            sent.some((message) =>
              String(message.content).includes(
                `Execute in the validated target ${target}`,
              ),
            ),
          );
        } finally {
          scheduler.dispose();
          adapter.dispose();
        }
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("queues same-TODO spawn handshakes and retains concurrent disjoint package owners", async () => {
    __resetState();
    commitState({
      tasks: [
        task("pending", {
          metadata: {
            preparation: approvedPreparation("prep-secret"),
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
      ({ todoId, todoToken }) => assignmentError(scheduler, todoId, todoToken),
      ({ todoId, todoToken, subagentId }) =>
        scheduler.authorizePackageAssignment(
          todoId,
          todoToken,
          subagentId,
          currentExecutionTarget.path,
          currentTargetBinding,
        ),
      ({ todoId, todoToken, subagentId }, reason) =>
        scheduler.rollbackPackageAssignment(
          todoId,
          todoToken,
          subagentId,
          reason,
        ),
    );
    const request = {
      todoId: 1,
      todoToken: "prep-secret",
      workerCwd: currentExecutionTarget.path,
      targetBinding: currentTargetBinding,
    };
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

  it("cancels interrupted package workers when automation pauses", async () => {
    __resetState();
    commitState({
      tasks: [
        task("in_progress", {
          metadata: {
            preparation: approvedPreparation("prep-secret"),
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
    const cancelled = [];
    const unregister = registerBackgroundSubagentService({
      async run() {
        return { id: "unused", status: "done", output: "{}" };
      },
      async cancel(ids) {
        cancelled.push(...ids);
      },
    });
    const scheduler = new TodoScheduler(
      { events: bus, appendEntry() {}, sendMessage() {} },
      adapter,
      () => {},
    );
    try {
      scheduler.activate({});
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "worker-1", todo_id: 1, todo_token: "prep-secret" },
        ],
      });

      scheduler.pauseAutomation();
      await new Promise((resolve) => setImmediate(resolve));

      // Marking the owner interrupted is not enough — the worker keeps burning
      // capacity unless the service is told to cancel it.
      assert.deepEqual(cancelled, ["worker-1"]);
      assert.equal(getState().tasks[0].metadata.delegation.status, "cancelled");
    } finally {
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
            preparation: approvedPreparation("prep-secret"),
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
      ({ todoId, todoToken }) => assignmentError(scheduler, todoId, todoToken),
      ({ todoId, todoToken, subagentId }) =>
        scheduler.authorizePackageAssignment(
          todoId,
          todoToken,
          subagentId,
          currentExecutionTarget.path,
          currentTargetBinding,
        ),
      ({ todoId, todoToken, subagentId }, reason) =>
        scheduler.rollbackPackageAssignment(
          todoId,
          todoToken,
          subagentId,
          reason,
        ),
    );
    let started = false;
    try {
      const assigned = await spawnPackageAssignment(
        {
          todoId: 1,
          todoToken: "prep-secret",
          workerCwd: currentExecutionTarget.path,
          targetBinding: currentTargetBinding,
        },
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

  it("hydrates reload cancellation intent and authorizes explicit id reuse only after settlement", async () => {
    __resetState();
    let resolveCancel;
    const unregister = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      cancel() {
        return new Promise((resolve) => {
          resolveCancel = resolve;
        });
      },
    });
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
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getState().tasks[0].metadata.delegation.status, "cancelling");
    assert.match(
      assignmentError(scheduler, 1, "prep-secret"),
      /cancellation settles/,
    );
    assert.throws(
      () =>
        scheduler.authorizePackageAssignment(
          1,
          "prep-secret",
          "worker-1",
          currentExecutionTarget.path,
          currentTargetBinding,
        ),
      /ownership or approval changed/,
    );

    resolveCancel();
    await new Promise((resolve) => setImmediate(resolve));

    scheduler.authorizePackageAssignment(
      1,
      "prep-secret",
      "worker-1",
      currentExecutionTarget.path,
      currentTargetBinding,
    );
    bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
      delegations: [{ id: "worker-1", todo_id: 1, todo_token: "prep-secret" }],
    });
    assert.equal(getState().tasks[0].metadata.delegation.status, "running");
    scheduler.dispose();
    adapter.dispose();
    unregister();
  });

  it("blocks replacement while a replayed running delegation cancellation is pending", async () => {
    __resetState();
    const pending = [];
    const unregister = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      cancel(ids) {
        pending.push({ ids: [...ids], resolve: undefined });
        return new Promise((resolve) => {
          pending.at(-1).resolve = resolve;
        });
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
        tasks: [owned()],
        nextId: 2,
        revision: 1,
        orchestrator: { setting: "auto", sticky: true },
      });
      scheduler.activate({});
      assert.deepEqual(
        pending.map((entry) => entry.ids),
        [["worker-1"]],
      );
      assert.equal(
        getState().tasks[0].metadata.delegation.status,
        "cancelling",
      );
      assert.match(
        assignmentError(scheduler, 1, "prep-secret"),
        /cancellation settles/,
      );
      assert.throws(
        () =>
          scheduler.authorizePackageAssignment(
            1,
            "prep-secret",
            "replacement",
            currentExecutionTarget.path,
            currentTargetBinding,
          ),
        /ownership or approval changed/,
      );
      pending[0].resolve();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(getState().tasks[0].metadata.delegation.status, "cancelled");
      scheduler.authorizePackageAssignment(
        1,
        "prep-secret",
        "replacement",
        currentExecutionTarget.path,
        currentTargetBinding,
      );
      assert.equal(getState().tasks[0].metadata.delegation.status, "running");
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("admits terminal delegation cancellation into overflow after primary capacity", async () => {
    __resetState();
    let resolveCancel;
    const unregister = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      cancel(ids) {
        assert.deepEqual(ids, ["worker-1"]);
        return new Promise((resolve) => {
          resolveCancel = resolve;
        });
      },
    });
    const primary = Array.from({ length: 256 }, (_, index) => ({
      kind: "delegation",
      taskId: index + 100,
      token: `primary-${index}`,
      ids: [`primary-worker-${index}`],
      generation: 1,
      attempts: 0,
    }));
    const overflow = Array.from({ length: 255 }, (_, index) => ({
      kind: "preparation",
      taskId: index + 400,
      token: `overflow-${index}`,
      ids: [`overflow-worker-${index}`],
      generation: 1,
      attempts: 0,
      workerGeneration: 1,
    }));
    const bus = new Bus();
    const adapter = new JobsAdapter(bus);
    const scheduler = new TodoScheduler(
      { events: bus, appendEntry() {}, sendMessage() {} },
      adapter,
      () => {},
    );
    try {
      commitState({
        tasks: [owned("completed")],
        nextId: 2,
        revision: 1,
        cancellationIntents: primary,
        cancellationOverflow: overflow,
      });
      scheduler.activate({});
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(getState().cancellationIntents?.length, 256);
      assert.equal(getState().cancellationOverflow?.length, 256);
      assert.deepEqual(getState().cancellationOverflow?.at(-1).ids, [
        "worker-1",
      ]);
      resolveCancel();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("clears the combined capacity fault after one overflow settlement", async () => {
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
        kind: "preparation",
        taskId: index + 400,
        token: `overflow-${index}`,
        ids: [`overflow-worker-${index}`],
        generation: 1,
        attempts: 0,
        workerGeneration: 1,
      })),
      {
        kind: "delegation",
        taskId: 1,
        token: "prep-secret",
        ids: ["worker-1"],
        generation: 1,
        attempts: 0,
      },
    ];
    const bus = new Bus();
    const adapter = new JobsAdapter(bus);
    const scheduler = new TodoScheduler(
      { events: bus, appendEntry() {}, sendMessage() {} },
      adapter,
      () => {},
    );
    try {
      commitState({
        tasks: [owned("completed")],
        nextId: 2,
        revision: 1,
        cancellationIntents: primary,
        cancellationOverflow: overflow,
        cancellationCapacityError: CANCELLATION_CAPACITY_ERROR,
      });
      scheduler.activate({});
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(cancelled, [["worker-1"]]);
      assert.equal(
        getState().cancellationIntents.length +
          getState().cancellationOverflow.length,
        MAX_CANCELLATION_INTENTS * 2 - 1,
      );
      assert.equal(getState().cancellationCapacityError, undefined);
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("re-adopts a stale-generation owner after rejection and retries after activation", async () => {
    __resetState();
    const requests = [];
    const unregister = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      cancel(ids) {
        requests.push([...ids]);
        if (requests.length === 1)
          return Promise.reject(new Error("old generation"));
        return new Promise(() => {});
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
      commitState({ tasks: [owned("completed")], nextId: 2, revision: 1 });
      scheduler.activate({});
      scheduler.activate({});
      await new Promise((resolve) => setTimeout(resolve, 45));
      assert.deepEqual(requests, [["worker-1"], ["worker-1"]]);
      assert.equal(getState().cancellationIntents?.[0].attempts, 2);
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("discards an old-session rejection without a handoff or current owner proof", async () => {
    __resetState();
    let rejectFirst;
    const firstCancellation = new Promise((_resolve, reject) => {
      rejectFirst = reject;
    });
    const unregister = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      async cancel() {
        return firstCancellation;
      },
    });
    const bus = new Bus();
    const adapter = new JobsAdapter(bus);
    const schedulerPi = { events: bus, appendEntry() {}, sendMessage() {} };
    const scheduler = new TodoScheduler(schedulerPi, adapter, () => {});
    try {
      commitState({ tasks: [owned("completed")], nextId: 2, revision: 1 });
      scheduler.activate({});
      await new Promise((resolve) => setImmediate(resolve));
      replaceState({ tasks: [], nextId: 1, revision: 2 });
      scheduler.activate({});
      rejectFirst(new Error("old-session rejection"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(getState().cancellationIntents?.length ?? 0, 0);
      assert.equal(getState().cancellationOverflow?.length ?? 0, 0);
      assert.equal(getState().cancellationQuarantine?.length ?? 0, 0);
      assert.equal(
        reservedCancellationWorkerIds(schedulerPi).has("worker-1"),
        false,
      );
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("recovers interrupted and intent-less cancelling delegations before reuse", async () => {
    __resetState();
    const pending = [];
    const unregister = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      cancel(ids) {
        pending.push({ ids: [...ids], resolve: undefined });
        return new Promise((resolve) => {
          pending.at(-1).resolve = resolve;
        });
      },
    });
    const makeScheduler = () => {
      const bus = new Bus();
      const adapter = new JobsAdapter(bus);
      const scheduler = new TodoScheduler(
        { events: bus, appendEntry() {}, sendMessage() {} },
        adapter,
        () => {},
      );
      return { scheduler, adapter };
    };
    try {
      for (const status of ["interrupted", "cancelling"]) {
        const { scheduler, adapter } = makeScheduler();
        commitState({
          tasks: [owned("in_progress", status)],
          nextId: 2,
          revision: 1,
        });
        scheduler.activate({});
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(pending.at(-1).ids, ["worker-1"]);
        assert.equal(
          getState().tasks[0].metadata.delegation.status,
          "cancelling",
        );
        assert.match(
          assignmentError(scheduler, 1, "prep-secret"),
          /cancellation settles/,
        );
        pending.at(-1).resolve();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(
          getState().tasks[0].metadata.delegation.status,
          "cancelled",
        );
        scheduler.dispose();
        adapter.dispose();
      }
    } finally {
      unregister();
    }
  });

  it("stops automatic delegation cancellation at three attempts and re-arms in the same activation", async () => {
    __resetState();
    let calls = 0;
    const unregister = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      async cancel() {
        calls++;
        throw new Error("permanent delegation cancellation failure");
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
      commitState({ tasks: [owned("completed")], nextId: 2, revision: 1 });
      for (let activation = 0; activation < 4; activation++) {
        scheduler.activate({});
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(calls, 3);
      assert.equal(getState().cancellationIntents[0].attempts, 3);
      assert.equal(scheduler.rearmCancellationIntents(), true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls, 4);
      assert.equal(getState().cancellationIntents[0].attempts, 1);
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
  });

  it("replays and retries more than 64 failed delegation intents without eviction", async () => {
    __resetState();
    const requests = [];
    const unregister = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      async cancel(ids) {
        requests.push([...ids]);
        throw new Error("provider unavailable");
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
      const tasks = Array.from({ length: 65 }, (_, index) => ({
        ...owned("completed"),
        id: index + 1,
        metadata: {
          ...owned("completed").metadata,
          preparation: approvedPreparation(`token-${index}`),
          delegation: {
            status: "cancelling",
            subagentId: `worker-${index}`,
            subagentIds: [`worker-${index}`],
            todoId: index + 1,
            todoToken: `token-${index}`,
            cancellationGeneration: 1,
            cancellationIds: [`worker-${index}`],
          },
        },
      }));
      commitState({
        tasks,
        nextId: 66,
        revision: 1,
        cancellationIntents: tasks.map((candidate, index) => ({
          kind: "delegation",
          taskId: candidate.id,
          token: `token-${index}`,
          ids: [`worker-${index}`],
          generation: 1,
          attempts: 2,
          error: "previous provider failure",
        })),
      });
      scheduler.activate({});
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(requests.length, 65);
      assert.equal(getState().cancellationIntents?.length, 65);
      assert.equal(getState().cancellationIntents?.[0].attempts, 3);
      assert.equal(getState().cancellationIntents?.at(-1).ids[0], "worker-64");
      assert.equal(getState().cancellationCapacityError, undefined);
    } finally {
      scheduler.dispose();
      adapter.dispose();
      unregister();
    }
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
    assert.equal(getState().tasks[0].metadata.delegation.status, "cancelling");
    bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
      delegations: [{ id: "worker-1", todo_id: 1, todo_token: "prep-secret" }],
    });
    bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, { delegations: [] });
    assert.equal(getState().tasks[0].metadata.delegation.status, "cancelling");
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
      result: "done",
      evidence: ["verified"],
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
      tasks: [
        {
          ...getState().tasks[0],
          status: "completed",
          result: "done",
          evidence: ["verified"],
          review: approvedReview(),
        },
      ],
      revision: getState().revision + 1,
    });
    scheduler.stateChanged();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(cancelled, [["worker-1"]]);
    assert.equal(getState().tasks[0].metadata.delegation.status, "cancelled");
    assert.equal(
      sent.filter(
        (message) => message.customType === "rpiv-todo:completion-report",
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
        (message) => message.customType === "rpiv-todo:completion-report",
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
      assert.deepEqual(requests, [["worker-1"], ["worker-z"], ["worker-a"]]);
      assert.equal(
        requests.filter((ids) => ids.includes("worker-1")).length,
        1,
      );
      let delegation = getState().tasks[0].metadata.delegation;
      assert.equal(delegation.cancellationGeneration, 3);
      assert.deepEqual(delegation.subagentIds, ["worker-1"]);
      assert.deepEqual(delegation.cancellationIds, ["worker-a", "worker-z"]);
      assert.deepEqual(
        [
          ...(getState().cancellationIntents ?? []),
          ...(getState().cancellationOverflow ?? []),
        ]
          .filter((intent) => intent.ids.includes("worker-1"))
          .map((intent) => intent.generation),
        [1],
      );
      assert.equal(applyTaskMutation(getState(), "clear", {}).op.kind, "error");

      pending[0].reject(new Error("stale failure"));
      pending[1].resolve();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        requests.filter((ids) => ids.includes("worker-1")).length,
        1,
      );
      delegation = getState().tasks[0].metadata.delegation;
      assert.equal(delegation.status, "cancelling");
      assert.equal(delegation.cancellationGeneration, 3);
      assert.equal(delegation.cancellationError, undefined);
      assert.equal(hasCompletedBatch(), false);
      assert.equal(sent.length, 0);
      assert.equal(applyTaskMutation(getState(), "clear", {}).op.kind, "error");

      pending[2].resolve();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        getState().tasks[0].metadata.delegation.status,
        "cancelling",
      );
      scheduler.activate({});
      pending.at(-1).resolve();
      await new Promise((resolve) => setImmediate(resolve));
      delegation = getState().tasks[0].metadata.delegation;
      assert.equal(delegation.status, "cancelled");
      assert.equal(delegation.cancellationGeneration, 3);
      assert.equal(hasCompletedBatch(), true);
      assert.equal(
        sent.filter(
          ({ customType }) => customType === "rpiv-todo:completion-report",
        ).length,
        1,
      );
      assert.equal(
        [
          ...(getState().cancellationIntents ?? []),
          ...(getState().cancellationOverflow ?? []),
          ...(getState().cancellationQuarantine ?? []),
        ].some((intent) => intent.ids.includes("worker-1")),
        false,
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
        preparation: approvedPreparation("prep-deleted"),
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
        for (const candidate of snapshot.data.tasks ??
          snapshot.data.upsertedTasks ??
          [])
          persisted.set(candidate.id, candidate);
      assert.deepEqual(
        [...persisted.values()].map(
          (candidate) => candidate.metadata.delegation.status,
        ),
        ["cancelled", "cancelled"],
      );
      assert.equal(
        sent.filter(
          (message) => message.customType === "rpiv-todo:completion-report",
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
          (message) => message.customType === "rpiv-todo:completion-report",
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
      assert.equal(delegation.subagentIds, undefined);
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
          result: "done",
          evidence: ["verified"],
          review: approvedReview(),
          metadata: {
            ...current.metadata,
            delegation: { status: "cancelled" },
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
      ["rpiv-todo:completion-report"],
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
      const approvedAdded = {
        ...added,
        tasks: added.tasks.map((candidate) =>
          candidate.id === 1
            ? {
                ...candidate,
                metadata: {
                  ...candidate.metadata,
                  preparation: {
                    ...candidate.metadata.preparation,
                    status: "ready",
                    approvalRequired: false,
                    approval: "granted",
                    analysisCwd: currentExecutionTarget.path,
                    analysisCwdIdentity: currentExecutionTarget.identity,
                    hostAssignment: {
                      source: "host",
                      version: 1,
                      token: addToken,
                      targetBinding: currentTargetBinding,
                    },
                  },
                },
              }
            : candidate,
        ),
      };
      commitState(approvedAdded);
      scheduler.stateChanged();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(cancelled, [["worker-1"]]);
      bus.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
        delegations: [
          { id: "worker-1", todo_id: 1, todo_token: "prep-secret" },
        ],
      });
      assert.equal(getState().tasks[0].metadata.delegation, undefined);

      scheduler.authorizePackageAssignment(
        1,
        addToken,
        "worker-2",
        currentExecutionTarget.path,
        currentTargetBinding,
      );
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

  it("queues one recovery turn per failed preparation incarnation", () => {
    __resetState();
    commitState({
      tasks: [
        task("pending", {
          metadata: {
            preparation: {
              status: "failed",
              code: "preparation_failed",
              token: "failed-preparation-1",
              version: 1,
              error: "fetch failed",
            },
          },
        }),
      ],
      nextId: 2,
      revision: 1,
      orchestrator: { setting: "auto", sticky: true },
    });
    const sent = [];
    const adapter = new JobsAdapter(new Bus());
    const pi = {
      appendEntry() {},
      sendMessage(message) {
        sent.push(message);
      },
    };
    const exercise = (scheduler) => {
      scheduler.activate({});
      for (let turn = 0; turn < 3; turn++) {
        scheduler.onAgentStart();
        scheduler.recordToolProgress();
        scheduler.onAgentSettled({});
      }
    };
    const recoveryTurns = () =>
      sent.filter(({ content }) =>
        content.includes("preparation failed after two attempts"),
      ).length;
    const first = new TodoScheduler(pi, adapter, () => {});
    try {
      exercise(first);
      assert.equal(recoveryTurns(), 1);
      exercise(first);
      assert.equal(
        recoveryTurns(),
        2,
        "each activation gets one recovery turn",
      );

      const errorChanged = getState();
      commitState({
        ...errorChanged,
        revision: errorChanged.revision + 1,
        tasks: errorChanged.tasks.map((candidate) =>
          candidate.id === 1
            ? {
                ...candidate,
                metadata: {
                  ...candidate.metadata,
                  preparation: {
                    ...candidate.metadata.preparation,
                    error: "different fetch failure",
                  },
                },
              }
            : candidate,
        ),
      });
      exercise(first);
      assert.equal(
        recoveryTurns(),
        3,
        "same incarnation gets one turn in the new activation",
      );

      const newIncarnation = getState();
      commitState({
        ...newIncarnation,
        revision: newIncarnation.revision + 1,
        tasks: newIncarnation.tasks.map((candidate) =>
          candidate.id === 1
            ? {
                ...candidate,
                metadata: {
                  ...candidate.metadata,
                  preparation: {
                    ...candidate.metadata.preparation,
                    token: "failed-preparation-2",
                    version: 2,
                  },
                },
              }
            : candidate,
        ),
      });
      exercise(first);
      assert.equal(
        recoveryTurns(),
        4,
        "new token/version gets one recovery turn",
      );
      exercise(first);
      assert.equal(recoveryTurns(), 5, "new activation gets one recovery turn");
      first.dispose();
      const reloaded = new TodoScheduler(pi, adapter, () => {});
      try {
        exercise(reloaded);
        assert.equal(recoveryTurns(), 6, "reload may remind once");
        exercise(reloaded);
        assert.equal(recoveryTurns(), 7, "reload must not restart the loop");
      } finally {
        reloaded.dispose();
      }
    } finally {
      first.dispose();
      adapter.dispose();
    }
  });

  it("queues interrupted preparation recovery once per activation", async () => {
    __resetState();
    commitState({
      tasks: [
        task("pending", {
          metadata: {
            preparation: {
              status: "failed",
              code: "preparation_interrupted",
              token: "interrupted-preparation-1",
              version: 1,
              error: "TODO preparation interrupted by session reload",
            },
          },
        }),
      ],
      nextId: 2,
      revision: 1,
      orchestrator: { setting: "auto", sticky: true },
    });
    const sent = [];
    let dispatchAttempts = 0;
    const adapter = new JobsAdapter(new Bus());
    const scheduler = new TodoScheduler(
      {
        appendEntry() {},
        sendMessage(message) {
          dispatchAttempts++;
          if (dispatchAttempts === 1)
            throw new Error("transient dispatch failure");
          sent.push(message);
        },
      },
      adapter,
      () => {},
    );
    const recoveryTurns = () =>
      sent.filter(({ content }) =>
        content.includes("preparation was interrupted by session reload"),
      ).length;
    try {
      scheduler.activate({});
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(dispatchAttempts, 2, "failed dispatch must retry");
      for (let turn = 0; turn < 5; turn++) {
        scheduler.onAgentStart();
        scheduler.recordToolProgress();
        scheduler.onAgentSettled({});
      }
      assert.equal(recoveryTurns(), 1);

      scheduler.activate({});
      scheduler.onAgentStart();
      scheduler.recordToolProgress();
      scheduler.onAgentSettled({});
      assert.equal(recoveryTurns(), 2, "reload may remind once");
    } finally {
      scheduler.dispose();
      adapter.dispose();
    }
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
