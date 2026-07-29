/**
 * SubagentManager — owns the registry of running/finished subagents.
 *
 * Each subagent is a scoped `SubagentSession` from a `SubagentBackend` plus a
 * pump fiber that folds its normalized event stream into a mutable
 * `SubagentSnapshot`. Closing a subagent's scope kills the underlying
 * session/process and stops the pump.
 *
 * The manager also exposes a synchronous `SubagentReadModel` so the
 * imperative TUI components (which render synchronously) can read snapshots
 * and issue fire-and-forget commands without touching the Effect runtime.
 */

import {
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Result,
  Scope,
  Stream,
} from "effect";
import type { SubagentBackend, SubagentSession } from "./backend.ts";
import { BackendRegistry } from "./backend.ts";
import {
  DEFAULT_NESTED_WORKER_TURNS,
  DEFAULT_SUBAGENT_TURNS,
  MAX_SUBAGENT_TURNS,
  NESTED_NAME_MAX_BYTES,
  NESTED_OUTPUT_MAX_BYTES,
  NESTED_PROMPT_MAX_BYTES,
  normalizeNestedWorkerTurns,
  normalizeSubagentTurns,
  REASONING_EFFORTS,
} from "./domain.ts";
import {
  handoffRawEvidence,
  packageHandoffCorrection,
  parsePackageHandoff,
} from "./handoff.ts";
import {
  parseTurnBudgetRequest,
  turnBudgetFinalizationWarning,
  withSubagentTurnBudget,
} from "./turn-budget.ts";
import type {
  BackendName,
  BackendSpawnTask,
  LiveToolState,
  NestedSpawnRequest,
  RunOutcome,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
  SubagentSnapshot,
  SubagentStatus,
  TranscriptItem,
  TranscriptPart,
} from "./domain.ts";
import {
  BackendUnavailableError,
  ConcurrencyLimitError,
  SendError,
  SpawnError,
} from "./domain.ts";
import { isMutationCwdAllowed } from "./safe-mutation.ts";
import {
  acquireWorkspaceMutationLease,
  registerManagedWorkspaceWorker,
  registerUnconstrainedWorkspaceWorker,
  type WorkspaceActivity,
  type WorkspaceMutationLease,
} from "../../shared/workspace-mutation-lease.ts";

export const MAX_RUNNING = 4;
export const MAX_TRACKED = 64;
const STOP_TIMEOUT_MS = 5_000;
const ERROR_TEXT_MAX_LENGTH = 4_096;
const TRANSCRIPT_TEXT_MAX_LENGTH = 64 * 1_024;
const LIVE_ASSISTANT_MAX_LENGTH = 128 * 1_024;
const FINAL_TEXT_MAX_LENGTH = 1_024 * 1_024;
const MAX_TRANSCRIPT_ITEMS = 512;
export const MAX_HANDOFF_TRANSCRIPT_PARTS = 64;
export const MAX_HANDOFF_TRANSCRIPT_BYTES = 64 * 1_024;

function bounded(text: string) {
  return text.slice(0, ERROR_TEXT_MAX_LENGTH);
}

function boundedTranscriptText(text: string) {
  return text.slice(0, TRANSCRIPT_TEXT_MAX_LENGTH);
}

function appendTranscript(snapshot: MutableSnapshot, item: TranscriptItem) {
  snapshot.transcript.push(item);
  if (snapshot.transcript.length > MAX_TRANSCRIPT_ITEMS) {
    snapshot.transcript.splice(
      0,
      snapshot.transcript.length - MAX_TRANSCRIPT_ITEMS,
    );
  }
}

function boundedTranscriptParts(parts: ReadonlyArray<TranscriptPart>) {
  return parts.map((part) =>
    part.type === "toolCall"
      ? {
          ...part,
          argsPreview: part.argsPreview
            ? boundedTranscriptText(part.argsPreview)
            : undefined,
        }
      : { ...part, text: boundedTranscriptText(part.text) },
  );
}

function utf8Prefix(text: string, maxBytes: number) {
  const bytes = Buffer.from(text);
  if (bytes.byteLength <= maxBytes) return text;
  return bytes
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
}

function boundedHandoffParts(parts: ReadonlyArray<TranscriptPart>) {
  const retained: TranscriptPart[] = [];
  let remaining = MAX_HANDOFF_TRANSCRIPT_BYTES;
  const take = (text: string) => {
    const value = utf8Prefix(text, remaining);
    remaining -= Buffer.byteLength(value);
    return value;
  };

  for (const part of parts.slice(0, MAX_HANDOFF_TRANSCRIPT_PARTS)) {
    if (remaining === 0) break;
    if (part.type === "text" || part.type === "thinking") {
      retained.push({ ...part, text: take(handoffRawEvidence(part.text)) });
    } else {
      const toolId = take(part.toolId);
      const name = take(part.name);
      const argsPreview = part.argsPreview ? take(part.argsPreview) : undefined;
      retained.push({ ...part, toolId, name, argsPreview });
    }
  }
  return retained;
}

// --- Internal state -----------------------------------------------------------

/** Mutable snapshot; exposed to readers via the readonly SubagentSnapshot type. */
interface MutableSnapshot {
  revision: number;
  id: string;
  backend: BackendName;
  title: string;
  prompt: string;
  cwd: string;
  status: SubagentStatus;
  pendingStart?: boolean;
  createdAt: number;
  settledAt?: number;
  reasoningEffort?: SubagentSnapshot["reasoningEffort"];
  outputContract?: SubagentSnapshot["outputContract"];
  todoId?: number;
  todoToken?: string;
  lineage?: SubagentSnapshot["lineage"];
  maxTurns: number;
  budgetExtension?: SubagentSnapshot["budgetExtension"];
  errorText?: string;
  meta: SubagentMeta;
  usage: { tokens?: number; contextWindow?: number; cost?: number };
  transcript: TranscriptItem[];
  liveAssistant?: { text: string; thinking: string };
  liveTools: LiveToolState[];
  queued: SubagentSnapshot["queued"];
  finalText: string;
  handoff?: SubagentSnapshot["handoff"];
  turns: number;
}

interface Entry {
  snapshot: MutableSnapshot;
  backendTask: BackendSpawnTask;
  session?: SubagentSession;
  scope?: Scope.Closeable;
  pump?: Fiber.Fiber<void>;
  liveToolMap: Map<string, LiveToolState>;
  suppressResultDelivery: boolean;
  correctionUsed: boolean;
  correctionPending: boolean;
  correctionDispatching: boolean;
  correctionDispatch?: Fiber.Fiber<void>;
  correctionGeneration: number;
  correctionTurnLimit?: number;
  cancellationRequested: boolean;
  cancellationStopping: boolean;
  cancellation?: Fiber.Fiber<void>;
  closing?: Fiber.Fiber<void>;
  forcedClosing: boolean;
  descendantDraining: boolean;
  descendantDrain?: Fiber.Fiber<void>;
  pendingOutcome?: RunOutcome;
  forcedFailure?: string;
  maxTurns: number;
  turnClaims: { count: number; limit: number };
  packageBudget?: { claimed: number; limit: number };
  parentContext: SpawnTask["parent"];
  model?: string;
  validateAuthority?: () => string | undefined;
  workspaceWorker?: WorkspaceActivity;
  mutationLease?: WorkspaceMutationLease;
  started: boolean;
  starting: boolean;
  /** Idle restart dispatched but RunStarted not folded yet; counts as running
   * so concurrent restarts cannot race past the cap. */
  restarting?: boolean;
}

// --- Read model ----------------------------------------------------------------

/** Synchronous bridge for the TUI. Snapshots are live objects; do not mutate. */
export interface SubagentReadModel {
  list(): ReadonlyArray<SubagentSnapshot>;
  get(id: string): SubagentSnapshot | undefined;
  size(): number;
  /** Any-change notification (footer status, dashboard). */
  subscribe(listener: () => void): () => void;
  /** Per-subagent notification (takeover view). */
  subscribeTo(id: string, listener: () => void): () => void;
  /** Fire-and-forget: steer/continue a subagent (takeover input). */
  requestSend(id: string, text: string): void;
  /** Fire-and-forget: abort a running subagent (dashboard `x`, takeover). */
  requestAbort(id: string): void;
  /**
   * Register the settle hook. `consumed` is true when an active
   * subagent_wait/cancel is collecting the result (so it must not also be
   * delivered as a follow-up message).
   */
  setOnSettled(
    hook: ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined,
  ): void;
}

// --- Service --------------------------------------------------------------------

export interface CancelResult {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentStatus;
  readonly cancelled: boolean;
}

export interface SubagentManagerShape {
  prepare(
    backend: BackendName,
    task: SpawnTask,
  ): Effect.Effect<
    SubagentSnapshot,
    SpawnError | ConcurrencyLimitError | BackendUnavailableError
  >;
  start(
    id: string,
    signal?: AbortSignal,
  ): Effect.Effect<SubagentSnapshot, SpawnError>;
  reject(id: string, reason: string): Effect.Effect<void>;
  spawn(
    backend: BackendName,
    task: SpawnTask,
  ): Effect.Effect<
    SubagentSnapshot,
    SpawnError | ConcurrencyLimitError | BackendUnavailableError
  >;
  spawnNested(
    parentId: string,
    request: NestedSpawnRequest,
  ): Effect.Effect<
    SubagentSnapshot,
    SpawnError | ConcurrencyLimitError | BackendUnavailableError
  >;
  /**
   * Wait until all listed subagents are settled. Unknown ids are treated as
   * settled (the tool layer validates ids first). While waiting, settles for
   * these ids are marked "consumed". Interruption (tool abort) releases the
   * interest and leaves the subagents running.
   */
  waitFor(
    ids: ReadonlyArray<string>,
    onPending?: (pending: string[]) => void,
  ): Effect.Effect<void>;
  /** Cancel running subagents; resolves when they have settled. */
  cancel(
    ids: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<CancelResult>>;
  send(
    id: string,
    text: string,
    additionalTurns?: number,
  ): Effect.Effect<void, SendError>;
  get(id: string): Effect.Effect<SubagentSnapshot | undefined>;
  readonly list: Effect.Effect<ReadonlyArray<SubagentSnapshot>>;
  readonly disposeAll: Effect.Effect<void>;
  readonly view: SubagentReadModel;
}

export class SubagentManager extends Context.Service<
  SubagentManager,
  SubagentManagerShape
>()("subagents/SubagentManager") {}

// --- Implementation --------------------------------------------------------------

const makeManager = Effect.gen(function* () {
  const registry = yield* BackendRegistry;
  // Detached forker for sync contexts (read-model commands, pruning) that
  // preserves the manager's services instead of using the global runtime.
  const managerContext = yield* Effect.context();
  const runDetached = Effect.runForkWith(managerContext);
  const runPromise = Effect.runPromiseWith(managerContext);

  const entries = new Map<string, Entry>();
  const childrenByParent = new Map<string, Set<string>>();
  const parentByChild = new Map<string, string>();
  const waitInterest = new Map<string, number>();
  const listeners = new Set<() => void>();
  /** One-shot nextChange waiters, swapped out before invocation so waiters
   * re-registering during notification are not visited in the same sweep. */
  let changeWaiters: Array<() => void> = [];
  const idListeners = new Map<string, Set<() => void>>();
  const cleanups = new Set<Fiber.Fiber<unknown>>();
  let counter = 0;
  let reserved = 0;
  let disposed = false;
  let disposal: Fiber.Fiber<void> | undefined;
  let onSettled:
    ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined;
  let drainDescendants = (_entry: Entry, _outcome: RunOutcome) => false;

  const notify = (id?: string) => {
    if (id) {
      const snapshot = entries.get(id)?.snapshot;
      if (snapshot) snapshot.revision++;
    }
    const waiters = changeWaiters;
    changeWaiters = [];
    for (const waiter of waiters) waiter();
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A failed status/render listener must not corrupt lifecycle state.
      }
    }
    if (id) {
      for (const listener of idListeners.get(id) ?? []) {
        try {
          listener();
        } catch {
          // Same.
        }
      }
    }
  };

  /** Resolves on the next state change. Interruption unregisters the waiter. */
  const nextChange = Effect.callback<void>((resume) => {
    const waiter = () => resume(Effect.void);
    changeWaiters.push(waiter);
    return Effect.sync(() => {
      const index = changeWaiters.indexOf(waiter);
      if (index >= 0) changeWaiters.splice(index, 1);
    });
  });

  const runningCount = () =>
    [...entries.values()].filter(
      (e) => e.snapshot.status === "running" || e.restarting === true,
    ).length;

  const addInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) waitInterest.set(id, (waitInterest.get(id) ?? 0) + 1);
  };
  const releaseInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) {
      const count = (waitInterest.get(id) ?? 1) - 1;
      if (count <= 0) waitInterest.delete(id);
      else waitInterest.set(id, count);
    }
  };

  const closeEntryScope = (entry: Entry): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (entry.closing) return Fiber.await(entry.closing).pipe(Effect.asVoid);
      if (!entry.scope) return Effect.void;
      const closing = runDetached(
        Scope.close(entry.scope, Exit.void).pipe(Effect.ignore),
      );
      entry.closing = closing;
      return Fiber.await(closing).pipe(Effect.asVoid);
    });

  const registerWorkspaceWorker = (
    backend: BackendName,
    root: string,
    owner?: WorkspaceMutationLease["owner"],
  ) =>
    backend === "pi"
      ? registerManagedWorkspaceWorker(root, owner)
      : registerUnconstrainedWorkspaceWorker();

  const releaseWorkspace = (entry: Entry) => {
    entry.workspaceWorker?.close();
    entry.workspaceWorker = undefined;
    entry.mutationLease?.close();
    entry.mutationLease = undefined;
  };

  const removeEntry = (entry: Entry) => {
    const id = entry.snapshot.id;
    if (entries.get(id) !== entry) return;
    entries.delete(id);
    const parentId = parentByChild.get(id);
    if (parentId) {
      const children = childrenByParent.get(parentId);
      children?.delete(id);
      if (children?.size === 0) childrenByParent.delete(parentId);
    }
    parentByChild.delete(id);
    childrenByParent.delete(id);
    waitInterest.delete(id);
    releaseWorkspace(entry);
    notify(id);
  };

  const pruneSettled = () => {
    if (entries.size <= MAX_TRACKED) return;
    const candidates = [...entries.values()]
      .filter(
        (e) =>
          e.snapshot.status !== "running" && !waitInterest.has(e.snapshot.id),
      )
      .sort(
        (a, b) =>
          (a.snapshot.settledAt ?? a.snapshot.createdAt) -
          (b.snapshot.settledAt ?? b.snapshot.createdAt),
      );
    for (const entry of candidates) {
      if (entries.size <= MAX_TRACKED) break;
      entries.delete(entry.snapshot.id);
      const parentId = parentByChild.get(entry.snapshot.id);
      if (parentId) childrenByParent.get(parentId)?.delete(entry.snapshot.id);
      parentByChild.delete(entry.snapshot.id);
      childrenByParent.delete(entry.snapshot.id);
      const fiber = runDetached(closeEntryScope(entry));
      cleanups.add(fiber);
      fiber.addObserver(() => cleanups.delete(fiber));
    }
  };

  const finalizeSettlement = (entry: Entry, outcome: RunOutcome) => {
    const s = entry.snapshot;
    entry.correctionPending = false;
    entry.correctionDispatching = false;
    s.settledAt = Date.now();
    switch (outcome._tag) {
      case "Completed":
        s.status = "done";
        s.errorText = undefined;
        s.finalText = outcome.finalText.slice(0, FINAL_TEXT_MAX_LENGTH);
        break;
      case "Failed":
        s.status = "error";
        s.errorText = bounded(outcome.errorText);
        s.finalText = outcome.partialText
          ? handoffRawEvidence(outcome.partialText).slice(
              0,
              FINAL_TEXT_MAX_LENGTH,
            )
          : "";
        break;
      case "Interrupted":
        s.status = "error";
        s.errorText = "Run was aborted";
        s.finalText = outcome.partialText
          ? handoffRawEvidence(outcome.partialText).slice(
              0,
              FINAL_TEXT_MAX_LENGTH,
            )
          : "";
        break;
    }
    if (s.handoff?.errors)
      s.finalText = s.handoff.rawResponses
        .join("\n\n")
        .slice(0, FINAL_TEXT_MAX_LENGTH);
    s.liveAssistant = undefined;
    entry.liveToolMap.clear();
    s.liveTools = [];
    s.queued = [];
    releaseWorkspace(entry);
    const consumed =
      entry.suppressResultDelivery || (waitInterest.get(s.id) ?? 0) > 0;
    notify(s.id);
    try {
      if (!disposed) onSettled?.(s, consumed);
    } catch {}
    pruneSettled();
  };

  const settle = (entry: Entry, incoming: RunOutcome) => {
    const s = entry.snapshot;
    entry.restarting = false;
    if (
      disposed ||
      entry.forcedClosing ||
      s.status !== "running" ||
      (entry.cancellationRequested && entry.cancellationStopping)
    )
      return;

    let outcome: RunOutcome = entry.cancellationRequested
      ? {
          _tag: "Interrupted",
          partialText:
            incoming._tag === "Completed"
              ? incoming.finalText
              : incoming.partialText,
        }
      : entry.forcedFailure
        ? {
            _tag: "Failed",
            errorText: entry.forcedFailure,
            partialText:
              incoming._tag === "Completed"
                ? incoming.finalText
                : incoming.partialText,
          }
        : incoming;

    if (
      entry.snapshot.outputContract === "package_handoff" &&
      outcome._tag === "Completed"
    ) {
      const finalText = outcome.finalText;
      const evidence = handoffRawEvidence(finalText);
      const rawResponses = [...(s.handoff?.rawResponses ?? []), evidence];
      const validation = parsePackageHandoff(finalText, s.cwd);
      if (!validation.valid && !entry.correctionUsed) {
        entry.correctionUsed = true;
        entry.correctionPending = true;
        entry.session?.enterHandoffOnly?.();
        const generation = ++entry.correctionGeneration;
        entry.correctionTurnLimit = Math.min(entry.maxTurns + 1, s.turns + 1);
        entry.turnClaims.limit = entry.maxTurns + 1;
        if (entry.packageBudget) entry.packageBudget.limit = entry.maxTurns + 1;
        s.handoff = {
          status: "failed",
          rawResponses,
          errors: validation.errors,
        };
        s.finalText = evidence;
        notify(s.id);
        queueMicrotask(() => {
          if (
            !entry.correctionPending ||
            entry.correctionGeneration !== generation ||
            entry.cancellationRequested ||
            entry.snapshot.status !== "running"
          ) {
            return;
          }
          entry.correctionPending = false;
          entry.correctionDispatching = true;
          const dispatch = runDetached(
            Effect.suspend(() =>
              entry.cancellationRequested || entry.cancellationStopping
                ? new SendError({
                    message: `Subagent "${s.id}" cancellation is in progress.`,
                  })
                : entry.session!.send(
                    packageHandoffCorrection(validation.errors),
                  ),
            ).pipe(
              Effect.onError(() =>
                Effect.sync(() => {
                  if (
                    entry.correctionGeneration === generation &&
                    entry.snapshot.status === "running"
                  ) {
                    settle(entry, {
                      _tag: "Failed",
                      errorText: "invalid_handoff",
                      partialText: evidence,
                    });
                  }
                }),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  if (entry.correctionGeneration === generation)
                    entry.correctionDispatching = false;
                }),
              ),
              Effect.ignore,
            ),
          );
          entry.correctionDispatch = dispatch;
          dispatch.addObserver(() => {
            if (entry.correctionDispatch === dispatch)
              entry.correctionDispatch = undefined;
          });
        });
        return;
      }
      if (!validation.valid) {
        outcome = {
          _tag: "Failed",
          errorText: "invalid_handoff",
          partialText: evidence,
        };
        s.handoff = {
          status: "failed",
          rawResponses,
          errors: validation.errors,
        };
      } else {
        outcome = {
          _tag: "Completed",
          finalText: JSON.stringify(validation.handoff),
        };
        s.handoff = { status: validation.handoff.status, rawResponses };
      }
    }

    if (drainDescendants(entry, outcome)) return;
    finalizeSettlement(entry, outcome);
  };

  const stopAtTurnLimit = (entry: Entry) => {
    if (entry.forcedFailure || entry.snapshot.status !== "running") return;
    entry.forcedFailure = `Subagent reached its ${entry.maxTurns}-turn limit.`;
    entry.forcedClosing = true;
    runDetached(
      (entry.session?.interrupt ?? Effect.void).pipe(
        Effect.timeout(STOP_TIMEOUT_MS),
        Effect.result,
        Effect.andThen(closeEntryScope(entry)),
        Effect.andThen(
          Effect.sync(() => {
            entry.forcedClosing = false;
            settle(entry, {
              _tag: "Failed",
              errorText: entry.forcedFailure!,
            });
          }),
        ),
        Effect.ignore,
      ),
    );
  };

  const packageRoot = (entry: Entry) => {
    const parentId = entry.snapshot.lineage?.parentId;
    return parentId ? entries.get(parentId) : entry;
  };

  const packageTurns = (entry: Entry) => {
    const root = packageRoot(entry);
    if (!root) return Math.max(entry.snapshot.turns, entry.turnClaims.count);
    let turns = Math.max(root.snapshot.turns, root.turnClaims.count);
    for (const childId of childrenByParent.get(root.snapshot.id) ?? []) {
      const child = entries.get(childId);
      if (child)
        turns += Math.max(child.snapshot.turns, child.turnClaims.count);
    }
    return Math.max(turns, root.packageBudget?.claimed ?? 0);
  };

  const foldEvent = (entry: Entry, event: SubagentEvent) => {
    const s = entry.snapshot;
    if (entry.descendantDraining) return;
    if (s.status !== "running" && !entry.restarting) return;

    const turnLimit = entry.correctionTurnLimit ?? entry.maxTurns;
    const root = packageRoot(entry);
    const packageLimit = root
      ? root.maxTurns +
        (entry === root && root.correctionTurnLimit !== undefined ? 1 : 0)
      : entry.maxTurns;
    const packageAtLimit =
      s.lineage !== undefined && packageTurns(entry) >= packageLimit;
    const claimedMessage =
      event._tag === "AssistantMessage" && entry.turnClaims.count > s.turns;
    if (
      s.status === "running" &&
      (s.turns >= turnLimit || packageAtLimit) &&
      event._tag === "AssistantMessage" &&
      !claimedMessage
    ) {
      stopAtTurnLimit(entry);
      return;
    }

    switch (event._tag) {
      case "RunStarted":
        entry.restarting = false;
        s.status = "running";
        s.settledAt = undefined;
        s.errorText = undefined;
        break;
      case "RunSettled":
        settle(entry, event.outcome);
        return;
      case "UserMessage":
        appendTranscript(s, {
          kind: "user",
          text: boundedTranscriptText(event.text),
        });
        break;
      case "AssistantDelta": {
        const live = s.liveAssistant ?? { text: "", thinking: "" };
        s.liveAssistant =
          event.kind === "text"
            ? {
                ...live,
                text: (live.text + event.delta).slice(
                  -LIVE_ASSISTANT_MAX_LENGTH,
                ),
              }
            : {
                ...live,
                thinking: (live.thinking + event.delta).slice(
                  -LIVE_ASSISTANT_MAX_LENGTH,
                ),
              };
        break;
      }
      case "AssistantMessage": {
        const parts =
          entry.snapshot.outputContract === "package_handoff"
            ? boundedHandoffParts(event.parts)
            : boundedTranscriptParts(event.parts);
        appendTranscript(s, { kind: "assistant", parts });
        s.liveAssistant = undefined;
        s.turns++;
        if (
          !s.outputContract &&
          s.turns === Math.max(1, turnLimit - 3) &&
          parts.some((part) => part.type === "toolCall")
        ) {
          const warning = entry.session?.send(
            turnBudgetFinalizationWarning(turnLimit),
          );
          if (warning) runDetached(warning.pipe(Effect.ignore));
        }
        break;
      }
      case "ToolStart":
        entry.liveToolMap.set(event.toolId, {
          toolId: event.toolId,
          name: event.name,
          argsPreview: event.argsPreview
            ? boundedTranscriptText(event.argsPreview)
            : undefined,
        });
        s.liveTools = [...entry.liveToolMap.values()];
        break;
      case "ToolUpdate": {
        const current = entry.liveToolMap.get(event.toolId);
        if (current) {
          entry.liveToolMap.set(event.toolId, {
            ...current,
            outputPreview: event.outputPreview
              ? boundedTranscriptText(event.outputPreview)
              : current.outputPreview,
          });
          s.liveTools = [...entry.liveToolMap.values()];
        }
        break;
      }
      case "ToolEnd":
        entry.liveToolMap.delete(event.toolId);
        s.liveTools = [...entry.liveToolMap.values()];
        appendTranscript(s, {
          kind: "toolResult",
          toolId: event.toolId,
          name: event.name,
          isError: event.isError,
          outputPreview: event.outputPreview
            ? boundedTranscriptText(event.outputPreview)
            : undefined,
        });
        break;
      case "QueueChanged":
        s.queued = event.queued;
        break;
      case "UsageChanged":
        s.usage = {
          tokens: event.tokens ?? s.usage.tokens,
          contextWindow: event.contextWindow ?? s.usage.contextWindow,
          cost: event.cost ?? s.usage.cost,
        };
        break;
      case "MetaChanged":
        s.meta = { ...s.meta, ...event.meta };
        break;
      case "BackendError":
        s.errorText = bounded(event.message);
        break;
    }
    notify(s.id);
  };

  const isNestedParentEligible = (parentId: string) => {
    const parent = entries.get(parentId);
    return (
      !disposed &&
      parent?.snapshot.backend === "pi" &&
      parent.snapshot.outputContract === "package_handoff" &&
      parent.snapshot.lineage?.depth === 0 &&
      parent.snapshot.lineage.role === "package-worker" &&
      parent.snapshot.status === "running" &&
      !parent.cancellationRequested &&
      !parent.descendantDraining &&
      !parent.correctionUsed &&
      !parent.correctionPending &&
      !parent.correctionDispatching &&
      parent.correctionTurnLimit === undefined
    );
  };

  const spawnManaged = (
    backendName: BackendName,
    task: SpawnTask,
    lineage?: SubagentSnapshot["lineage"],
  ) =>
    Effect.gen(function* () {
      yield* Effect.suspend(
        (): Effect.Effect<void, SpawnError | ConcurrencyLimitError> => {
          if (disposed)
            return new SpawnError({
              message: "Subagent manager is shutting down.",
            });
          if (
            task.outputContract === "package_handoff" &&
            !isMutationCwdAllowed(task.cwd)
          )
            return new SpawnError({
              message:
                "Package Worker cwd is inside Git administration data; mutation is refused.",
            });
          if (runningCount() + reserved >= MAX_RUNNING)
            return new ConcurrencyLimitError({
              message: `Max ${MAX_RUNNING} subagents can run concurrently. Wait for one to finish (subagent_wait) before spawning another.`,
            });
          reserved++;
          return Effect.void;
        },
      );

      let workspaceWorker: WorkspaceActivity | undefined;
      let mutationLease: WorkspaceMutationLease | undefined;
      let workspaceTransferred = false;
      const doSpawn = Effect.gen(function* () {
        const backend: SubagentBackend | undefined = registry.get(backendName);
        if (!backend)
          return yield* new BackendUnavailableError({
            message: `Unknown backend "${backendName}".`,
          });
        if (!(yield* backend.available))
          return yield* new BackendUnavailableError({
            message: `Backend "${backendName}" is not available on this machine (binary/SDK/credentials missing).`,
          });

        const id = `sa-${++counter}`;
        const maxTurns =
          lineage?.depth === 1
            ? normalizeNestedWorkerTurns(
                task.maxTurns ?? DEFAULT_NESTED_WORKER_TURNS,
              )
            : normalizeSubagentTurns(task.maxTurns ?? DEFAULT_SUBAGENT_TURNS);
        const canNest =
          backendName === "pi" &&
          task.outputContract === "package_handoff" &&
          lineage?.depth === 0;
        const parentEntry = lineage?.parentId
          ? entries.get(lineage.parentId)
          : undefined;
        mutationLease = yield* Effect.try({
          try: () =>
            lineage?.role === "finding-fixer"
              ? acquireWorkspaceMutationLease(
                  task.cwd,
                  parentEntry?.workspaceWorker,
                )
              : undefined,
          catch: (error) =>
            new SpawnError({
              message: error instanceof Error ? error.message : String(error),
            }),
        });
        workspaceWorker = yield* Effect.try({
          try: () =>
            registerWorkspaceWorker(
              backendName,
              task.cwd,
              mutationLease?.owner,
            ),
          catch: (error) => {
            mutationLease?.close();
            return new SpawnError({
              message: error instanceof Error ? error.message : String(error),
            });
          },
        });
        const turnClaims = { count: 0, limit: maxTurns };
        const packageBudget =
          lineage?.parentId !== undefined
            ? entries.get(lineage.parentId)?.packageBudget
            : backendName === "pi"
              ? { claimed: 0, limit: maxTurns }
              : undefined;
        const claimTurn = packageBudget
          ? () => {
              if (
                turnClaims.count >= turnClaims.limit ||
                packageBudget.claimed >= packageBudget.limit
              )
                return false;
              packageBudget.claimed++;
              turnClaims.count++;
              return true;
            }
          : undefined;
        const backendTask: BackendSpawnTask = {
          ...task,
          prompt: withSubagentTurnBudget(task.prompt, maxTurns),
          maxTurns,
          lineage,
          nestedMutationPolicy:
            lineage?.role === "finding-fixer"
              ? "finding-fixer"
              : lineage?.depth === 1
                ? "read-only"
                : undefined,
          mutationLeaseOwner: mutationLease?.owner,
          claimTurn,
          nestedSpawn: canNest
            ? (request, signal) =>
                runPromise(
                  Effect.gen(function* () {
                    const nested = yield* spawnNested(id, request);
                    yield* waitFor([nested.id]).pipe(
                      Effect.onInterrupt(() =>
                        cancel([nested.id]).pipe(Effect.asVoid),
                      ),
                    );
                    const settled = entries.get(nested.id)?.snapshot;
                    return {
                      id: nested.id,
                      status: settled?.status ?? "error",
                      output: utf8Prefix(
                        settled?.finalText ?? "",
                        NESTED_OUTPUT_MAX_BYTES,
                      ),
                      ...(settled?.errorText
                        ? {
                            error: utf8Prefix(
                              settled.errorText,
                              NESTED_OUTPUT_MAX_BYTES,
                            ),
                          }
                        : {}),
                    };
                  }),
                  signal ? { signal } : undefined,
                )
            : undefined,
        };
        const meta: SubagentMeta = {
          backend: backendName,
          modelLabel: task.model,
        };
        const entry: Entry = {
          snapshot: {
            revision: 0,
            id,
            backend: backendName,
            title: task.title,
            prompt: task.prompt,
            cwd: task.cwd,
            status: "running",
            pendingStart: true,
            createdAt: Date.now(),
            reasoningEffort:
              task.reasoningEffort ??
              (REASONING_EFFORTS.includes(
                task.parent
                  .inheritedThinkingLevel as (typeof REASONING_EFFORTS)[number],
              )
                ? (task.parent
                    .inheritedThinkingLevel as (typeof REASONING_EFFORTS)[number])
                : undefined),
            outputContract: task.outputContract,
            todoId: task.todoId,
            todoToken: task.todoToken,
            lineage,
            maxTurns,
            meta,
            usage: {},
            transcript: [],
            liveTools: [],
            queued: [],
            finalText: "",
            turns: 0,
          },
          backendTask,
          liveToolMap: new Map(),
          suppressResultDelivery: task.suppressResultDelivery === true,
          correctionUsed: false,
          correctionPending: false,
          correctionDispatching: false,
          correctionGeneration: 0,
          cancellationRequested: false,
          cancellationStopping: false,
          forcedClosing: false,
          descendantDraining: false,
          maxTurns,
          turnClaims,
          packageBudget,
          parentContext: task.parent,
          model: task.model,
          validateAuthority: task.validateAuthority,
          workspaceWorker,
          mutationLease,
          started: false,
          starting: false,
        };
        entries.set(id, entry);
        workspaceTransferred = true;
        if (lineage?.parentId) {
          parentByChild.set(id, lineage.parentId);
          const children = childrenByParent.get(lineage.parentId) ?? new Set();
          children.add(id);
          childrenByParent.set(lineage.parentId, children);
        }

        notify(id);
        return entry.snapshot as SubagentSnapshot;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (!workspaceTransferred) {
              workspaceWorker?.close();
              mutationLease?.close();
            }
          }),
        ),
      );

      return yield* doSpawn.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            reserved--;
            notify();
          }),
        ),
      );
    });

  const reject = (id: string, reason: string) =>
    Effect.suspend(() => {
      const entry = entries.get(id);
      if (!entry || entry.snapshot.status !== "running") return Effect.void;
      entry.snapshot.pendingStart = undefined;
      entry.forcedClosing = true;
      return closeEntryScope(entry).pipe(
        Effect.andThen(
          Effect.sync(() => {
            entry.forcedClosing = false;
            settle(entry, { _tag: "Failed", errorText: bounded(reason) });
          }),
        ),
      );
    });

  const start = (
    id: string,
    signal?: AbortSignal,
  ): Effect.Effect<SubagentSnapshot, SpawnError> =>
    Effect.suspend(() => {
      const entry = entries.get(id);
      if (!entry || entry.snapshot.status !== "running")
        return new SpawnError({
          message: `Prepared subagent "${id}" is no longer running.`,
        });
      if (entry.started) return Effect.succeed(entry.snapshot);
      if (entry.starting)
        return new SpawnError({
          message: `Prepared subagent "${id}" is already starting.`,
        });

      const startFailure = () => {
        if (signal?.aborted)
          return "package_handoff assignment acquisition was aborted.";
        if (disposed) return "Subagent manager shut down while starting.";
        if (
          entries.get(id) !== entry ||
          entry.snapshot.status !== "running" ||
          entry.cancellationRequested
        )
          return `Prepared subagent "${id}" was cancelled while starting.`;
        const authorityError = entry.validateAuthority?.();
        if (authorityError)
          return `Package Worker authority revoked: ${authorityError}`;
        if (
          entry.snapshot.lineage?.parentId &&
          !isNestedParentEligible(entry.snapshot.lineage.parentId)
        )
          return "Package Worker stopped while nested worker was spawning.";
        return undefined;
      };
      const ensureStartable = () =>
        Effect.suspend(() => {
          const failure = startFailure();
          return failure ? new SpawnError({ message: failure }) : Effect.void;
        });
      const initialFailure = startFailure();
      if (initialFailure)
        return reject(id, initialFailure).pipe(
          Effect.andThen(new SpawnError({ message: initialFailure })),
        );

      entry.starting = true;
      entry.snapshot.pendingStart = undefined;
      notify(id);
      const publishedFailure = startFailure();
      if (publishedFailure) {
        entry.starting = false;
        return reject(id, publishedFailure).pipe(
          Effect.andThen(new SpawnError({ message: publishedFailure })),
        );
      }
      const backend = registry.get(entry.snapshot.backend);
      if (!backend) {
        entry.starting = false;
        return new SpawnError({
          message: `Unknown backend "${entry.snapshot.backend}".`,
        });
      }

      const onAbort = () => {
        if (entry.snapshot.status !== "running") return;
        runDetached(abortEntry(entry).pipe(Effect.ignore));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();

      return Effect.gen(function* () {
        const scope = yield* Scope.make();
        entry.scope = scope;
        yield* ensureStartable();
        const session = yield* Scope.provide(
          backend.spawn(entry.backendTask),
          scope,
        );
        yield* ensureStartable();
        entry.session = session;

        const meta = yield* session.meta;
        yield* ensureStartable();
        entry.snapshot.meta = meta;
        entry.snapshot.usage.contextWindow = meta.contextWindow;
        const pump = Stream.runForEach(session.events, (event) =>
          Effect.sync(() => foldEvent(entry, event)),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (
                entry.snapshot.status === "running" &&
                !entry.descendantDraining
              )
                settle(entry, {
                  _tag: "Failed",
                  errorText: "Backend event stream ended unexpectedly",
                });
            }),
          ),
        );
        entry.pump = yield* Scope.provide(Effect.forkScoped(pump), scope);
        yield* ensureStartable();
        entry.started = true;
        yield* session.start.pipe(
          Effect.mapError(
            (error) => new SpawnError({ message: bounded(error.message) }),
          ),
        );
        yield* ensureStartable();
        return entry.snapshot as SubagentSnapshot;
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? closeEntryScope(entry) : Effect.void,
        ),
        Effect.onError((cause) =>
          Effect.sync(() => {
            if (
              entries.get(id) === entry &&
              entry.snapshot.status === "running"
            )
              settle(entry, {
                _tag: "Failed",
                errorText: bounded(String(cause)),
              });
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            entry.starting = false;
            signal?.removeEventListener("abort", onAbort);
            if (
              !entry.started &&
              entry.snapshot.lineage?.parentId &&
              !isNestedParentEligible(entry.snapshot.lineage.parentId)
            )
              removeEntry(entry);
            else notify(id);
          }),
        ),
      );
    });

  const prepare = (backendName: BackendName, task: SpawnTask) =>
    spawnManaged(
      backendName,
      task,
      backendName === "pi" && task.outputContract === "package_handoff"
        ? { depth: 0, role: "package-worker" }
        : undefined,
    );

  const spawn = (backendName: BackendName, task: SpawnTask) =>
    prepare(backendName, task).pipe(
      Effect.flatMap((snapshot) => start(snapshot.id)),
    );

  const spawnNested = (parentId: string, request: NestedSpawnRequest) =>
    Effect.suspend(() => {
      const parent = entries.get(parentId);
      if (!parent)
        return new SpawnError({
          message: `Nested worker parent "${parentId}" is unknown.`,
        });
      const authorityError = parent.validateAuthority?.();
      if (authorityError)
        return new SpawnError({
          message: `Package Worker authority revoked: ${authorityError}`,
        });
      if (
        parent.snapshot.backend !== "pi" ||
        parent.snapshot.outputContract !== "package_handoff" ||
        parent.snapshot.lineage?.depth !== 0 ||
        parent.snapshot.lineage.role !== "package-worker"
      )
        return new SpawnError({
          message:
            "Nested workers require a root Pi Package Worker with package_handoff.",
        });
      if (parent.snapshot.status !== "running" || parent.cancellationRequested)
        return new SpawnError({ message: "Package Worker is not running." });
      if (
        parent.correctionUsed ||
        parent.correctionPending ||
        parent.correctionDispatching ||
        parent.correctionTurnLimit !== undefined
      )
        return new SpawnError({
          message: "Package handoff correction cannot spawn descendants.",
        });
      if (!["reviewer", "verifier", "finding-fixer"].includes(request.role))
        return new SpawnError({ message: "Unknown nested worker role." });
      if (
        !request.prompt.trim() ||
        Buffer.byteLength(request.prompt) > NESTED_PROMPT_MAX_BYTES
      )
        return new SpawnError({
          message: `Nested worker prompt must be non-empty and at most ${NESTED_PROMPT_MAX_BYTES} UTF-8 bytes.`,
        });
      if (
        !request.title.trim() ||
        Buffer.byteLength(request.title.trim()) > NESTED_NAME_MAX_BYTES
      )
        return new SpawnError({
          message: `Nested worker name must be non-empty and at most ${NESTED_NAME_MAX_BYTES} UTF-8 bytes.`,
        });
      if (
        request.maxTurns !== undefined &&
        (!Number.isInteger(request.maxTurns) ||
          request.maxTurns < 1 ||
          request.maxTurns > 8)
      )
        return new SpawnError({
          message: "Nested worker maxTurns must be an integer from 1 to 8.",
        });
      const remaining = parent.maxTurns - packageTurns(parent);
      if (remaining < 1)
        return new SpawnError({
          message: "Package turn budget has no room for a nested worker.",
        });
      const maxTurns = request.maxTurns ?? DEFAULT_NESTED_WORKER_TURNS;
      if (remaining < maxTurns)
        return new SpawnError({
          message: `Nested worker requested ${maxTurns} turns but only ${remaining} package turns remain. Finish existing work or request fewer turns.`,
        });
      const readOnly = request.role !== "finding-fixer";
      const policy = readOnly
        ? "Read-only: inspect regular single-link files inside package cwd only through native safe read; do not edit files or mutate state."
        : "Fix findings only with custom native read/edit/write inside package cwd. If the native helper is unavailable, all file access fails closed. Never change Git history, branches, commits, remotes, or external/production state.";
      return spawnManaged(
        "pi",
        {
          prompt: `${policy}\nNo external approvals. Stay inside inherited package scope. Return concise evidence to the Package Worker.\n\n${request.prompt}`,
          title: request.title.trim(),
          cwd: parent.snapshot.cwd,
          model: parent.model,
          reasoningEffort: parent.snapshot.reasoningEffort,
          maxTurns,
          allowedTools: readOnly ? ["read"] : ["read", "edit", "write"],
          noExtensions: true,
          suppressResultDelivery: true,
          todoId: parent.snapshot.todoId,
          todoToken: parent.snapshot.todoToken,
          validateAuthority: parent.validateAuthority,
          parent: parent.parentContext,
        },
        { parentId, depth: 1, role: request.role },
      ).pipe(Effect.flatMap((snapshot) => start(snapshot.id)));
    });

  const waitFor = (
    ids: ReadonlyArray<string>,
    onPending?: (pending: string[]) => void,
  ) =>
    Effect.suspend(() => {
      const unique = [...new Set(ids)];
      addInterest(unique);
      const loop = Effect.gen(function* () {
        while (true) {
          const pending = unique.filter(
            (id) => entries.get(id)?.snapshot.status === "running",
          );
          if (pending.length === 0) return;
          onPending?.(pending);
          yield* nextChange;
        }
      });
      return loop.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseInterest(unique);
            pruneSettled();
          }),
        ),
      );
    });

  const markCancellation = (entry: Entry) => {
    if (entry.snapshot.status !== "running") return false;
    entry.cancellationRequested = true;
    entry.cancellationStopping = true;
    if (entry.correctionPending || entry.correctionDispatching) {
      entry.correctionPending = false;
      entry.correctionDispatching = false;
      entry.correctionGeneration++;
      const dispatch = entry.correctionDispatch;
      entry.correctionDispatch = undefined;
      if (dispatch) runDetached(Fiber.interrupt(dispatch).pipe(Effect.ignore));
    }
    return true;
  };

  const abortEntry = (entry: Entry): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (entry.cancellation)
        return Fiber.await(entry.cancellation).pipe(Effect.asVoid);
      if (!entry.cancellationRequested && !markCancellation(entry))
        return Effect.void;
      const cancellation = runDetached(
        Effect.gen(function* () {
          const graceful = yield* (
            entry.descendantDraining
              ? Effect.void
              : (entry.session?.interrupt ?? closeEntryScope(entry))
          ).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.result);
          const startupCleanup = yield* Effect.gen(function* () {
            while (entry.starting) yield* nextChange;
          }).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.result);
          const forced =
            Result.isFailure(graceful) || Result.isFailure(startupCleanup);
          if (forced) yield* closeEntryScope(entry);
          yield* Effect.sync(() => {
            entry.cancellationStopping = false;
            settle(entry, { _tag: "Interrupted" });
            if (forced && entry.snapshot.status !== "running") {
              entry.snapshot.errorText =
                "Abort deadline exceeded; session was force-disposed";
              notify(entry.snapshot.id);
            }
          });
          while (entry.forcedClosing && entry.snapshot.status === "running")
            yield* nextChange;
        }),
      );
      entry.cancellation = cancellation;
      return Fiber.await(cancellation).pipe(Effect.asVoid);
    });

  const cancel = (ids: ReadonlyArray<string>) =>
    Effect.suspend(() => {
      const unique = [...new Set(ids)];
      const expanded = new Set(unique);
      for (const id of unique)
        for (const childId of childrenByParent.get(id) ?? [])
          expanded.add(childId);
      const running = [...expanded]
        .map((id) => entries.get(id))
        .filter(
          (entry): entry is Entry => entry?.snapshot.status === "running",
        );
      const runningIds = running.map((entry) => entry.snapshot.id);
      // Mark consumed before interrupting so cancellation does not also
      // enqueue duplicate automatic result messages into the parent.
      addInterest(runningIds);
      for (const entry of running) markCancellation(entry);
      const work = Effect.gen(function* () {
        yield* Effect.forEach(
          running.filter((entry) => entry.snapshot.lineage?.depth === 1),
          abortEntry,
          { concurrency: "unbounded" },
        );
        yield* Effect.forEach(
          running.filter((entry) => entry.snapshot.lineage?.depth !== 1),
          abortEntry,
          { concurrency: "unbounded" },
        );
        while (running.some((entry) => entry.snapshot.status === "running")) {
          yield* nextChange;
        }
      });
      return work.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseInterest(runningIds);
            pruneSettled();
          }),
        ),
        Effect.map((): ReadonlyArray<CancelResult> =>
          unique.map((id) => {
            const snapshot = entries.get(id)?.snapshot;
            return {
              id,
              title: snapshot?.title ?? "?",
              status: snapshot?.status ?? "error",
              cancelled: runningIds.includes(id),
            };
          }),
        ),
      );
    });

  drainDescendants = (root, outcome) => {
    if (root.snapshot.lineage?.depth !== 0) return false;
    if (root.descendantDraining) {
      root.pendingOutcome = outcome;
      return true;
    }
    const children = [...(childrenByParent.get(root.snapshot.id) ?? [])]
      .map((id) => entries.get(id))
      .filter((entry): entry is Entry => entry?.snapshot.status === "running");
    if (children.length === 0) return false;

    root.descendantDraining = true;
    root.pendingOutcome = outcome;
    for (const child of children) markCancellation(child);
    const drain = runDetached(
      Effect.forEach(children, abortEntry, { concurrency: "unbounded" }).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (
              disposed ||
              entries.get(root.snapshot.id) !== root ||
              root.snapshot.status !== "running"
            )
              return;
            const terminal = root.pendingOutcome ?? outcome;
            root.pendingOutcome = undefined;
            root.descendantDraining = false;
            finalizeSettlement(root, terminal);
          }),
        ),
      ),
    );
    root.descendantDrain = drain;
    drain.addObserver(() => {
      if (root.descendantDrain === drain) root.descendantDrain = undefined;
    });
    return true;
  };

  const send = (id: string, text: string, additionalTurns?: number) =>
    Effect.suspend((): Effect.Effect<void, SendError> => {
      const entry = entries.get(id);
      if (!entry || disposed) {
        return new SendError({
          message: `Subagent "${id}" is no longer tracked.`,
        });
      }

      const extensionFailure = () => {
        if (additionalTurns === undefined) return undefined;
        if (!Number.isInteger(additionalTurns) || additionalTurns < 1)
          return new SendError({
            message: "additionalTurns must be a positive integer.",
          });
        if (entry.snapshot.status !== "done")
          return new SendError({
            message: `Subagent "${id}" must settle with a partial budget request before extension.`,
          });
        if (entry.snapshot.lineage?.depth === 1)
          return new SendError({
            message: "Nested worker budgets cannot be extended.",
          });
        if (entry.snapshot.budgetExtension)
          return new SendError({
            message: `Subagent "${id}" already received its one allowed budget extension.`,
          });
        const request = parseTurnBudgetRequest(entry.snapshot.finalText);
        if (!request)
          return new SendError({
            message: `Subagent "${id}" did not return a valid partial budget_request.`,
          });
        if (request.additionalTurns !== additionalTurns)
          return new SendError({
            message: `Subagent "${id}" requested ${request.additionalTurns} additional turns, not ${additionalTurns}.`,
          });
        if (entry.maxTurns + additionalTurns > MAX_SUBAGENT_TURNS)
          return new SendError({
            message: `Subagent "${id}" cannot exceed the ${MAX_SUBAGENT_TURNS}-turn total limit.`,
          });
        return undefined;
      };

      const authorityFailure = () => {
        const reason = entry.validateAuthority?.();
        if (!reason) return undefined;
        if (entry.snapshot.status === "running" && markCancellation(entry))
          runDetached(abortEntry(entry).pipe(Effect.ignore));
        return new SendError({
          message: `Package Worker authority revoked: ${reason}`,
        });
      };
      const publicSendFailure = () => {
        const revoked = authorityFailure();
        if (revoked) return revoked;
        if (entry.cancellationRequested || entry.cancellationStopping)
          return new SendError({
            message: `Subagent "${id}" cancellation is in progress.`,
          });
        if (entry.descendantDraining)
          return new SendError({
            message: `Subagent "${id}" descendant drain is in progress.`,
          });
        if (
          entry.snapshot.status === "running" &&
          (entry.correctionPending ||
            entry.correctionDispatching ||
            entry.correctionTurnLimit !== undefined)
        )
          return new SendError({
            message: `Subagent "${id}" is reserving its final turn for package handoff correction.`,
          });
        const turnLimit = entry.correctionTurnLimit ?? entry.maxTurns;
        if (Math.max(entry.snapshot.turns, entry.turnClaims.count) >= turnLimit)
          return new SendError({
            message: `Subagent "${id}" reached its ${entry.maxTurns}-turn limit.`,
          });
        return undefined;
      };

      const invalidExtension = extensionFailure();
      if (invalidExtension) return invalidExtension;
      const initialFailure = publicSendFailure();
      if (initialFailure) return initialFailure;
      if (
        entry.snapshot.lineage?.depth === 1 &&
        entry.snapshot.status !== "running"
      )
        return new SendError({
          message: `Nested worker "${id}" cannot be restarted after its workspace lease is released.`,
        });
      if (
        entry.snapshot.outputContract === "package_handoff" &&
        entry.snapshot.status !== "running" &&
        (entry.snapshot.status !== "done" ||
          !entry.snapshot.handoff ||
          entry.snapshot.handoff.errors)
      )
        return new SendError({
          message: `Package Worker "${id}" can restart only after a schema-valid handoff.`,
        });

      const applyExtension = () => {
        if (additionalTurns === undefined) return () => {};
        const previousMaxTurns = entry.maxTurns;
        const previousPackageLimit = entry.packageBudget?.limit;
        entry.maxTurns += additionalTurns;
        entry.snapshot.maxTurns = entry.maxTurns;
        entry.snapshot.budgetExtension = {
          additionalTurns,
          approvedAt: Date.now(),
        };
        entry.turnClaims.limit = entry.maxTurns;
        if (entry.packageBudget) entry.packageBudget.limit = entry.maxTurns;
        notify(entry.snapshot.id);
        return () => {
          entry.maxTurns = previousMaxTurns;
          entry.snapshot.maxTurns = previousMaxTurns;
          entry.snapshot.budgetExtension = undefined;
          entry.turnClaims.limit = previousMaxTurns;
          if (entry.packageBudget && previousPackageLimit !== undefined)
            entry.packageBudget.limit = previousPackageLimit;
          notify(entry.snapshot.id);
        };
      };

      const dispatch = (restarting: boolean) =>
        Effect.yieldNow.pipe(
          Effect.andThen(
            Effect.suspend(() => {
              const failure = publicSendFailure();
              if (failure) {
                if (restarting) {
                  entry.restarting = false;
                  releaseWorkspace(entry);
                }
                return failure;
              }
              if (!entry.session) {
                if (restarting) {
                  entry.restarting = false;
                  releaseWorkspace(entry);
                }
                return new SendError({
                  message: `Subagent "${id}" has not started.`,
                });
              }
              return entry.session.send(text).pipe(
                Effect.onError(() =>
                  restarting
                    ? Effect.sync(() => {
                        entry.restarting = false;
                        releaseWorkspace(entry);
                      })
                    : Effect.void,
                ),
              );
            }),
          ),
        );

      // Restarting a settled subagent occupies a running slot again, so it
      // must respect the same cap as spawn. Steering an already-running one
      // does not consume additional capacity.
      if (entry.snapshot.status !== "running") {
        if (runningCount() + reserved >= MAX_RUNNING)
          return new SendError({
            message: `Max ${MAX_RUNNING} subagents can run concurrently; restarting "${id}" would exceed that.`,
          });
        // Authority was checked before workspace registration. Recheck after
        // the async boundary in dispatch before handing text to the backend.
        try {
          entry.workspaceWorker = registerWorkspaceWorker(
            entry.snapshot.backend,
            entry.snapshot.cwd,
          );
        } catch (error) {
          return new SendError({
            message: error instanceof Error ? error.message : String(error),
          });
        }
        entry.restarting = true;
        entry.cancellationRequested = false;
        entry.cancellationStopping = false;
        entry.cancellation = undefined;
        entry.forcedFailure = undefined;
        const rollbackExtension = applyExtension();
        return dispatch(true).pipe(
          Effect.onError(() => Effect.sync(rollbackExtension)),
        );
      }
      return dispatch(false);
    });

  const disposeAllWork = Effect.gen(function* () {
    disposed = true;
    const all = [...entries.values()];
    const close = (entry: Entry) =>
      closeEntryScope(entry).pipe(
        Effect.ensuring(Effect.sync(() => releaseWorkspace(entry))),
      );
    yield* Effect.forEach(
      all.filter((entry) => entry.snapshot.lineage?.depth === 1),
      close,
      { concurrency: "unbounded" },
    );
    yield* Effect.forEach(
      all.filter((entry) => entry.snapshot.lineage?.depth !== 1),
      close,
      { concurrency: "unbounded" },
    );
    yield* Effect.forEach(
      [...cleanups],
      (fiber) => Fiber.await(fiber).pipe(Effect.asVoid),
      { concurrency: "unbounded" },
    );
    yield* Effect.sync(() => {
      entries.clear();
      childrenByParent.clear();
      parentByChild.clear();
      notify();
    });
  });

  const disposeAll = Effect.suspend(() => {
    if (!disposal) disposal = runDetached(disposeAllWork);
    return Fiber.await(disposal).pipe(Effect.asVoid);
  });

  const view: SubagentReadModel = {
    list: () => [...entries.values()].map((entry) => entry.snapshot),
    get: (id) => entries.get(id)?.snapshot,
    size: () => entries.size,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeTo: (id, listener) => {
      let set = idListeners.get(id);
      if (!set) {
        set = new Set();
        idListeners.set(id, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) idListeners.delete(id);
      };
    },
    requestSend: (id, text) => {
      runDetached(send(id, text).pipe(Effect.ignore));
    },
    requestAbort: (id) => {
      const entry = entries.get(id);
      if (!entry || !markCancellation(entry)) return;
      // UI-initiated aborts are not "consumed": the failed result still
      // flows back to the parent as a follow-up message, matching v1.
      runDetached(abortEntry(entry).pipe(Effect.ignore));
    },
    setOnSettled: (hook) => {
      onSettled = hook;
    },
  };

  // Safety net: disposing the ManagedRuntime tears everything down even if
  // the extension forgot to call disposeAll explicitly.
  yield* Effect.addFinalizer(() => disposeAll);

  return SubagentManager.of({
    prepare,
    start,
    reject,
    spawn,
    spawnNested,
    waitFor,
    cancel,
    send,
    get: (id) => Effect.sync(() => entries.get(id)?.snapshot),
    list: Effect.sync(() => [...entries.values()].map((e) => e.snapshot)),
    disposeAll,
    view,
  });
});

export const SubagentManagerLive: Layer.Layer<
  SubagentManager,
  never,
  BackendRegistry
> = Layer.effect(SubagentManager, makeManager);
