import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BackgroundTerminalAdapter } from "./background-terminal-adapter.ts";
import { BoundedEventQueue, matchingConditions } from "./core.ts";
import {
  installJobSessionListeners,
  jobFleetItems,
  jobsStatus,
} from "./index.ts";
import { JobManager } from "./manager.ts";
import { inspectNetworkTarget } from "./network-security.ts";
import { JobStore } from "./store.ts";
import { applyTaskMutation } from "../todo/state/state-reducer.ts";
import { applyJobState } from "../todo/state/waits.ts";

test("job session listeners detach and reinstall across session switches", () => {
  const listeners = new Map();
  const events = {
    on(channel, listener) {
      const entries = listeners.get(channel) ?? new Set();
      entries.add(listener);
      listeners.set(channel, entries);
      return () => entries.delete(listener);
    },
    emit(channel, value) {
      for (const listener of listeners.get(channel) ?? []) listener(value);
    },
  };
  const calls = [];
  const install = () =>
    installJobSessionListeners(events, {
      query: () => calls.push("query"),
      fleetQuery: () => calls.push("fleet-query"),
      fleetOpen: () => calls.push("fleet-open"),
      automationPause: () => calls.push("pause"),
    });
  const first = install();
  events.emit("jobs:query");
  events.emit("fleet:query:v1");
  events.emit("fleet:open:v1", { source: "jobs", kind: "job", id: "job-1" });
  events.emit("automation:pause:v1", {});
  assert.deepEqual(calls, ["query", "fleet-query", "fleet-open", "pause"]);
  first();
  first();
  calls.length = 0;
  for (const channel of listeners.keys()) events.emit(channel, {});
  assert.deepEqual(calls, []);

  const second = install();
  events.emit("jobs:query");
  assert.deepEqual(calls, ["query"]);
  second();
});

test("running jobs expose bounded footer status without commands or output", () => {
  const job = (id, status, title = `Gate ${id}`) => ({
    id,
    status,
    createdAt: 10,
    startedAt: 20,
    attempt: 1,
    definition: {
      kind: "command",
      title,
      command: "secret-command --token hidden",
      cwd: "/private/worktree",
      conditions: [],
      restartPolicy: "never",
    },
  });
  const status = jobsStatus([
    job("job-1", "running", "Root gate"),
    job("job-2", "starting"),
    job("job-3", "running"),
    job("job-4", "running"),
    job("job-5", "failed"),
  ]);
  assert.equal(status, "jobs: ■ 4 running");
  const fleet = jobFleetItems([
    job("job-1", "running", "Root gate"),
    { ...job("job-2", "failed"), settledAt: 30 },
  ]);
  assert.deepEqual(
    fleet.map(({ id, status, kind, title }) => ({ id, status, kind, title })),
    [
      { id: "job-1", status: "running", kind: "job", title: "Root gate" },
      {
        id: "job-2",
        status: "error",
        kind: "job",
        title: "Gate job-2",
      },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify({ status, fleet }),
    /secret-command|hidden|private\/worktree/,
  );
  assert.equal(jobsStatus([job("job-5", "completed")]), undefined);
});

async function waitFor(predicate, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function acceptWebSocket(socket, request) {
  const key = /sec-websocket-key:\s*(.+)\r\n/i.exec(request)?.[1]?.trim();
  assert.ok(key);
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
}

test("bounded queue evicts old events and JSONPath filters use safe evaluation", () => {
  const queue = new BoundedEventQueue();
  for (let sequence = 1; sequence <= 300; sequence++) {
    queue.push({
      sequence,
      at: sequence,
      source: "poll",
      data: String(sequence),
      bytes: 1,
    });
  }
  assert.equal(queue.events.length, 256);
  assert.equal(queue.droppedEvents, 44);
  const event = {
    sequence: 1,
    at: 1,
    source: "poll",
    data: '{"items":[{"ready":false},{"ready":true}]}',
    bytes: 41,
  };
  const matches = matchingConditions(
    [
      {
        type: "jsonpath",
        expression: "$..items[?(@.ready === true)]",
        action: "complete",
      },
    ],
    event,
  );
  assert.equal(matches.length, 1);
  assert.equal(
    matchingConditions(
      [
        {
          type: "jsonpath",
          expression: "$.items[1].ready",
          operator: "equals",
          value: true,
          action: "wake",
        },
      ],
      event,
    ).length,
    1,
  );
});

test("job regex flags retain search semantics with the memory-safe engine", () => {
  const event = (data) => ({
    sequence: 1,
    at: 1,
    source: "stdout",
    data,
    bytes: Buffer.byteLength(data),
  });
  assert.equal(
    matchingConditions(
      [{ type: "regex", expression: "ready", flags: "i", action: "wake" }],
      event("READY"),
    ).length,
    1,
  );
  assert.equal(
    matchingConditions(
      [{ type: "regex", expression: "^READY$", flags: "m", action: "wake" }],
      event("before\nREADY\nafter"),
    ).length,
    1,
  );
  assert.equal(
    matchingConditions(
      [{ type: "regex", expression: "a.b", flags: "s", action: "wake" }],
      event("a\nb"),
    ).length,
    1,
  );
  assert.equal(
    matchingConditions(
      [{ type: "regex", expression: "\\p{L}+", flags: "u", action: "wake" }],
      event("Ž"),
    ).length,
    1,
  );
});

test("regex conditions reuse compiled RE2 programs across sustained ingestion", () => {
  const regex = [{ type: "regex", expression: "PASS$", action: "complete" }];
  const jsonMatch = [
    {
      type: "jsonpath",
      expression: "$.status",
      operator: "matches",
      value: "^pass",
      action: "wake",
    },
  ];
  for (let sequence = 1; sequence <= 5_000; sequence++) {
    assert.equal(
      matchingConditions(regex, {
        sequence,
        at: sequence,
        source: "stdout",
        data: "PASS",
        bytes: 4,
      }).length,
      1,
    );
    assert.equal(
      matchingConditions(jsonMatch, {
        sequence,
        at: sequence,
        source: "poll",
        data: '{"status":"passed"}',
        bytes: 19,
      }).length,
      1,
    );
  }
});

test("background terminal adapter captures early output and settlement across module graphs", async () => {
  const { provideBackgroundTerminalService } =
    await import("../../vendor/pi-tools/extensions/background-terminals/src/api.ts?provider-copy");
  let settled;
  const settlementListeners = new Set();
  const lifetime = provideBackgroundTerminalService({
    async start(options) {
      options.stdoutSink?.write("early output\n");
      return {
        id: "bt-1",
        command: options.command,
        title: options.title,
        cwd: options.cwd,
        pid: 1,
        status: "running",
        createdAt: Date.now(),
        stdout: { text: "", totalBytes: 0, truncatedBytes: 0 },
        stderr: { text: "", totalBytes: 0, truncatedBytes: 0 },
      };
    },
    async status() {
      return {
        id: "bt-1",
        command: "test",
        title: "test",
        cwd: process.cwd(),
        pid: 1,
        status: "running",
        createdAt: Date.now(),
        stdout: { text: "", totalBytes: 0, truncatedBytes: 0 },
        stderr: { text: "", totalBytes: 0, truncatedBytes: 0 },
      };
    },
    async list() {
      return [];
    },
    async kill() {
      return [];
    },
    subscribeSettled(listener) {
      settlementListeners.add(listener);
      return () => settlementListeners.delete(listener);
    },
    subscribeOutput() {
      return () => {};
    },
  });
  const output = [];
  const adapter = new BackgroundTerminalAdapter();
  await adapter.connect();
  const handle = await adapter.start(
    { command: "test", title: "test", cwd: process.cwd() },
    (event) => output.push(event.data),
    (event) => {
      settled = event;
    },
  );
  for (const listener of settlementListeners)
    listener(
      {
        id: "bt-1",
        command: "test",
        title: "test",
        cwd: process.cwd(),
        pid: 1,
        status: "done",
        createdAt: Date.now(),
        settledAt: Date.now(),
        exitCode: 0,
        stdout: { text: "", totalBytes: 0, truncatedBytes: 0 },
        stderr: { text: "", totalBytes: 0, truncatedBytes: 0 },
      },
      false,
    );
  assert.deepEqual(output, ["early output\n"]);
  assert.equal(settled.status, "done");
  handle.dispose();
  adapter.dispose();
  lifetime.shutdown();
});

test("a command that settles during start remains settled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-jobs-fast-settle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let stops = 0;
  let disposals = 0;
  const manager = new JobManager(
    new JobStore(root),
    {
      async start(_options, _onOutput, onSettlement) {
        onSettlement({ status: "done", exitCode: 0 });
        return {
          id: "bt-fast",
          async stop() {
            stops++;
          },
          dispose() {
            disposals++;
          },
        };
      },
      async stop() {},
    },
    {
      onLifecycle() {},
      async approveNetwork() {
        return false;
      },
    },
  );
  await manager.initialize("fast-settle", root);
  const job = await manager.start({
    kind: "command",
    title: "fast",
    command: "true",
    cwd: root,
    restartPolicy: "never",
    conditions: [],
  });
  assert.equal(job.status, "completed");
  assert.equal(manager.get(job.id).status, "completed");
  assert.equal(stops, 1);
  assert.equal(disposals, 1);
  await manager.dispose();
});

test("burst ingress batches scope writes and terminal settlement flushes final state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-jobs-batch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root);
  const snapshots = [];
  store.save = async (scope) => snapshots.push(structuredClone(scope));
  let output;
  let settle;
  let resolveCompleted;
  const completed = new Promise((resolve) => {
    resolveCompleted = resolve;
  });
  const manager = new JobManager(
    store,
    {
      async start(_options, onOutput, onSettlement) {
        output = onOutput;
        settle = onSettlement;
        return { id: "bt-batch", async stop() {}, dispose() {} };
      },
      async stop() {},
    },
    {
      onLifecycle(event) {
        if (event.type === "completed") resolveCompleted();
      },
      async approveNetwork() {
        return false;
      },
    },
  );
  await manager.initialize("batch-session", root);
  const job = await manager.start({
    kind: "command",
    title: "batch",
    command: "fixture",
    cwd: root,
    restartPolicy: "never",
    conditions: [],
  });
  const beforeBurst = snapshots.length;
  for (let index = 0; index < 64; index++)
    output({ stream: "stdout", data: `${index}\n` });
  settle({ status: "done", exitCode: 0 });
  await completed;
  assert.equal(snapshots.length - beforeBurst, 9); // eight batches, terminal
  assert.ok(snapshots.length - beforeBurst < 64);
  const final = snapshots.at(-1).jobs.find((record) => record.id === job.id);
  assert.equal(final.status, "completed");
  assert.equal(final.events.length, 64);
  assert.equal(manager.get(job.id).status, "completed");
  await manager.dispose();
});

test("reopen replays batched log events into cursor and dedupe state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-jobs-replay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = "replay-session";
  const store = new JobStore(root);
  await store.open(session, root);
  const job = {
    id: "job-deadbeef",
    definition: {
      kind: "websocket",
      title: "replay",
      url: "ws://127.0.0.1/events",
      conditions: [],
      dedupeJsonPath: "$.id",
      cursorJsonPath: "$.cursor",
      resumeQuery: "after",
      binary: "reject",
      maxFrameBytes: 4096,
    },
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    attempt: 1,
    events: [],
    eventBytes: 0,
    droppedEvents: 0,
    droppedBytes: 0,
    duplicateEvents: 0,
    recentDedupeKeys: [],
    logPath: store.logPath("job-deadbeef"),
  };
  await store.save({ version: 1, sessionId: session, cwd: root, jobs: [job] });
  await store.append(job, {
    sequence: 1,
    at: 2,
    source: "websocket",
    data: '{"id":"one","cursor":"c1"}',
    bytes: 26,
  });
  const reopened = await new JobStore(root).open(session, root);
  assert.equal(reopened.jobs[0].events[0].sequence, 1);
  assert.equal(reopened.jobs[0].cursor, "c1");
  assert.equal(reopened.jobs[0].recentDedupeKeys.length, 1);
});

test("network validation rejects embedded credentials before connection", async () => {
  await assert.rejects(
    inspectNetworkTarget("wss://user:secret@example.com/events", [
      "ws:",
      "wss:",
    ]),
    /Credentials/,
  );
});

test("resume interrupts arbitrary commands and relaunches only idempotent commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-jobs-resume-"));
  const session = "resume-session";
  let starts = 0;
  const commands = {
    async start() {
      starts++;
      return { id: `bt-${starts}`, async stop() {}, dispose() {} };
    },
    async stop() {},
  };
  const hooks = {
    onLifecycle() {},
    async approveNetwork() {
      return false;
    },
  };
  const first = new JobManager(new JobStore(root), commands, hooks);
  await first.initialize(session, root);
  const arbitrary = await first.start({
    kind: "command",
    title: "arbitrary",
    command: "do-work",
    cwd: root,
    restartPolicy: "never",
    conditions: [],
  });
  await first.dispose();

  const second = new JobManager(new JobStore(root), commands, hooks);
  await second.initialize(session, root);
  assert.equal(second.get(arbitrary.id).status, "interrupted");
  const idempotent = await second.start({
    kind: "command",
    title: "safe",
    command: "sync-cache",
    cwd: root,
    restartPolicy: "idempotent",
    conditions: [],
  });
  await second.dispose();

  const third = new JobManager(new JobStore(root), commands, hooks);
  await third.initialize(session, root);
  assert.equal(third.get(idempotent.id).status, "running");
  assert.equal(third.get(idempotent.id).attempt, 2);
  assert.equal(starts, 3);
  await third.dispose();
});

test("resume fails an expired absolute deadline without relaunching", async () => {
  const now = Date.now();
  const job = {
    id: "job-deadbeef",
    definition: {
      kind: "command",
      title: "expired",
      command: "work",
      cwd: process.cwd(),
      restartPolicy: "idempotent",
      conditions: [],
      deadline: now - 1,
    },
    status: "running",
    createdAt: now - 10_000,
    updatedAt: now - 10_000,
    startedAt: now - 10_000,
    attempt: 1,
    events: [],
    eventBytes: 0,
    droppedEvents: 0,
    droppedBytes: 0,
    duplicateEvents: 0,
    recentDedupeKeys: [],
    logPath: "/tmp/unused.jsonl",
  };
  let starts = 0;
  const store = {
    async open(sessionId, cwd) {
      return { version: 1, sessionId, cwd, jobs: [job] };
    },
    logPath() {
      return "/tmp/unused.jsonl";
    },
    async save() {},
    async append() {},
    async delete() {},
  };
  const manager = new JobManager(
    store,
    {
      async start() {
        starts++;
        throw new Error("must not launch");
      },
      async stop() {},
    },
    {
      onLifecycle() {},
      async approveNetwork() {
        return false;
      },
    },
  );
  await manager.initialize("expired-resume", process.cwd());
  assert.equal(starts, 0);
  assert.equal(manager.get(job.id).status, "failed");
  assert.equal(manager.get(job.id).error, "Job timeout/deadline exceeded.");
  await manager.dispose();
});

test("noisy command ingress fails explicitly at the bounded queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-jobs-overflow-"));
  const store = new JobStore(root);
  let output;
  let resolveFailed;
  const failed = new Promise((resolve) => {
    resolveFailed = resolve;
  });
  const manager = new JobManager(
    store,
    {
      async start(_options, onOutput) {
        output = onOutput;
        return { id: "bt-1", async stop() {}, dispose() {} };
      },
      async stop() {},
    },
    {
      onLifecycle(event) {
        if (event.type === "failed") resolveFailed(event);
      },
      async approveNetwork() {
        return false;
      },
    },
  );
  await manager.initialize("overflow-session", root);
  store.append = async () => {};
  store.save = async () => {};
  const job = await manager.start({
    kind: "command",
    title: "overflow",
    command: "fixture",
    cwd: root,
    restartPolicy: "never",
    conditions: [],
  });
  for (let index = 0; index < 600; index++)
    output({ stream: "stdout", data: `${index}\n` });
  await Promise.race([
    failed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("overflow failure timeout")), 3_000),
    ),
  ]);
  assert.equal(manager.get(job.id).status, "failed");
  assert.match(manager.get(job.id).error, /bounded queue/);
  await manager.dispose();
});

test("dispose waits for in-flight event persistence and rejects later ingress", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-jobs-dispose-"));
  const store = new JobStore(root);
  const append = store.append.bind(store);
  let releaseAppend;
  let appendStarted;
  const started = new Promise((resolve) => {
    appendStarted = resolve;
  });
  const blocked = new Promise((resolve) => {
    releaseAppend = resolve;
  });
  let appendCalls = 0;
  store.append = async (...args) => {
    appendCalls++;
    appendStarted();
    await blocked;
    return append(...args);
  };
  let output;
  let afterDispose = false;
  let lateLifecycle = 0;
  const manager = new JobManager(
    store,
    {
      async start(_options, onOutput) {
        output = onOutput;
        return { id: "bt-1", async stop() {}, dispose() {} };
      },
      async stop() {},
    },
    {
      onLifecycle() {
        if (afterDispose) lateLifecycle++;
      },
      async approveNetwork() {
        return false;
      },
    },
  );
  await manager.initialize("dispose-session", root);
  await manager.start({
    kind: "command",
    title: "dispose",
    command: "fixture",
    cwd: root,
    restartPolicy: "never",
    conditions: [{ type: "regex", expression: "READY", action: "wake" }],
  });
  output({ stream: "stdout", data: "READY\n" });
  await started;
  let settled = false;
  const disposal = manager.dispose().then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  releaseAppend();
  await disposal;
  afterDispose = true;
  output({ stream: "stdout", data: "READY\n" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(appendCalls, 1);
  assert.equal(lateLifecycle, 0);
});

test("explicit stop drains accepted ingress without emitting a stale wake", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-jobs-stop-"));
  const store = new JobStore(root);
  const append = store.append.bind(store);
  let appendStarted;
  let releaseAppend;
  const started = new Promise((resolve) => {
    appendStarted = resolve;
  });
  const blocked = new Promise((resolve) => {
    releaseAppend = resolve;
  });
  store.append = async (...args) => {
    appendStarted();
    await blocked;
    return append(...args);
  };
  let output;
  const lifecycle = [];
  const manager = new JobManager(
    store,
    {
      async start(_options, onOutput) {
        output = onOutput;
        return { id: "bt-1", async stop() {}, dispose() {} };
      },
      async stop() {},
    },
    {
      onLifecycle(event) {
        lifecycle.push(event);
      },
      async approveNetwork() {
        return false;
      },
    },
  );
  await manager.initialize("stop-session", root);
  const job = await manager.start({
    kind: "command",
    title: "stop",
    command: "fixture",
    cwd: root,
    restartPolicy: "never",
    conditions: [{ type: "regex", expression: "READY", action: "wake" }],
  });
  output({ stream: "stdout", data: "READY\n" });
  await started;
  let settled = false;
  const stopping = manager.stop(job.id).then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  releaseAppend();
  await stopping;
  assert.equal(manager.get(job.id).status, "stopped");
  assert.equal(
    lifecycle.some((event) => event.type === "wake"),
    false,
  );
  assert.equal(lifecycle.filter((event) => event.type === "stopped").length, 1);
  await manager.dispose();
});

test("dispose force-closes connecting and uncooperative open WebSockets", async (t) => {
  for (const upgrade of [false, true]) {
    const sockets = new Set();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      if (!upgrade) {
        socket.resume();
        return;
      }
      let request = "";
      socket.on("data", (chunk) => {
        request += chunk.toString("utf8");
        if (!request.includes("\r\n\r\n")) return;
        acceptWebSocket(socket, request);
        socket.removeAllListeners("data");
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      for (const socket of sockets) socket.destroy();
      server.close();
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const root = await mkdtemp(join(tmpdir(), "pi-jobs-ws-dispose-"));
    const manager = new JobManager(
      new JobStore(root),
      {
        async start() {
          throw new Error("not used");
        },
        async stop() {},
      },
      {
        onLifecycle() {},
        async approveNetwork() {
          return true;
        },
      },
    );
    await manager.initialize(`ws-dispose-${upgrade}`, root);
    await manager.start({
      kind: "websocket",
      title: "dispose socket",
      url: `ws://127.0.0.1:${address.port}/events`,
      conditions: [],
      binary: "reject",
      maxFrameBytes: 4096,
    });
    await waitFor(() => sockets.size === 1, "WebSocket did not connect");
    await manager.dispose();
    await waitFor(
      () => sockets.size === 0,
      `WebSocket survived manager disposal (upgrade=${upgrade})`,
    );
  }
});

test("identical wake frames remain repeatable across TODO re-arm", async (t) => {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk.toString("utf8");
      if (!request.includes("\r\n\r\n")) return;
      acceptWebSocket(socket, request);
      const body = Buffer.from("READY");
      const frame = Buffer.concat([Buffer.from([0x81, body.length]), body]);
      setTimeout(() => socket.write(Buffer.concat([frame, frame])), 25);
      socket.removeAllListeners("data");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const root = await mkdtemp(join(tmpdir(), "pi-jobs-repeat-wake-"));
  let state = {
    tasks: [
      {
        id: 1,
        subject: "Watch",
        status: "waiting:jobs",
        wait: {
          kind: "jobs",
          jobIds: ["pending"],
          mode: "any",
          deadline: Date.now() + 10_000,
          settled: {},
        },
      },
    ],
    nextId: 2,
    revision: 1,
  };
  let jobId;
  let wakes = 0;
  let resolveWakes;
  const wokeTwice = new Promise((resolve) => {
    resolveWakes = resolve;
  });
  const manager = new JobManager(
    new JobStore(root),
    {
      async start() {
        throw new Error("not used");
      },
      async stop() {},
    },
    {
      onLifecycle(event) {
        if (event.type !== "wake") return;
        wakes++;
        state = applyJobState(
          state,
          { id: event.jobId, status: "wake", settledAt: event.at },
          event.at,
        );
        if (wakes === 1) {
          state = applyTaskMutation(state, "update", {
            id: 1,
            status: "waiting:jobs",
            jobIds: [event.jobId],
            jobMode: "any",
            timeoutSeconds: 10,
          }).state;
        } else resolveWakes();
      },
      async approveNetwork() {
        return true;
      },
    },
  );
  await manager.initialize("repeat-wake", root);
  const job = await manager.start({
    kind: "websocket",
    title: "repeat wake",
    url: `ws://127.0.0.1:${address.port}/events`,
    conditions: [{ type: "regex", expression: "READY", action: "wake" }],
    binary: "reject",
    maxFrameBytes: 4096,
  });
  jobId = job.id;
  state.tasks[0].wait.jobIds = [jobId];
  await Promise.race([
    wokeTwice,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("second wake timeout")), 3_000),
    ),
  ]);
  assert.equal(wakes, 2);
  assert.equal(state.tasks[0].status, "pending");
  assert.equal(state.tasks[0].waitEvidence[0].status, "wake");
  assert.equal(manager.get(job.id).status, "running");
  assert.equal(manager.get(job.id).duplicateEvents, 0);
  await manager.dispose();
});

test("deadline settlement closes an uncooperative WebSocket before lifecycle completion", async (t) => {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk.toString("utf8");
      if (!request.includes("\r\n\r\n")) return;
      acceptWebSocket(socket, request);
      socket.removeAllListeners("data");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const root = await mkdtemp(join(tmpdir(), "pi-jobs-ws-deadline-"));
  let resolveFailed;
  const failed = new Promise((resolve) => {
    resolveFailed = resolve;
  });
  const manager = new JobManager(
    new JobStore(root),
    {
      async start() {
        throw new Error("not used");
      },
      async stop() {},
    },
    {
      onLifecycle(event) {
        if (event.type === "failed") resolveFailed(event);
      },
      async approveNetwork() {
        return true;
      },
    },
  );
  await manager.initialize("deadline", root);
  const job = await manager.start({
    kind: "websocket",
    title: "deadline",
    url: `ws://127.0.0.1:${address.port}/events`,
    conditions: [],
    timeoutMs: 100,
    binary: "reject",
    maxFrameBytes: 4096,
  });
  await Promise.race([
    failed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("deadline timeout")), 3_000),
    ),
  ]);
  assert.equal(manager.get(job.id).status, "failed");
  assert.equal(sockets.size, 0);
  await manager.dispose();
});

test("HTTP poll completes against an approved local endpoint", async (t) => {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"done":true}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const root = await mkdtemp(join(tmpdir(), "pi-jobs-poll-"));
  let resolveCompleted;
  const completed = new Promise((resolve) => {
    resolveCompleted = resolve;
  });
  const manager = new JobManager(
    new JobStore(root),
    {
      async start() {
        throw new Error("not used");
      },
      async stop() {},
    },
    {
      onLifecycle(event) {
        if (event.type === "completed") resolveCompleted(event);
      },
      async approveNetwork(request) {
        assert.equal(request.endpoint, `http://127.0.0.1:${address.port}`);
        return true;
      },
    },
  );
  await manager.initialize("poll-session", root);
  const job = await manager.start({
    kind: "poll",
    title: "poll",
    url: `http://127.0.0.1:${address.port}/status`,
    intervalMs: 1_000,
    conditions: [
      {
        type: "jsonpath",
        expression: "$.done",
        operator: "equals",
        value: true,
        action: "complete",
      },
    ],
    binary: "reject",
    maxFrameBytes: 4096,
  });
  await Promise.race([
    completed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("poll completion timeout")), 3_000),
    ),
  ]);
  assert.equal(manager.get(job.id).status, "completed");
  assert.equal(manager.get(job.id).events[0].source, "poll");
  await manager.dispose();
});

test("WebSocket monitor completes from a local frame and persists private state/logs", async (t) => {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk.toString("utf8");
      if (!request.includes("\r\n\r\n")) return;
      const key = /sec-websocket-key:\s*(.+)\r\n/i.exec(request)?.[1]?.trim();
      assert.ok(key);
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      const body = Buffer.from('{"done":true,"cursor":"c1"}');
      socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body]));
      socket.removeAllListeners("data");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const root = await mkdtemp(join(tmpdir(), "pi-jobs-test-"));
  const lifecycle = [];
  let completed;
  const completedPromise = new Promise((resolve) => {
    completed = resolve;
  });
  const commands = {
    async start() {
      throw new Error("not used");
    },
    async stop() {},
  };
  const manager = new JobManager(new JobStore(root), commands, {
    onLifecycle(event) {
      lifecycle.push(event);
      if (event.type === "completed") completed(event);
    },
    async approveNetwork(request) {
      assert.equal(request.endpoint, `ws://127.0.0.1:${address.port}`);
      assert.ok(request.restricted.some((entry) => entry.includes("loopback")));
      return true;
    },
  });
  await manager.initialize(`session-${randomBytes(4).toString("hex")}`, root);
  const job = await manager.start({
    kind: "websocket",
    title: "local test",
    url: `ws://127.0.0.1:${address.port}/events`,
    conditions: [
      { type: "jsonpath", expression: "$.done", action: "complete" },
    ],
    cursorJsonPath: "$.cursor",
    resumeQuery: "after",
    binary: "reject",
    maxFrameBytes: 4096,
  });
  await Promise.race([
    completedPromise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("completion timeout")), 3_000),
    ),
  ]);
  const record = manager.get(job.id);
  assert.equal(record.status, "completed");
  assert.equal(record.cursor, "c1");
  assert.equal(
    JSON.parse((await readFile(record.logPath, "utf8")).trim()).data,
    '{"done":true,"cursor":"c1"}',
  );
  assert.equal((await stat(record.logPath)).mode & 0o777, 0o600);
  const stateFile = (await import("node:fs/promises"))
    .readdir(root)
    .then((files) => files.find((file) => file.endsWith(".json")));
  assert.equal((await stat(join(root, await stateFile))).mode & 0o777, 0o600);
  assert.ok(lifecycle.some((event) => event.type === "started"));
  await manager.dispose();
});
