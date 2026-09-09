export const TELEMETRY_CHANNEL = "telemetry:v1";

export type TelemetryErrorCategory =
  | "aborted"
  | "timeout"
  | "turn_limit"
  | "validation"
  | "provider"
  | "tool"
  | "persistence"
  | "unknown";

export type TelemetryEvent =
  | {
      type: "workflow_run";
      phase: "start" | "settle";
      status: "running" | "completed" | "failed" | "aborted";
      durationMs: number;
      errorCategory?: TelemetryErrorCategory;
    }
  | {
      type: "workflow_agent";
      agentIndex: number;
      phase: "start" | "settle";
      status: "running" | "completed" | "failed" | "aborted";
      turns: number;
      maxTurns: number;
      durationMs: number;
      errorCategory?: TelemetryErrorCategory;
    }
  | {
      type: "job";
      action:
        | "created"
        | "started"
        | "restarted"
        | "wake"
        | "completed"
        | "failed"
        | "stopped"
        | "interrupted"
        | "deleted";
      kind: "command" | "websocket" | "poll";
      status:
        | "starting"
        | "running"
        | "completed"
        | "failed"
        | "stopped"
        | "interrupted";
      attempt: number;
      durationMs: number;
    }
  | {
      type: "todo_state" | "todo_no_progress";
      status:
        | "preparing"
        | "ready"
        | "in_progress"
        | "waiting"
        | "verifying"
        | "completed"
        | "failed";
    }
  | {
      type: "todo_cancellation";
      status: "cancelling" | "failed" | "exhausted" | "settled";
    }
  | {
      type: "background_terminal";
      phase: "start" | "settle";
      status: "running" | "done" | "failed" | "killed";
      durationMs: number;
      exitCategory?:
        "success" | "nonzero" | "signal" | "killed" | "runtime_error";
    };

type TelemetryIdentityKey = "runId" | "jobId" | "taskId" | "terminalId";
export type TelemetryRecord = TelemetryEvent extends infer Event
  ? Event extends TelemetryEvent
    ? Omit<Event, TelemetryIdentityKey> & { v: 1; ts: string }
    : never
  : never;

interface EventBus {
  emit(channel: string, value: unknown): unknown;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function integer(value: unknown, minimum = 0): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum
    ? value
    : undefined;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
): T[number] | undefined {
  return typeof value === "string" && values.includes(value)
    ? (value as T[number])
    : undefined;
}

function errorCategory(value: unknown): TelemetryErrorCategory | undefined {
  return oneOf(value, [
    "aborted",
    "timeout",
    "turn_limit",
    "validation",
    "provider",
    "tool",
    "persistence",
    "unknown",
  ] as const);
}

export function normalizeTelemetryEvent(
  value: unknown,
  now = Date.now(),
): TelemetryRecord | undefined {
  const event = object(value);
  if (!event) return undefined;
  const ts = new Date(Number.isFinite(now) ? now : Date.now()).toISOString();
  if (event.type === "workflow_run") {
    const phase = oneOf(event.phase, ["start", "settle"] as const);
    const status = oneOf(event.status, [
      "running",
      "completed",
      "failed",
      "aborted",
    ] as const);
    const durationMs = integer(event.durationMs);
    const category =
      event.errorCategory === undefined
        ? undefined
        : errorCategory(event.errorCategory);
    if (
      !phase ||
      !status ||
      durationMs === undefined ||
      (event.errorCategory !== undefined && !category)
    )
      return undefined;
    return {
      v: 1,
      ts,
      type: "workflow_run",
      phase,
      status,
      durationMs,
      ...(category ? { errorCategory: category } : {}),
    };
  }
  if (event.type === "workflow_agent") {
    const agentIndex = integer(event.agentIndex, 1);
    const phase = oneOf(event.phase, ["start", "settle"] as const);
    const status = oneOf(event.status, [
      "running",
      "completed",
      "failed",
      "aborted",
    ] as const);
    const turns = integer(event.turns);
    const maxTurns = integer(event.maxTurns, 1);
    const durationMs = integer(event.durationMs);
    const category =
      event.errorCategory === undefined
        ? undefined
        : errorCategory(event.errorCategory);
    if (
      agentIndex === undefined ||
      !phase ||
      !status ||
      turns === undefined ||
      maxTurns === undefined ||
      turns > maxTurns ||
      durationMs === undefined ||
      (event.errorCategory !== undefined && !category)
    )
      return undefined;
    return {
      v: 1,
      ts,
      type: "workflow_agent",
      agentIndex,
      phase,
      status,
      turns,
      maxTurns,
      durationMs,
      ...(category ? { errorCategory: category } : {}),
    };
  }
  if (event.type === "job") {
    const action = oneOf(event.action, [
      "created",
      "started",
      "restarted",
      "wake",
      "completed",
      "failed",
      "stopped",
      "interrupted",
      "deleted",
    ] as const);
    const kind = oneOf(event.kind, ["command", "websocket", "poll"] as const);
    const status = oneOf(event.status, [
      "starting",
      "running",
      "completed",
      "failed",
      "stopped",
      "interrupted",
    ] as const);
    const attempt = integer(event.attempt, 1);
    const durationMs = integer(event.durationMs);
    if (
      !action ||
      !kind ||
      !status ||
      attempt === undefined ||
      durationMs === undefined
    )
      return undefined;
    return {
      v: 1,
      ts,
      type: "job",
      action,
      kind,
      status,
      attempt,
      durationMs,
    };
  }
  if (event.type === "todo_state" || event.type === "todo_no_progress") {
    const status = oneOf(event.status, [
      "preparing",
      "ready",
      "in_progress",
      "waiting",
      "verifying",
      "completed",
      "failed",
    ] as const);
    if (!status) return undefined;
    return { v: 1, ts, type: event.type, status };
  }
  if (event.type === "todo_cancellation") {
    const status = oneOf(event.status, [
      "cancelling",
      "failed",
      "exhausted",
      "settled",
    ] as const);
    if (!status) return undefined;
    return { v: 1, ts, type: event.type, status };
  }
  if (event.type === "background_terminal") {
    const phase = oneOf(event.phase, ["start", "settle"] as const);
    const status = oneOf(event.status, [
      "running",
      "done",
      "failed",
      "killed",
    ] as const);
    const durationMs = integer(event.durationMs);
    const exitCategory =
      event.exitCategory === undefined
        ? undefined
        : oneOf(event.exitCategory, [
            "success",
            "nonzero",
            "signal",
            "killed",
            "runtime_error",
          ] as const);
    if (
      !phase ||
      !status ||
      durationMs === undefined ||
      (event.exitCategory !== undefined && !exitCategory)
    )
      return undefined;
    return {
      v: 1,
      ts,
      type: "background_terminal",
      phase,
      status,
      durationMs,
      ...(exitCategory ? { exitCategory } : {}),
    };
  }
  return undefined;
}

export function emitTelemetry(bus: EventBus, event: TelemetryEvent): void {
  try {
    bus.emit(TELEMETRY_CHANNEL, event);
  } catch {}
}

export function categorizeTelemetryError(
  error: unknown,
  status?: string,
): TelemetryErrorCategory | undefined {
  if (!error && status !== "aborted") return undefined;
  const text = String(error ?? "").toLowerCase();
  if (/turn.{0,12}limit|max turns/.test(text)) return "turn_limit";
  if (/timeout|timed out|deadline|no assistant response/.test(text))
    return "timeout";
  if (status === "aborted" || /abort|shutting down|shutdown/.test(text))
    return "aborted";
  if (/artifact|persist/.test(text)) return "persistence";
  if (/structured_output|tool/.test(text)) return "tool";
  if (/provider|model|api|rate limit|response event/.test(text))
    return "provider";
  if (/parse|schema|invalid|requires|unknown|must be/.test(text))
    return "validation";
  return "unknown";
}

export function jobLifecycleTelemetry(event: {
  type: Extract<TelemetryEvent, { type: "job" }>["action"];
  jobId: string;
  kind: Extract<TelemetryEvent, { type: "job" }>["kind"];
  status: Extract<TelemetryEvent, { type: "job" }>["status"];
  attempt: number;
  durationMs: number;
}): Extract<TelemetryEvent, { type: "job" }>;
export function jobLifecycleTelemetry(event: {
  type: Extract<TelemetryEvent, { type: "job" }>["action"];
  jobId: string;
  kind: Extract<TelemetryEvent, { type: "job" }>["kind"];
  status: Extract<TelemetryEvent, { type: "job" }>["status"];
  attempt: number;
  durationMs: number;
}): Extract<TelemetryEvent, { type: "job" }> {
  return {
    type: "job",
    action: event.type,
    kind: event.kind,
    status: event.status,
    attempt: event.attempt,
    durationMs: event.durationMs,
  };
}

export function backgroundTerminalTelemetry(
  snapshot: {
    id: string;
    status: "running" | "done" | "failed" | "killed";
    createdAt: number;
    settledAt?: number;
    exitCode?: number;
    signal?: string;
  },
  phase: "start" | "settle",
  now = Date.now(),
): Extract<TelemetryEvent, { type: "background_terminal" }> {
  const end = snapshot.settledAt ?? now;
  const exitCategory =
    phase === "start"
      ? undefined
      : snapshot.status === "done"
        ? "success"
        : snapshot.status === "killed"
          ? "killed"
          : snapshot.signal
            ? "signal"
            : snapshot.exitCode !== undefined
              ? "nonzero"
              : "runtime_error";
  return {
    type: "background_terminal",
    phase,
    status: snapshot.status,
    durationMs: Math.max(0, Math.round(end - snapshot.createdAt)),
    ...(exitCategory ? { exitCategory } : {}),
  };
}
