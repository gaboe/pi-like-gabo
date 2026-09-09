import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import todoExtension from "../todo/index.ts";
import { __resetState } from "../todo/todo.ts";
import { commitState, getState } from "../todo/state/store.ts";
import {
  createTodoSnapshot,
  replayFromBranch,
  TODO_SNAPSHOT_TYPE,
} from "../todo/state/replay.ts";
import { registerBackgroundSubagentService } from "../../vendor/pi-tools/extensions/shared/background-subagent-protocol.ts";
import {
  TELEMETRY_CHANNEL,
  backgroundTerminalTelemetry,
  categorizeTelemetryError,
  jobLifecycleTelemetry,
  normalizeTelemetryEvent,
} from "./protocol.ts";
import { TELEMETRY_FILE, TelemetryWriter } from "./writer.ts";

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

test("schema allowlists metadata and drops producer payloads", () => {
  const mapped = jobLifecycleTelemetry({
    type: "failed",
    jobId: "job-deadbeef",
    kind: "poll",
    status: "failed",
    attempt: 2,
    durationMs: 45,
    title: "secret title",
    reason: "token=secret",
    event: { data: "prompt and output" },
    url: "https://secret.example/path",
  });
  const record = normalizeTelemetryEvent(
    {
      ...mapped,
      prompt: "private prompt",
      toolArguments: { command: "rm secret" },
      path: "/private/file",
    },
    0,
  );
  assert.deepEqual(record, {
    v: 1,
    ts: "1970-01-01T00:00:00.000Z",
    type: "job",
    action: "failed",
    kind: "poll",
    status: "failed",
    attempt: 2,
    durationMs: 45,
  });
  assert.doesNotMatch(
    JSON.stringify(record),
    /secret|prompt|command|url|path|title|reason|event/i,
  );
  assert.doesNotMatch(
    JSON.stringify(
      normalizeTelemetryEvent({ ...mapped, jobId: "/private/file" }),
    ),
    /jobId|private/,
  );
  assert.equal(
    categorizeTelemetryError("provider leaked token abc"),
    "provider",
  );
  assert.equal(
    normalizeTelemetryEvent({
      type: "workflow_agent",
      runId: "run-1",
      agentIndex: 1,
      phase: "settle",
      status: "completed",
      turns: 5,
      maxTurns: 4,
      durationMs: 10,
    }),
    undefined,
  );
});

test("background terminal mapping excludes command, output, path, and error text", () => {
  const event = backgroundTerminalTelemetry(
    {
      id: "bt-3",
      status: "failed",
      createdAt: 100,
      settledAt: 160,
      exitCode: 9,
      command: "print-secret",
      cwd: "/private/work",
      errorText: "token=secret",
      stdout: { text: "secret output" },
    },
    "settle",
  );
  assert.deepEqual(event, {
    type: "background_terminal",
    phase: "settle",
    status: "failed",
    durationMs: 60,
    exitCategory: "nonzero",
  });
});

test("writer enforces private permissions and bounded rotation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-telemetry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "telemetry");
  const writer = new TelemetryWriter(directory, { maxBytes: 360, archives: 2 });
  try {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        writer.write({
          type: "todo_state",
          taskId: index + 1,
          status: index % 2 ? "completed" : "pending",
        }),
      ),
    );
  } catch (error) {
    assert.fail(`telemetry writes must not reject: ${String(error)}`);
  }
  await writer.close();
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const files = (await readdir(directory)).sort();
  assert.deepEqual(files, [
    TELEMETRY_FILE,
    `${TELEMETRY_FILE}.1`,
    `${TELEMETRY_FILE}.2`,
  ]);
  for (const file of files) {
    assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
    for (const line of (await readFile(join(directory, file), "utf8"))
      .trim()
      .split("\n")) {
      assert.equal(JSON.parse(line).v, 1);
    }
  }
});

test("TODO producer emits state and no-progress metadata only", async () => {
  __resetState();
  const bus = new Bus();
  const lifecycle = new Map();
  let tool;
  const events = [];
  bus.on(TELEMETRY_CHANNEL, (event) => events.push(event));
  const pi = {
    events: bus,
    on(name, handler) {
      const handlers = lifecycle.get(name) ?? [];
      handlers.push(handler);
      lifecycle.set(name, handlers);
    },
    registerTool(definition) {
      tool = definition;
    },
    registerCommand() {},
    appendEntry() {},
    sendMessage() {},
  };
  todoExtension(pi);
  const ctx = { hasUI: false, sessionManager: { getBranch: () => [] } };
  await lifecycle.get("session_start")[0]({}, ctx);
  await tool.execute("call", { action: "create", subject: "never logged" });
  await tool.execute("call", {
    action: "update",
    id: 1,
    description: "also never logged",
  });
  for (let attempt = 0; attempt < 20; attempt++) {
    const status = getState().tasks[0]?.metadata?.preparation?.status;
    if (status !== "queued" && status !== "running") break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  await lifecycle.get("agent_settled")[0]({}, ctx);
  await lifecycle.get("agent_start")[0]();
  await lifecycle.get("agent_settled")[0]({}, ctx);
  await lifecycle.get("agent_start")[0]();
  await lifecycle.get("agent_settled")[0]({}, ctx);
  const todoEvents = events.filter((event) => event.type.startsWith("todo"));
  assert.deepEqual(todoEvents[0], {
    type: "todo_state",
    status: "ready",
  });
  assert.deepEqual(
    [...new Set(todoEvents.map((event) => event.status))].sort(),
    ["failed", "preparing", "ready"],
  );
  assert.equal(todoEvents.at(-1).type, "todo_no_progress");
  assert.equal(todoEvents.at(-1).status, "failed");
  assert.ok(
    todoEvents.every(
      (event) => Object.keys(event).sort().join(",") === "status,type",
    ),
  );
  for (const status of ["pending", "deleted"]) {
    assert.equal(
      normalizeTelemetryEvent({
        type: "todo_state",
        taskId: 1,
        status,
      }),
      undefined,
    );
  }
  await lifecycle.get("session_shutdown")[0]();
});

test("TODO producer emits low-cardinality cancellation transitions", async () => {
  __resetState();
  const bus = new Bus();
  const lifecycle = new Map();
  const events = [];
  bus.on(TELEMETRY_CHANNEL, (event) => events.push(event));
  const pi = {
    events: bus,
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
  const ctx = { hasUI: false, sessionManager: { getBranch: () => [] } };
  await lifecycle.get("session_start")[0]({}, ctx);
  const base = {
    tasks: [
      {
        id: 1,
        subject: "safe task",
        status: "in_progress",
        metadata: {
          delegation: {
            status: "cancelling",
            cancellationAttempts: 0,
          },
        },
      },
    ],
    nextId: 2,
    revision: 1,
  };
  commitState(base);
  commitState({
    ...base,
    revision: 2,
    tasks: [
      {
        ...base.tasks[0],
        metadata: {
          delegation: {
            ...base.tasks[0].metadata.delegation,
            cancellationAttempts: 1,
            cancellationError: "temporary",
          },
        },
      },
    ],
  });
  commitState({
    ...base,
    revision: 3,
    tasks: [
      {
        ...base.tasks[0],
        metadata: {
          delegation: {
            ...base.tasks[0].metadata.delegation,
            cancellationAttempts: 3,
            cancellationError: "permanent",
          },
        },
      },
    ],
  });
  commitState({
    ...base,
    revision: 4,
    tasks: [
      { ...base.tasks[0], metadata: { delegation: { status: "cancelled" } } },
    ],
    cancellationIntents: [],
  });
  assert.deepEqual(
    events.filter((event) => event.type === "todo_cancellation"),
    [
      { type: "todo_cancellation", status: "cancelling" },
      { type: "todo_cancellation", status: "failed" },
      { type: "todo_cancellation", status: "exhausted" },
      { type: "todo_cancellation", status: "settled" },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /hidden|token|business|temporary|permanent/,
  );
  await lifecycle.get("session_shutdown")[0]();
});

test("TODO producer emits replayed exhausted cancellation state at startup", async () => {
  __resetState();
  const bus = new Bus();
  const lifecycle = new Map();
  const events = [];
  bus.on(TELEMETRY_CHANNEL, (event) => events.push(event));
  const replayed = {
    tasks: [
      {
        id: 1,
        subject: "delegated task",
        status: "in_progress",
        metadata: {
          delegation: { status: "cancelling", cancellationAttempts: 3 },
        },
      },
      {
        id: 2,
        subject: "prepared task",
        status: "pending",
        metadata: { preparation: { status: "cancelled", token: "prep-token" } },
      },
    ],
    nextId: 3,
    revision: 4,
    cancellationIntents: [
      {
        kind: "delegation",
        taskId: 1,
        token: "delegation-token",
        ids: ["delegation-worker"],
        generation: 1,
        attempts: 3,
        error: "permanent",
      },
      {
        kind: "preparation",
        taskId: 2,
        token: "prep-token",
        ids: ["preparation-worker"],
        generation: 1,
        workerGeneration: 1,
        attempts: 3,
        error: "permanent",
      },
    ],
  };
  const pi = {
    events: bus,
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
  const ctx = {
    hasUI: false,
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: TODO_SNAPSHOT_TYPE,
          data: createTodoSnapshot(replayed),
        },
      ],
    },
  };
  await lifecycle.get("session_start")[0]({}, ctx);
  assert.deepEqual(
    events.filter((event) => event.type === "todo_cancellation"),
    [
      { type: "todo_cancellation", status: "exhausted" },
      { type: "todo_cancellation", status: "exhausted" },
    ],
  );
  await lifecycle.get("session_shutdown")[0]();
});

test("TODO producer reports orphan cancellation intents through settlement", async () => {
  __resetState();
  const bus = new Bus();
  const lifecycle = new Map();
  let branch = [];
  const events = [];
  bus.on(TELEMETRY_CHANNEL, (event) => events.push(event));
  const pi = {
    events: bus,
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
  const ctx = { hasUI: false, sessionManager: { getBranch: () => branch } };
  await lifecycle.get("session_start")[0]({}, ctx);
  const intent = (kind, taskId, attempts, error) => ({
    kind,
    taskId,
    token: `${kind}-token`,
    ids: [`${kind}-worker`],
    generation: 1,
    ...(kind === "preparation" ? { workerGeneration: 1 } : {}),
    attempts,
    ...(error ? { error } : {}),
  });
  const replay = (revision, cancellationIntents) => ({
    tasks: [],
    nextId: 1,
    revision,
    cancellationIntents,
  });
  branch = [
    {
      type: "custom",
      customType: TODO_SNAPSHOT_TYPE,
      data: createTodoSnapshot(
        replay(1, [intent("preparation", 11, 0), intent("delegation", 12, 0)]),
      ),
    },
  ];
  await lifecycle.get("session_compact")[0]({}, ctx);
  await lifecycle.get("session_compact")[0]({}, ctx);
  branch = [
    {
      type: "custom",
      customType: TODO_SNAPSHOT_TYPE,
      data: createTodoSnapshot(
        replay(2, [
          intent("preparation", 11, 1, "temporary"),
          intent("delegation", 12, 3, "permanent"),
        ]),
      ),
    },
  ];
  await lifecycle.get("session_tree")[0]({}, ctx);
  branch = [
    {
      type: "custom",
      customType: TODO_SNAPSHOT_TYPE,
      data: createTodoSnapshot(replay(3, [])),
    },
  ];
  await lifecycle.get("session_compact")[0]({}, ctx);
  assert.deepEqual(
    events.filter((event) => event.type === "todo_cancellation"),
    [
      { type: "todo_cancellation", status: "cancelling" },
      { type: "todo_cancellation", status: "cancelling" },
      { type: "todo_cancellation", status: "failed" },
      { type: "todo_cancellation", status: "exhausted" },
      { type: "todo_cancellation", status: "settled" },
      { type: "todo_cancellation", status: "settled" },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /worker|token|temporary|permanent/,
  );
  await lifecycle.get("session_shutdown")[0]();
});

test("TODO tree replay retries preparation cancellation only after successful replay", async () => {
  __resetState();
  const bus = new Bus();
  const lifecycle = new Map();
  let branch = [];
  const cancelled = [];
  const pi = {
    events: bus,
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
  const unregister = registerBackgroundSubagentService({
    async run() {
      throw new Error("not used");
    },
    async cancel(ids) {
      cancelled.push([...ids]);
    },
  });
  todoExtension(pi);
  const state = {
    tasks: [
      {
        id: 1,
        subject: "preparation recovery",
        status: "in_progress",
        metadata: {
          preparation: {
            status: "cancelled",
            token: "prep-token",
            workerGeneration: 1,
            activeWorkerIds: ["prep-worker"],
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
        token: "prep-token",
        ids: ["prep-worker"],
        generation: 1,
        workerGeneration: 1,
        attempts: 0,
      },
    ],
  };
  const ctx = { hasUI: false, sessionManager: { getBranch: () => branch } };
  await lifecycle.get("session_start")[0](
    {},
    { hasUI: false, sessionManager: { getBranch: () => [] } },
  );
  commitState(state);
  const staleCtx = {
    get sessionManager() {
      throw new Error("stale after session replacement");
    },
  };
  await lifecycle.get("session_tree")[0]({}, staleCtx);
  assert.deepEqual(cancelled, []);
  branch = [
    {
      type: "custom",
      customType: TODO_SNAPSHOT_TYPE,
      data: createTodoSnapshot(state),
    },
  ];
  await lifecycle.get("session_tree")[0]({}, ctx);
  assert.equal(getState().cancellationIntents?.length ?? 0, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cancelled, [["prep-worker"]]);
  await lifecycle.get("session_shutdown")[0]();
  unregister();
});

test("TODO cancellation telemetry aggregates concurrent sibling intents by task", async () => {
  __resetState();
  const bus = new Bus();
  const lifecycle = new Map();
  const events = [];
  bus.on(TELEMETRY_CHANNEL, (event) => events.push(event));
  const pi = {
    events: bus,
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
  const intent = (
    kind,
    taskId,
    generation,
    workerGeneration,
    attempts,
    error,
  ) => ({
    kind,
    taskId,
    token: `${kind}-${generation}-private`,
    ids: [`${kind}-${generation}-private-worker`],
    generation,
    ...(kind === "preparation" ? { workerGeneration } : {}),
    attempts,
    ...(error ? { error } : {}),
  });
  await lifecycle.get("session_start")[0](
    {},
    { hasUI: false, sessionManager: { getBranch: () => [] } },
  );
  commitState({
    tasks: [{ id: 1, subject: "concurrent", status: "in_progress" }],
    nextId: 2,
    revision: 1,
    cancellationIntents: [
      intent("preparation", 1, 1, 1, 0),
      intent("delegation", 1, 1, undefined, 0),
      intent("preparation", 2, 4, 2, 3, "old exhausted"),
    ],
  });
  commitState({
    tasks: [{ id: 1, subject: "concurrent", status: "in_progress" }],
    nextId: 2,
    revision: 2,
    cancellationIntents: [
      intent("preparation", 1, 1, 1, 1, "temporary"),
      intent("delegation", 1, 1, undefined, 3, "permanent"),
      intent("preparation", 1, 2, 2, 0),
      intent("preparation", 2, 4, 2, 3, "old exhausted"),
    ],
  });
  commitState({
    tasks: [{ id: 1, subject: "concurrent", status: "in_progress" }],
    nextId: 2,
    revision: 3,
    cancellationIntents: [
      intent("preparation", 1, 2, 2, 0),
      intent("preparation", 2, 4, 2, 3, "old exhausted"),
    ],
  });
  commitState({
    tasks: [{ id: 1, subject: "concurrent", status: "in_progress" }],
    nextId: 2,
    revision: 4,
    cancellationIntents: [intent("preparation", 1, 2, 2, 0)],
  });
  commitState({
    tasks: [{ id: 1, subject: "concurrent", status: "in_progress" }],
    nextId: 2,
    revision: 5,
    cancellationIntents: [],
  });
  assert.deepEqual(
    events.filter((event) => event.type === "todo_cancellation"),
    [
      { type: "todo_cancellation", status: "cancelling" },
      { type: "todo_cancellation", status: "exhausted" },
      { type: "todo_cancellation", status: "exhausted" },
      { type: "todo_cancellation", status: "cancelling" },
      { type: "todo_cancellation", status: "settled" },
      { type: "todo_cancellation", status: "settled" },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /private|temporary|permanent|worker/,
  );
  await lifecycle.get("session_shutdown")[0]();
});

test("TODO cancellation telemetry settles a sibling task only after its last intent", async () => {
  __resetState();
  const bus = new Bus();
  const lifecycle = new Map();
  const events = [];
  bus.on(TELEMETRY_CHANNEL, (event) => events.push(event));
  const pi = {
    events: bus,
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
  const intent = (suffix, attempts, error) => ({
    kind: "preparation",
    taskId: 9,
    token: `private-token-${suffix}`,
    ids: [`private-worker-${suffix}`],
    generation: 1,
    workerGeneration: 1,
    attempts,
    ...(error ? { error } : {}),
  });
  const legacySnapshot = createTodoSnapshot({
    tasks: [],
    nextId: 1,
    revision: 1,
    cancellationIntents: [intent("a", 0), intent("b", 0)],
  });
  legacySnapshot.cancellationIntents = legacySnapshot.cancellationIntents.map(
    ({ correlationId: _correlationId, ...legacy }) => legacy,
  );
  const migrated = replayFromBranch({
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: TODO_SNAPSHOT_TYPE,
          data: legacySnapshot,
        },
      ],
    },
  });
  assert.equal(
    new Set(
      migrated.cancellationIntents.map((candidate) => candidate.correlationId),
    ).size,
    2,
  );
  assert.ok(
    migrated.cancellationIntents.every((candidate) =>
      /^[a-f0-9]{32}$/.test(candidate.correlationId),
    ),
  );
  await lifecycle.get("session_start")[0](
    {},
    { hasUI: false, sessionManager: { getBranch: () => [] } },
  );
  commitState({
    tasks: [],
    nextId: 1,
    revision: 1,
    cancellationIntents: [intent("a", 0), intent("b", 0)],
  });
  commitState({
    tasks: [],
    nextId: 1,
    revision: 2,
    cancellationIntents: [intent("a", 1, "temporary"), intent("b", 0)],
  });
  commitState({
    tasks: [],
    nextId: 1,
    revision: 3,
    cancellationIntents: [intent("b", 0)],
  });
  commitState({ tasks: [], nextId: 1, revision: 4, cancellationIntents: [] });
  assert.deepEqual(
    events.filter((event) => event.type === "todo_cancellation"),
    [
      { type: "todo_cancellation", status: "cancelling" },
      { type: "todo_cancellation", status: "failed" },
      { type: "todo_cancellation", status: "cancelling" },
      { type: "todo_cancellation", status: "settled" },
    ],
  );
  assert.doesNotMatch(JSON.stringify(events), /private|temporary|worker/);
  await lifecycle.get("session_shutdown")[0]();
});

test("TODO producer emits only changed exhausted state after compact and tree replay", async () => {
  __resetState();
  const bus = new Bus();
  const lifecycle = new Map();
  const events = [];
  let branch = [];
  bus.on(TELEMETRY_CHANNEL, (event) => events.push(event));
  const pi = {
    events: bus,
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
  const ctx = {
    hasUI: false,
    sessionManager: { getBranch: () => branch },
  };
  await lifecycle.get("session_start")[0]({}, ctx);
  const delegationState = {
    tasks: [
      {
        id: 1,
        subject: "delegated task",
        status: "in_progress",
        metadata: {
          delegation: { status: "cancelling", cancellationAttempts: 3 },
        },
      },
    ],
    nextId: 2,
    revision: 2,
    cancellationIntents: [
      {
        kind: "delegation",
        taskId: 1,
        token: "delegation-token",
        ids: ["delegation-worker"],
        generation: 1,
        attempts: 3,
      },
    ],
  };
  branch = [
    {
      type: "custom",
      customType: TODO_SNAPSHOT_TYPE,
      data: createTodoSnapshot(delegationState),
    },
  ];
  await lifecycle.get("session_compact")[0]({}, ctx);
  assert.deepEqual(
    events.filter((event) => event.type === "todo_cancellation"),
    [{ type: "todo_cancellation", status: "exhausted" }],
  );
  await lifecycle.get("session_compact")[0]({}, ctx);
  assert.equal(
    events.filter((event) => event.type === "todo_cancellation").length,
    1,
  );

  const treeState = {
    ...delegationState,
    tasks: [
      ...delegationState.tasks,
      {
        id: 2,
        subject: "prepared task",
        status: "pending",
        metadata: { preparation: { status: "cancelled", token: "prep-token" } },
      },
    ],
    nextId: 3,
    revision: 3,
    cancellationIntents: [
      ...delegationState.cancellationIntents,
      {
        kind: "preparation",
        taskId: 2,
        token: "prep-token",
        ids: ["preparation-worker"],
        generation: 1,
        workerGeneration: 1,
        attempts: 3,
      },
    ],
  };
  branch = [
    {
      type: "custom",
      customType: TODO_SNAPSHOT_TYPE,
      data: createTodoSnapshot(treeState),
    },
  ];
  await lifecycle.get("session_tree")[0]({}, ctx);
  assert.deepEqual(
    events.filter((event) => event.type === "todo_cancellation"),
    [
      { type: "todo_cancellation", status: "exhausted" },
      { type: "todo_cancellation", status: "exhausted" },
    ],
  );
  await lifecycle.get("session_shutdown")[0]();
});
