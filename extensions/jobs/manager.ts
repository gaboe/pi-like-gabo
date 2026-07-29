import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { TextDecoder } from "node:util";
import { Agent, fetch as undiciFetch } from "undici";
import WebSocket, { type RawData } from "ws";
import {
  BackgroundTerminalAdapter,
  type TerminalOutput,
  type TerminalSettlement,
} from "./background-terminal-adapter.js";
import {
  BoundedEventQueue,
  DEFAULT_FRAME_BYTES,
  jsonPathValue,
  matchingConditions,
  MAX_DEDUPE_KEYS,
  MAX_FRAME_BYTES,
  validateConditions,
  withResumeCursor,
} from "./core.js";
import { inspectNetworkTarget } from "./network-security.js";
import {
  beginGlobalShellExecution,
  type WorkspaceActivity,
} from "../../vendor/pi-tools/extensions/shared/workspace-mutation-lease.js";
import { JobStore } from "./store.js";
import type {
  CommandDefinition,
  JobDefinition,
  JobEvent,
  JobLifecycleEvent,
  JobLifecycleType,
  JobManagerHooks,
  JobRecord,
  NetworkDefinition,
  PersistedScope,
} from "./types.js";

interface CommandBackend {
  start(
    options: { command: string; title: string; cwd: string },
    onOutput: (event: TerminalOutput) => void,
    onSettlement: (event: TerminalSettlement) => void,
  ): Promise<{ id: string; stop(): Promise<void>; dispose(): void }>;
  stop(id: string): Promise<void>;
}

interface ActiveJob {
  generation: number;
  closed: boolean;
  workspaceActivity?: WorkspaceActivity;
  queued: number;
  stdoutBuffer: string;
  stderrBuffer: string;
  stop(): Promise<void>;
  chain: Promise<void>;
}

const TERMINAL = new Set<JobRecord["status"]>([
  "completed",
  "failed",
  "stopped",
  "interrupted",
]);
const MAX_ACTIVE_JOBS = 32;
const MAX_QUEUED_OPERATIONS = 512;
const WEBSOCKET_CLOSE_TIMEOUT_MS = 250;
// Keep unsnapshotted max-size frames within the retained 32 MiB event log.
const SCOPE_SAVE_EVENT_BATCH = 8;

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    4096,
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function closeWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    let force: NodeJS.Timeout | undefined;
    let giveUp: NodeJS.Timeout | undefined;
    const done = () => {
      if (force) clearTimeout(force);
      if (giveUp) clearTimeout(giveUp);
      socket.removeListener("close", done);
      resolve();
    };
    socket.once("close", done);
    force = setTimeout(() => socket.terminate(), WEBSOCKET_CLOSE_TIMEOUT_MS);
    giveUp = setTimeout(done, WEBSOCKET_CLOSE_TIMEOUT_MS * 2);
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else if (socket.readyState === WebSocket.OPEN)
      socket.close(1000, "job stopped");
  });
}

function pinnedLookup(addresses: readonly string[]) {
  return (
    _hostname: string,
    options: { all?: boolean },
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ) => {
    const records = addresses.map((address) => ({
      address,
      family: isIP(address),
    }));
    if (records.length === 0) {
      callback(new Error("Approved DNS address set is empty."), "");
      return;
    }
    if (options.all) callback(null, records);
    else callback(null, records[0].address, records[0].family);
  };
}

export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly active = new Map<string, ActiveJob>();
  private scope?: PersistedScope;
  private shuttingDown = false;
  private reservations = 0;
  private unsavedEvents = 0;

  constructor(
    private readonly store: JobStore,
    private readonly commands: CommandBackend,
    private readonly hooks: JobManagerHooks,
  ) {}

  async initialize(sessionId: string, cwd: string) {
    const persisted = await this.store.open(sessionId, cwd);
    this.scope = persisted ?? { version: 1, sessionId, cwd, jobs: [] };
    for (const job of this.scope.jobs) this.jobs.set(job.id, job);
    await this.resume();
  }

  list() {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(clone);
  }

  get(id: string) {
    const job = this.require(id);
    return clone(job);
  }

  async start(definition: JobDefinition) {
    this.reserveSlot();
    try {
      this.validateDefinition(definition);
      const now = Date.now();
      const id = `job-${randomUUID().slice(0, 8)}`;
      const job: JobRecord = {
        id,
        definition: clone(definition),
        status: "starting",
        createdAt: now,
        updatedAt: now,
        attempt: 1,
        events: [],
        eventBytes: 0,
        droppedEvents: 0,
        droppedBytes: 0,
        duplicateEvents: 0,
        recentDedupeKeys: [],
        logPath: this.store.logPath(id),
      };
      this.jobs.set(id, job);
      await this.save(true);
      this.emit(job, "created");
      await this.launch(job, false);
      return clone(job);
    } finally {
      this.reservations--;
    }
  }

  async restart(id: string) {
    const job = this.require(id);
    this.reserveSlot();
    try {
      await this.stopActive(job, true);
      job.status = "starting";
      job.error = undefined;
      job.backendId = undefined;
      job.settledAt = undefined;
      job.startedAt = undefined;
      job.attempt++;
      job.updatedAt = Date.now();
      await this.save(true);
      await this.launch(job, true);
      return clone(job);
    } finally {
      this.reservations--;
    }
  }

  async stop(id: string) {
    const job = this.require(id);
    if (TERMINAL.has(job.status)) return clone(job);
    job.status = "stopped";
    job.settledAt = job.updatedAt = Date.now();
    await this.save(true);
    await this.stopActive(job, true);
    this.emit(job, "stopped", "Stopped by request.");
    return clone(job);
  }

  async delete(id: string) {
    const job = this.require(id);
    if (!TERMINAL.has(job.status)) await this.stop(id);
    this.jobs.delete(id);
    await this.store.delete(job);
    await this.save(true);
    this.emit(job, "deleted");
  }

  async dispose() {
    this.shuttingDown = true;
    const active = [...this.active.values()];
    for (const job of this.jobs.values()) {
      if (
        job.definition.kind === "command" &&
        !TERMINAL.has(job.status) &&
        job.definition.restartPolicy !== "idempotent"
      ) {
        job.status = "interrupted";
        job.error = "Session ended while a non-idempotent command was running.";
        job.settledAt = job.updatedAt = Date.now();
        this.emit(job, "interrupted", job.error);
      }
    }
    await Promise.allSettled(active.map((entry) => entry.stop()));
    await Promise.allSettled(active.map((entry) => entry.chain));
    await this.save(true);
    this.active.clear();
  }

  private reserveSlot() {
    if (this.shuttingDown) throw new Error("Job manager is shutting down.");
    if (this.active.size + this.reservations >= MAX_ACTIVE_JOBS) {
      throw new Error(`At most ${MAX_ACTIVE_JOBS} jobs may run concurrently.`);
    }
    this.reservations++;
  }

  private validateDefinition(definition: JobDefinition) {
    definition.title = definition.title
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
    if (!definition.title) throw new Error("title must not be empty.");
    validateConditions(definition.conditions);
    if (
      definition.timeoutMs !== undefined &&
      (!Number.isInteger(definition.timeoutMs) ||
        definition.timeoutMs < 100 ||
        definition.timeoutMs > 30 * 24 * 60 * 60 * 1000)
    ) {
      throw new Error(
        "timeoutMs must be an integer from 100ms through 30 days.",
      );
    }
    if (
      definition.deadline !== undefined &&
      (!Number.isFinite(definition.deadline) ||
        definition.deadline <= Date.now())
    )
      throw new Error("deadline must be a future Unix millisecond timestamp.");
    if (definition.dedupeJsonPath)
      validateConditions([
        {
          type: "jsonpath",
          expression: definition.dedupeJsonPath,
          action: "wake",
        },
      ]);
    if (definition.kind === "command") {
      if (!definition.command.trim())
        throw new Error("command must not be empty.");
      if (!definition.cwd) throw new Error("cwd must not be empty.");
      return;
    }
    definition.maxFrameBytes ||= DEFAULT_FRAME_BYTES;
    if (
      !Number.isInteger(definition.maxFrameBytes) ||
      definition.maxFrameBytes < 1024 ||
      definition.maxFrameBytes > MAX_FRAME_BYTES
    ) {
      throw new Error(`maxFrameBytes must be 1024-${MAX_FRAME_BYTES}.`);
    }
    if (
      definition.kind === "poll" &&
      (!Number.isInteger(definition.intervalMs) ||
        (definition.intervalMs ?? 0) < 1_000 ||
        (definition.intervalMs ?? 0) > 24 * 60 * 60 * 1000)
    ) {
      throw new Error("poll intervalMs must be 1000ms through 24 hours.");
    }
  }

  private async resume() {
    for (const job of this.jobs.values()) {
      if (job.status !== "running" && job.status !== "starting") continue;
      if (
        job.definition.kind === "command" &&
        job.definition.restartPolicy !== "idempotent"
      ) {
        job.status = "interrupted";
        job.error =
          "The prior session ended before this non-idempotent command settled.";
        job.settledAt = job.updatedAt = Date.now();
        this.emit(job, "interrupted", job.error);
        continue;
      }
      if (job.definition.kind !== "command") {
        job.approvedEndpoint = undefined;
        job.approvedAddresses = undefined;
        job.approvedRestricted = undefined;
      }
      job.attempt++;
      try {
        await this.launch(job, true);
      } catch {
        // launch() records the failure.
      }
    }
    await this.save(true);
  }

  private async launch(job: JobRecord, restarted: boolean) {
    try {
      if (this.shuttingDown) throw new Error("Job manager is shutting down.");
      if (
        job.definition.deadline !== undefined &&
        job.definition.deadline <= Date.now()
      ) {
        throw new Error("Job timeout/deadline exceeded.");
      }
      if (job.definition.kind === "command")
        await this.launchCommand(job, job.definition);
      else {
        await this.ensureApproved(job, job.definition);
        if (
          job.definition.deadline !== undefined &&
          job.definition.deadline <= Date.now()
        ) {
          throw new Error("Job timeout/deadline exceeded.");
        }
        if (job.definition.kind === "websocket")
          this.launchWebSocket(job, job.definition);
        else this.launchPoll(job, job.definition);
      }
      if (TERMINAL.has(job.status)) {
        await this.active.get(job.id)?.chain;
        return;
      }
      job.status = "running";
      job.startedAt = job.updatedAt = Date.now();
      await this.save(true);
      this.emit(job, restarted ? "restarted" : "started");
      this.armDeadline(job);
    } catch (error) {
      await this.fail(job, boundedError(error));
      throw error;
    }
  }

  private async launchCommand(job: JobRecord, definition: CommandDefinition) {
    const active = this.newActive(job);
    active.workspaceActivity = beginGlobalShellExecution();
    active.stop = async () => {
      active.closed = true;
      active.workspaceActivity?.close();
      active.workspaceActivity = undefined;
    };
    this.active.set(job.id, active);
    let handle: Awaited<ReturnType<CommandBackend["start"]>>;
    try {
      handle = await this.commands.start(
        {
          command: definition.command,
          title: definition.title,
          cwd: definition.cwd,
        },
        (output) =>
          this.queue(job, () =>
            this.ingestCommandChunk(job, active, output.stream, output.data),
          ),
        (settlement) =>
          this.queue(job, async () => {
            await this.flushCommandBuffers(job, active);
            await this.commandSettled(job, settlement);
          }),
      );
    } catch (error) {
      if (this.active.get(job.id) === active) this.active.delete(job.id);
      await active.stop();
      throw error;
    }
    job.backendId = handle.id;
    let stopped = false;
    active.stop = async () => {
      if (stopped) return;
      stopped = true;
      active.closed = true;
      try {
        handle.dispose();
        await handle.stop();
      } finally {
        active.workspaceActivity?.close();
        active.workspaceActivity = undefined;
      }
    };
    if (this.shuttingDown || active.generation !== job.attempt) {
      await active.stop();
      throw new Error("Job start was interrupted by session shutdown.");
    }
    if (
      active.closed ||
      TERMINAL.has(job.status) ||
      this.active.get(job.id) !== active
    ) {
      await active.chain;
      await active.stop();
      if (TERMINAL.has(job.status)) return;
      throw new Error(
        "Job start was interrupted before its backend became ready.",
      );
    }
  }

  private launchWebSocket(job: JobRecord, definition: NetworkDefinition) {
    const active = this.newActive(job);
    this.active.set(job.id, active);
    let failures = 0;
    let reconnectTimer: NodeJS.Timeout | undefined;
    let socket: WebSocket | undefined;
    const connect = async () => {
      if (active.closed || TERMINAL.has(job.status)) return;
      try {
        await this.ensureApproved(job, definition);
      } catch (error) {
        await this.queue(job, () => this.fail(job, boundedError(error)));
        return;
      }
      if (active.closed || this.shuttingDown || TERMINAL.has(job.status))
        return;
      const url = withResumeCursor(
        definition.url,
        definition.resumeQuery,
        job.cursor,
      );
      socket = new WebSocket(url, {
        followRedirects: false,
        perMessageDeflate: false,
        maxPayload: definition.maxFrameBytes,
        lookup: pinnedLookup(job.approvedAddresses ?? []),
      });
      socket.on("message", (message: RawData, binary: boolean) => {
        void this.queue(job, async () => {
          failures = 0;
          const data = binary
            ? new Uint8Array(message as Buffer)
            : message.toString("utf8");
          await this.ingest(job, "websocket", data, binary);
        });
      });
      socket.on("close", () => {
        if (active.closed || TERMINAL.has(job.status)) return;
        const base = Math.min(30_000, 500 * 2 ** Math.min(failures++, 6));
        reconnectTimer = setTimeout(
          connect,
          Math.round(base * (0.5 + Math.random())),
        );
      });
      socket.on(
        "error",
        () =>
          void this.queue(job, () =>
            this.ingest(job, "system", "websocket connection error", false),
          ),
      );
    };
    active.stop = async () => {
      active.closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket) await closeWebSocket(socket);
    };
    void connect();
  }

  private launchPoll(job: JobRecord, definition: NetworkDefinition) {
    const active = this.newActive(job);
    this.active.set(job.id, active);
    let timer: NodeJS.Timeout | undefined;
    let controller: AbortController | undefined;
    let failures = 0;
    const poll = async () => {
      if (active.closed || TERMINAL.has(job.status)) return;
      controller = new AbortController();
      let dispatcher: Agent | undefined;
      try {
        await this.ensureApproved(job, definition);
        if (active.closed || this.shuttingDown || TERMINAL.has(job.status))
          return;
        dispatcher = new Agent({
          connect: { lookup: pinnedLookup(job.approvedAddresses ?? []) },
        });
        const response = await undiciFetch(
          withResumeCursor(definition.url, definition.resumeQuery, job.cursor),
          {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(30_000),
            ]),
            redirect: "error",
            dispatcher,
          },
        );
        if (!response.ok)
          throw new Error(`Poll returned HTTP ${response.status}.`);
        const { data, oversize } = await this.readBounded(
          response as unknown as Response,
          definition.maxFrameBytes,
        );
        failures = 0;
        const contentType =
          response.headers.get("content-type")?.toLowerCase() ?? "";
        const binary =
          !/^(text\/)|json|xml|javascript|x-www-form-urlencoded/.test(
            contentType,
          );
        const input =
          oversize || binary
            ? data
            : new TextDecoder("utf-8", { fatal: false }).decode(
                data as Uint8Array,
              );
        await this.queue(job, () =>
          this.ingest(job, "poll", input, binary && !oversize, oversize),
        );
      } catch (error) {
        if (!active.closed)
          await this.queue(job, () =>
            this.ingest(
              job,
              "system",
              `poll error: ${boundedError(error)}`,
              false,
            ),
          );
        failures++;
      } finally {
        await dispatcher?.close().catch(() => undefined);
      }
      if (!active.closed && !TERMINAL.has(job.status)) {
        const delay = Math.max(
          definition.intervalMs ?? 1_000,
          Math.min(30_000, 500 * 2 ** Math.min(failures, 6)),
        );
        timer = setTimeout(
          poll,
          Math.round(delay * (0.75 + Math.random() * 0.5)),
        );
      }
    };
    active.stop = async () => {
      active.closed = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
    void poll();
  }

  private async readBounded(response: Response, max: number) {
    if (!response.body) return { data: new Uint8Array(), oversize: false };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        return {
          data: `[oversize poll response rejected: ${size}+ bytes]`,
          oversize: true,
        };
      }
      chunks.push(value);
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { data: joined, oversize: false };
  }

  private async ensureApproved(job: JobRecord, definition: NetworkDefinition) {
    const protocols =
      definition.kind === "websocket" ? ["ws:", "wss:"] : ["http:", "https:"];
    const request = await inspectNetworkTarget(definition.url, protocols);
    const sameAddresses =
      job.approvedAddresses?.length === request.addresses.length &&
      request.addresses.every(
        (address, index) => job.approvedAddresses?.[index] === address,
      );
    if (
      job.approvedEndpoint === request.endpoint &&
      sameAddresses &&
      request.restricted.every((scope) =>
        job.approvedRestricted?.includes(scope),
      )
    )
      return;
    if (!(await this.hooks.approveNetwork(request)))
      throw new Error(`Network scope not approved: ${request.endpoint}`);
    job.approvedEndpoint = request.endpoint;
    job.approvedAddresses = request.addresses;
    job.approvedRestricted = request.restricted;
  }

  private async ingest(
    job: JobRecord,
    source: JobEvent["source"],
    input: string | Uint8Array,
    binary: boolean,
    forcedOversize = false,
  ) {
    if (TERMINAL.has(job.status) || this.shuttingDown) return;
    const definition = job.definition;
    const rawBytes =
      typeof input === "string" ? Buffer.byteLength(input) : input.byteLength;
    let data: string;
    let oversize = forcedOversize;
    if (forcedOversize)
      data =
        typeof input === "string"
          ? input
          : `[oversize ${source} frame rejected]`;
    else if (
      definition.kind !== "command" &&
      rawBytes > definition.maxFrameBytes
    ) {
      data = `[oversize ${source} frame rejected: ${rawBytes} bytes]`;
      oversize = true;
    } else if (binary) {
      data =
        definition.kind !== "command" && definition.binary === "base64"
          ? Buffer.from(input as Uint8Array).toString("base64")
          : `[binary ${source} frame rejected: ${rawBytes} bytes]`;
    } else
      data =
        typeof input === "string" ? input : new TextDecoder().decode(input);

    if (definition.dedupeJsonPath) {
      const selected = jsonPathValue(definition.dedupeJsonPath, data);
      const key = createHash("sha256")
        .update(source)
        .update("\0")
        .update(selected ?? data)
        .digest("hex");
      if (job.recentDedupeKeys.includes(key)) {
        job.duplicateEvents++;
        job.updatedAt = Date.now();
        await this.save();
        return;
      }
      job.recentDedupeKeys.push(key);
      if (job.recentDedupeKeys.length > MAX_DEDUPE_KEYS)
        job.recentDedupeKeys.shift();
    }

    const event: JobEvent = {
      sequence: (job.events.at(-1)?.sequence ?? job.droppedEvents) + 1,
      at: Date.now(),
      source,
      data,
      bytes: Buffer.byteLength(data),
      ...(binary ? { binary: true } : {}),
      ...(oversize ? { oversize: true } : {}),
    };
    await this.store.append(job, event);
    if (this.shuttingDown || TERMINAL.has(job.status)) return;
    const queue = new BoundedEventQueue(job.events, job.eventBytes);
    queue.push(event);
    job.eventBytes = queue.bytes;
    job.droppedEvents += queue.droppedEvents;
    job.droppedBytes += queue.droppedBytes;
    job.updatedAt = event.at;
    const cursor = jsonPathValue(
      definition.kind === "command" ? undefined : definition.cursorJsonPath,
      data,
    );
    if (cursor !== undefined) job.cursor = cursor.slice(0, 2048);
    await this.save();
    if (this.shuttingDown || TERMINAL.has(job.status)) return;
    if (
      (binary &&
        definition.kind !== "command" &&
        definition.binary === "reject") ||
      oversize
    )
      return;

    const matches = matchingConditions(definition.conditions, event);
    const action = matches.some((condition) => condition.action === "failure")
      ? "failure"
      : matches.some((condition) => condition.action === "complete")
        ? "complete"
        : matches.some((condition) => condition.action === "wake")
          ? "wake"
          : undefined;
    if (action === "wake")
      this.emit(job, "wake", "Wake condition matched.", event);
    else if (action === "complete")
      await this.settle(
        job,
        "completed",
        "Completion condition matched.",
        event,
      );
    else if (action === "failure")
      await this.settle(job, "failed", "Failure condition matched.", event);
  }

  private async ingestCommandChunk(
    job: JobRecord,
    active: ActiveJob,
    stream: "stdout" | "stderr",
    chunk: string,
  ) {
    const key = stream === "stdout" ? "stdoutBuffer" : "stderrBuffer";
    active[key] += chunk;
    while (true) {
      const newline = active[key].indexOf("\n");
      if (newline < 0) break;
      const line = active[key].slice(0, newline).replace(/\r$/, "");
      active[key] = active[key].slice(newline + 1);
      await this.ingest(job, stream, line, false);
    }
    if (Buffer.byteLength(active[key]) > DEFAULT_FRAME_BYTES) {
      const oversize = `[oversize ${stream} line rejected]`;
      active[key] = "";
      await this.ingest(job, stream, oversize, false, true);
    }
  }

  private async flushCommandBuffers(job: JobRecord, active: ActiveJob) {
    for (const stream of ["stdout", "stderr"] as const) {
      const key = stream === "stdout" ? "stdoutBuffer" : "stderrBuffer";
      if (!active[key]) continue;
      const tail = active[key].replace(/\r$/, "");
      active[key] = "";
      await this.ingest(job, stream, tail, false);
    }
  }

  private async commandSettled(job: JobRecord, settlement: TerminalSettlement) {
    if (TERMINAL.has(job.status) || this.shuttingDown) return;
    const reason =
      settlement.errorText ??
      (settlement.signal
        ? `signal ${settlement.signal}`
        : `exit ${settlement.exitCode ?? "?"}`);
    await this.settle(
      job,
      settlement.status === "done" ? "completed" : "failed",
      reason,
    );
  }

  private async settle(
    job: JobRecord,
    status: "completed" | "failed",
    reason: string,
    event?: JobEvent,
  ) {
    if (TERMINAL.has(job.status)) return;
    job.status = status;
    job.error = status === "failed" ? reason : undefined;
    job.settledAt = job.updatedAt = Date.now();
    await this.save(true);
    await this.stopActive(job);
    this.emit(job, status, reason, event);
  }

  private async fail(job: JobRecord, reason: string) {
    await this.settle(job, "failed", reason);
  }

  private armDeadline(job: JobRecord) {
    const { timeoutMs, deadline } = job.definition;
    const expires = Math.min(
      deadline ?? Infinity,
      timeoutMs === undefined
        ? Infinity
        : (job.startedAt ?? Date.now()) + timeoutMs,
    );
    if (!Number.isFinite(expires)) return;
    const active = this.active.get(job.id);
    if (!active) return;
    const priorStop = active.stop;
    const timer = setTimeout(
      () =>
        this.queue(job, () => this.fail(job, "Job timeout/deadline exceeded.")),
      Math.max(0, expires - Date.now()),
    );
    active.stop = async () => {
      clearTimeout(timer);
      await priorStop();
    };
  }

  private newActive(job: JobRecord): ActiveJob {
    return {
      generation: job.attempt,
      closed: false,
      queued: 0,
      stdoutBuffer: "",
      stderrBuffer: "",
      stop: async () => {},
      chain: Promise.resolve(),
    };
  }

  private queue(job: JobRecord, operation: () => Promise<void>) {
    const active = this.active.get(job.id);
    if (
      !active ||
      active.closed ||
      this.shuttingDown ||
      active.generation !== job.attempt
    )
      return Promise.resolve();
    if (active.queued >= MAX_QUEUED_OPERATIONS) {
      active.closed = true;
      active.chain = active.chain.then(
        () => this.fail(job, "Job event ingress exceeded the bounded queue."),
        () => this.fail(job, "Job event ingress exceeded the bounded queue."),
      );
      return active.chain;
    }
    active.queued++;
    const run = () => operation().finally(() => active.queued--);
    active.chain = active.chain.then(run, run);
    return active.chain;
  }

  private async stopActive(job: JobRecord, drain = false) {
    const active = this.active.get(job.id);
    if (!active) return;
    this.active.delete(job.id);
    await active.stop();
    if (drain) await active.chain;
  }

  private require(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown job id "${id}".`);
    return job;
  }

  private save(force = false) {
    if (!this.scope) throw new Error("Job manager is not initialized.");
    this.scope.jobs = [...this.jobs.values()];
    if (!force && ++this.unsavedEvents < SCOPE_SAVE_EVENT_BATCH)
      return Promise.resolve();
    this.unsavedEvents = 0;
    return this.store.save(this.scope);
  }

  private emit(
    job: JobRecord,
    type: JobLifecycleType,
    reason?: string,
    event?: JobEvent,
  ) {
    const at = Date.now();
    const lifecycle: JobLifecycleEvent = {
      type,
      jobId: job.id,
      title: job.definition.title,
      kind: job.definition.kind,
      status: job.status,
      at,
      attempt: job.attempt,
      durationMs: Math.max(0, at - (job.startedAt ?? job.createdAt)),
      ...(reason ? { reason } : {}),
      ...(event ? { event } : {}),
    };
    this.hooks.onLifecycle(lifecycle);
  }
}

export function createDefaultManager(store: JobStore, hooks: JobManagerHooks) {
  return new JobManager(store, new BackgroundTerminalAdapter(), hooks);
}
