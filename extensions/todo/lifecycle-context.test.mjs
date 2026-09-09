import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  bindChildSessionExtensions,
  excludeSessionOwnedChildExtensions,
  shutdownAndDisposeChildSession,
} from "../../vendor/pi-tools/extensions/shared/child-session.ts";
import {
  acquirePackageAssignmentLease,
  packageAssignmentError,
  registerPackageAssignmentGate,
} from "../../vendor/pi-tools/extensions/shared/assignment-gate-protocol.ts";
import todoExtension, { awakenedQueuedPreparations } from "./index.ts";
import { resolveTodoReviewTarget } from "./enrichment.ts";
import { TodoScheduler } from "./scheduler.ts";
import { __resetState } from "./todo.ts";
import { commitState, getState } from "./state/store.ts";
import { publicTodoState } from "./state/inbox.ts";
import { createTodoSnapshot, TODO_SNAPSHOT_TYPE } from "./state/replay.ts";
import {
  CANCELLATION_CAPACITY_ERROR,
  CANCELLATION_QUARANTINE_ERROR,
} from "./state/state.ts";
import { registerBackgroundSubagentService } from "../../vendor/pi-tools/extensions/shared/background-subagent-protocol.ts";
import { SUBAGENT_DELEGATION_STATE_CHANNEL } from "../../vendor/pi-tools/extensions/shared/subagent-wait-protocol.ts";
import { AUTOMATION_PAUSE_CHANNEL } from "../../vendor/pi-tools/extensions/shared/automation-pause-protocol.ts";

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

const packageRequest = (todoId, todoToken) => ({
  todoId,
  todoToken,
  workerCwd: process.cwd(),
  targetBinding: "a".repeat(64),
});
const currentTarget = resolveTodoReviewTarget(
  `external checkout "${process.cwd()}"`,
);

function extensionHarness(startBranch = [], startContext, options = {}) {
  const lifecycle = new Map();
  const messages = [];
  let syntheticToolCallId = 0;
  const pi = {
    events: new Bus(),
    on(name, handler) {
      const handlers = lifecycle.get(name) ?? [];
      handlers.push(handler);
      lifecycle.set(name, handlers);
    },
    registerTool() {},
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    appendEntry(type, data) {
      options.appendEntry?.(type, data);
    },
    sendMessage(message, options) {
      messages.push({ message, options });
    },
  };
  const commands = new Map();
  todoExtension(pi);
  return {
    start: (context = startContext) =>
      lifecycle.get("session_start")[0](
        {},
        context ?? {
          mode: "print",
          hasUI: false,
          sessionManager: { getBranch: () => startBranch },
        },
      ),
    lifecycle,
    shutdown: () => lifecycle.get("session_shutdown")[0](),
    commands,
    messages,
    events: pi.events,
    emit: async (name, event, ctx) => {
      const details = event.result?.details;
      const syntheticAnswer =
        details &&
        typeof details === "object" &&
        !Array.isArray(details) &&
        typeof details.question === "string" &&
        details.question.trim() &&
        (details.cancelled === undefined ||
          typeof details.cancelled === "boolean") &&
        (details.explanationRequested === undefined ||
          typeof details.explanationRequested === "boolean") &&
        ((typeof details.answer === "string" && details.answer.trim()) ||
          (details.answer === null &&
            Array.isArray(details.answers) &&
            details.answers.length > 0 &&
            details.answers.every(
              (answer) => typeof answer === "string" && answer.trim(),
            ))) &&
        (details.answers === undefined || Array.isArray(details.answers));
      if (
        name === "tool_execution_end" &&
        event.toolName === "ask_user" &&
        event.toolCallId === undefined &&
        syntheticAnswer
      ) {
        const toolCallId = `synthetic-ask-${++syntheticToolCallId}`;
        await Promise.all(
          (lifecycle.get("tool_execution_start") ?? []).map((handler) =>
            handler(
              {
                toolCallId,
                toolName: "ask_user",
                args: { question: event.result?.details?.question },
              },
              ctx,
            ),
          ),
        );
        event = { ...event, toolCallId };
      }
      return Promise.all(
        (lifecycle.get(name) ?? []).map((handler) => handler(event, ctx)),
      );
    },
  };
}

test("restarts queued preparation when a job wake makes its task executable", () => {
  const queued = (status, token = "prep-token") => ({
    id: 1,
    subject: "Verify after jobs",
    status,
    metadata: { preparation: { status: "queued", token } },
  });
  assert.deepEqual(
    awakenedQueuedPreparations(
      [queued("waiting:jobs")],
      [queued("pending")],
    ).map(({ id }) => id),
    [1],
  );
  assert.deepEqual(
    awakenedQueuedPreparations([queued("pending")], [queued("pending")]),
    [],
  );
  assert.deepEqual(
    awakenedQueuedPreparations(
      [queued("waiting:jobs", "old-token")],
      [queued("pending", "new-token")],
    ),
    [],
  );
});

test("does not report background TODO work as a Herdr user blocker", async () => {
  __resetState();
  const context = {
    mode: "tui",
    hasUI: false,
    cwd: process.cwd(),
    isIdle: () => true,
    ui: { setStatus() {} },
    sessionManager: { getBranch: () => [] },
  };
  const extension = extensionHarness([], context);
  const events = [];
  extension.events.on("herdr:blocked", (event) => events.push(event));
  await extension.start();
  for (const [revision, task] of [
    [
      1,
      {
        id: 1,
        subject: "Review in background",
        status: "completed",
        result: "done",
        evidence: ["verified"],
        review: {
          status: "pending",
          generation: 1,
          token: "review-token",
          completionRevision: 1,
          requestedAt: 1,
          reviewer: { id: "background-subagent", model: "luna" },
        },
      },
    ],
    [
      2,
      {
        id: 1,
        subject: "Preparation in background",
        status: "pending",
        metadata: {
          preparation: {
            status: "running",
            version: 1,
            token: "preparation-token",
            sourceRevision: 2,
          },
        },
      },
    ],
    [
      3,
      {
        id: 1,
        subject: "Jobs in background",
        status: "waiting:jobs",
        wait: {
          kind: "jobs",
          jobIds: ["job-1"],
          mode: "all",
          deadline: Date.now() + 60_000,
          settled: {},
          waitToken: "job-wait-token",
          registeredAt: Date.now(),
          generation: 1,
        },
      },
    ],
  ]) {
    commitState({ tasks: [task], nextId: 2, revision });
  }
  await extension.emit("agent_start", {}, context);
  await extension.emit("agent_settled", {}, context);
  await extension.shutdown();
  assert.deepEqual(events, []);
});

async function assertReplacementPreparationContext(lifecycleEvent) {
  const parent = await mkdtemp(
    path.join(tmpdir(), `todo-${lifecycleEvent}-context-`),
  );
  const oldCwd = path.join(parent, "old");
  const checkout = path.join(parent, "checkout");
  await mkdir(oldCwd, { recursive: true });
  await mkdir(checkout);
  execFileSync("git", ["init", "-q", checkout]);
  const canonicalCheckout = await realpath(checkout);
  const selected = resolveTodoReviewTarget(`external checkout "${checkout}"`);
  assert.equal(selected?.status, "selected");
  const question = "Approve the refreshed external plan";
  const state = {
    tasks: [
      {
        id: 1,
        subject: "Refresh external preparation",
        description: `Implement the external checkout "${checkout}"`,
        status: "waiting:user",
        wait: { kind: "user", questions: [question] },
        metadata: {
          preparation: {
            status: "awaiting_approval",
            version: 1,
            approval: "awaiting_approval",
            approvalRequired: true,
            approvalQuestion: question,
            token: "context-drift-token",
            classifier: { status: "ready" },
            reviewTarget: selected,
            analysisCwd: selected.path,
            analysisCwdIdentity: selected.identity,
          },
        },
      },
    ],
    nextId: 2,
    revision: 1,
  };
  const newRegistry = { name: `${lifecycleEvent}-new-registry` };
  const requests = [];
  const unregister = registerBackgroundSubagentService({
    async run(request) {
      requests.push(request);
      return request.title === "Classify TODO"
        ? {
            id: "classifier",
            status: "done",
            output: '{"requiresOrchestration":false,"signals":[]}',
          }
        : {
            id: "analyst",
            status: "done",
            output: JSON.stringify({
              status: "ready",
              summary: "Prepared",
              verifiedFacts: [],
              assumptions: [],
              affectedPaths: [],
              steps: ["Implement"],
              checks: [],
              questions: [],
              risks: [],
              sources: [],
            }),
          };
    },
  });
  const oldContext = {
    mode: "print",
    hasUI: false,
    cwd: oldCwd,
    isProjectTrusted: () => false,
    model: { provider: "old-provider", id: "old-model" },
    modelRegistry: { name: "old-registry" },
    sessionManager: { getBranch: () => [] },
  };
  const extension = extensionHarness([], oldContext);
  const newContext = {
    mode: "print",
    hasUI: false,
    cwd: canonicalCheckout,
    isProjectTrusted: () => true,
    model: { provider: "new-provider", id: "new-model" },
    modelRegistry: newRegistry,
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: TODO_SNAPSHOT_TYPE,
          data: createTodoSnapshot(state),
        },
      ],
    },
  };
  try {
    await extension.start();
    commitState(state);
    await rm(checkout, { recursive: true, force: true });
    await mkdir(checkout);
    execFileSync("git", ["init", "-q", checkout]);
    assert.notDeepEqual(
      resolveTodoReviewTarget(`external checkout "${checkout}"`),
      selected,
    );
    await extension.emit(lifecycleEvent, {}, newContext);
    for (let attempt = 0; attempt < 40 && requests.length < 1; attempt++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      requests.length >= 1,
      `preparation did not start after ${lifecycleEvent}`,
    );
    for (const request of requests) {
      assert.equal(request.parent.parentCwd, canonicalCheckout);
      assert.equal(request.parent.projectTrusted, true);
      assert.equal(request.parent.modelRegistry, newRegistry);
      assert.deepEqual(request.parent.inheritedModel, {
        provider: "new-provider",
        id: "new-model",
      });
    }
  } finally {
    await extension.shutdown();
    unregister();
    await rm(parent, { recursive: true, force: true });
  }
}

test("session compact installs the replacement preparation context before activation recovery", async () => {
  await assertReplacementPreparationContext("session_compact");
});

test("session tree installs the replacement preparation context before activation recovery", async () => {
  await assertReplacementPreparationContext("session_tree");
});

test("re-arms current-task preparation and delegation cancellation through /todo", async () => {
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
  const extension = extensionHarness();
  try {
    await extension.start();
    commitState({
      tasks: [
        {
          id: 1,
          subject: "Recover workers",
          status: "completed",
          metadata: {
            preparation: {
              status: "cancelled",
              token: "prep-current",
              cancellationToken: "prep-current",
              cancellationIds: ["prep-worker"],
              cancellationWorkerGeneration: 1,
            },
            delegation: {
              status: "cancelled",
              todoId: 1,
              todoToken: "delegation-current",
              cancellationIds: ["delegation-worker"],
              subagentIds: ["delegation-worker"],
              cancellationGeneration: 1,
            },
          },
        },
      ],
      nextId: 2,
      revision: 1,
      cancellationOverflow: [
        {
          kind: "preparation",
          taskId: 1,
          token: "prep-current",
          workerGeneration: 1,
          ids: ["prep-worker"],
          generation: 1,
          attempts: 3,
          error: "permanent",
        },
        {
          kind: "delegation",
          taskId: 1,
          token: "delegation-current",
          ids: ["delegation-worker"],
          generation: 1,
          attempts: 3,
          error: "permanent",
        },
      ],
    });
    const notices = [];
    const ctx = {
      hasUI: false,
      ui: {
        notify(text) {
          notices.push(text);
        },
      },
    };
    await extension.commands.get("todo").handler("rearm #1", ctx);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      notices.at(-1),
      "Re-armed cancellation for TODO #1; retrying now.",
    );
    assert.deepEqual(cancelled.map((ids) => ids[0]).sort(), [
      "delegation-worker",
      "prep-worker",
    ]);
    assert.equal(getState().cancellationIntents?.length ?? 0, 0);
    assert.equal(getState().cancellationOverflow?.length ?? 0, 0);

    await extension.commands.get("todo").handler("rearm #1", ctx);
    assert.equal(
      notices.at(-1),
      "TODO #1 has no pending cancellation to re-arm.",
    );
    await extension.commands.get("todo").handler("rearm #2", ctx);
    assert.equal(notices.at(-1), "TODO #2 was not found.");
    commitState({
      ...getState(),
      tasks: [
        {
          ...getState().tasks[0],
          status: "in_progress",
          metadata: {
            ...getState().tasks[0].metadata,
            preparation: {
              status: "ready",
              token: "new-token",
              approvalRequired: false,
              approval: "granted",
            },
            delegation: {
              status: "running",
              todoId: 1,
              todoToken: "new-token",
              subagentIds: ["current-worker"],
            },
          },
        },
      ],
      cancellationIntents: [
        {
          kind: "delegation",
          taskId: 1,
          token: "old-token",
          ids: ["stale-worker"],
          generation: 1,
          attempts: 3,
          error: "permanent",
        },
      ],
      revision: getState().revision + 1,
    });
    await extension.commands.get("todo").handler("rearm #1", ctx);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      notices.at(-1),
      "TODO #1 cancellation cannot be safely re-armed: ownership proof is unavailable.",
    );
    assert.equal(cancelled.flat().includes("stale-worker"), false);
    assert.equal(cancelled.flat().includes("current-worker"), false);
  } finally {
    await extension.shutdown();
    unregister();
  }
});

test("promotes replayed quarantine current owners before rearm dispatch", async () => {
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
  const extension = extensionHarness();
  const notices = [];
  try {
    await extension.start();
    commitState({
      tasks: [
        {
          id: 1,
          subject: "preparation owner",
          status: "in_progress",
          metadata: {
            preparation: {
              status: "failed",
              token: "prep-quarantine-token",
              cancellationIds: ["prep-quarantine-worker"],
              workerGeneration: 1,
            },
          },
        },
        {
          id: 2,
          subject: "delegation owner",
          status: "in_progress",
          metadata: {
            delegation: {
              status: "cancelling",
              todoId: 2,
              todoToken: "delegation-quarantine-token",
              subagentIds: ["delegation-quarantine-worker"],
              cancellationGeneration: 1,
            },
          },
        },
      ],
      nextId: 3,
      revision: 1,
      cancellationCapacityError: CANCELLATION_CAPACITY_ERROR,
      cancellationQuarantine: [
        {
          kind: "preparation",
          taskId: 1,
          token: "prep-quarantine-token",
          ids: ["prep-quarantine-worker"],
          generation: 1,
          attempts: 3,
          workerGeneration: 1,
          orphaned: true,
        },
        {
          kind: "delegation",
          taskId: 2,
          token: "delegation-quarantine-token",
          ids: ["delegation-quarantine-worker"],
          generation: 1,
          attempts: 3,
          orphaned: true,
        },
      ],
    });
    await extension.commands.get("todo").handler("rearm #1", {
      hasUI: false,
      ui: {
        notify(text) {
          notices.push(text);
        },
      },
    });
    await extension.commands.get("todo").handler("rearm #2", {
      hasUI: false,
      ui: {
        notify(text) {
          notices.push(text);
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      notices.at(-1),
      "Re-armed cancellation for TODO #2; retrying now.",
    );
    assert.deepEqual(cancelled.map((ids) => ids[0]).sort(), [
      "delegation-quarantine-worker",
      "prep-quarantine-worker",
    ]);
    assert.equal(getState().cancellationQuarantine?.length ?? 0, 0);
    assert.equal(getState().cancellationIntents?.length ?? 0, 0);
    assert.equal(getState().cancellationOverflow?.length ?? 0, 0);
  } finally {
    await extension.shutdown();
    unregister();
  }
});

test("does not re-arm stale primary or overflow cancellation incarnations", async () => {
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
  const extension = extensionHarness();
  const notices = [];
  try {
    await extension.start();
    commitState({
      tasks: [
        {
          id: 1,
          subject: "stale preparation",
          status: "in_progress",
          metadata: {
            preparation: {
              status: "failed",
              token: "new-prep",
              workerGeneration: 2,
              cancellationIds: ["new-prep-worker"],
            },
          },
        },
        {
          id: 2,
          subject: "stale delegation",
          status: "in_progress",
          metadata: {
            preparation: {
              status: "ready",
              token: "new-delegation",
              approvalRequired: false,
              approval: "granted",
            },
            delegation: {
              status: "cancelling",
              todoId: 2,
              todoToken: "new-delegation",
              cancellationGeneration: 2,
              cancellationIds: ["new-delegation-worker"],
            },
          },
        },
      ],
      nextId: 3,
      revision: 1,
      cancellationIntents: [
        {
          kind: "preparation",
          taskId: 1,
          token: "old-prep",
          workerGeneration: 1,
          ids: ["old-prep-worker"],
          generation: 1,
          attempts: 3,
          error: "permanent",
        },
      ],
      cancellationOverflow: [
        {
          kind: "delegation",
          taskId: 2,
          token: "old-delegation",
          generation: 1,
          ids: ["old-delegation-worker"],
          attempts: 3,
          error: "permanent",
        },
      ],
    });
    const before = JSON.stringify(getState());
    const ctx = {
      hasUI: false,
      ui: {
        notify(text) {
          notices.push(text);
        },
      },
    };
    await extension.commands.get("todo").handler("rearm #1", ctx);
    await extension.commands.get("todo").handler("rearm #2", ctx);
    assert.equal(JSON.stringify(getState()), before);
    assert.deepEqual(cancelled, []);
    assert.match(notices.at(-1), /ownership proof is unavailable/);
  } finally {
    await extension.shutdown();
    unregister();
  }
});

test("re-arms an exhausted missing-task orphan from durable queues", async () => {
  __resetState();
  const extension = extensionHarness();
  const notices = [];
  try {
    await extension.start();
    commitState({
      tasks: [],
      nextId: 1,
      revision: 1,
      cancellationIntents: [
        {
          kind: "delegation",
          taskId: 27,
          token: "orphan-token",
          ids: ["orphan-worker"],
          generation: 4,
          attempts: 3,
          orphaned: true,
          error: "permanent",
        },
      ],
    });
    const before = JSON.stringify(getState());
    await extension.commands.get("todo").handler("rearm #27", {
      hasUI: false,
      ui: {
        notify(text) {
          notices.push(text);
        },
      },
    });
    assert.equal(
      notices.at(-1),
      "TODO #27 cancellation cannot be safely re-armed: ownership proof is unavailable.",
    );
    assert.equal(JSON.stringify(getState()), before);
  } finally {
    await extension.shutdown();
  }
});

test("re-arms a replayed missing-task orphan only with retained ownership proof", async () => {
  __resetState();
  let calls = 0;
  const unregister = registerBackgroundSubagentService({
    async run() {
      throw new Error("not used");
    },
    async cancel() {
      calls++;
      throw new Error("temporary");
    },
  });
  const extension = extensionHarness();
  const notices = [];
  try {
    await extension.start();
    commitState({
      tasks: [
        {
          id: 27,
          subject: "proof-backed orphan",
          status: "in_progress",
          metadata: {
            preparation: {
              status: "ready",
              token: "orphan-token",
              approval: "granted",
              approvalRequired: false,
            },
            delegation: {
              status: "running",
              todoId: 27,
              todoToken: "orphan-token",
              subagentIds: ["orphan-worker"],
            },
          },
        },
      ],
      nextId: 28,
      revision: 1,
    });
    const replayCtx = { hasUI: false, sessionManager: { getBranch: () => [] } };
    await extension.emit("session_tree", {}, replayCtx);
    const intent = [
      ...(getState().cancellationIntents ?? []),
      ...(getState().cancellationOverflow ?? []),
      ...(getState().cancellationQuarantine ?? []),
    ].find((candidate) => candidate.taskId === 27);
    assert.ok(intent);
    await extension.commands.get("todo").handler("rearm", {
      hasUI: false,
      ui: {
        notify(text) {
          notices.push(text);
        },
      },
    });
    assert.match(notices.at(-1), /Recoverable cancellation TODOs: #27/);
    assert.doesNotMatch(notices.at(-1), /orphan-worker|orphan-token/);
    commitState({
      ...getState(),
      cancellationIntents: [{ ...intent, attempts: 3 }],
      revision: getState().revision + 1,
    });
    await extension.commands.get("todo").handler("rearm #27", {
      hasUI: false,
      ui: {
        notify(text) {
          notices.push(text);
        },
      },
    });
    assert.equal(
      notices.at(-1),
      "Re-armed cancellation for TODO #27; retrying now.",
    );
    assert.equal(calls >= 2, true);
    assert.equal(
      [
        ...(getState().cancellationIntents ?? []),
        ...(getState().cancellationOverflow ?? []),
        ...(getState().cancellationQuarantine ?? []),
      ].find((candidate) => candidate.taskId === 27)?.attempts,
      1,
    );
  } finally {
    await extension.shutdown();
    unregister();
  }
});

test("restart does not promote an unproven preparation overflow intent", async () => {
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
  const overflow = (attempts) => ({
    kind: "preparation",
    taskId: 27,
    token: "stale-preparation-token",
    ids: ["reused-preparation-worker"],
    generation: 1,
    attempts,
    workerGeneration: 2,
    orphaned: true,
  });
  const branch = (intent) => [
    {
      type: "custom",
      customType: TODO_SNAPSHOT_TYPE,
      data: createTodoSnapshot({
        tasks: [],
        nextId: 1,
        revision: 1,
        cancellationOverflow: [intent],
      }),
    },
  ];
  const first = extensionHarness(branch(overflow(0)));
  try {
    await first.start();
    assert.deepEqual(cancelled, []);
    assert.equal(
      (getState().cancellationIntents?.length ?? 0) +
        (getState().cancellationOverflow?.length ?? 0),
      1,
    );
    await first.shutdown();
    const second = extensionHarness(branch(overflow(3)));
    try {
      await second.start();
      assert.deepEqual(cancelled, []);
      const notices = [];
      await second.commands.get("todo").handler("rearm #27", {
        hasUI: false,
        ui: {
          notify(text) {
            notices.push(text);
          },
        },
      });
      assert.equal(
        notices.at(-1),
        "TODO #27 cancellation cannot be safely re-armed: ownership proof is unavailable.",
      );
      assert.equal(
        [
          ...(getState().cancellationIntents ?? []),
          ...(getState().cancellationOverflow ?? []),
        ].find((intent) => intent.taskId === 27)?.attempts,
        3,
      );
    } finally {
      await second.shutdown();
    }
  } finally {
    unregister();
  }
});

test("restart does not promote an unproven delegation overflow intent onto a reused worker", async () => {
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
  const extension = extensionHarness([
    {
      type: "custom",
      customType: TODO_SNAPSHOT_TYPE,
      data: createTodoSnapshot({
        tasks: [
          {
            id: 2,
            subject: "new owner",
            status: "in_progress",
            metadata: {
              delegation: {
                status: "running",
                todoId: 2,
                todoToken: "new-token",
                subagentIds: ["reused-worker"],
              },
            },
          },
        ],
        nextId: 3,
        revision: 1,
        cancellationOverflow: [
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
      }),
    },
  ]);
  try {
    await extension.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(cancelled, []);
    assert.ok(
      [
        ...(getState().cancellationIntents ?? []),
        ...(getState().cancellationOverflow ?? []),
      ].some((intent) => intent.taskId === 1 && intent.token === "old-token"),
    );
  } finally {
    await extension.shutdown();
    unregister();
  }
});

test("replay never treats an arbitrary persisted quarantine worker as owned", async () => {
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
  const extension = extensionHarness([
    {
      type: "custom",
      customType: TODO_SNAPSHOT_TYPE,
      data: createTodoSnapshot({
        tasks: [
          {
            id: 1,
            subject: "held task",
            status: "waiting:user",
            wait: { kind: "user", questions: ["hold"] },
            metadata: {
              preparation: {
                status: "running",
                token: "attacker-prep-token",
                activeWorkerIds: ["arbitrary-prep-worker"],
                workerGeneration: 1,
              },
              delegation: {
                status: "cancelling",
                todoId: 1,
                todoToken: "attacker-delegation-token",
                subagentIds: ["arbitrary-delegation-worker"],
                cancellationGeneration: 1,
              },
            },
          },
        ],
        nextId: 2,
        revision: 1,
        cancellationQuarantine: [
          {
            kind: "preparation",
            taskId: 1,
            token: "attacker-prep-token",
            ids: ["arbitrary-prep-worker"],
            generation: 1,
            attempts: 0,
            workerGeneration: 1,
            orphaned: true,
          },
          {
            kind: "delegation",
            taskId: 1,
            token: "attacker-delegation-token",
            ids: ["arbitrary-delegation-worker"],
            generation: 1,
            attempts: 0,
            orphaned: true,
          },
        ],
      }),
    },
  ]);
  try {
    await extension.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(cancelled, []);
    assert.equal(getState().cancellationQuarantine?.length, 2);
    assert.equal(getState().tasks[0].metadata.preparation.status, "running");
    assert.equal(getState().tasks[0].metadata.delegation.status, "cancelling");
  } finally {
    await extension.shutdown();
    unregister();
  }
});

test("assignment gate belongs only to active TODO session", async () => {
  __resetState();
  const unregisterSentinel = registerPackageAssignmentGate(
    () => "sentinel gate",
    () => undefined,
    () => undefined,
  );
  const extension = extensionHarness();
  assert.equal(
    packageAssignmentError(packageRequest(1, "token")),
    "sentinel gate",
  );

  await extension.start();
  assert.notEqual(
    packageAssignmentError(packageRequest(1, "token")),
    "sentinel gate",
  );
  await extension.shutdown();
  assert.equal(
    packageAssignmentError(packageRequest(1, "token")),
    "package_handoff assignment gate unavailable.",
  );
  unregisterSentinel();
});

for (const lifecycleEvent of [
  "session_start",
  "session_compact",
  "session_tree",
]) {
  test(`${lifecycleEvent} failure closes stale assignment authority`, async () => {
    __resetState();
    const extension = extensionHarness();
    await extension.start();
    const failedContext = {
      mode: "print",
      hasUI: false,
      cwd: process.cwd(),
      sessionManager: {
        getBranch() {
          throw new Error(`${lifecycleEvent} replay failed`);
        },
      },
    };
    if (lifecycleEvent === "session_start") {
      await assert.rejects(extension.start(failedContext), /replay failed/);
    } else {
      await assert.rejects(
        extension.emit(lifecycleEvent, {}, failedContext),
        /replay failed/,
      );
    }
    assert.equal(
      packageAssignmentError(packageRequest(1, "token")),
      "package_handoff assignment gate unavailable.",
    );
    await extension.shutdown();
  });
}

test("session reload refreshes gate and shutdown removes only its own registration", async () => {
  __resetState();
  const oldSession = extensionHarness();
  const newSession = extensionHarness();
  await oldSession.start();
  await oldSession.shutdown();
  assert.equal(
    packageAssignmentError(packageRequest(1, "token")),
    "package_handoff assignment gate unavailable.",
  );

  await newSession.start();
  assert.notEqual(
    packageAssignmentError(packageRequest(1, "token")),
    "package_handoff assignment gate unavailable.",
  );
  const unregisterNewer = registerPackageAssignmentGate(
    () => "newer canonical gate",
    () => undefined,
    () => undefined,
  );
  await newSession.shutdown();
  assert.equal(
    packageAssignmentError(packageRequest(1, "token")),
    "newer canonical gate",
  );
  unregisterNewer();
});

test("session tree rebinds replayed orchestrator mode before admission resumes", async () => {
  __resetState();
  const extension = extensionHarness();
  const branch = (setting, revision) => [
    {
      type: "custom",
      customType: TODO_SNAPSHOT_TYPE,
      data: createTodoSnapshot({
        tasks: [],
        nextId: 1,
        revision,
        orchestrator: { setting },
      }),
    },
  ];
  try {
    await extension.start();
    await extension.emit(
      "session_tree",
      {},
      {
        hasUI: false,
        sessionManager: { getBranch: () => branch("off", 2) },
      },
    );
    assert.deepEqual(getState().orchestrator, { setting: "off" });
    assert.equal(
      packageAssignmentError(packageRequest(1, "missing")),
      "package_handoff assignment gate is off.",
    );

    await extension.emit(
      "session_tree",
      {},
      {
        hasUI: false,
        sessionManager: { getBranch: () => branch("on", 3) },
      },
    );
    assert.deepEqual(getState().orchestrator, { setting: "on" });
    assert.notEqual(
      packageAssignmentError(packageRequest(1, "missing")),
      "package_handoff assignment gate is off.",
    );

    await extension.emit(
      "session_tree",
      {},
      {
        hasUI: false,
        sessionManager: { getBranch: () => branch("auto", 4) },
      },
    );
    assert.deepEqual(getState().orchestrator, { setting: "auto" });
    assert.notEqual(
      packageAssignmentError(packageRequest(1, "missing")),
      "package_handoff assignment gate is off.",
    );
  } finally {
    await extension.shutdown();
  }
});

test("persists every orchestrator mode before runtime and gate changes", async () => {
  __resetState();
  const entries = [];
  let failPersistence = false;
  const extension = extensionHarness([], undefined, {
    appendEntry(type, data) {
      if (failPersistence) throw new Error("forced TODO persistence failure");
      entries.push({ type, data });
    },
  });
  await extension.start();
  const run = (value) =>
    extension.commands.get("orchestrator").handler(value, {
      ui: { notify() {} },
    });
  try {
    await run("on");
    assert.deepEqual(getState().orchestrator, { setting: "on" });
    assert.notEqual(
      packageAssignmentError(packageRequest(1, "missing")),
      "package_handoff assignment gate is off.",
    );

    failPersistence = true;
    await assert.rejects(run("auto"), /forced TODO persistence failure/);
    assert.deepEqual(getState().orchestrator, { setting: "on" });
    assert.notEqual(
      packageAssignmentError(packageRequest(1, "missing")),
      "package_handoff assignment gate is off.",
    );

    failPersistence = false;
    await run("auto");
    assert.deepEqual(getState().orchestrator, { setting: "auto" });
    await run("off");
    assert.deepEqual(getState().orchestrator, {
      setting: "off",
      sticky: false,
    });
    assert.equal(
      packageAssignmentError(packageRequest(1, "missing")),
      "package_handoff assignment gate is off.",
    );
  } finally {
    await extension.shutdown();
  }

  const replayed = extensionHarness(
    entries.map(({ type, data }) => ({
      type: "custom",
      customType: type,
      data,
    })),
  );
  await replayed.start();
  try {
    assert.deepEqual(getState().orchestrator, {
      setting: "off",
      sticky: false,
    });
  } finally {
    await replayed.shutdown();
  }
});

test("off canonically clears sticky mode with owner cancellation and replay", async () => {
  __resetState();
  const cancelled = [];
  const entries = [];
  const unregister = registerBackgroundSubagentService({
    async run() {
      throw new Error("not used");
    },
    async cancel(ids) {
      cancelled.push([...ids]);
    },
  });
  const extension = extensionHarness([], undefined, {
    appendEntry(type, data) {
      entries.push({ type, data });
    },
  });
  let extensionClosed = false;
  try {
    await extension.start();
    commitState({
      tasks: [
        {
          id: 1,
          subject: "owned package",
          status: "in_progress",
          metadata: {
            preparation: {
              status: "ready",
              token: "off-token",
              approval: "granted",
              approvalRequired: false,
            },
            orchestrator: { mode: "sticky" },
            delegation: {
              status: "running",
              todoId: 1,
              todoToken: "off-token",
              subagentIds: ["off-worker"],
              cancellationIds: ["off-pending-worker"],
              cancellationGeneration: 1,
            },
          },
        },
      ],
      nextId: 2,
      revision: 1,
      orchestrator: { setting: "on", sticky: true },
      cancellationIntents: [
        {
          kind: "delegation",
          taskId: 1,
          token: "off-token",
          ids: ["off-pending-worker"],
          generation: 1,
          attempts: 0,
        },
      ],
    });
    entries.push({
      type: TODO_SNAPSHOT_TYPE,
      data: createTodoSnapshot(getState()),
    });
    await extension.commands.get("orchestrator").handler("off", {
      ui: { notify() {} },
    });
    assert.deepEqual(
      new Set(cancelled.flat()),
      new Set(["off-worker", "off-pending-worker"]),
    );
    assert.deepEqual(getState().orchestrator, {
      setting: "off",
      sticky: false,
    });
    assert.notEqual(getState().tasks[0].metadata.delegation.status, "running");
    assert.equal(
      (getState().cancellationIntents ?? []).some((intent) =>
        intent.ids.includes("off-worker"),
      ),
      false,
    );
    assert.equal(
      entries.some(
        ({ data }) =>
          data?.orchestrator?.setting === "off" &&
          data?.orchestrator?.sticky === false,
      ),
      true,
    );
    const replayed = extensionHarness(
      entries.map(({ type, data }) => ({
        type: "custom",
        customType: type,
        data,
      })),
    );
    await extension.shutdown();
    extensionClosed = true;
    await replayed.start();
    assert.notEqual(
      replayed ? getState().tasks[0]?.metadata?.delegation?.status : "running",
      "running",
    );
    assert.deepEqual(getState().orchestrator, {
      setting: "off",
      sticky: false,
    });
    assert.equal(
      packageAssignmentError(packageRequest(1, "missing")),
      "package_handoff assignment gate is off.",
    );
    await replayed.shutdown();
  } finally {
    if (!extensionClosed) await extension.shutdown();
    unregister();
  }
});

test("off revalidates cached owners before cancelling a reused current worker", async () => {
  __resetState();
  const cancelled = [];
  let releaseCancellation;
  const unregister = registerBackgroundSubagentService({
    async run() {
      throw new Error("not used");
    },
    async cancel(ids) {
      cancelled.push([...ids]);
      await new Promise((resolve) => {
        releaseCancellation = resolve;
      });
    },
  });
  const entries = [];
  const extension = extensionHarness([], undefined, {
    appendEntry(type, data) {
      entries.push({ type, data });
    },
  });
  try {
    await extension.start();
    commitState({
      tasks: [
        {
          id: 1,
          subject: "reused package owner",
          status: "in_progress",
          metadata: {
            preparation: {
              status: "ready",
              token: "old-token",
              approval: "granted",
              approvalRequired: false,
            },
            orchestrator: { mode: "sticky" },
            delegation: {
              status: "running",
              todoId: 1,
              todoToken: "old-token",
              subagentIds: ["reused-worker"],
              subagentId: "reused-worker",
            },
          },
        },
      ],
      nextId: 2,
      revision: 1,
      orchestrator: { setting: "on", sticky: true },
    });
    extension.events.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
      delegations: [
        { id: "reused-worker", todo_id: 1, todo_token: "old-token" },
      ],
    });
    const current = getState();
    commitState({
      ...current,
      revision: current.revision + 1,
      tasks: [
        {
          ...current.tasks[0],
          metadata: {
            ...current.tasks[0].metadata,
            preparation: {
              ...current.tasks[0].metadata.preparation,
              token: "new-token",
            },
            delegation: {
              ...current.tasks[0].metadata.delegation,
              todoToken: "new-token",
            },
          },
        },
      ],
    });

    await extension.commands.get("orchestrator").handler("off", {
      ui: { notify() {} },
    });
    assert.deepEqual(cancelled, [["reused-worker"]]);
    const intents = [
      ...(getState().cancellationIntents ?? []),
      ...(getState().cancellationOverflow ?? []),
      ...(getState().cancellationQuarantine ?? []),
    ];
    assert.equal(intents.length, 1);
    assert.equal(intents[0].token, "new-token");
    assert.equal(intents[0].ids[0], "reused-worker");
    assert.deepEqual(getState().orchestrator, {
      setting: "off",
      sticky: false,
    });
    assert.equal(
      getState().tasks[0].metadata.delegation.todoToken,
      "new-token",
    );
    assert.equal(
      entries.some(({ data }) => JSON.stringify(data).includes("new-token")),
      true,
    );
    releaseCancellation();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    await extension.shutdown();
    unregister();
  }
});

test("off rejects full cancellation admission without mutating state", async () => {
  __resetState();
  const extension = extensionHarness();
  await extension.start();
  try {
    const intent = (index) => ({
      kind: "delegation",
      taskId: index + 10,
      token: `capacity-token-${index}`,
      ids: [`capacity-worker-${index}`],
      generation: 1,
      attempts: 0,
    });
    commitState({
      tasks: [
        {
          id: 1,
          subject: "capacity owner",
          status: "in_progress",
          metadata: {
            preparation: {
              status: "ready",
              token: "capacity-owner-token",
              approval: "granted",
              approvalRequired: false,
            },
            orchestrator: { mode: "sticky" },
            delegation: {
              status: "running",
              todoId: 1,
              todoToken: "capacity-owner-token",
              subagentIds: ["capacity-live-worker"],
            },
          },
        },
      ],
      nextId: 2,
      revision: 1,
      orchestrator: { setting: "on" },
      cancellationIntents: Array.from({ length: 256 }, (_, index) =>
        intent(index),
      ),
      cancellationOverflow: Array.from({ length: 256 }, (_, index) =>
        intent(index + 256),
      ),
    });
    const before = structuredClone(getState());
    await assert.rejects(
      extension.commands.get("orchestrator").handler("off", {
        ui: { notify() {} },
      }),
      /capacity reached/i,
    );
    assert.deepEqual(getState(), before);
    assert.notEqual(
      packageAssignmentError(packageRequest(1, "missing")),
      "package_handoff assignment gate is off.",
    );
  } finally {
    await extension.shutdown();
  }
});

test("shutdown generation prevents a late session start from replacing the active gate", async () => {
  __resetState();
  const originalDisable = TodoScheduler.prototype.disableOrchestrator;
  let releaseDisable;
  const blockedDisable = new Promise((resolve) => {
    releaseDisable = resolve;
  });
  TodoScheduler.prototype.disableOrchestrator = async () => {
    await blockedDisable;
  };

  const stale = extensionHarness();
  const staleStart = stale.start();
  await Promise.resolve();
  await stale.shutdown();
  TodoScheduler.prototype.disableOrchestrator = originalDisable;

  const unregister = registerPackageAssignmentGate(
    () => undefined,
    () => undefined,
    () => undefined,
  );
  const lease = acquirePackageAssignmentLease(packageRequest(1, "token"));
  assert.notEqual(typeof lease, "string");
  if (typeof lease === "string") throw new Error(lease);
  try {
    releaseDisable();
    await staleStart;
    assert.equal(lease.validate(), undefined);
  } finally {
    lease.close();
    unregister();
    TodoScheduler.prototype.disableOrchestrator = originalDisable;
  }
});

test("filtered child loading and binding keep acquired parent gate generation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "todo-child-gate-"));
  const unregister = registerPackageAssignmentGate(
    () => undefined,
    () => undefined,
    () => undefined,
  );
  const request = packageRequest(1, "token");
  const lease = acquirePackageAssignmentLease(request);
  assert.notEqual(typeof lease, "string");
  if (typeof lease === "string") throw new Error(lease);

  let session;
  try {
    const settingsManager = SettingsManager.inMemory(undefined, {
      projectTrusted: false,
    });
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: path.join(directory, "agent"),
      settingsManager,
      noExtensions: true,
      extensionFactories: [todoExtension],
      extensionsOverride: excludeSessionOwnedChildExtensions,
    });
    await loader.reload();
    assert.equal(loader.getExtensions().extensions.length, 0);
    assert.equal(lease.validate(), undefined);

    ({ session } = await createAgentSession({
      cwd: directory,
      agentDir: path.join(directory, "agent"),
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(directory),
    }));
    await bindChildSessionExtensions(session);
    assert.equal(lease.validate(), undefined);
  } finally {
    lease.close();
    unregister();
    if (session) await shutdownAndDisposeChildSession(session);
    await rm(directory, { recursive: true, force: true });
  }
});

test("agent_settled ignores a stale replaced-session context", async () => {
  __resetState();
  const lifecycle = new Map();
  const pi = {
    events: new Bus(),
    on(name, handler) {
      const handlers = lifecycle.get(name) ?? [];
      handlers.push(handler);
      lifecycle.set(name, handlers);
    },
    registerTool() {},
    registerCommand() {},
    appendEntry() {},
    sendMessage() {},
  };
  todoExtension(pi);
  const replaced = { hasUI: false, sessionManager: { getBranch: () => [] } };
  const current = { hasUI: false, sessionManager: { getBranch: () => [] } };
  const stale = new Proxy(
    {},
    {
      get() {
        throw new Error("stale-context proxy accessed");
      },
    },
  );
  try {
    await lifecycle.get("session_start")[0]({}, replaced);
    await lifecycle.get("session_start")[0]({}, current);
    await lifecycle.get("agent_settled")[0]({}, stale);
  } finally {
    await lifecycle.get("session_shutdown")[0]();
  }
  assert.ok(true);
});

test("repeated session_start hands off a successful cancellation to the durable identity", async () => {
  __resetState();
  let resolveFirst;
  const cancelled = [];
  const unregister = registerBackgroundSubagentService({
    async run() {
      throw new Error("not used");
    },
    async cancel(ids) {
      cancelled.push([...ids]);
      if (cancelled.length === 1)
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
    },
  });
  const extension = extensionHarness();
  try {
    await extension.start();
    commitState({
      tasks: [
        {
          id: 1,
          subject: "repeated start cancellation",
          status: "in_progress",
          metadata: {
            preparation: {
              status: "ready",
              token: "repeat-token",
              approval: "granted",
              approvalRequired: false,
            },
            delegation: {
              status: "running",
              todoId: 1,
              todoToken: "repeat-token",
              subagentIds: ["repeat-worker"],
              subagentId: "repeat-worker",
            },
          },
        },
      ],
      nextId: 2,
      revision: 1,
    });
    extension.events.emit(SUBAGENT_DELEGATION_STATE_CHANNEL, {
      delegations: [
        { id: "repeat-worker", todo_id: 1, todo_token: "repeat-token" },
      ],
    });
    extension.events.emit(AUTOMATION_PAUSE_CHANNEL, {
      reason: "double-escape",
      acknowledge() {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled.length, 1);
    assert.equal(getState().tasks[0].metadata.delegation.status, "cancelling");

    const replayCtx = {
      hasUI: false,
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: TODO_SNAPSHOT_TYPE,
            data: createTodoSnapshot(getState()),
          },
        ],
      },
    };
    await extension.emit("session_start", {}, replayCtx);
    resolveFirst();
    for (
      let attempt = 0;
      attempt < 20 &&
      getState().tasks[0].metadata.delegation.status !== "cancelled";
      attempt++
    )
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled.length, 1);
    assert.equal(getState().tasks[0].metadata.delegation.status, "cancelled");
    assert.equal(
      getState().tasks[0].metadata.delegation.cancellationIds,
      undefined,
    );
    assert.equal((getState().cancellationIntents ?? []).length, 0);
    assert.equal((getState().cancellationOverflow ?? []).length, 0);
  } finally {
    await extension.shutdown();
    unregister();
  }
});

test("failed replacement after activation preserves a newly in-flight cancellation for restart", async () => {
  __resetState();
  const cancelled = [];
  const cancelResolvers = [];
  const unregister = registerBackgroundSubagentService({
    async run() {
      throw new Error("not used");
    },
    async cancel(ids) {
      cancelled.push([...ids]);
      return new Promise((resolve) => cancelResolvers.push(resolve));
    },
  });
  const extension = extensionHarness();
  const state = {
    tasks: [
      {
        id: 1,
        subject: "replacement cancellation",
        status: "completed",
        metadata: {
          preparation: {
            status: "ready",
            token: "replacement-token",
            approval: "granted",
            approvalRequired: false,
          },
          delegation: {
            status: "cancelling",
            todoId: 1,
            todoToken: "replacement-token",
            cancellationGeneration: 2,
            cancellationIds: ["replacement-worker"],
          },
        },
      },
    ],
    nextId: 2,
    revision: 1,
    cancellationIntents: [
      {
        kind: "delegation",
        taskId: 1,
        token: "replacement-token",
        ids: ["replacement-worker"],
        generation: 2,
        attempts: 0,
      },
    ],
  };
  try {
    await extension.start();
    commitState(state);
    let failHasUI = true;
    const failingContext = {
      mode: "print",
      cwd: process.cwd(),
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: TODO_SNAPSHOT_TYPE,
            data: createTodoSnapshot(state),
          },
        ],
      },
      get hasUI() {
        if (failHasUI) {
          failHasUI = false;
          throw new Error("replacement UI setup failed");
        }
        return false;
      },
    };
    await assert.rejects(
      extension.start(failingContext),
      /replacement UI setup failed/,
    );
    assert.deepEqual(cancelled, [["replacement-worker"]]);
    assert.equal(getState().cancellationIntents?.length, 1);
    cancelResolvers.shift()();
    await new Promise((resolve) => setImmediate(resolve));

    const replayContext = {
      hasUI: false,
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: TODO_SNAPSHOT_TYPE,
            data: createTodoSnapshot(getState()),
          },
        ],
      },
    };
    await extension.start(replayContext);
    for (let attempt = 0; attempt < 20 && cancelResolvers.length < 1; attempt++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(cancelled, [
      ["replacement-worker"],
      ["replacement-worker"],
    ]);
    cancelResolvers.shift()();
    for (
      let attempt = 0;
      attempt < 20 && getState().cancellationIntents?.length;
      attempt++
    )
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getState().tasks[0].metadata.delegation.status, "cancelled");
    assert.equal(getState().cancellationIntents?.length ?? 0, 0);
  } finally {
    await extension.shutdown();
    unregister();
  }
});

test("session tree preserves abandoned preparation and delegation owners for cancellation", async () => {
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
  const extension = extensionHarness();
  try {
    await extension.start();
    commitState({
      tasks: [
        {
          id: 1,
          subject: "abandoned owners",
          status: "in_progress",
          metadata: {
            preparation: {
              status: "running",
              token: "prep-old",
              workerGeneration: 1,
              activeWorkerIds: ["prep-old-worker"],
            },
            delegation: {
              status: "running",
              todoId: 1,
              todoToken: "delegation-old",
              cancellationGeneration: 1,
              subagentIds: ["delegation-old-worker"],
            },
          },
        },
      ],
      nextId: 2,
      revision: 1,
    });
    await extension.emit(
      "session_tree",
      {},
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(cancelled.sort(), [
      ["delegation-old-worker"],
      ["prep-old-worker"],
    ]);
    assert.equal(getState().tasks.length, 0);
    assert.equal(getState().cancellationIntents?.length ?? 0, 0);
  } finally {
    await extension.shutdown();
    unregister();
  }
});

test("session tree deduplicates recovery targets across primary and overflow queues", async () => {
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
  const extension = extensionHarness();
  const intent = {
    kind: "delegation",
    taskId: 1,
    token: "old-token",
    ids: ["old-worker"],
    generation: 1,
    attempts: 0,
  };
  try {
    await extension.start();
    commitState({
      tasks: [
        {
          id: 1,
          subject: "abandoned delegation",
          status: "in_progress",
          metadata: {
            preparation: {
              status: "ready",
              token: "old-token",
              approval: "granted",
              approvalRequired: false,
            },
            delegation: {
              status: "running",
              todoId: 1,
              todoToken: "old-token",
              subagentIds: ["old-worker"],
            },
          },
        },
      ],
      nextId: 2,
      revision: 1,
    });
    await extension.emit(
      "session_tree",
      {},
      {
        hasUI: false,
        sessionManager: {
          getBranch: () => [
            {
              type: "custom",
              customType: TODO_SNAPSHOT_TYPE,
              data: {
                version: 1,
                revision: 1,
                tasks: [],
                nextId: 1,
                cancellationIntents: [intent],
                cancellationOverflow: [intent],
              },
            },
          ],
        },
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(cancelled, [["old-worker"]]);
  } finally {
    await extension.shutdown();
    unregister();
  }
});

test("session compact preserves an in-flight cancellation until settlement", async () => {
  __resetState();
  let releaseFirst;
  const firstCancellation = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const cancelled = [];
  const unregister = registerBackgroundSubagentService({
    async run() {
      throw new Error("not used");
    },
    async cancel(ids) {
      cancelled.push([...ids]);
      if (cancelled.length === 1) await firstCancellation;
    },
  });
  const extension = extensionHarness();
  const state = {
    tasks: [
      {
        id: 1,
        subject: "compact cancellation",
        status: "completed",
        metadata: {
          preparation: {
            status: "ready",
            token: "token",
            approval: "granted",
            approvalRequired: false,
          },
          delegation: {
            status: "cancelling",
            todoId: 1,
            todoToken: "token",
            cancellationGeneration: 1,
            cancellationIds: ["compact-worker"],
          },
        },
      },
    ],
    nextId: 2,
    revision: 1,
    cancellationIntents: [
      {
        kind: "delegation",
        taskId: 1,
        token: "token",
        ids: ["compact-worker"],
        generation: 1,
        attempts: 0,
      },
    ],
  };
  const ctx = {
    hasUI: false,
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: TODO_SNAPSHOT_TYPE,
          data: createTodoSnapshot(state),
        },
      ],
    },
  };
  try {
    await extension.start();
    commitState(state);
    await extension.emit("session_tree", {}, ctx);
    assert.deepEqual(cancelled, [["compact-worker"]]);
    await extension.emit("session_compact", {}, ctx);
    assert.deepEqual(cancelled, [["compact-worker"]]);
    releaseFirst();
    for (
      let attempt = 0;
      attempt < 20 &&
      getState().tasks[0].metadata.delegation.status !== "cancelled";
      attempt++
    )
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getState().tasks[0].metadata.delegation.status, "cancelled");
    assert.deepEqual(cancelled, [["compact-worker"]]);
  } finally {
    await extension.shutdown();
    unregister();
  }
});

test("session compact preserves a failed cancellation handoff for retry", async () => {
  __resetState();
  let rejectFirst;
  const firstCancellation = new Promise((_resolve, reject) => {
    rejectFirst = reject;
  });
  const cancelled = [];
  const unregister = registerBackgroundSubagentService({
    async run() {
      throw new Error("not used");
    },
    async cancel(ids) {
      cancelled.push([...ids]);
      if (cancelled.length === 1) await firstCancellation;
    },
  });
  const extension = extensionHarness();
  const state = {
    tasks: [
      {
        id: 1,
        subject: "compact failure",
        status: "completed",
        metadata: {
          preparation: {
            status: "ready",
            token: "token",
            approval: "granted",
            approvalRequired: false,
          },
          delegation: {
            status: "cancelling",
            todoId: 1,
            todoToken: "token",
            cancellationGeneration: 1,
            cancellationIds: ["compact-worker"],
          },
        },
      },
    ],
    nextId: 2,
    revision: 1,
    cancellationIntents: [
      {
        kind: "delegation",
        taskId: 1,
        token: "token",
        ids: ["compact-worker"],
        generation: 1,
        attempts: 0,
      },
    ],
  };
  const ctx = {
    hasUI: false,
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: TODO_SNAPSHOT_TYPE,
          data: createTodoSnapshot(state),
        },
      ],
    },
  };
  try {
    await extension.start();
    commitState(state);
    await extension.emit("session_tree", {}, ctx);
    assert.equal(cancelled.length, 1);
    await extension.emit("session_compact", {}, ctx);
    rejectFirst(new Error("temporary cancellation failure"));
    for (let attempt = 0; attempt < 30 && cancelled.length < 2; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(cancelled, [["compact-worker"], ["compact-worker"]]);
  } finally {
    await extension.shutdown();
    unregister();
  }
});

test("session compact preserves quarantine as non-capacity recovery state", async () => {
  __resetState();
  const extension = extensionHarness();
  const quarantined = {
    tasks: [],
    nextId: 1,
    revision: 1,
    cancellationCapacityError: CANCELLATION_QUARANTINE_ERROR,
    cancellationQuarantine: [
      {
        kind: "delegation",
        taskId: 1,
        token: "token",
        ids: ["quarantine-worker"],
        generation: 1,
        attempts: 3,
        orphaned: true,
      },
    ],
  };
  const healthy = { tasks: [], nextId: 1, revision: 2 };
  const ctx = (state) => ({
    hasUI: false,
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: TODO_SNAPSHOT_TYPE,
          data: createTodoSnapshot(state),
        },
      ],
    },
  });
  try {
    await extension.start();
    await extension.emit("session_compact", {}, ctx(quarantined));
    assert.doesNotMatch(
      packageAssignmentError(packageRequest(1, "token")),
      /Cancellation recovery capacity reached/,
    );
    await extension.emit("session_compact", {}, ctx(healthy));
    assert.doesNotMatch(
      packageAssignmentError(packageRequest(1, "token")),
      /cancellation recovery is quarantined/,
    );
  } finally {
    await extension.shutdown();
  }
});

test("session tree keeps normal overflow and clears a stale capacity fault", async () => {
  __resetState();
  const extension = extensionHarness();
  const primary = Array.from({ length: 256 }, (_, index) => ({
    kind: "delegation",
    taskId: index + 1,
    token: `primary-${index}`,
    ids: [`primary-worker-${index}`],
    generation: 1,
    attempts: 0,
  }));
  const overflow = [
    {
      kind: "preparation",
      taskId: 400,
      token: "overflow-token",
      ids: ["overflow-worker"],
      generation: 1,
      attempts: 0,
      workerGeneration: 1,
    },
  ];
  try {
    await extension.start();
    await extension.emit(
      "session_tree",
      {},
      {
        hasUI: false,
        sessionManager: {
          getBranch: () => [
            {
              type: "custom",
              customType: TODO_SNAPSHOT_TYPE,
              data: createTodoSnapshot({
                tasks: [],
                nextId: 1,
                revision: 1,
                cancellationIntents: primary,
                cancellationOverflow: overflow,
              }),
            },
          ],
        },
      },
    );
    assert.equal(getState().cancellationIntents?.length, 256);
    assert.equal(getState().cancellationOverflow?.length, 1);
    assert.equal(getState().cancellationCapacityError, undefined);
  } finally {
    await extension.shutdown();
  }
});

test("session tree preserves a capacity fault while both recovery queues are full", async () => {
  __resetState();
  const extension = extensionHarness();
  const primary = Array.from({ length: 256 }, (_, index) => ({
    kind: "delegation",
    taskId: index + 1,
    token: `primary-${index}`,
    ids: [`primary-worker-${index}`],
    generation: 1,
    attempts: 3,
  }));
  const overflow = Array.from({ length: 256 }, (_, index) => ({
    kind: "preparation",
    taskId: index + 400,
    token: `overflow-${index}`,
    ids: [`overflow-worker-${index}`],
    generation: 1,
    attempts: 3,
    workerGeneration: 1,
  }));
  try {
    await extension.start();
    commitState({
      tasks: [],
      nextId: 1,
      revision: 0,
      cancellationIntents: primary,
      cancellationOverflow: overflow,
      cancellationCapacityError: CANCELLATION_CAPACITY_ERROR,
    });
    await extension.emit(
      "session_tree",
      {},
      {
        hasUI: false,
        sessionManager: {
          getBranch: () => [
            {
              type: "custom",
              customType: TODO_SNAPSHOT_TYPE,
              data: createTodoSnapshot({
                tasks: [],
                nextId: 1,
                revision: 1,
                cancellationIntents: primary,
                cancellationOverflow: overflow,
              }),
            },
          ],
        },
      },
    );
    assert.equal(getState().cancellationIntents?.length, 256);
    assert.equal(getState().cancellationOverflow?.length, 256);
    assert.equal(
      getState().cancellationCapacityError,
      CANCELLATION_CAPACITY_ERROR,
      JSON.stringify(getState()),
    );
  } finally {
    await extension.shutdown();
  }
});

test("session tree rejects lossy abandoned-owner merges and preserves recovery on repeat", async () => {
  __resetState();
  const extension = extensionHarness();
  const primary = Array.from({ length: 256 }, (_, index) => ({
    kind: "delegation",
    taskId: index + 100,
    token: `primary-${index}`,
    ids: [`primary-worker-${index}`],
    generation: 1,
    attempts: 3,
  }));
  const overflow = Array.from({ length: 256 }, (_, index) => ({
    kind: "preparation",
    taskId: index + 500,
    token: `overflow-${index}`,
    ids: [`overflow-worker-${index}`],
    generation: 1,
    attempts: 3,
    workerGeneration: 1,
  }));
  const branch = {
    type: "custom",
    customType: TODO_SNAPSHOT_TYPE,
    data: createTodoSnapshot({
      tasks: [],
      nextId: 1,
      revision: 1,
      cancellationIntents: primary,
      cancellationOverflow: overflow,
    }),
  };
  try {
    await extension.start();
    commitState({
      tasks: [
        {
          id: 1,
          subject: "preserve owner",
          status: "in_progress",
          metadata: {
            preparation: {
              status: "ready",
              token: "owner-token",
              approval: "granted",
              approvalRequired: false,
            },
            delegation: {
              status: "running",
              todoId: 1,
              todoToken: "owner-token",
              subagentIds: ["abandoned-worker"],
            },
          },
        },
      ],
      nextId: 2,
      revision: 2,
      cancellationIntents: primary,
      cancellationOverflow: overflow,
    });
    const ctx = { hasUI: false, sessionManager: { getBranch: () => [branch] } };
    await extension.emit("session_tree", {}, ctx);
    assert.equal(getState().tasks.length, 0);
    assert.equal(getState().cancellationIntents?.length, 256);
    assert.equal(getState().cancellationOverflow?.length, 256);
    assert.equal(
      getState().cancellationCapacityError,
      CANCELLATION_CAPACITY_ERROR,
    );
    assert.match(
      packageAssignmentError(packageRequest(1, "owner-token")),
      /Cancellation recovery capacity reached/,
    );
    await extension.emit("session_tree", {}, ctx);
    assert.equal(getState().tasks.length, 0);
    assert.equal(getState().cancellationIntents?.length, 256);
    assert.equal(getState().cancellationOverflow?.length, 256);
  } finally {
    await extension.shutdown();
  }
});

test("session tree preserves more than 512 abandoned owners instead of slicing recovery", async () => {
  __resetState();
  const cancelled = [];
  const unregister = registerBackgroundSubagentService({
    async run() {
      throw new Error("not used");
    },
    async cancel(ids) {
      cancelled.push(...ids);
      return new Promise(() => {});
    },
  });
  const extension = extensionHarness();
  const tasks = Array.from({ length: 513 }, (_, index) => ({
    id: index + 1,
    subject: `abandoned ${index}`,
    status: "in_progress",
    metadata: {
      preparation: {
        status: "ready",
        token: `owner-token-${index}`,
        approval: "granted",
        approvalRequired: false,
      },
      delegation: {
        status: "running",
        todoId: index + 1,
        todoToken: `owner-token-${index}`,
        subagentIds: [`abandoned-worker-${index}`],
      },
    },
  }));
  const ctx = {
    hasUI: false,
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: TODO_SNAPSHOT_TYPE,
          data: createTodoSnapshot({ tasks: [], nextId: 1, revision: 1 }),
        },
      ],
    },
  };
  try {
    await extension.start();
    commitState({ tasks, nextId: 514, revision: 1 });
    await extension.emit("session_tree", {}, ctx);
    assert.equal(getState().tasks.length, 0);
    assert.equal(
      getState().cancellationCapacityError,
      CANCELLATION_CAPACITY_ERROR,
    );
    assert.equal(cancelled.length, 513);
    assert.equal(getState().cancellationIntents?.length, 256);
    assert.equal(getState().cancellationOverflow?.length, 256);
    assert.equal(getState().cancellationQuarantine?.length, 1);
    const persisted = createTodoSnapshot(getState());
    await extension.shutdown();
    unregister();
    const replayedCancelled = [];
    const unregisterReplay = registerBackgroundSubagentService({
      async run() {
        throw new Error("not used");
      },
      async cancel(ids) {
        replayedCancelled.push(...ids);
      },
    });
    const replayed = extensionHarness([
      {
        type: "custom",
        customType: TODO_SNAPSHOT_TYPE,
        data: persisted,
      },
    ]);
    try {
      await replayed.start();
      assert.deepEqual(replayedCancelled, []);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(getState().cancellationIntents?.length, 256);
      assert.equal(getState().cancellationOverflow?.length, 256);
      assert.equal(getState().cancellationQuarantine?.length, 1);
      assert.equal(
        getState().cancellationCapacityError,
        CANCELLATION_CAPACITY_ERROR,
      );
    } finally {
      await replayed.shutdown();
      unregisterReplay();
    }
  } finally {
    if (getState().cancellationQuarantine?.length) await extension.shutdown();
  }
});

test("session tree holds a branch when full replay recovery plus abandoned owners exceeds the bound", async () => {
  __resetState();
  const extension = extensionHarness();
  const primary = Array.from({ length: 256 }, (_, index) => ({
    kind: "delegation",
    taskId: index + 1000,
    token: `branch-primary-${index}`,
    ids: [`branch-primary-worker-${index}`],
    generation: 1,
    attempts: 3,
    correlationId: "a".repeat(32),
  }));
  const overflow = Array.from({ length: 256 }, (_, index) => ({
    kind: "preparation",
    taskId: index + 2000,
    token: `branch-overflow-${index}`,
    ids: [`branch-overflow-worker-${index}`],
    generation: 1,
    attempts: 3,
    workerGeneration: 1,
    correlationId: "b".repeat(32),
  }));
  const tasks = Array.from({ length: 513 }, (_, index) => ({
    id: index + 1,
    subject: `abandoned ${index}`,
    status: "in_progress",
    metadata: {
      preparation: {
        status: "ready",
        token: `owner-token-${index}`,
        approval: "granted",
        approvalRequired: false,
      },
      delegation: {
        status: "running",
        todoId: index + 1,
        todoToken: `owner-token-${index}`,
        subagentIds: [`abandoned-worker-${index}`],
      },
    },
  }));
  const branch = {
    type: "custom",
    customType: TODO_SNAPSHOT_TYPE,
    data: createTodoSnapshot({
      tasks: [],
      nextId: 1,
      revision: 3,
      cancellationIntents: primary,
      cancellationOverflow: overflow,
    }),
  };
  try {
    await extension.start();
    commitState({ tasks, nextId: 514, revision: 2 });
    const before = getState();
    await assert.rejects(
      extension.emit(
        "session_tree",
        {},
        { hasUI: false, sessionManager: { getBranch: () => [branch] } },
      ),
      /recovery exceeds replay bound/,
    );
    assert.deepEqual(getState().tasks, before.tasks);
    assert.equal(getState().cancellationIntents?.length, 256);
    assert.equal(getState().cancellationOverflow?.length, 256);
    assert.equal(getState().cancellationQuarantine?.length, 1);
    assert.equal(
      getState().cancellationCapacityError,
      CANCELLATION_CAPACITY_ERROR,
    );
    assert.equal(
      packageAssignmentError(packageRequest(1, "stale-token")),
      "package_handoff assignment gate unavailable.",
    );
    await extension.emit(
      "session_start",
      {},
      {
        mode: "print",
        hasUI: false,
        sessionManager: { getBranch: () => [branch] },
      },
    );
    assert.notEqual(
      packageAssignmentError(packageRequest(1, "stale-token")),
      "package_handoff assignment gate unavailable.",
    );
  } finally {
    await extension.shutdown();
  }
});

test("prepared siblings continue without per-TODO approval prompts", async () => {
  __resetState();
  const preparedTask = (id) => ({
    id,
    subject: `Prepare TODO ${id}`,
    status: "pending",
    metadata: {
      preparation: {
        status: "ready",
        token: `approval-${id}`,
        classifier: { status: "ready" },
        analysisCwd: currentTarget.path,
        analysisCwdIdentity: currentTarget.identity,
        scope: [`${"scope evidence ".repeat(200)} for TODO #${id}`],
        steps: [`${"step evidence ".repeat(100)} for TODO #${id}`],
        risks: [`${"risk evidence ".repeat(100)} for TODO #${id}`],
        decisions: [`${"decision evidence ".repeat(100)} for TODO #${id}`],
        questions: [
          `${"required decision evidence ".repeat(100)} for TODO #${id}`,
        ],
      },
    },
  });
  const branch = [
    {
      type: "custom",
      customType: TODO_SNAPSHOT_TYPE,
      data: createTodoSnapshot({
        tasks: [preparedTask(29), preparedTask(30)],
        nextId: 31,
        revision: 1,
      }),
    },
  ];
  const extension = extensionHarness(branch, {
    mode: "print",
    hasUI: false,
    cwd: process.cwd(),
    sessionManager: { getBranch: () => branch },
  });
  await extension.start();
  try {
    const automatic = () =>
      extension.messages.filter(
        ({ message }) => message.customType === "rpiv-todo:auto-continue",
      );
    assert.equal(automatic().length, 1);
    assert.match(automatic()[0].message.content, /TODO #29/);
    assert.doesNotMatch(
      automatic()[0].message.content,
      /ask_user|Approve TODO/,
    );
    assert.equal(getState().tasks[0].status, "pending");
    assert.equal(getState().tasks[1].status, "pending");
    assert.equal(publicTodoState(getState().tasks[0]), "ready");
    assert.equal(publicTodoState(getState().tasks[1]), "ready");
    assert.equal(getState().tasks[0].wait, undefined);
    assert.equal(getState().tasks[1].wait, undefined);
    await extension.emit("agent_start", {});
    await extension.emit("agent_settled", {}, {});
    assert.equal(automatic().length, 2);
    assert.match(automatic()[1].message.content, /TODO #29/);
    assert.doesNotMatch(
      automatic()[1].message.content,
      /ask_user|Approve TODO/,
    );
  } finally {
    await extension.shutdown();
  }
});

test("replay migrates a prepared task without dispatching a plan approval", async () => {
  __resetState();
  const question =
    'Approve prepared plan for TODO #30 (select "Approve TODO #30" to continue).';
  const state = {
    tasks: [
      {
        id: 30,
        subject: "Dogfood approval",
        status: "waiting:user",
        wait: { kind: "user", questions: [question] },
        metadata: {
          preparation: {
            status: "awaiting_approval",
            approval: "awaiting_approval",
            approvalRequired: true,
            approvalQuestion: question,
            token: "dogfood-token",
            analysisCwd: currentTarget.path,
            analysisCwdIdentity: currentTarget.identity,
          },
        },
      },
    ],
    nextId: 31,
    revision: 1,
  };
  const branch = [
    {
      type: "custom",
      customType: TODO_SNAPSHOT_TYPE,
      data: createTodoSnapshot(state),
    },
  ];
  const extension = extensionHarness(branch, {
    mode: "print",
    hasUI: false,
    cwd: process.cwd(),
    sessionManager: { getBranch: () => branch },
  });
  await extension.start();
  try {
    const automatic = () =>
      extension.messages.filter(
        ({ message }) => message.customType === "rpiv-todo:auto-continue",
      );
    assert.equal(automatic().length, 1);
    await extension.shutdown();
    await extension.start({
      mode: "print",
      hasUI: false,
      cwd: process.cwd(),
      sessionManager: { getBranch: () => branch },
    });
    assert.equal(automatic().length, 2);

    await extension.emit("tool_execution_end", {
      toolCallId: "unstarted-approval",
      isError: false,
      toolName: "ask_user",
      result: { details: { question, answer: "Approve TODO #30" } },
    });
    assert.equal(getState().tasks[0].status, "pending");

    await extension.emit("tool_execution_start", {
      toolCallId: "approval-30-reloaded",
      toolName: "ask_user",
      args: { question },
    });
    await extension.emit("tool_execution_end", {
      toolCallId: "approval-30-reloaded",
      isError: false,
      toolName: "ask_user",
      result: { details: { question, answer: "Approve TODO #30" } },
    });
    assert.equal(getState().tasks[0].status, "pending");
    assert.equal(publicTodoState(getState().tasks[0]), "ready");
    assert.equal(getState().tasks[0].metadata.preparation.approval, undefined);
    assert.equal(automatic().length, 2);
  } finally {
    await extension.shutdown();
  }
});

test("reload removes obsolete completion-review decisions and preserves real questions", async () => {
  __resetState();
  const obsolete =
    "Completion review for TODO #1 failed repeatedly: workspace changed. Choose whether to retry or revise evidence.";
  const ordinary = "Answer the ordinary review question";
  const state = {
    tasks: [
      {
        id: 1,
        subject: "Recover review wait",
        status: "waiting:user",
        result: "done",
        evidence: ["checked"],
        review: {
          status: "rejected",
          generation: 1,
          token: "review-token-1",
          completionRevision: 1,
          requestedAt: 1,
          attempts: 3,
          failedAt: 2,
          reviewer: { id: "reviewer", model: "model" },
          feedback: "workspace changed",
        },
        wait: { kind: "user", questions: [ordinary, obsolete] },
      },
    ],
    nextId: 2,
    revision: 1,
  };
  const branch = [
    {
      type: "custom",
      customType: TODO_SNAPSHOT_TYPE,
      data: createTodoSnapshot(state),
    },
  ];
  const context = {
    mode: "print",
    hasUI: false,
    cwd: process.cwd(),
    sessionManager: { getBranch: () => branch },
  };
  const extension = extensionHarness(branch, context);
  try {
    await extension.start(context);
    assert.equal(getState().tasks[0].status, "waiting:user");
    assert.deepEqual(getState().tasks[0].wait.questions, [ordinary]);
    assert.equal(
      extension.messages.some(({ message }) =>
        String(message.content).includes("retry or revise evidence"),
      ),
      false,
    );
    await extension.emit("tool_execution_start", {
      toolCallId: "obsolete-review-answer",
      toolName: "ask_user",
      args: { question: obsolete },
    });
    await extension.emit("tool_execution_end", {
      toolCallId: "obsolete-review-answer",
      isError: false,
      toolName: "ask_user",
      result: { details: { question: obsolete, answer: "Retry" } },
    });
    assert.deepEqual(getState().tasks[0].wait.questions, [ordinary]);
  } finally {
    await extension.shutdown();
  }
});

test("session shutdown closes ordinary ask_user lifecycle before disposing the scheduler", async () => {
  __resetState();
  const extension = extensionHarness();
  const question = "Which region should be used?";
  await extension.start();
  commitState({
    tasks: [
      {
        id: 1,
        subject: "Closed-session ordinary question",
        status: "waiting:user",
        wait: { kind: "user", questions: [question] },
      },
    ],
    nextId: 2,
    revision: 1,
  });
  await extension.emit("tool_execution_start", {
    toolCallId: "closed-session-ask",
    toolName: "ask_user",
    args: { question },
  });
  assert.equal(
    typeof getState().tasks[0].metadata.askUserCorrelation?.lifecycleNonce,
    "number",
  );
  await extension.emit("tool_execution_start", {
    toolCallId: "closed-session-tool",
    toolName: "bash",
  });
  await extension.shutdown();
  assert.equal(getState().tasks[0].metadata.askUserCorrelation, undefined);
  const closedState = structuredClone(getState());

  commitState({
    ...closedState,
    tasks: [
      {
        id: 1,
        subject: "Closed-session ordinary wait",
        status: "waiting:user",
        wait: { kind: "user", questions: ["Answer me"] },
      },
    ],
    revision: closedState.revision + 1,
  });
  const beforeLateCallbacks = structuredClone(getState());
  await extension.emit("input", { source: "interactive", text: "late answer" });
  await extension.emit("agent_start", {});
  await extension.emit("agent_end", {
    messages: [{ role: "assistant", stopReason: "stop" }],
  });
  await extension.emit("agent_settled", {}, {});
  await extension.emit("tool_execution_end", {
    isError: false,
    toolCallId: "closed-session-tool",
    toolName: "bash",
  });
  assert.deepEqual(getState(), beforeLateCallbacks);

  await extension.emit("tool_execution_start", {
    toolCallId: "closed-session-ask",
    toolName: "ask_user",
    args: { question },
  });
  await extension.emit("tool_execution_end", {
    isError: false,
    toolCallId: "closed-session-ask",
    toolName: "ask_user",
    result: { details: { question, answer: "Europe" } },
  });
  assert.deepEqual(getState(), beforeLateCallbacks);
});

test("concurrent ask_user starts keep the first live task correlation", async () => {
  __resetState();
  const extension = extensionHarness();
  const question = "Choose one region";
  await extension.start();
  commitState({
    tasks: [
      {
        id: 1,
        subject: "Choose region",
        status: "waiting:user",
        wait: { kind: "user", questions: [question] },
      },
    ],
    nextId: 2,
    revision: 1,
  });
  try {
    await extension.emit("tool_execution_start", {
      toolCallId: "first-ask",
      toolName: "ask_user",
      args: { question },
    });
    assert.equal(
      getState().tasks[0].metadata.askUserCorrelation.toolCallId,
      "first-ask",
    );
    await extension.emit("tool_execution_start", {
      toolCallId: "second-ask",
      toolName: "ask_user",
      args: { question },
    });
    assert.equal(
      getState().tasks[0].metadata.askUserCorrelation.toolCallId,
      "first-ask",
    );
    await extension.emit("tool_execution_end", {
      toolCallId: "second-ask",
      toolName: "ask_user",
      isError: false,
      result: { details: { question, cancelled: true } },
    });
    assert.equal(
      getState().tasks[0].metadata.askUserCorrelation.toolCallId,
      "first-ask",
    );
    await extension.emit("tool_execution_end", {
      toolCallId: "first-ask",
      toolName: "ask_user",
      isError: false,
      result: { details: { question, answer: "Europe" } },
    });
    assert.equal(getState().tasks[0].status, "pending");
    assert.equal(getState().tasks[0].metadata?.askUserCorrelation, undefined);
  } finally {
    await extension.shutdown();
  }
});

test("ask_user cancelled and explanation results preserve ordinary correlation", async () => {
  for (const terminalFlag of ["cancelled", "explanationRequested"]) {
    __resetState();
    const extension = extensionHarness();
    const question = "Choose a region";
    await extension.start();
    commitState({
      tasks: [
        {
          id: 1,
          subject: `Terminal ${terminalFlag}`,
          status: "waiting:user",
          wait: { kind: "user", questions: [question] },
        },
      ],
      nextId: 2,
      revision: 1,
    });
    try {
      await extension.emit("tool_execution_start", {
        toolCallId: `terminal-${terminalFlag}`,
        toolName: "ask_user",
        args: { question },
      });
      await extension.emit("tool_execution_end", {
        isError: false,
        toolCallId: `terminal-${terminalFlag}`,
        toolName: "ask_user",
        result: { details: { question, [terminalFlag]: true } },
      });
      assert.equal(
        getState().tasks[0].metadata.askUserCorrelation.toolCallId,
        `terminal-${terminalFlag}`,
        terminalFlag,
      );
      assert.equal(
        getState().tasks[0].metadata.askUserCorrelation.retryable,
        true,
        terminalFlag,
      );
      assert.equal(getState().tasks[0].status, "waiting:user", terminalFlag);
    } finally {
      await extension.shutdown();
    }
  }
});

test("ask_user errors and malformed results retain correlation for bounded retry", async () => {
  for (const terminal of ["error", "malformed"]) {
    __resetState();
    const extension = extensionHarness();
    const question = "Choose a region";
    await extension.start();
    commitState({
      tasks: [
        {
          id: 1,
          subject: `Malformed ${terminal}`,
          status: "waiting:user",
          wait: { kind: "user", questions: [question] },
        },
      ],
      nextId: 2,
      revision: 1,
    });
    try {
      await extension.emit("tool_execution_start", {
        toolCallId: `terminal-${terminal}`,
        toolName: "ask_user",
        args: { question },
      });
      await extension.emit(
        "tool_execution_end",
        terminal === "error"
          ? {
              isError: true,
              toolCallId: `terminal-${terminal}`,
              toolName: "ask_user",
              result: { details: { question, answer: "Approve TODO #1" } },
            }
          : {
              isError: false,
              toolCallId: `terminal-${terminal}`,
              toolName: "ask_user",
              result: { details: { question, answer: { approve: true } } },
            },
      );
      assert.equal(
        getState().tasks[0].metadata.askUserCorrelation.toolCallId,
        `terminal-${terminal}`,
        terminal,
      );
      assert.equal(
        getState().tasks[0].metadata.askUserCorrelation.retryable,
        true,
        terminal,
      );
      await extension.emit("tool_execution_start", {
        toolCallId: `retry-${terminal}`,
        toolName: "ask_user",
        args: { question },
      });
      assert.equal(
        getState().tasks[0].metadata.askUserCorrelation.toolCallId,
        `retry-${terminal}`,
        terminal,
      );
      await extension.emit("tool_execution_end", {
        isError: false,
        toolCallId: `retry-${terminal}`,
        toolName: "ask_user",
        result: { details: { question, answer: "Europe" } },
      });
      assert.equal(getState().tasks[0].status, "pending", terminal);
    } finally {
      await extension.shutdown();
    }
  }
});

test("ask_user clarification answers stay bound to the prompted preparation incarnation across replay", async () => {
  __resetState();
  const extension = extensionHarness();
  const question = "What missing scope should preparation cover?";
  await extension.start();
  commitState({
    tasks: [
      {
        id: 1,
        subject: "Clarification incarnation race",
        status: "waiting:user",
        wait: { kind: "user", questions: [question] },
        metadata: {
          preparation: { status: "insufficient", token: "clarification-old" },
        },
      },
    ],
    nextId: 2,
    revision: 1,
  });
  try {
    await extension.emit("tool_execution_start", {
      toolCallId: "clarification-old-call",
      toolName: "ask_user",
      args: { question },
    });
    const replayCtx = {
      hasUI: false,
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: TODO_SNAPSHOT_TYPE,
            data: createTodoSnapshot(getState()),
          },
        ],
      },
    };
    await extension.emit("session_start", {}, replayCtx);
    commitState({
      ...getState(),
      tasks: getState().tasks.map((task) => ({
        ...task,
        metadata: (() => {
          const metadata = { ...task.metadata };
          delete metadata.askUserCorrelation;
          metadata.preparation = {
            ...task.metadata.preparation,
            token: "clarification-new",
          };
          return metadata;
        })(),
      })),
      revision: getState().revision + 1,
    });
    await extension.emit("tool_execution_start", {
      toolCallId: "clarification-new-call",
      toolName: "ask_user",
      args: { question },
    });
    const beforeOldAnswer = structuredClone(getState());
    await extension.emit("tool_execution_end", {
      isError: false,
      toolCallId: "clarification-old-call",
      toolName: "ask_user",
      result: { details: { question, answer: "old clarification" } },
    });
    assert.deepEqual(getState(), beforeOldAnswer);
    await extension.emit("tool_execution_end", {
      isError: false,
      toolCallId: "clarification-new-call",
      toolName: "ask_user",
      result: { details: { question, answer: "new clarification" } },
    });
    assert.equal(getState().tasks[0].status, "pending");
    assert.equal(getState().tasks[0].metadata.preparation.status, "queued");
    assert.equal(
      getState().tasks[0].metadata.preparation.clarification,
      "new clarification",
    );
  } finally {
    await extension.shutdown();
  }
});

test("ask_user preserves ambiguity across ordinary waits", async () => {
  __resetState();
  const extension = extensionHarness();
  const question = "Which region?";
  await extension.start();
  commitState({
    tasks: [
      {
        id: 1,
        subject: "Approve target",
        status: "waiting:user",
        wait: { kind: "user", questions: [question] },
      },
      {
        id: 2,
        subject: "Answer ordinary target",
        status: "waiting:user",
        wait: { kind: "user", questions: [question] },
      },
    ],
    nextId: 3,
    revision: 1,
  });
  try {
    const before = structuredClone(getState());
    await extension.emit("tool_execution_end", {
      isError: false,
      toolName: "ask_user",
      result: { details: { question, answer: "Approve TODO #1" } },
    });
    assert.deepEqual(getState(), before);
  } finally {
    await extension.shutdown();
  }
});

test("ask_user ignores malformed non-string answers", async () => {
  __resetState();
  const extension = extensionHarness();
  const question = "Which region?";
  await extension.start();
  commitState({
    tasks: [
      {
        id: 1,
        subject: "Ordinary target",
        status: "waiting:user",
        wait: { kind: "user", questions: [question] },
      },
      {
        id: 2,
        subject: "Ordinary target",
        status: "waiting:user",
        wait: { kind: "user", questions: ["Choose scope"] },
      },
    ],
    nextId: 3,
    revision: 1,
  });
  try {
    const before = structuredClone(getState());
    await extension.emit("tool_execution_end", {
      isError: false,
      toolName: "ask_user",
      result: { details: { question, answer: { approve: true } } },
    });
    await extension.emit("tool_execution_end", {
      isError: false,
      toolName: "ask_user",
      result: { details: { question: "Choose scope", answer: ["Europe"] } },
    });
    assert.deepEqual(getState(), before);
  } finally {
    await extension.shutdown();
  }
});

test("ask_user ignores malformed event payloads without resolving waits", async () => {
  __resetState();
  const extension = extensionHarness();
  const question = "Choose scope";
  await extension.start();
  commitState({
    tasks: [
      {
        id: 1,
        subject: "Ordinary target",
        status: "waiting:user",
        wait: { kind: "user", questions: [question] },
      },
    ],
    nextId: 2,
    revision: 1,
  });
  try {
    const before = structuredClone(getState());
    const malformed = [
      undefined,
      null,
      [],
      "details",
      {},
      { question, answer: "" },
      { question: "", answer: "Europe" },
      { question, answer: "Europe", cancelled: 0 },
      { question, answer: "Europe", explanationRequested: null },
      { question, answer: false },
    ];
    for (const details of malformed) {
      await extension.emit("tool_execution_end", {
        isError: false,
        toolName: "ask_user",
        ...(details === undefined ? {} : { result: { details } }),
      });
    }
    assert.deepEqual(getState(), before);
  } finally {
    await extension.shutdown();
  }
});

test("ask_user normalizes a valid ordinary multi-select answer", async () => {
  __resetState();
  const extension = extensionHarness();
  await extension.start();
  commitState({
    tasks: [
      {
        id: 1,
        subject: "Choose regions",
        status: "waiting:user",
        wait: { kind: "user", questions: ["Which regions?"] },
      },
    ],
    nextId: 2,
    revision: 1,
  });
  try {
    await extension.emit("tool_execution_end", {
      isError: false,
      toolName: "ask_user",
      result: {
        details: {
          question: "Which regions?",
          answer: null,
          answers: ["Europe", "Asia"],
        },
      },
    });
    assert.equal(getState().tasks[0].status, "pending");
    assert.equal(getState().tasks[0].wait, undefined);
  } finally {
    await extension.shutdown();
  }
});

test("ask_user answers multi-question waits one correlated question at a time", async () => {
  __resetState();
  const extension = extensionHarness();
  await extension.start();
  commitState({
    tasks: [
      {
        id: 1,
        subject: "Choose deployment",
        status: "waiting:user",
        wait: { kind: "user", questions: ["Which region?", "Which owner?"] },
      },
    ],
    nextId: 2,
    revision: 1,
  });
  try {
    await extension.emit("tool_execution_start", {
      toolCallId: "ask-owner",
      toolName: "ask_user",
      args: { question: "Which owner?" },
    });
    await extension.emit("tool_execution_end", {
      toolCallId: "ask-owner",
      isError: false,
      toolName: "ask_user",
      result: { details: { question: "Which owner?", answer: "Ada" } },
    });
    assert.equal(getState().tasks[0].status, "waiting:user");
    assert.deepEqual(getState().tasks[0].wait.questions, ["Which region?"]);

    await extension.emit("tool_execution_start", {
      toolCallId: "ask-region",
      toolName: "ask_user",
      args: { question: "Which region?" },
    });
    await extension.emit("tool_execution_end", {
      toolCallId: "ask-region",
      isError: false,
      toolName: "ask_user",
      result: { details: { question: "Which region?", answer: "EU" } },
    });
    assert.equal(getState().tasks[0].status, "pending");
    assert.equal(getState().tasks[0].wait, undefined);
  } finally {
    await extension.shutdown();
  }
});

test("ordinary tool churn cannot evict ask_user tombstones or allow ID reuse", async () => {
  __resetState();
  const extension = extensionHarness();
  await extension.start();
  commitState({
    tasks: [
      {
        id: 1,
        subject: "Choose region",
        status: "waiting:user",
        wait: { kind: "user", questions: ["Which region?"] },
      },
    ],
    nextId: 2,
    revision: 1,
  });
  try {
    for (let index = 0; index < 257; index++) {
      const toolCallId = `retired-${index}`;
      await extension.emit("tool_execution_start", {
        toolCallId,
        toolName: "bash",
        args: {},
      });
      await extension.emit("tool_execution_end", {
        toolCallId,
        isError: false,
        toolName: "bash",
      });
    }
    await extension.emit("tool_execution_start", {
      toolCallId: "retired-0",
      toolName: "ask_user",
      args: { question: "Which region?" },
    });
    await extension.emit("tool_execution_end", {
      toolCallId: "retired-0",
      isError: false,
      toolName: "ask_user",
      result: { details: { question: "Which region?", answer: "EU" } },
    });
    assert.equal(getState().tasks[0].status, "waiting:user");
    await extension.emit("tool_execution_start", {
      toolCallId: "fresh-ask",
      toolName: "ask_user",
      args: { question: "Which region?" },
    });
    await extension.emit("tool_execution_end", {
      toolCallId: "fresh-ask",
      isError: false,
      toolName: "ask_user",
      result: { details: { question: "Which region?", answer: "EU" } },
    });
    assert.equal(getState().tasks[0].status, "pending");
    const afterAnswer = structuredClone(getState());
    await extension.emit("tool_execution_end", {
      toolCallId: "fresh-ask",
      isError: false,
      toolName: "ask_user",
      result: { details: { question: "Which region?", answer: "stale" } },
    });
    assert.deepEqual(getState(), afterAnswer);
  } finally {
    await extension.shutdown();
  }
});

test("active tool ownership requires the original tool name", async () => {
  __resetState();
  const extension = extensionHarness();
  await extension.start();
  commitState({
    tasks: [
      {
        id: 1,
        subject: "Choose region",
        status: "waiting:user",
        wait: { kind: "user", questions: ["Which region?"] },
      },
    ],
    nextId: 2,
    revision: 1,
  });
  try {
    await extension.emit("tool_execution_start", {
      toolCallId: "active-ask",
      toolName: "ask_user",
      args: { question: "Which region?" },
    });
    const beforeWrongEnd = structuredClone(getState());
    await extension.emit("tool_execution_end", {
      toolCallId: "active-ask",
      isError: false,
      toolName: "bash",
    });
    assert.deepEqual(getState(), beforeWrongEnd);
    await extension.emit("tool_execution_end", {
      toolCallId: "active-ask",
      isError: false,
      toolName: "ask_user",
      result: { details: { question: "Which region?", answer: "EU" } },
    });
    assert.equal(getState().tasks[0].status, "pending");
  } finally {
    await extension.shutdown();
  }
});

test("plain text preserves zero or ambiguous ordinary waiting questions", async () => {
  __resetState();
  const extension = extensionHarness();
  await extension.start();
  try {
    commitState({ tasks: [], nextId: 1, revision: 1 });
    await extension.emit("input", { source: "interactive", text: "Europe" });
    assert.deepEqual(getState().tasks, []);

    commitState({
      tasks: [
        {
          id: 1,
          subject: "Choose region",
          status: "waiting:user",
          wait: { kind: "user", questions: ["Which region?"] },
        },
        {
          id: 2,
          subject: "Choose owner",
          status: "waiting:user",
          wait: { kind: "user", questions: ["Which owner?"] },
        },
      ],
      nextId: 3,
      revision: 2,
    });
    const before = structuredClone(getState());
    await extension.emit("input", { source: "interactive", text: "Europe" });
    assert.deepEqual(getState(), before);
  } finally {
    await extension.shutdown();
  }
});

test("plain command input does not answer an ordinary waiting question", async () => {
  __resetState();
  const extension = extensionHarness();
  await extension.start();
  try {
    commitState({
      tasks: [
        {
          id: 1,
          subject: "Choose region",
          status: "waiting:user",
          wait: { kind: "user", questions: ["Which region?"] },
        },
      ],
      nextId: 2,
      revision: 1,
    });
    for (const text of ["/todos", "/todo rearm #1", "/orchestrator off"]) {
      const before = structuredClone(getState());
      await extension.emit("input", { source: "interactive", text });
      assert.deepEqual(getState(), before);
    }
  } finally {
    await extension.shutdown();
  }
});

test("ask_user preserves duplicate ordinary persisted questions", async () => {
  __resetState();
  const extension = extensionHarness();
  await extension.start();
  try {
    commitState({
      tasks: [
        {
          id: 1,
          subject: "Choose region A",
          status: "waiting:user",
          wait: { kind: "user", questions: ["Which region?"] },
        },
        {
          id: 2,
          subject: "Choose region B",
          status: "waiting:user",
          wait: { kind: "user", questions: ["Which region?"] },
        },
      ],
      nextId: 3,
      revision: 1,
    });
    const before = structuredClone(getState());
    await extension.emit("tool_execution_end", {
      isError: false,
      toolName: "ask_user",
      result: { details: { question: "Which region?", answer: "Europe" } },
    });
    assert.deepEqual(getState(), before);
  } finally {
    await extension.shutdown();
  }
});

test("plain text preserves a single waiting task with multiple questions", async () => {
  __resetState();
  const extension = extensionHarness();
  await extension.start();
  try {
    commitState({
      tasks: [
        {
          id: 1,
          subject: "Choose deployment",
          status: "waiting:user",
          wait: { kind: "user", questions: ["Which region?", "Which owner?"] },
        },
      ],
      nextId: 2,
      revision: 1,
    });
    const before = structuredClone(getState());
    await extension.emit("input", { source: "interactive", text: "Europe" });
    assert.deepEqual(getState(), before);
  } finally {
    await extension.shutdown();
  }
});

test("plain text does not answer one ordinary persisted waiting question", async () => {
  __resetState();
  const extension = extensionHarness();
  await extension.start();
  commitState({
    tasks: [
      {
        id: 1,
        subject: "Choose region",
        status: "waiting:user",
        wait: { kind: "user", questions: ["Which region?"] },
      },
    ],
    nextId: 2,
    revision: 1,
  });
  try {
    await extension.emit("input", { source: "interactive", text: "Europe" });
    assert.equal(getState().tasks[0].status, "waiting:user");
    assert.deepEqual(getState().tasks[0].wait, {
      kind: "user",
      questions: ["Which region?"],
    });
  } finally {
    await extension.shutdown();
  }
});
