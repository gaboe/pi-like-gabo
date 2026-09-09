import type { Task } from "../tool/types.js";
import { createHash } from "node:crypto";

export const MAX_CANCELLATION_INTENTS = 256;
/** Primary, overflow, and bounded quarantine recovery combined. */
export const MAX_CANCELLATION_RECOVERY_ENTRIES = MAX_CANCELLATION_INTENTS * 4;
export const CANCELLATION_CAPACITY_ERROR =
  "Cancellation recovery capacity reached; resolve or deliberately re-arm an existing cancellation before creating another.";
export const CANCELLATION_QUARANTINE_ERROR =
  "Cancellation recovery needs manual re-arm; no worker is authorized from quarantine without current ownership proof.";

export interface TodoCancellationIntent {
  kind: "delegation" | "preparation";
  taskId: number;
  token: string;
  ids: string[];
  generation: number;
  attempts: number;
  correlationId?: string;
  workerGeneration?: number;
  error?: string;
  orphaned?: boolean;
  rearmed?: true;
}

export function cancellationIntentCorrelationId(
  intent: Pick<
    TodoCancellationIntent,
    | "kind"
    | "taskId"
    | "token"
    | "generation"
    | "workerGeneration"
    | "ids"
    | "correlationId"
  >,
): string {
  if (
    typeof intent.correlationId === "string" &&
    /^[a-f0-9]{16,64}$/.test(intent.correlationId)
  )
    return intent.correlationId;
  return createHash("sha256")
    .update(
      JSON.stringify([
        intent.kind,
        intent.taskId,
        intent.token,
        intent.generation,
        intent.workerGeneration ?? null,
        normalizeCancellationIds(intent.ids),
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

export function normalizeCancellationIntent(
  intent: TodoCancellationIntent,
): TodoCancellationIntent {
  const normalized = {
    ...intent,
    ids: normalizeCancellationIds(intent.ids),
    correlationId: cancellationIntentCorrelationId(intent),
  };
  for (const field of [
    "workerGeneration",
    "error",
    "orphaned",
    "rearmed",
  ] as const) {
    if (normalized[field] === undefined) delete normalized[field];
  }
  return normalized;
}

export function normalizeCancellationIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
    .sort()
    .slice(0, 64);
}

/** Unique union of every persisted delegation worker-ID representation. */
export function delegationWorkerIds(
  delegation: Record<string, unknown> | undefined,
): string[] {
  if (!delegation) return [];
  return [
    ...new Set(
      [
        ...(Array.isArray(delegation.subagentIds)
          ? delegation.subagentIds
          : []),
        ...(Array.isArray(delegation.workerIds) ? delegation.workerIds : []),
        ...(Array.isArray(delegation.cancellationIds)
          ? delegation.cancellationIds
          : []),
        delegation.subagentId,
      ].filter(
        (id): id is string => typeof id === "string" && Boolean(id.trim()),
      ),
    ),
  ].sort();
}

export interface CancellationIntentMerge {
  intents: TodoCancellationIntent[];
  overflow: TodoCancellationIntent[];
  capacityExceeded: boolean;
}

export function allCancellationIntents(
  state: Pick<
    TaskState,
    "cancellationIntents" | "cancellationOverflow" | "cancellationQuarantine"
  >,
): TodoCancellationIntent[] {
  const merged = new Map<string, TodoCancellationIntent>();
  for (const intent of [
    ...(state.cancellationIntents ?? []),
    ...(state.cancellationOverflow ?? []),
    ...(state.cancellationQuarantine ?? []),
  ]) {
    const key = cancellationIntentTargetKey(intent);
    const prior = merged.get(key);
    merged.set(
      key,
      prior ? mergeCancellationIntents([prior], [intent]).intents[0] : intent,
    );
  }
  return [...merged.values()];
}

export function cancellationRecoveryError(
  intents: number,
  overflow: number,
  quarantine: number,
  capacityExceeded = false,
): string | undefined {
  if (capacityExceeded || intents + overflow >= MAX_CANCELLATION_INTENTS * 2)
    return CANCELLATION_CAPACITY_ERROR;
  if (quarantine > 0) return CANCELLATION_QUARANTINE_ERROR;
  return undefined;
}

export interface CancellationLedgerUpdate {
  accepted: boolean;
  intents: TodoCancellationIntent[];
  overflow: TodoCancellationIntent[];
  quarantine: TodoCancellationIntent[];
  capacityError?: string;
}

export function withCancellationLedger(
  state: TaskState,
  ledger: Pick<
    CancellationLedgerUpdate,
    "intents" | "overflow" | "quarantine" | "capacityError"
  >,
): TaskState {
  const next = { ...state };
  delete next.cancellationOverflow;
  delete next.cancellationQuarantine;
  delete next.cancellationCapacityError;
  next.cancellationIntents = ledger.intents;
  if (ledger.overflow.length) next.cancellationOverflow = ledger.overflow;
  if (ledger.quarantine.length) next.cancellationQuarantine = ledger.quarantine;
  if (ledger.capacityError !== undefined)
    next.cancellationCapacityError = ledger.capacityError;
  return next;
}

type CancellationLedgerBand = "primary" | "overflow" | "quarantine";

export interface CancellationLedgerMigration {
  from: TodoCancellationIntent;
  to: TodoCancellationIntent;
}

export function updateCancellationLedger(
  state:
    | Pick<
        TaskState,
        | "cancellationIntents"
        | "cancellationOverflow"
        | "cancellationQuarantine"
      >
    | CancellationLedgerUpdate,
  intent: TodoCancellationIntent,
  options: {
    remove?: boolean;
    error?: unknown;
    orphaned?: boolean;
    band?: CancellationLedgerBand;
  } = {},
): CancellationLedgerUpdate {
  const current =
    "accepted" in state
      ? {
          cancellationIntents: state.intents,
          cancellationOverflow: state.overflow,
          cancellationQuarantine: state.quarantine,
        }
      : state;
  const normalized = normalizeCancellationIntent(intent);
  const targetKey = cancellationIntentTargetKey(normalized);
  const intents = (current.cancellationIntents ?? []).filter(
    (candidate) => cancellationIntentTargetKey(candidate) !== targetKey,
  );
  const overflow = (current.cancellationOverflow ?? []).filter(
    (candidate) => cancellationIntentTargetKey(candidate) !== targetKey,
  );
  const quarantine = (current.cancellationQuarantine ?? []).filter(
    (candidate) => cancellationIntentTargetKey(candidate) !== targetKey,
  );
  const wasPrimary = (current.cancellationIntents ?? []).some(
    (candidate) => cancellationIntentTargetKey(candidate) === targetKey,
  );
  const wasOverflow = (current.cancellationOverflow ?? []).some(
    (candidate) => cancellationIntentTargetKey(candidate) === targetKey,
  );
  const wasQuarantine = (current.cancellationQuarantine ?? []).some(
    (candidate) => cancellationIntentTargetKey(candidate) === targetKey,
  );
  if (
    !options.remove &&
    !wasPrimary &&
    !wasOverflow &&
    !wasQuarantine &&
    intents.length >= MAX_CANCELLATION_INTENTS &&
    overflow.length >= MAX_CANCELLATION_INTENTS
  )
    return {
      accepted: false,
      intents,
      overflow,
      quarantine,
      capacityError: CANCELLATION_CAPACITY_ERROR,
    };
  if (
    !options.remove &&
    !wasPrimary &&
    !wasOverflow &&
    !wasQuarantine &&
    options.band === "overflow" &&
    overflow.length >= MAX_CANCELLATION_INTENTS
  )
    return {
      accepted: false,
      intents,
      overflow,
      quarantine,
      capacityError: CANCELLATION_CAPACITY_ERROR,
    };
  if (
    !options.remove &&
    !wasPrimary &&
    !wasOverflow &&
    !wasQuarantine &&
    options.band === "quarantine" &&
    quarantine.length >= MAX_CANCELLATION_RECOVERY_ENTRIES
  )
    return {
      accepted: false,
      intents,
      overflow,
      quarantine,
      capacityError: CANCELLATION_CAPACITY_ERROR,
    };
  if (!options.remove) {
    const { error: _previousError, ...withoutError } = normalized;
    const record = normalizeCancellationIntent({
      ...withoutError,
      ...(options.orphaned === undefined
        ? {}
        : options.orphaned
          ? { orphaned: true }
          : { orphaned: undefined }),
      ...(options.error === undefined
        ? {}
        : { error: String(options.error).trim().slice(0, 512) }),
    });
    if (options.band === "quarantine" || wasQuarantine) quarantine.push(record);
    else if (options.band === "overflow" || wasOverflow) overflow.push(record);
    else if (!wasPrimary && intents.length >= MAX_CANCELLATION_INTENTS)
      overflow.push(record);
    else intents.push(record);
  }
  return {
    accepted: true,
    intents,
    overflow,
    quarantine,
    capacityError: cancellationRecoveryError(
      intents.length,
      overflow.length,
      quarantine.length,
    ),
  };
}

function cancellationBandPriority(band: CancellationLedgerBand): number {
  return band === "quarantine" ? 2 : band === "overflow" ? 1 : 0;
}

/**
 * Re-key cancellation intents without ever writing a cross-band duplicate or
 * dropping an entry when the bounded ledger cannot admit the result.
 */
export function migrateCancellationLedger(
  state: Pick<
    TaskState,
    "cancellationIntents" | "cancellationOverflow" | "cancellationQuarantine"
  >,
  migrations: readonly CancellationLedgerMigration[],
): CancellationLedgerUpdate {
  const records = new Map<
    string,
    { intent: TodoCancellationIntent; band: CancellationLedgerBand }
  >();
  const addExisting = (
    intent: TodoCancellationIntent,
    band: CancellationLedgerBand,
  ): void => {
    const normalized = normalizeCancellationIntent(intent);
    const key = cancellationIntentTargetKey(normalized);
    const prior = records.get(key);
    if (!prior) {
      records.set(key, { intent: normalized, band });
      return;
    }
    records.set(key, {
      intent: mergeCancellationIntents([prior.intent], [normalized]).intents[0],
      band:
        cancellationBandPriority(prior.band) >= cancellationBandPriority(band)
          ? prior.band
          : band,
    });
  };
  for (const intent of state.cancellationIntents ?? [])
    addExisting(intent, "primary");
  for (const intent of state.cancellationOverflow ?? [])
    addExisting(intent, "overflow");
  for (const intent of state.cancellationQuarantine ?? [])
    addExisting(intent, "quarantine");

  for (const migration of migrations) {
    const from = normalizeCancellationIntent(migration.from);
    const to = normalizeCancellationIntent(migration.to);
    const fromKey = cancellationIntentTargetKey(from);
    const toKey = cancellationIntentTargetKey(to);
    const source = records.get(fromKey);
    if (!source) continue;
    records.delete(fromKey);
    const prior = records.get(toKey);
    const band = prior
      ? cancellationBandPriority(prior.band) >=
        cancellationBandPriority(source.band)
        ? prior.band
        : source.band
      : source.band;
    const mergeRecord = (priorIntent: TodoCancellationIntent) =>
      normalizeCancellationIntent({
        ...to,
        attempts: Math.max(priorIntent.attempts, to.attempts),
        error: priorIntent.error ?? to.error,
        correlationId: priorIntent.correlationId ?? to.correlationId,
        rearmed: priorIntent.rearmed ?? to.rearmed,
        orphaned: priorIntent.orphaned || to.orphaned,
      });
    records.set(toKey, {
      intent: prior ? mergeRecord(prior.intent) : mergeRecord(source.intent),
      band,
    });
  }

  let result: CancellationLedgerUpdate = {
    accepted: true,
    intents: [],
    overflow: [],
    quarantine: [],
  };
  for (const { intent, band } of records.values()) {
    result = updateCancellationLedger(result, intent, { band });
    if (!result.accepted) return result;
  }
  if (
    result.intents.length > MAX_CANCELLATION_INTENTS ||
    result.overflow.length > MAX_CANCELLATION_INTENTS ||
    result.intents.length + result.overflow.length + result.quarantine.length >
      MAX_CANCELLATION_RECOVERY_ENTRIES
  )
    return {
      accepted: false,
      intents: [...(state.cancellationIntents ?? [])],
      overflow: [...(state.cancellationOverflow ?? [])],
      quarantine: [...(state.cancellationQuarantine ?? [])],
      capacityError: CANCELLATION_CAPACITY_ERROR,
    };
  return result;
}

export interface RearmedCancellationLedger {
  changed: boolean;
  intents: TodoCancellationIntent[];
  overflow: TodoCancellationIntent[];
  quarantine: TodoCancellationIntent[];
  rearmed: TodoCancellationIntent[];
  capacityError?: string;
}

export function rearmCancellationLedger(
  state: TaskState,
  kind: TodoCancellationIntent["kind"],
  taskId: number | undefined,
  tokens: readonly string[] | undefined,
  authorize: (intent: TodoCancellationIntent) => boolean,
  promote: (intent: TodoCancellationIntent) => boolean = authorize,
  rewrite: (intent: TodoCancellationIntent) => TodoCancellationIntent = (
    intent,
  ) => intent,
): RearmedCancellationLedger {
  const rearmed: TodoCancellationIntent[] = [];
  const matches = (intent: TodoCancellationIntent) =>
    intent.kind === kind &&
    (taskId === undefined || intent.taskId === taskId) &&
    (tokens === undefined || tokens.includes(intent.token));
  const primary = [...(state.cancellationIntents ?? [])];
  const overflow = [...(state.cancellationOverflow ?? [])];
  const primaryKeys = new Set(
    [...primary, ...overflow].map(cancellationIntentTargetKey),
  );
  const promotions = (state.cancellationQuarantine ?? []).filter(
    (intent) =>
      matches(intent) &&
      intent.attempts >= 3 &&
      promote(intent) &&
      authorize(intent) &&
      !primaryKeys.has(cancellationIntentTargetKey(intent)),
  );
  if (
    promotions.length >
    MAX_CANCELLATION_INTENTS * 2 - primary.length - overflow.length
  )
    return {
      changed: false,
      intents: primary,
      overflow,
      quarantine: [...(state.cancellationQuarantine ?? [])],
      rearmed: [],
    };
  const rearm = (
    intent: TodoCancellationIntent,
  ): { intent: TodoCancellationIntent; rearmed: boolean } => {
    if (!matches(intent) || intent.attempts < 3 || !authorize(intent))
      return { intent, rearmed: false };
    const { error: _error, ...withoutError } = intent;
    const next = normalizeCancellationIntent(
      rewrite({
        ...withoutError,
        attempts: 0,
        rearmed: true as const,
      }),
    );
    return { intent: next, rearmed: true };
  };
  const rearmRecord = (
    intent: TodoCancellationIntent,
  ): TodoCancellationIntent => {
    const result = rearm(intent);
    if (result.rearmed) rearmed.push(result.intent);
    return result.intent;
  };
  const nextIntents = primary.map(rearmRecord);
  const nextOverflow = overflow.map(rearmRecord);
  const promotedKeys = new Set<string>();
  let nextQuarantine = [...(state.cancellationQuarantine ?? [])];
  for (const intent of promotions) {
    const result = rearm({ ...intent, orphaned: undefined });
    if (!result.rearmed) continue;
    const next = result.intent;
    rearmed.push(next);
    promotedKeys.add(cancellationIntentTargetKey(intent));
    if (nextIntents.length < MAX_CANCELLATION_INTENTS) nextIntents.push(next);
    else nextOverflow.push(next);
  }
  if (promotedKeys.size)
    nextQuarantine = nextQuarantine.filter(
      (intent) => !promotedKeys.has(cancellationIntentTargetKey(intent)),
    );
  const changed =
    JSON.stringify(nextIntents) !==
      JSON.stringify(state.cancellationIntents ?? []) ||
    JSON.stringify(nextOverflow) !==
      JSON.stringify(state.cancellationOverflow ?? []) ||
    JSON.stringify(nextQuarantine) !==
      JSON.stringify(state.cancellationQuarantine ?? []);
  return {
    changed,
    intents: nextIntents,
    overflow: nextOverflow,
    quarantine: nextQuarantine,
    rearmed,
    capacityError: cancellationRecoveryError(
      nextIntents.length,
      nextOverflow.length,
      nextQuarantine.length,
    ),
  };
}

export function mergeCancellationIntents(
  existing: readonly TodoCancellationIntent[],
  additions: readonly TodoCancellationIntent[],
): CancellationIntentMerge {
  const merged = new Map<string, TodoCancellationIntent>();
  const merge = (
    prior: TodoCancellationIntent | undefined,
    next: TodoCancellationIntent,
  ): TodoCancellationIntent =>
    normalizeCancellationIntent({
      ...next,
      ...(prior
        ? {
            attempts: Math.max(prior.attempts, next.attempts),
            error: prior.error ?? next.error,
            correlationId: prior.correlationId ?? next.correlationId,
            rearmed: prior.rearmed ?? next.rearmed,
            orphaned: prior.orphaned || next.orphaned,
          }
        : {}),
    });
  const add = (candidate: TodoCancellationIntent): void => {
    const normalized = normalizeCancellationIntent(candidate);
    const key = cancellationIntentTargetKey(normalized);
    const prior = merged.get(key);
    if (prior) {
      merged.set(key, merge(prior, normalized));
      return;
    }
    merged.set(key, normalized);
  };
  for (const intent of existing) add(intent);
  for (const intent of additions) add(intent);
  const values = [...merged.values()];
  return {
    intents: values.slice(0, MAX_CANCELLATION_INTENTS),
    overflow: values.slice(
      MAX_CANCELLATION_INTENTS,
      MAX_CANCELLATION_INTENTS * 2,
    ),
    capacityExceeded: values.length > MAX_CANCELLATION_INTENTS * 2,
  };
}

export function cancellationIntentTargetKey(
  intent: Pick<
    TodoCancellationIntent,
    "kind" | "taskId" | "token" | "generation" | "workerGeneration" | "ids"
  >,
): string {
  return JSON.stringify([
    intent.kind,
    intent.taskId,
    intent.token,
    intent.generation,
    intent.workerGeneration ?? null,
    normalizeCancellationIds(intent.ids),
  ]);
}

export function cancellationIntentMatchesCurrentTask(
  state: TaskState,
  intent: TodoCancellationIntent,
): boolean {
  const hasGeneration = (value: unknown, expected: number, minimum = 0) =>
    Number.isSafeInteger(value) &&
    Number(value) >= minimum &&
    Number(value) === expected;
  const hasIds = (value: unknown, ids: readonly string[]) =>
    Array.isArray(value) && ids.every((id) => value.includes(id));
  const task = state.tasks.find((candidate) => candidate.id === intent.taskId);
  if (!task) return false;
  const metadata = task.metadata ?? {};
  if (intent.kind === "preparation") {
    const preparation = metadata.preparation as
      Record<string, unknown> | undefined;
    if (intent.orphaned) {
      const sameTaskRepreparing =
        preparation &&
        preparation.token !== intent.token &&
        ["queued", "running", "classifying", "failed"].includes(
          String(preparation.status),
        );
      if (!(
        task.status === "completed" ||
        task.status === "deleted" ||
        sameTaskRepreparing
      ))
        return false;
      const currentIds = [
        ...(Array.isArray(preparation?.activeWorkerIds)
          ? preparation.activeWorkerIds
          : []),
        ...(Array.isArray(preparation?.cancellationIds)
          ? preparation.cancellationIds
          : []),
        preparation?.subagentId,
      ].filter((id): id is string => typeof id === "string");
      if (sameTaskRepreparing) {
        const oldCancellationIds = Array.isArray(preparation?.cancellationIds)
          ? preparation.cancellationIds.filter(
              (id): id is string => typeof id === "string",
            )
          : [];
        return (
          preparation?.cancellationToken === intent.token &&
          hasGeneration(
            preparation.cancellationWorkerGeneration,
            intent.workerGeneration ?? -1,
          ) &&
          hasIds(oldCancellationIds, intent.ids)
        );
      }
      const generation =
        preparation?.cancellationWorkerGeneration ??
        preparation?.workerGeneration;
      if (!hasGeneration(generation, intent.workerGeneration ?? -1))
        return false;
      if (!hasIds(currentIds, intent.ids)) return false;
      return preparation?.token === intent.token;
    }
    if (!preparation || preparation.token !== intent.token) return false;
    const ids = [
      ...(Array.isArray(preparation.activeWorkerIds)
        ? preparation.activeWorkerIds
        : []),
      ...(Array.isArray(preparation.cancellationIds)
        ? preparation.cancellationIds
        : []),
      preparation.subagentId,
    ].filter((id): id is string => typeof id === "string");
    if (!intent.ids.every((id) => ids.includes(id))) return false;
    if (
      preparation.workerGeneration !== undefined &&
      preparation.workerGeneration !== intent.workerGeneration
    )
      return false;
    if (preparation.workerGeneration !== undefined) return true;
    if (
      preparation.cancellationWorkerGeneration !== undefined &&
      preparation.cancellationWorkerGeneration !== intent.workerGeneration
    )
      return false;
    return (
      preparation.cancellationWorkerGeneration !== undefined ||
      intent.workerGeneration === 0
    );
  }
  const delegation = metadata.delegation as Record<string, unknown> | undefined;
  if (intent.orphaned) {
    const currentDelegation = metadata.delegation as
      Record<string, unknown> | undefined;
    const currentIds = delegationWorkerIds(currentDelegation);
    const sameDelegationIncarnation =
      currentDelegation?.todoId === task.id &&
      currentDelegation.todoToken === intent.token &&
      ["cancelling", "interrupted"].includes(String(currentDelegation.status));
    const generation = currentDelegation?.cancellationGeneration;
    if (task.status === "completed" || task.status === "deleted") {
      return Boolean(
        currentDelegation?.todoId === task.id &&
        currentDelegation.todoToken === intent.token &&
        hasGeneration(generation, intent.generation, 1) &&
        hasIds(currentIds, intent.ids),
      );
    }
    if (sameDelegationIncarnation) {
      return Boolean(
        hasGeneration(generation, intent.generation, 1) &&
        hasIds(currentIds, intent.ids),
      );
    }
    return false;
  }
  if (
    !delegation ||
    delegation.todoId !== task.id ||
    delegation.todoToken !== intent.token ||
    !(
      ["cancelling", "interrupted"].includes(String(delegation.status)) ||
      (String(delegation.status) === "cancelled" &&
        Array.isArray(delegation.cancellationIds) &&
        intent.ids.every((id) =>
          (delegation.cancellationIds as unknown[]).includes(id),
        ))
    )
  )
    return false;
  const ids = delegationWorkerIds(delegation);
  if (!intent.ids.every((id) => ids.includes(id))) return false;
  const cancellationIds = Array.isArray(delegation.cancellationIds)
    ? delegation.cancellationIds
    : [];
  return (
    delegation.cancellationGeneration === undefined ||
    delegation.cancellationGeneration === intent.generation ||
    ((task.status === "completed" || task.status === "deleted") &&
      intent.ids.every((id) => cancellationIds.includes(id)))
  );
}

/**
 * Canonical state for the todo tool. Single source of truth — both the reducer
 * (`state/state-reducer.ts`) and the live store cell (`state/store.ts`) read
 * this shape. Replay (`state/replay.ts`) returns a fresh `TaskState`; the
 * lifecycle handlers in `index.ts` write it via `replaceState`.
 *
 * The shape is intentionally minimal — no derived caches or runtime cells.
 * Selectors in `state/selectors.ts` are pure of `TaskState` and own all
 * derivations (visible/grouped/counted/etc).
 */
export interface TaskState {
  tasks: Task[];
  nextId: number;
  revision: number;
  orchestrator?: { setting: "on" | "off" | "auto"; sticky?: boolean };
  cancellationIntents?: TodoCancellationIntent[];
  cancellationOverflow?: TodoCancellationIntent[];
  cancellationQuarantine?: TodoCancellationIntent[];
  cancellationCapacityError?: string;
}

export const EMPTY_STATE: TaskState = { tasks: [], nextId: 1, revision: 0 };
