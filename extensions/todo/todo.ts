/**
 * todo tool + /todos command — thin registration shell.
 *
 * Tool/command identity, schema, types, reducer, store, replay, response
 * envelope, selectors, and view formatters live in the layered modules under
 * `tool/`, `state/`, and `view/`. This file is the package-root registration
 * surface — it mirrors `packages/rpiv-ask-user-question/ask-user-question.ts`
 * which keeps the tool registration at the package root.
 *
 * Public re-exports below preserve the pre-refactor import surface so that
 * `index.ts`, `todo-overlay.ts`, and the global `test/setup.ts` `beforeEach`
 * continue to import from `./todo.js`.
 */

import { randomUUID } from "node:crypto";
import type {
  ExtensionContext,
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  getBackgroundSubagentService,
  type BackgroundSubagentProgress,
} from "../../vendor/pi-tools/extensions/shared/background-subagent-protocol.js";
import { loadConfig, validateGuidanceFields } from "./config.js";
import {
  classifyOrchestration,
  markOrchestrator,
  ORCHESTRATOR_GUIDANCE,
  orchestratorStatus,
  requestOrchestratorClassification,
  type OrchestratorClassification,
  type OrchestratorSetting,
} from "./orchestrator.js";
import {
  applyPreparationCAS,
  liveWorkerOwnerKinds,
  reserveCancellationWorkerIds,
  releaseCancellationWorkerIds,
  reservedCancellationWorkerIds,
  provisionalTodoSubject,
  requestTodoAnalysis,
  requestTodoReorder,
  todoPreparationPolicy,
  isTodoReviewTargetIdentity,
  validateTodoReviewTarget,
  sameTodoReviewTargetIdentity,
  todoReviewTargetIdentityBinding,
  type TodoAnalysis,
  type TodoEnrichment,
} from "./enrichment.js";
import type { JobsAdapter } from "./jobs-adapter.js";
import {
  isTaskReviewScope,
  MAX_WAIT_QUESTION_LENGTH,
  type Task,
  type TaskReviewScope,
} from "./tool/types.js";
import {
  applyTodoReorder,
  createTodoReorderSnapshot,
  type TodoReorderSnapshot,
} from "./reorder.js";
import { persistTodoSnapshot } from "./scheduler.js";
import { t } from "./state/i18n-bridge.js";
import { replayFromBranch } from "./state/replay.js";
import { selectVisibleTasks } from "./state/selectors.js";
import { showTodoDetailView } from "./todo-detail-view.js";
import { applyTaskMutation } from "./state/state-reducer.js";
import { commitState, getState, replaceState } from "./state/store.js";
import {
  CANCELLATION_CAPACITY_ERROR,
  allCancellationIntents,
  cancellationIntentTargetKey,
  cancellationIntentMatchesCurrentTask,
  MAX_CANCELLATION_INTENTS,
  normalizeCancellationIntent,
  normalizeCancellationIds,
  rearmCancellationLedger,
  updateCancellationLedger,
  withCancellationLedger,
  type TodoCancellationIntent,
} from "./state/state.js";
import { buildToolResult } from "./tool/response-envelope.js";
import {
  COMMAND_NAME,
  ERR_REQUIRES_INTERACTIVE,
  type TaskMutationParams,
  TOOL_LABEL,
  TOOL_NAME,
  TodoParamsSchema,
} from "./tool/types.js";
import {
  formatCommandTaskLine,
  renderTodoCall,
  renderTodoResult,
} from "./view/format.js";

// ---------------------------------------------------------------------------
// Public re-exports — pre-refactor consumers (overlay, tests, index.ts) keep
// importing from `./todo.js`. New code may opt into deeper imports.
// ---------------------------------------------------------------------------

export { isTransitionValid } from "./state/invariants.js";
export { applyTaskMutation } from "./state/state-reducer.js";
export { __resetState, getNextId, getTodos } from "./state/store.js";
export { deriveBlocks, detectCycle } from "./state/task-graph.js";
export type {
  JobStateEvent,
  JobStatus,
  Task,
  TaskAction,
  TaskDetails,
  TaskStatus,
} from "./tool/types.js";
export { TOOL_NAME } from "./tool/types.js";

/**
 * Backward-compat replay shim. Pre-refactor `reconstructTodoState(ctx)`
 * mutated module state directly; the new replay seam (`state/replay.ts`)
 * returns a `TaskState` and the caller commits via `replaceState`.
 */
export function reconstructTodoState(
  ctx: Parameters<typeof replayFromBranch>[0],
): void {
  replaceState(replayFromBranch(ctx));
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export const DEFAULT_PROMPT_SNIPPET =
  "Manage a task list to track multi-step progress";
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
  "Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
  "TODOs represent current execution scope, not a roadmap or possible follow-up. Before implementing multi-step work, translate the whole known execution plan into separate TODOs. Use one task per meaningful phase so progress is visible; never collapse a known multi-phase plan into one umbrella task or invent speculative microtasks. When the user narrows or changes scope, delete superseded pending TODOs before adding replacements.",
  "When starting any task, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one driver task should be in_progress at a time; that bookkeeping rule does not serialize execution, and one driver task may own multiple safe parallel workers.",
  "Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
  "When all visible tasks become completed, follow the automatic completion review: create TODOs for anything missing and continue, or call todo clear to archive the completed batch and give one context-preserving completion report with outcome, before→now behavior, key paths and short code snippets, resulting flow, exact verification, usage steps, and remaining caveats. Clear must never remove unresolved tasks.",
  "Task status supports pending, in_progress, waiting:user, waiting:jobs, completed, and deleted. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.",
  "When work needs user input, set waiting:user with 1-8 exact concrete questions. When work depends on running jobs, set waiting:jobs with unique jobIds, jobMode all/any, and timeoutSeconds; job outcomes wake the task to pending with evidence and never complete it.",
  "Use blockedBy only for true execution prerequisites. Do not block research, review, or other independently useful work on a broad parent task. Before waiting or saying work must happen after a running operation, scan the TODO graph and current plan, then start every safe independent unit up to the worker limit. Same feature, PR, or stack is not itself a conflict: serialize only exact write-set, worktree/ref, or result-freshness conflicts; use isolated worktrees or pinned read-only snapshots to prepare blocked integration work in parallel when safe. When every pending task is blocked while a job runs, reassess dependencies once, remove obsolete or overbroad edges, and continue independent work; never remove a genuine dependency merely to stay busy. On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.",
  "list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
  "Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
  "When metadata.preparation becomes ready, call todo get and use its verified scope, steps, risks, and decisions to continue the task. Ask the user only for a real unresolved decision; preparation is not a per-TODO permission gate.",
  ORCHESTRATOR_GUIDANCE,
];

export interface TodoRuntimeHooks {
  jobs?: Pick<JobsAdapter, "validateRunning">;
  onStateChanged?: () => void;
  preparation?: TodoAddHooks;
  orchestrator?: () => OrchestratorSetting;
  /** Session fence supplied by index.ts; absent for standalone callers/tests. */
  lifecycle?: {
    getGeneration: () => number;
    isActive: () => boolean;
  };
  captureCompletionReviewScope?: (
    task: Task,
    fallbackCwd: string,
  ) => Promise<TaskReviewScope | undefined>;
}

const RESERVED_METADATA_KEYS = new Set([
  "delegation",
  "orchestrator",
  "preparation",
  "askUserCorrelation",
  "inbox",
  "verification",
  "completionReviewBaseline",
]);

function reservedMetadataKey(params: TaskMutationParams): string | undefined {
  return Object.keys(params.metadata ?? {}).find((key) =>
    RESERVED_METADATA_KEYS.has(key),
  );
}

export function registerTodoTool(
  pi: ExtensionAPI,
  hooks: TodoRuntimeHooks = {},
): void {
  const guidance = validateGuidanceFields(loadConfig().guidance);
  let mutationTail = Promise.resolve();
  const enqueue = getAnalysisQueue(pi);
  pi.registerTool({
    name: TOOL_NAME,
    label: TOOL_LABEL,
    description:
      "Manage a task list for tracking multi-step progress. Actions: create, update, merge, challenge, list, get, delete, clear. Merge links a pending duplicate to one execution owner; approved owner evidence settles the duplicate. Challenge records persuasive evidence against an unresolved verifier finding. Clear archives completed tasks and rejects unresolved work. Statuses: pending, in_progress, waiting:user, waiting:jobs, completed, deleted. Waiting jobs wake to pending with evidence; they never auto-complete.",
    promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
    promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
    parameters: TodoParamsSchema,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const startedGeneration = hooks.lifecycle?.getGeneration();
      const assertLive = (): void => {
        if (signal?.aborted) {
          throw signal.reason ?? new Error("TODO tool execution aborted");
        }
        if (
          hooks.lifecycle &&
          (!hooks.lifecycle.isActive() ||
            hooks.lifecycle.getGeneration() !== startedGeneration)
        ) {
          throw new Error("TODO tool execution belongs to an inactive session");
        }
      };
      assertLive();
      const previous = mutationTail;
      let release!: () => void;
      mutationTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        assertLive();
        await previous;
        assertLive();
        let current = getState();
        const inputParams = params as TaskMutationParams;
        const reservedKey = reservedMetadataKey(inputParams);
        if (reservedKey) {
          return buildToolResult(params.action, inputParams, current, {
            kind: "error",
            message: `metadata.${reservedKey} is reserved for pi-plugins; use the task's classified mode instead of editing orchestration metadata`,
          });
        }
        let mutationParams: TaskMutationParams =
          params.action === "create"
            ? {
                ...inputParams,
                subject: provisionalTodoSubject(inputParams.subject ?? ""),
                ...(inputParams.description === undefined
                  ? { description: inputParams.subject }
                  : {}),
                prepare: inputParams.prepare === true,
              }
            : inputParams;
        const existing =
          params.action === "update" && mutationParams.id !== undefined
            ? current.tasks.find((task) => task.id === mutationParams.id)
            : undefined;
        if (
          params.action === "update" &&
          mutationParams.status === "in_progress" &&
          existing &&
          existing.status !== "in_progress" &&
          !isTaskReviewScope(existing.metadata?.completionReviewBaseline)
        ) {
          assertLive();
          const reviewScope = await hooks.captureCompletionReviewScope?.(
            existing,
            ctx.cwd,
          );
          assertLive();
          mutationParams = {
            ...mutationParams,
            metadata: {
              ...(mutationParams.metadata ?? {}),
              completionReviewBaseline: reviewScope ?? null,
            },
          };
        }
        const configuresJobWait =
          params.action === "update" &&
          ((params.status === "waiting:jobs" &&
            (existing?.status !== "waiting:jobs" ||
              mutationParams.jobIds !== undefined ||
              mutationParams.jobMode !== undefined ||
              mutationParams.timeoutSeconds !== undefined)) ||
            (params.status === undefined &&
              existing?.status === "waiting:jobs" &&
              (mutationParams.jobIds !== undefined ||
                mutationParams.jobMode !== undefined ||
                mutationParams.timeoutSeconds !== undefined)));
        if (configuresJobWait) {
          const jobIds =
            mutationParams.jobIds ??
            (existing?.wait?.kind === "jobs" ? existing.wait.jobIds : []);
          assertLive();
          const error = await hooks.jobs?.validateRunning(jobIds);
          assertLive();
          if (!hooks.jobs || error) {
            const message =
              error ?? "waiting:jobs unavailable: no jobs adapter";
            return buildToolResult(params.action, mutationParams, getState(), {
              kind: "error",
              message,
            });
          }
        }
        current = getState();
        const result = applyTaskMutation(
          current,
          params.action,
          mutationParams,
        );
        let nextState = result.state;
        if (result.state !== current) {
          let mutatedId: number | undefined;
          if (result.op.kind === "create") mutatedId = result.op.taskId;
          else if (result.op.kind === "update" || result.op.kind === "delete")
            mutatedId = result.op.id;
          const previousTask =
            mutatedId === undefined
              ? undefined
              : current.tasks.find((task) => task.id === mutatedId);
          const updatedTask =
            mutatedId === undefined
              ? undefined
              : result.state.tasks.find((task) => task.id === mutatedId);
          const previousToken = (
            previousTask?.metadata?.preparation as
              { token?: unknown } | undefined
          )?.token;
          const updatedToken = (
            updatedTask?.metadata?.preparation as
              { token?: unknown } | undefined
          )?.token;
          const incarnationChanged = previousToken !== updatedToken;
          const startsPreparation =
            result.op.kind === "create" || incarnationChanged;
          const completed =
            previousTask?.status !== "completed" &&
            updatedTask?.status === "completed";
          const previousDelegation = previousTask?.metadata?.delegation as
            { status?: unknown } | undefined;
          const invalidatesDelegation = Boolean(
            previousTask &&
            ["running", "interrupted", "cancelling"].includes(
              String(previousDelegation?.status),
            ) &&
            updatedTask &&
            (updatedTask.status === "completed" ||
              updatedTask.status === "deleted" ||
              !["pending", "in_progress"].includes(updatedTask.status)),
          );
          const replacesPreparation = Boolean(
            previousTask &&
            (params.action === "delete" ||
              incarnationChanged ||
              completed ||
              invalidatesDelegation),
          );
          if (replacesPreparation && previousTask) {
            const workerGeneration = hooks.preparation?.getGeneration?.() ?? 0;
            const withCancellation = addPreparationCancellationIntents(
              nextState,
              previousTask,
              workerGeneration,
            );
            if (!withCancellation) {
              return buildToolResult(params.action, mutationParams, current, {
                kind: "error",
                message: CANCELLATION_CAPACITY_ERROR,
              });
            }
            nextState = withCancellation;
            const withDelegationCancellation = hooks.preparation
              ?.admitDelegationCancellation
              ? hooks.preparation.admitDelegationCancellation(
                  nextState,
                  previousTask,
                  workerGeneration,
                )
              : nextState;
            if (!withDelegationCancellation) {
              return buildToolResult(params.action, mutationParams, current, {
                kind: "error",
                message: CANCELLATION_CAPACITY_ERROR,
              });
            }
            nextState = withDelegationCancellation;
          }
          assertLive();
          persistTodoSnapshot(pi, nextState);
          assertLive();
          commitState(nextState);
          if (replacesPreparation && previousTask) {
            const cancellation = cancelTodoPreparation(
              pi,
              previousTask,
              hooks.preparation?.getGeneration?.() ?? 0,
            );
            if (typeof previousToken === "string")
              enqueue.cancel(previousTask.id, previousToken, cancellation);
          }
          const updatedPreparation = updatedTask?.metadata?.preparation as
            { status?: unknown } | undefined;
          if (
            hooks.preparation &&
            updatedTask &&
            ["pending", "in_progress"].includes(updatedTask.status) &&
            startsPreparation &&
            updatedPreparation?.status === "queued"
          ) {
            const request =
              mutationParams.description !== undefined
                ? (updatedTask.description ?? updatedTask.subject)
                : mutationParams.subject !== undefined
                  ? updatedTask.subject
                  : (updatedTask.description ?? updatedTask.subject);
            startPreparation(
              pi,
              ctx,
              request,
              updatedTask,
              hooks.preparation,
              enqueue,
            );
          }
          hooks.onStateChanged?.();
        }
        return buildToolResult(
          params.action,
          mutationParams,
          nextState,
          result.op,
        );
      } finally {
        release();
      }
    },

    renderCall(args, theme, _context) {
      return renderTodoCall(args as never, theme, getState());
    },

    renderResult(result, _opts, theme, _context) {
      return renderTodoResult(result, theme);
    },
  });
}

export interface HostBlockingDecision {
  token: string;
  revision: number;
  questions: string[];
  reason: string;
}

function hostBlockingDecision(
  value: unknown,
  task: Task,
  revision: number,
): HostBlockingDecision | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return undefined;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (
    Reflect.ownKeys(candidate).length !== keys.length ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      return !descriptor || !("value" in descriptor);
    })
  )
    return undefined;
  if (
    keys.length !== 4 ||
    !keys.every((key) =>
      ["token", "revision", "questions", "reason"].includes(key),
    ) ||
    typeof candidate.token !== "string" ||
    candidate.token !==
      (task.metadata?.preparation as { token?: unknown })?.token ||
    candidate.revision !== revision ||
    typeof candidate.reason !== "string" ||
    !candidate.reason.trim() ||
    candidate.reason.length > MAX_WAIT_QUESTION_LENGTH ||
    !Array.isArray(candidate.questions) ||
    candidate.questions.length < 1 ||
    candidate.questions.length > 6 ||
    !candidate.questions.every(
      (question) =>
        typeof question === "string" &&
        question.trim().length > 0 &&
        question.length <= MAX_WAIT_QUESTION_LENGTH,
    ) ||
    new Set(candidate.questions.map((question) => question.trim())).size !==
      candidate.questions.length
  )
    return undefined;
  return {
    token: candidate.token,
    revision,
    questions: candidate.questions.map((question) => question.trim()),
    reason: candidate.reason.trim(),
  };
}

export interface TodoAddHooks {
  blockingDecision?: (
    task: Task,
    analysis: TodoAnalysis,
    revision: number,
  ) => unknown;
  enrich?: (
    ctx: ExtensionContext,
    raw: string,
  ) => Promise<TodoEnrichment | undefined>;
  analyze?: (
    ctx: ExtensionContext,
    raw: string,
    classification: TodoEnrichment,
    onSpawn?: (id: string) => void,
    onProgress?: (progress: BackgroundSubagentProgress) => void,
  ) => Promise<TodoAnalysis>;
  reorder?: (
    ctx: ExtensionContext,
    snapshot: TodoReorderSnapshot,
    tasks: ReturnType<typeof getState>["tasks"],
  ) => Promise<number[] | undefined>;
  getGeneration?: () => number;
  isCurrent?: (generation: number) => boolean;
  onStateChanged?: () => void;
  orchestrator?: () => OrchestratorSetting;
  classify?: (
    ctx: ExtensionContext,
    raw: string,
    prepared?: Record<string, unknown>,
    onSpawn?: (id: string) => void,
  ) => Promise<OrchestratorClassification>;
  rearmCancellation?: (taskId: number) => string;
  listCancellationRecovery?: () => string;
  admitDelegationCancellation?: (
    state: ReturnType<typeof getState>,
    task: Task,
    generation: number,
  ) => ReturnType<typeof getState> | undefined;
}

interface AnalysisSlot {
  taskId: number;
  token: string;
  work: () => Promise<void>;
  cancelled: boolean;
  resolve: () => void;
}

function createAnalysisQueue() {
  const pending: AnalysisSlot[] = [];
  let active: AnalysisSlot | undefined;

  const pump = () => {
    if (active) return;
    while (pending.length) {
      const slot = pending.shift()!;
      if (slot.cancelled) {
        slot.resolve();
        continue;
      }
      active = slot;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        active = undefined;
        slot.resolve();
        pump();
      };
      const work = Promise.resolve().then(() =>
        slot.cancelled ? undefined : slot.work(),
      );
      work.then(release, release);
      return;
    }
  };

  return {
    enqueue(taskId: number, token: string, work: () => Promise<void>) {
      return new Promise<void>((resolve) => {
        pending.push({ taskId, token, work, cancelled: false, resolve });
        pump();
      });
    },
    cancel(
      taskId: number,
      token: string,
      cancellation: Promise<unknown> = Promise.resolve(),
    ) {
      const slot =
        active?.taskId === taskId && active.token === token
          ? active
          : pending.find(
              (candidate) =>
                candidate.taskId === taskId && candidate.token === token,
            );
      if (!slot) return;
      slot.cancelled = true;
      if (slot === active) {
        // Cancellation acknowledges ownership of the worker request, not the
        // still-running service work. The work promise owns slot release.
        void cancellation.catch(() => undefined);
      } else pump();
    },
  };
}

const preparationCancellationEpoch = new WeakMap<object, number>();
const preparationCancellationInFlight = new WeakMap<
  object,
  Map<string, number>
>();
const preparationCancellationReservations = new WeakMap<
  object,
  Map<string, { ids: string[]; epoch: number }>
>();
const preparationCancellationOwnerProofs = new WeakMap<
  object,
  Map<string, TodoCancellationIntent>
>();
const preparationCancellationRetryTimers = new WeakMap<
  object,
  Map<string, { timer: ReturnType<typeof setTimeout>; epoch: number }>
>();
const preparationCancellationRetryAt = new WeakMap<
  object,
  Map<string, number>
>();
const PREPARATION_CANCELLATION_RETRY_BASE_MS = 25;

function preparationCancellationLifecycleEpoch(owner: object): number {
  return preparationCancellationEpoch.get(owner) ?? 0;
}

export function disposeTodoPreparationCancellations(
  pi: Pick<ExtensionAPI, "appendEntry">,
): void {
  const owner = pi as object;
  const epoch = preparationCancellationLifecycleEpoch(owner) + 1;
  preparationCancellationEpoch.set(owner, epoch);
  for (const entry of preparationCancellationRetryTimers.get(owner)?.values() ??
    [])
    clearTimeout(entry.timer);
  const ids = new Set(
    [
      ...(preparationCancellationReservations.get(owner)?.values() ?? []),
    ].flatMap((reservation) => reservation.ids),
  );
  releaseCancellationWorkerIds(owner, [...ids]);
  preparationCancellationInFlight.delete(owner);
  preparationCancellationReservations.delete(owner);
  preparationCancellationRetryTimers.delete(owner);
  preparationCancellationRetryAt.delete(owner);
  preparationCancellationOwnerProofs.delete(owner);
}

function preparationWorkerIds(task: Task): string[] {
  const preparation = task.metadata?.preparation as
    Record<string, unknown> | undefined;
  const ids = Array.isArray(preparation?.activeWorkerIds)
    ? preparation.activeWorkerIds.filter(
        (id): id is string => typeof id === "string",
      )
    : [];
  if (
    ["queued", "running", "classifying"].includes(
      String(preparation?.status),
    ) &&
    typeof preparation?.subagentId === "string"
  )
    ids.push(preparation.subagentId);
  return normalizeCancellationIds(ids);
}

function addPreparationCancellationIntents(
  state: ReturnType<typeof getState>,
  task: Task,
  workerGeneration: number,
): ReturnType<typeof getState> | undefined {
  const preparation = task.metadata?.preparation as
    Record<string, unknown> | undefined;
  if (typeof preparation?.token !== "string") return state;
  const ids = preparationWorkerIds(task);
  if (!ids.length) return state;
  const intents = [...(state.cancellationIntents ?? [])];
  const overflow = [...(state.cancellationOverflow ?? [])];
  const quarantine = [...(state.cancellationQuarantine ?? [])];
  const existing = [...intents, ...overflow, ...quarantine];
  const additions = ids.filter(
    (id) =>
      !existing.some(
        (intent) =>
          intent.kind === "preparation" &&
          intent.taskId === task.id &&
          intent.token === preparation.token &&
          intent.workerGeneration === workerGeneration &&
          intent.ids.length === 1 &&
          intent.ids[0] === id,
      ),
  );
  if (
    intents.length + overflow.length + quarantine.length + additions.length >
    MAX_CANCELLATION_INTENTS * 2
  )
    return undefined;
  const nextTask = state.tasks.find((candidate) => candidate.id === task.id);
  const nextPreparation = nextTask?.metadata?.preparation as
    Record<string, unknown> | undefined;
  for (const id of additions) {
    const target =
      intents.length < MAX_CANCELLATION_INTENTS ? intents : overflow;
    target.push({
      kind: "preparation",
      taskId: task.id,
      token: preparation.token,
      ids: [id],
      generation: 1,
      attempts: 0,
      workerGeneration,
      ...(nextPreparation?.token !== preparation.token
        ? { orphaned: true }
        : {}),
    });
  }
  const tasks =
    nextPreparation?.token === preparation.token
      ? state.tasks.map((candidate) =>
          candidate.id !== task.id
            ? candidate
            : {
                ...candidate,
                metadata: {
                  ...candidate.metadata,
                  preparation: {
                    ...nextPreparation,
                    cancellationIds: ids,
                    cancellationWorkerGeneration: workerGeneration,
                    cancellationToken: preparation.token,
                  },
                },
              },
        )
      : state.tasks;
  return withCancellationLedger(
    { ...state, tasks },
    { intents, overflow, quarantine },
  );
}

function preparationProtectedIds(
  owner: object,
  intent: TodoCancellationIntent,
  hasOwnerProof = false,
): Set<string> {
  const liveOwners = liveWorkerOwnerKinds();
  const reservedIds = new Set(reservedCancellationWorkerIds(owner));
  const durableIds = new Set(
    [
      ...(getState().cancellationIntents ?? []),
      ...(getState().cancellationOverflow ?? []),
      ...(getState().cancellationQuarantine ?? []),
    ].flatMap((candidate) => candidate.ids),
  );
  const protectedIds = new Set([
    ...liveOwners.keys(),
    ...reservedIds,
    ...durableIds,
  ]);
  const targetKey = cancellationIntentTargetKey(intent);
  const ownReservation = new Set(
    preparationCancellationReservations.get(owner)?.get(targetKey)?.ids ?? [],
  );
  if (
    cancellationIntentMatchesCurrentTask(getState(), intent) ||
    hasOwnerProof
  ) {
    for (const id of intent.ids) {
      if (reservedIds.has(id) && !ownReservation.has(id)) continue;
      const identities = liveOwners.get(id) ?? new Set();
      const unrelatedOwner = [...identities].some(
        (candidate) =>
          candidate.taskId !== intent.taskId ||
          candidate.token !== intent.token ||
          candidate.kind !== "preparation",
      );
      const unrelatedIntent = [
        ...(getState().cancellationIntents ?? []),
        ...(getState().cancellationOverflow ?? []),
        ...(getState().cancellationQuarantine ?? []),
      ].some(
        (candidate) =>
          candidate.ids.includes(id) &&
          cancellationIntentTargetKey(candidate) !== targetKey,
      );
      const currentPreparation = getState().tasks.find(
        (task) => task.id === intent.taskId,
      )?.metadata?.preparation as Record<string, unknown> | undefined;
      const reusedByCurrentPreparation =
        currentPreparation?.token !== intent.token &&
        Array.isArray(currentPreparation?.activeWorkerIds) &&
        currentPreparation.activeWorkerIds.includes(id);
      if (!unrelatedOwner && !unrelatedIntent && !reusedByCurrentPreparation)
        protectedIds.delete(id);
    }
  }
  return protectedIds;
}

export function adoptTodoPreparationCancellationOwners(
  pi: Pick<ExtensionAPI, "appendEntry">,
  intents: readonly TodoCancellationIntent[],
): void {
  const proofs =
    preparationCancellationOwnerProofs.get(pi) ??
    new Map<string, TodoCancellationIntent>();
  for (const intent of intents) {
    if (intent.kind === "preparation") {
      const key = cancellationIntentTargetKey(intent);
      proofs.set(key, intent);
    }
  }
  preparationCancellationOwnerProofs.set(pi, proofs);
}

export function hasTodoPreparationCancellationProof(
  pi: Pick<ExtensionAPI, "appendEntry">,
  intent: TodoCancellationIntent,
): boolean {
  return (
    intent.kind === "preparation" &&
    Boolean(
      preparationCancellationOwnerProofs
        .get(pi)
        ?.has(cancellationIntentTargetKey(intent)),
    )
  );
}

export function captureTodoPreparationCancellationOwners(
  pi: Pick<ExtensionAPI, "appendEntry">,
): TodoCancellationIntent[] {
  const proofs =
    preparationCancellationOwnerProofs.get(pi) ??
    new Map<string, TodoCancellationIntent>();
  const inFlight =
    preparationCancellationInFlight.get(pi) ?? new Map<string, number>();
  const handoff = new Map<string, TodoCancellationIntent>();
  for (const intent of proofs.values())
    handoff.set(cancellationIntentTargetKey(intent), intent);
  for (const intent of [
    ...(getState().cancellationIntents ?? []),
    ...(getState().cancellationOverflow ?? []),
    ...(getState().cancellationQuarantine ?? []),
  ]) {
    if (intent.kind !== "preparation") continue;
    const key = cancellationIntentTargetKey(intent);
    if (inFlight.has(key)) handoff.set(key, intent);
  }
  return [...handoff.values()];
}

function persistPreparationIntent(
  pi: Pick<ExtensionAPI, "appendEntry">,
  intent: TodoCancellationIntent,
  remove = false,
  error?: unknown,
): boolean {
  const current = getState();
  const normalized = normalizeCancellationIntent(intent);
  const task = current.tasks.find(
    (candidate) => candidate.id === normalized.taskId,
  );
  const preparation = task?.metadata?.preparation as
    Record<string, unknown> | undefined;
  const orphaned = !task || preparation?.token !== normalized.token;
  const ledger = updateCancellationLedger(current, normalized, {
    remove,
    error,
    orphaned,
  });
  if (!ledger.accepted) {
    const next = {
      ...current,
      cancellationCapacityError: ledger.capacityError,
      revision: current.revision + 1,
    };
    persistTodoSnapshot(pi, next);
    commitState(next);
    return false;
  }
  const cancellationIds = normalizeCancellationIds(
    ledger.intents
      .concat(ledger.overflow, ledger.quarantine)
      .filter(
        (candidate) =>
          candidate.kind === "preparation" &&
          candidate.taskId === normalized.taskId &&
          candidate.token === normalized.token &&
          candidate.workerGeneration === normalized.workerGeneration,
      )
      .flatMap((candidate) => candidate.ids),
  );
  const ownsCancellationMetadata = preparation?.token === normalized.token;
  const tasks = ownsCancellationMetadata
    ? current.tasks.map((candidate) =>
        candidate.id !== normalized.taskId
          ? candidate
          : {
              ...candidate,
              metadata: {
                ...candidate.metadata,
                preparation: (() => {
                  const nextPreparation = { ...preparation };
                  if (cancellationIds.length) {
                    nextPreparation.cancellationIds = cancellationIds;
                    nextPreparation.cancellationWorkerGeneration =
                      normalized.workerGeneration;
                    nextPreparation.cancellationToken = normalized.token;
                  } else {
                    delete nextPreparation.cancellationIds;
                    delete nextPreparation.cancellationWorkerGeneration;
                    delete nextPreparation.cancellationToken;
                  }
                  return nextPreparation;
                })(),
              },
            },
      )
    : current.tasks;
  const next = withCancellationLedger(
    { ...current, tasks, revision: current.revision + 1 },
    ledger,
  );
  persistTodoSnapshot(pi, next);
  commitState(next);
  return ledger.accepted;
}

async function dispatchPreparationCancellation(
  pi: Pick<ExtensionAPI, "appendEntry">,
  intent: TodoCancellationIntent,
  expectedEpoch = preparationCancellationLifecycleEpoch(pi),
): Promise<void> {
  if (expectedEpoch !== preparationCancellationLifecycleEpoch(pi)) return;
  const epoch = expectedEpoch;
  let inFlight = preparationCancellationInFlight.get(pi);
  if (!inFlight) {
    inFlight = new Map();
    preparationCancellationInFlight.set(pi, inFlight);
  }
  const normalized = normalizeCancellationIntent(intent);
  const ownerProof = preparationCancellationOwnerProofs
    .get(pi)
    ?.get(cancellationIntentTargetKey(normalized));
  const state = getState();
  const key = cancellationIntentTargetKey(normalized);
  const hasPrimaryOrOverflow = [
    ...(state.cancellationIntents ?? []),
    ...(state.cancellationOverflow ?? []),
  ].some((candidate) => cancellationIntentTargetKey(candidate) === key);
  const hasQuarantine = (state.cancellationQuarantine ?? []).some(
    (candidate) => cancellationIntentTargetKey(candidate) === key,
  );
  const hasDurableIntent = hasPrimaryOrOverflow || hasQuarantine;
  if (hasQuarantine && !hasPrimaryOrOverflow && !ownerProof) return;
  if (!cancellationIntentMatchesCurrentTask(state, normalized) && !ownerProof)
    return;
  if (!hasDurableIntent && !ownerProof) return;
  if (normalized.attempts >= 3) return;
  const retryAt = preparationCancellationRetryAt
    .get(pi)
    ?.get(cancellationIntentTargetKey(normalized));
  if (retryAt !== undefined && retryAt > Date.now()) return;
  if (retryAt !== undefined)
    preparationCancellationRetryAt
      .get(pi)
      ?.delete(cancellationIntentTargetKey(normalized));
  const protectedIds = preparationProtectedIds(pi, normalized, !!ownerProof);
  const ids = normalized.ids.filter((id) => !protectedIds.has(id));
  if (!ids.length) {
    if (normalized.ids.some((id) => protectedIds.has(id))) return;
    if (hasDurableIntent) persistPreparationIntent(pi, normalized, true);
    preparationCancellationOwnerProofs.get(pi)?.delete(key);
    return;
  }
  if (inFlight.has(key)) return;
  inFlight.set(key, epoch);
  const attempt = {
    ...normalized,
    attempts: Math.min(3, normalized.attempts + 1),
  };
  if (hasDurableIntent && !persistPreparationIntent(pi, attempt)) {
    inFlight.delete(key);
    return;
  }
  reserveCancellationWorkerIds(pi, ids);
  const reservations =
    preparationCancellationReservations.get(pi) ??
    new Map<string, { ids: string[]; epoch: number }>();
  reservations.set(key, { ids, epoch });
  preparationCancellationReservations.set(pi, reservations);
  try {
    const service = getBackgroundSubagentService();
    if (!service?.cancel)
      throw new Error("Subagent cancellation service unavailable");
    await service.cancel(ids);
    if (preparationCancellationLifecycleEpoch(pi) !== epoch) return;
    if (hasDurableIntent) persistPreparationIntent(pi, normalized, true);
    preparationCancellationOwnerProofs.get(pi)?.delete(key);
    const remaining = normalized.ids.filter((id) => protectedIds.has(id));
    if (remaining.length)
      persistPreparationIntent(pi, { ...attempt, ids: remaining });
  } catch (error) {
    if (preparationCancellationLifecycleEpoch(pi) === epoch) {
      const failedAttempt = {
        ...attempt,
        error: String(error).trim().slice(0, 512),
      };
      if (hasDurableIntent) persistPreparationIntent(pi, attempt, false, error);
      else if (ownerProof)
        preparationCancellationOwnerProofs.get(pi)?.set(key, failedAttempt);
      if (attempt.attempts < 3)
        schedulePreparationCancellationRetry(pi, attempt, epoch);
    }
  } finally {
    if (inFlight.get(key) === epoch) inFlight.delete(key);
    const reservation = preparationCancellationReservations.get(pi)?.get(key);
    if (
      reservation?.epoch === epoch &&
      (attempt.attempts >= 3 ||
        ![
          ...(getState().cancellationIntents ?? []),
          ...(getState().cancellationOverflow ?? []),
          ...(getState().cancellationQuarantine ?? []),
        ].some((candidate) => cancellationIntentTargetKey(candidate) === key))
    ) {
      preparationCancellationReservations.get(pi)?.delete(key);
      const stillReserved = new Set(
        [
          ...(preparationCancellationReservations.get(pi)?.values() ?? []),
        ].flatMap((entry) => entry.ids),
      );
      releaseCancellationWorkerIds(
        pi,
        ids.filter((id) => !stillReserved.has(id)),
      );
      clearPreparationCancellationRetry(pi, key);
    }
  }
}

function schedulePreparationCancellationRetry(
  pi: Pick<ExtensionAPI, "appendEntry">,
  intent: TodoCancellationIntent,
  epoch = preparationCancellationLifecycleEpoch(pi),
): void {
  if (epoch !== preparationCancellationLifecycleEpoch(pi)) return;
  const key = cancellationIntentTargetKey(intent);
  if (intent.attempts >= 3) return;
  const timers =
    preparationCancellationRetryTimers.get(pi) ??
    new Map<string, { timer: ReturnType<typeof setTimeout>; epoch: number }>();
  if (timers.has(key)) return;
  const delay =
    PREPARATION_CANCELLATION_RETRY_BASE_MS *
    2 ** Math.max(0, intent.attempts - 1);
  const due =
    preparationCancellationRetryAt.get(pi) ?? new Map<string, number>();
  due.set(key, Date.now() + delay);
  preparationCancellationRetryAt.set(pi, due);
  const timer = setTimeout(() => {
    const currentTimer = timers.get(key);
    if (!currentTimer || currentTimer.epoch !== epoch) return;
    timers.delete(key);
    due.delete(key);
    if (preparationCancellationLifecycleEpoch(pi) !== epoch) return;
    const current =
      [
        ...(getState().cancellationIntents ?? []),
        ...(getState().cancellationOverflow ?? []),
        ...(getState().cancellationQuarantine ?? []),
      ].find((candidate) => cancellationIntentTargetKey(candidate) === key) ??
      preparationCancellationOwnerProofs.get(pi)?.get(key);
    if (current)
      void dispatchPreparationCancellation(pi, current, epoch).catch(
        () => undefined,
      );
  }, delay);
  timer.unref?.();
  timers.set(key, { timer, epoch });
  preparationCancellationRetryTimers.set(pi, timers);
}

function clearPreparationCancellationRetry(
  pi: Pick<ExtensionAPI, "appendEntry">,
  key: string,
): void {
  const entry = preparationCancellationRetryTimers.get(pi)?.get(key);
  if (entry) clearTimeout(entry.timer);
  preparationCancellationRetryTimers.get(pi)?.delete(key);
  preparationCancellationRetryAt.get(pi)?.delete(key);
}

export async function cancelPreparationWorkers(
  pi: Pick<ExtensionAPI, "appendEntry">,
  taskId: number,
  token: string,
  workerGeneration: number,
  ids: readonly string[],
): Promise<void> {
  const bounded = normalizeCancellationIds(ids);
  if (!bounded.length || !token) return;
  const epoch = preparationCancellationLifecycleEpoch(pi);
  for (const id of bounded) {
    if (preparationCancellationLifecycleEpoch(pi) !== epoch) return;
    const task = getState().tasks.find((candidate) => candidate.id === taskId);
    const preparation = task?.metadata?.preparation as
      Record<string, unknown> | undefined;
    const orphaned = !task || preparation?.token !== token;
    const prior = [
      ...(getState().cancellationIntents ?? []),
      ...(getState().cancellationOverflow ?? []),
      ...(getState().cancellationQuarantine ?? []),
    ].find(
      (intent) =>
        intent.kind === "preparation" &&
        intent.taskId === taskId &&
        intent.token === token &&
        intent.workerGeneration === workerGeneration &&
        intent.ids.length === 1 &&
        intent.ids[0] === id,
    );
    const intent: TodoCancellationIntent = prior ?? {
      kind: "preparation",
      taskId,
      token,
      ids: [id],
      generation: 1,
      attempts: 0,
      workerGeneration,
      ...(orphaned ? { orphaned: true } : {}),
    };
    if (
      !prior &&
      task &&
      preparation?.token === token &&
      preparationWorkerIds(task).includes(id)
    ) {
      const proofs =
        preparationCancellationOwnerProofs.get(pi) ??
        new Map<string, TodoCancellationIntent>();
      proofs.set(cancellationIntentTargetKey(intent), intent);
      preparationCancellationOwnerProofs.set(pi, proofs);
    }
    if (!prior) persistPreparationIntent(pi, intent);
    await dispatchPreparationCancellation(pi, intent, epoch);
  }
}

async function cancelTodoPreparation(
  pi: Pick<ExtensionAPI, "appendEntry">,
  task: Task,
  workerGeneration = 0,
): Promise<void> {
  const preparation = task.metadata?.preparation as
    Record<string, unknown> | undefined;
  if (!preparation || typeof preparation.token !== "string") return;
  const ids = preparationWorkerIds(task);
  const proofs =
    preparationCancellationOwnerProofs.get(pi) ??
    new Map<string, TodoCancellationIntent>();
  for (const id of ids) {
    const intent: TodoCancellationIntent = {
      kind: "preparation",
      taskId: task.id,
      token: preparation.token,
      ids: [id],
      generation: 1,
      attempts: 0,
      workerGeneration,
    };
    proofs.set(cancellationIntentTargetKey(intent), intent);
  }
  preparationCancellationOwnerProofs.set(pi, proofs);
  await cancelPreparationWorkers(
    pi,
    task.id,
    preparation.token,
    workerGeneration,
    ids,
  );
}

export function retryTodoPreparationCancellations(
  pi: Pick<ExtensionAPI, "appendEntry">,
  extra: readonly TodoCancellationIntent[] = [],
): void {
  const intents = new Map<string, TodoCancellationIntent>();
  for (const intent of [
    ...(getState().cancellationIntents ?? []),
    ...(getState().cancellationOverflow ?? []),
    ...(getState().cancellationQuarantine ?? []),
    ...extra,
    ...captureTodoPreparationCancellationOwners(pi),
  ])
    if (intent.kind === "preparation")
      intents.set(cancellationIntentTargetKey(intent), intent);
  for (const intent of intents.values())
    void dispatchPreparationCancellation(pi, intent).catch(() => undefined);
}

export function rearmTodoPreparationCancellations(
  pi: Pick<ExtensionAPI, "appendEntry">,
  taskId?: number,
  tokens?: readonly string[],
): boolean {
  const state = getState();
  const authorize = (intent: TodoCancellationIntent): boolean =>
    cancellationIntentMatchesCurrentTask(state, {
      ...intent,
      orphaned: undefined,
    }) || hasTodoPreparationCancellationProof(pi, intent);
  const promote = (intent: TodoCancellationIntent): boolean => {
    const task = state.tasks.find(
      (candidate) => candidate.id === intent.taskId,
    );
    return (
      authorize(intent) &&
      Boolean(task || hasTodoPreparationCancellationProof(pi, intent))
    );
  };
  const ledger = rearmCancellationLedger(
    state,
    "preparation",
    taskId,
    tokens,
    authorize,
    promote,
    (intent) => {
      clearPreparationCancellationRetry(
        pi,
        cancellationIntentTargetKey(intent),
      );
      const task = state.tasks.find(
        (candidate) => candidate.id === intent.taskId,
      );
      return task &&
        (task.status === "completed" ||
          task.status === "deleted" ||
          (task.metadata?.preparation as Record<string, unknown> | undefined)
            ?.token !== intent.token)
        ? { ...intent, orphaned: true }
        : intent;
    },
  );
  if (!ledger.changed) return false;
  const next = withCancellationLedger(
    { ...state, revision: state.revision + 1 },
    ledger,
  );
  persistTodoSnapshot(pi, next);
  commitState(next);
  for (const intent of ledger.rearmed)
    void dispatchPreparationCancellation(pi, intent);
  retryTodoPreparationCancellations(pi);
  return true;
}

const analysisQueues = new WeakMap<
  object,
  ReturnType<typeof createAnalysisQueue>
>();

export function getAnalysisQueue(
  pi: ExtensionAPI,
): ReturnType<typeof createAnalysisQueue> {
  let queue = analysisQueues.get(pi);
  if (!queue) {
    queue = createAnalysisQueue();
    analysisQueues.set(pi, queue);
  }
  return queue;
}

function persistDetachedState(
  pi: ExtensionAPI,
  next: ReturnType<typeof getState>,
  hooks: TodoAddHooks,
): void {
  persistTodoSnapshot(pi, next);
  commitState(next);
  hooks.onStateChanged?.();
}

function startReorder(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  generation: number,
  hooks: TodoAddHooks,
): void {
  if (hooks.isCurrent && !hooks.isCurrent(generation)) return;
  const snapshot = createTodoReorderSnapshot(getState());
  if (!snapshot) return;
  const tasks = getState().tasks;
  void (hooks.reorder ?? requestTodoReorder)(ctx, snapshot, tasks).then(
    (order) => {
      if (!order || (hooks.isCurrent && !hooks.isCurrent(generation))) return;
      const current = getState();
      const reordered = applyTodoReorder(current, snapshot, order);
      if (reordered !== current) persistDetachedState(pi, reordered, hooks);
    },
    () => undefined,
  );
}

export function startPreparation(
  pi: ExtensionAPI,
  ctx: ExtensionContext | undefined,
  raw: string,
  task: import("./tool/types.js").Task,
  hooks: TodoAddHooks,
  enqueue = createAnalysisQueue(),
): void {
  const generation = hooks.getGeneration?.() ?? 0;
  const resolved = todoPreparationPolicy(raw, ctx?.cwd);
  let preparationTask = task;
  const token = (task.metadata?.preparation as { token?: unknown } | undefined)
    ?.token;
  const cancelStaleWorker = (id: string) => {
    if (typeof token === "string")
      void cancelPreparationWorkers(pi, task.id, token, generation, [id]);
  };
  const refreshPreparationTask = () => {
    const current = getState().tasks.find(
      (candidate) => candidate.id === task.id,
    );
    if (
      !current ||
      (current.metadata?.preparation as { token?: unknown } | undefined)
        ?.token !== token
    )
      return false;
    preparationTask = current;
    return true;
  };
  if (resolved.reviewTarget) {
    const current = getState();
    const targetPreparation = preparationTask.metadata?.preparation as
      Record<string, unknown> | undefined;
    if (targetPreparation) {
      const targeted = applyPreparationCAS(current, preparationTask, {
        ...targetPreparation,
        reviewTarget: resolved.reviewTarget,
        ...(resolved.reviewClassification
          ? { reviewClassification: resolved.reviewClassification }
          : {}),
        ...(resolved.analysisCwd ? { analysisCwd: resolved.analysisCwd } : {}),
        ...(resolved.analysisCwdIdentity
          ? { analysisCwdIdentity: resolved.analysisCwdIdentity }
          : {}),
      });
      if (targeted !== current) {
        persistDetachedState(pi, targeted, hooks);
        preparationTask = targeted.tasks.find(
          (candidate) => candidate.id === task.id,
        )!;
      }
    }
  }
  if (resolved.reviewTarget?.status === "unresolved") {
    const preparation = preparationTask.metadata?.preparation as
      Record<string, unknown> | undefined;
    if (preparation) {
      const failed = applyPreparationCAS(getState(), preparationTask, {
        ...preparation,
        status: "failed",
        code: "review_target_unresolved",
        error: resolved.reviewTarget.reason,
      });
      if (failed !== getState()) persistDetachedState(pi, failed, hooks);
    }
    return;
  }
  if (!ctx) {
    const preparation = preparationTask.metadata?.preparation as
      Record<string, unknown> | undefined;
    if (preparation) {
      const failed = applyPreparationCAS(getState(), preparationTask, {
        ...preparation,
        status: "failed",
        code: "preparation_failed",
        error: "TODO preparation requires a live extension context",
      });
      if (failed !== getState()) persistDetachedState(pi, failed, hooks);
    }
    return;
  }
  const trackWorker = (id: string, active: boolean) => {
    if (!refreshPreparationTask()) {
      if (active) cancelStaleWorker(id);
      return false;
    }
    const state = getState();
    const currentPreparation = preparationTask.metadata?.preparation as Record<
      string,
      unknown
    >;
    const ids = new Set(
      Array.isArray(currentPreparation.activeWorkerIds)
        ? currentPreparation.activeWorkerIds.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
    );
    if (active) ids.add(id);
    else ids.delete(id);
    const patch = { ...currentPreparation };
    if (ids.size) patch.activeWorkerIds = [...ids];
    else delete patch.activeWorkerIds;
    const next = applyPreparationCAS(state, preparationTask, patch);
    if (next === state) {
      if (active) cancelStaleWorker(id);
      return false;
    }
    persistDetachedState(pi, next, hooks);
    preparationTask = next.tasks.find((candidate) => candidate.id === task.id)!;
    return true;
  };
  const classify = async (prepared?: Record<string, unknown>) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let workerId: string | undefined;
      let active = true;
      try {
        const result = await (
          hooks.classify ?? requestOrchestratorClassification
        )(ctx, raw, prepared, (id) => {
          if (!active) {
            cancelStaleWorker(id);
            return;
          }
          workerId = id;
          trackWorker(id, true);
        });
        return result;
      } catch (error) {
        if (attempt === 1) return undefined;
        void error;
      } finally {
        active = false;
        if (workerId) trackWorker(workerId, false);
      }
    }
    return undefined;
  };
  const applyRawClassification = () =>
    classify().then((classification) => {
      if (
        !classification ||
        (hooks.isCurrent && !hooks.isCurrent(generation)) ||
        !refreshPreparationTask()
      )
        return;
      const state = getState();
      const currentPreparation = preparationTask.metadata
        ?.preparation as Record<string, unknown>;
      if (!["queued", "running"].includes(String(currentPreparation.status)))
        return;
      const withClassifier = applyPreparationCAS(state, preparationTask, {
        ...currentPreparation,
        classifier: { status: "raw" },
      });
      if (withClassifier === state) return;
      const classified = {
        ...withClassifier,
        tasks: withClassifier.tasks.map((candidate) =>
          candidate.id === task.id
            ? markOrchestrator(
                candidate,
                hooks.orchestrator?.() ?? "auto",
                classification,
                "raw",
                (
                  candidate.metadata?.orchestrator as
                    { mode?: "direct" | "provisional" | "sticky" } | undefined
                )?.mode,
              )
            : candidate,
        ),
      };
      persistDetachedState(pi, classified, hooks);
      preparationTask = classified.tasks.find(
        (candidate) => candidate.id === task.id,
      )!;
    });
  const rawApplied = applyRawClassification();
  const runPreparation = async () => {
    if (
      (hooks.isCurrent && !hooks.isCurrent(generation)) ||
      !refreshPreparationTask()
    )
      return;
    const latest = getState();
    const queuedPreparation = preparationTask.metadata?.preparation as Record<
      string,
      unknown
    >;
    const running = applyPreparationCAS(latest, preparationTask, {
      ...queuedPreparation,
      status: "running",
      ...(resolved.analysisRoot ? { analysisRoot: resolved.analysisRoot } : {}),
      ...(resolved.analysisKind ? { analysisKind: resolved.analysisKind } : {}),
      ...(resolved.reviewClassification
        ? { reviewClassification: resolved.reviewClassification }
        : {}),
      ...(resolved.analysisCwd ? { analysisCwd: resolved.analysisCwd } : {}),
      ...(resolved.analysisCwdIdentity
        ? { analysisCwdIdentity: resolved.analysisCwdIdentity }
        : {}),
      ...(resolved.reviewTarget ? { reviewTarget: resolved.reviewTarget } : {}),
    });
    if (running === latest) return;
    persistDetachedState(pi, running, hooks);
    preparationTask = running.tasks.find(
      (candidate) => candidate.id === task.id,
    )!;
    let analysisWorkerId: string | undefined;
    let lastAnalysisWorkerId: string | undefined;
    const onSpawn = (subagentId: string) => {
      analysisWorkerId = subagentId;
      lastAnalysisWorkerId = subagentId;
      if (
        (hooks.isCurrent && !hooks.isCurrent(generation)) ||
        !refreshPreparationTask()
      ) {
        cancelStaleWorker(subagentId);
        return;
      }
      if (!trackWorker(subagentId, true)) return;
      const currentPreparation = preparationTask.metadata
        ?.preparation as Record<string, unknown>;
      const withId = applyPreparationCAS(getState(), preparationTask, {
        ...currentPreparation,
        status: "running",
        ...(resolved.analysisRoot
          ? { analysisRoot: resolved.analysisRoot }
          : {}),
        ...(resolved.analysisKind
          ? { analysisKind: resolved.analysisKind }
          : {}),
        ...(resolved.reviewClassification
          ? { reviewClassification: resolved.reviewClassification }
          : {}),
        ...(resolved.analysisCwd ? { analysisCwd: resolved.analysisCwd } : {}),
        ...(resolved.analysisCwdIdentity
          ? { analysisCwdIdentity: resolved.analysisCwdIdentity }
          : {}),
        ...(resolved.reviewTarget
          ? { reviewTarget: resolved.reviewTarget }
          : {}),
        subagentId,
      });
      if (withId === getState()) {
        cancelStaleWorker(subagentId);
        return;
      }
      persistDetachedState(pi, withId, hooks);
      preparationTask = withId.tasks.find(
        (candidate) => candidate.id === task.id,
      )!;
    };
    const onProgress = (progress: BackgroundSubagentProgress) => {
      if (
        progress.id !== analysisWorkerId ||
        (hooks.isCurrent && !hooks.isCurrent(generation)) ||
        !refreshPreparationTask()
      ) {
        cancelStaleWorker(progress.id);
        return;
      }
      const currentPreparation = preparationTask.metadata
        ?.preparation as Record<string, unknown>;
      const next = applyPreparationCAS(
        getState(),
        preparationTask,
        {
          ...currentPreparation,
          status: "running",
          ...(resolved.analysisRoot
            ? { analysisRoot: resolved.analysisRoot }
            : {}),
          ...(resolved.analysisKind
            ? { analysisKind: resolved.analysisKind }
            : {}),
          ...(resolved.reviewClassification
            ? { reviewClassification: resolved.reviewClassification }
            : {}),
          ...(resolved.analysisCwd
            ? { analysisCwd: resolved.analysisCwd }
            : {}),
          ...(resolved.analysisCwdIdentity
            ? { analysisCwdIdentity: resolved.analysisCwdIdentity }
            : {}),
          ...(resolved.reviewTarget
            ? { reviewTarget: resolved.reviewTarget }
            : {}),
          subagentId: progress.id,
          progress: progress.stage,
          progressAt: progress.at,
        },
        progress.subject,
      );
      if (next === getState()) {
        cancelStaleWorker(progress.id);
        return;
      }
      persistDetachedState(pi, next, hooks);
      preparationTask = next.tasks.find(
        (candidate) => candidate.id === task.id,
      )!;
    };
    try {
      let prepared: TodoAnalysis | undefined;
      let preparationError: unknown;
      for (let attempt = 0; attempt < 2 && !prepared; attempt++) {
        analysisWorkerId = undefined;
        try {
          let analysisPolicy = resolved;
          if (
            !resolved.analysisCwd ||
            !isTodoReviewTargetIdentity(resolved.analysisCwdIdentity) ||
            validateTodoReviewTarget(
              resolved.analysisCwd,
              resolved.analysisCwdIdentity,
            ) !== resolved.analysisCwd
          )
            throw new Error(
              "prepared execution target invalidated or unavailable before analysis",
            );
          if (resolved.reviewTarget?.status === "selected") {
            const currentPreparation = preparationTask.metadata
              ?.preparation as Record<string, unknown>;
            const persistedTarget = currentPreparation.reviewTarget as
              Record<string, unknown> | undefined;
            const persistedPath =
              persistedTarget?.status === "selected" &&
              typeof persistedTarget.path === "string"
                ? persistedTarget.path
                : undefined;
            const persistedIdentity = persistedTarget?.identity;
            const canonical = persistedPath
              ? validateTodoReviewTarget(
                  persistedPath,
                  resolved.reviewTarget.identity,
                )
              : undefined;
            if (
              persistedPath !== resolved.reviewTarget.path ||
              !sameTodoReviewTargetIdentity(
                persistedIdentity,
                resolved.reviewTarget.identity,
              ) ||
              canonical !== persistedPath
            )
              throw new Error(
                "explicit checkout target invalidated before preparation",
              );
            analysisPolicy = {
              ...resolved,
              analysisCwd: canonical,
              reviewTarget: resolved.reviewTarget,
            };
          }
          prepared = await (hooks.analyze ?? requestTodoAnalysis)(
            ctx,
            raw,
            analysisPolicy,
            onSpawn,
            onProgress,
          );
        } catch (error) {
          preparationError = error;
        } finally {
          const settledWorkerId = analysisWorkerId;
          analysisWorkerId = undefined;
          if (settledWorkerId) trackWorker(settledWorkerId, false);
        }
      }
      if (!prepared)
        throw preparationError ?? new Error("TODO preparation failed twice");
      await rawApplied;
      if (
        (hooks.isCurrent && !hooks.isCurrent(generation)) ||
        !refreshPreparationTask()
      )
        return;
      const currentPreparation = preparationTask.metadata
        ?.preparation as Record<string, unknown>;
      const persistedPath =
        typeof currentPreparation.analysisCwd === "string"
          ? currentPreparation.analysisCwd
          : undefined;
      const persistedIdentity = currentPreparation.analysisCwdIdentity;
      const canonical =
        persistedPath && isTodoReviewTargetIdentity(persistedIdentity)
          ? validateTodoReviewTarget(persistedPath, persistedIdentity)
          : undefined;
      if (
        persistedPath !== resolved.analysisCwd ||
        !sameTodoReviewTargetIdentity(
          persistedIdentity,
          resolved.analysisCwdIdentity,
        ) ||
        canonical !== persistedPath
      ) {
        if (lastAnalysisWorkerId && typeof token === "string")
          void cancelPreparationWorkers(pi, task.id, token, generation, [
            lastAnalysisWorkerId,
          ]);
        throw new Error(
          "prepared execution target invalidated after preparation analysis",
        );
      }
      const status = (prepared as unknown as { status?: unknown }).status;
      const readyPreparation = preparationTask.metadata?.preparation as Record<
        string,
        unknown
      >;
      if (status === "insufficient" || status === "not_needed") {
        const current = getState();
        const currentTask = current.tasks.find(
          (candidate) => candidate.id === task.id,
        );
        const decision = currentTask
          ? hostBlockingDecision(
              hooks.blockingDecision?.(currentTask, prepared, current.revision),
              currentTask,
              current.revision,
            )
          : undefined;
        const outcome = applyPreparationCAS(
          current,
          preparationTask,
          {
            ...readyPreparation,
            status: decision ? status : "failed",
            ...(decision ? {} : { code: "preparation_insufficient" }),
            summary: prepared.summary,
            questions: prepared.questions,
            classifier: { status: "ready" },
            ...(decision
              ? { blockingDecision: { source: "host", ...decision } }
              : {}),
          },
          prepared.subject,
        );
        if (outcome !== current) {
          const waiting = decision
            ? {
                ...outcome,
                tasks: outcome.tasks.map((candidate) =>
                  candidate.id === task.id
                    ? {
                        ...candidate,
                        status: "waiting:user" as const,
                        wait: {
                          kind: "user" as const,
                          questions: decision.questions,
                        },
                      }
                    : candidate,
                ),
              }
            : outcome;
          persistDetachedState(pi, waiting, hooks);
        }
        return;
      }
      const dossierFields = Object.fromEntries(
        Object.entries({
          summary: prepared.summary,
          scope: prepared.scope,
          exclusions: prepared.exclusions,
          conflicts: prepared.conflicts,
          decisions: prepared.decisions,
          approvals: prepared.approvals,
          verifiedFacts: prepared.verifiedFacts,
          assumptions: prepared.assumptions,
          affectedPaths: prepared.affectedPaths,
          steps: prepared.steps,
          checks: prepared.checks,
          questions: prepared.questions,
          risks: prepared.risks,
          sources: prepared.sources,
          confidence: prepared.confidence,
          freshness: prepared.freshness,
          subagentId: prepared.subagentId,
        }).filter(([, value]) => value !== undefined),
      );
      const ready = applyPreparationCAS(
        getState(),
        preparationTask,
        {
          ...readyPreparation,
          status:
            status === "insufficient" || status === "not_needed"
              ? status
              : "ready",
          ...dossierFields,
          ...(resolved.analysisRoot
            ? { analysisRoot: resolved.analysisRoot }
            : {}),
          ...(resolved.analysisKind
            ? { analysisKind: resolved.analysisKind }
            : {}),
          ...(resolved.reviewClassification
            ? { reviewClassification: resolved.reviewClassification }
            : {}),
          ...(resolved.analysisCwd
            ? { analysisCwd: resolved.analysisCwd }
            : {}),
          ...(resolved.analysisCwdIdentity
            ? { analysisCwdIdentity: resolved.analysisCwdIdentity }
            : {}),
          ...(resolved.reviewTarget
            ? { reviewTarget: resolved.reviewTarget }
            : {}),
          classifier: { status: "pending" },
        },
        prepared.subject,
      );
      if (ready !== getState()) {
        persistDetachedState(pi, ready, hooks);
        preparationTask = ready.tasks.find(
          (candidate) => candidate.id === task.id,
        )!;
        const classified = await classify(
          prepared as unknown as Record<string, unknown>,
        );
        if (
          (hooks.isCurrent && !hooks.isCurrent(generation)) ||
          !refreshPreparationTask()
        )
          return;
        const fallback = classified ?? {
          ...classifyOrchestration(
            raw,
            prepared as unknown as Record<string, unknown>,
          ),
          fallback: "prepared classifier failed twice; structural fallback",
        };
        const currentPreparation = preparationTask.metadata
          ?.preparation as Record<string, unknown>;
        const classifiedState = applyPreparationCAS(
          getState(),
          preparationTask,
          {
            ...currentPreparation,
            classifier: {
              status: classified ? "ready" : "fallback",
              ...(fallback.fallback ? { fallback: fallback.fallback } : {}),
            },
          },
        );
        if (classifiedState === getState()) return;
        const updated = {
          ...classifiedState,
          tasks: classifiedState.tasks.map((candidate) => {
            if (candidate.id !== task.id) return candidate;
            const marked = markOrchestrator(
              candidate,
              hooks.orchestrator?.() ?? "auto",
              fallback,
              "prepared",
              (
                candidate.metadata?.orchestrator as
                  { mode?: "direct" | "provisional" | "sticky" } | undefined
              )?.mode,
            );
            const preparation = marked.metadata?.preparation as Record<
              string,
              unknown
            >;
            const target = preparation?.reviewTarget as
              Record<string, unknown> | undefined;
            const identity =
              target?.status === "selected"
                ? target.identity
                : preparation?.analysisCwdIdentity;
            const binding = todoReviewTargetIdentityBinding(identity);
            if (
              preparation?.status !== "ready" ||
              typeof preparation.token !== "string" ||
              !binding
            )
              return marked;
            return {
              ...marked,
              metadata: {
                ...marked.metadata,
                preparation: {
                  ...preparation,
                  hostAssignment: {
                    source: "host",
                    version: 1,
                    token: preparation.token,
                    targetBinding: binding,
                  },
                },
              },
            };
          }),
        };
        persistDetachedState(pi, updated, hooks);
      }
    } catch (error) {
      if (
        (hooks.isCurrent && !hooks.isCurrent(generation)) ||
        !refreshPreparationTask()
      )
        return;
      const currentPreparation = preparationTask.metadata
        ?.preparation as Record<string, unknown>;
      const failed = applyPreparationCAS(getState(), preparationTask, {
        ...currentPreparation,
        status: "failed",
        code: "preparation_failed",
        error: String(error).slice(0, 500),
        ...(resolved.analysisRoot
          ? { analysisRoot: resolved.analysisRoot }
          : {}),
        ...(resolved.analysisKind
          ? { analysisKind: resolved.analysisKind }
          : {}),
        ...(resolved.reviewClassification
          ? { reviewClassification: resolved.reviewClassification }
          : {}),
      });
      if (failed !== getState()) persistDetachedState(pi, failed, hooks);
    }
  };
  if (typeof token !== "string") return;
  const preparation = enqueue.enqueue(task.id, token, runPreparation);
  void preparation.then(() => {
    if (refreshPreparationTask()) startReorder(pi, ctx, generation, hooks);
  });
}

async function addTodo(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  raw: string,
  hooks: TodoAddHooks,
): Promise<void> {
  const before = getState();
  const result = applyTaskMutation(before, "create", {
    subject: provisionalTodoSubject(raw),
    description: raw,
    metadata: {
      ...markOrchestrator(
        { id: 0, subject: "", status: "pending" },
        hooks.orchestrator?.() ?? "auto",
        classifyOrchestration(raw),
        "raw",
      ).metadata,
      preparation: {
        status: "queued",
        version: 1,
        token: randomUUID(),
        sourceRevision: before.revision,
      },
    },
  });
  if (result.op.kind !== "create") return;
  const taskId = result.op.taskId;
  const task = result.state.tasks.find((candidate) => candidate.id === taskId)!;
  persistTodoSnapshot(pi, result.state);
  commitState(result.state);
  hooks.onStateChanged?.();
  ctx.ui.notify(`Added TODO #${task.id}`, "info");
  startPreparation(pi, ctx, raw, task, hooks, getAnalysisQueue(pi));
}

export function registerOrchestratorCommand(
  pi: ExtensionAPI,
  get: () => OrchestratorSetting,
  set: (value: OrchestratorSetting) => Promise<void>,
): void {
  pi.registerCommand("orchestrator", {
    description: "Set orchestrator mode: /orchestrator on|off|auto",
    handler: async (args, ctx) => {
      const value = args.trim() as OrchestratorSetting;
      if (!(["on", "off", "auto"] as string[]).includes(value)) {
        ctx.ui.notify("Usage: /orchestrator on|off|auto", "error");
        return;
      }
      await set(value);
      ctx.ui.notify(
        orchestratorStatus(
          getState().tasks,
          get(),
          getState().orchestrator?.sticky,
        ),
        "info",
      );
    },
  });
}

export function registerTodoAddCommand(
  pi: ExtensionAPI,
  hooks: TodoAddHooks = {},
): void {
  pi.registerCommand("todo", {
    description: "Add or recover a TODO: /todo add <raw> | /todo rearm [#N]",
    handler: async (args, ctx) => {
      if (/^\s*rearm\s*$/i.test(args)) {
        ctx.ui.notify(
          hooks.listCancellationRecovery
            ? hooks.listCancellationRecovery()
            : "TODO cancellation recovery is unavailable.",
          hooks.listCancellationRecovery ? "info" : "error",
        );
        return;
      }
      const rearmMatch = args.match(/^\s*rearm\s+#?(\d+)\s*$/i);
      if (rearmMatch) {
        const taskId = Number(rearmMatch[1]);
        ctx.ui.notify(
          hooks.rearmCancellation
            ? hooks.rearmCancellation(taskId)
            : "TODO cancellation recovery is unavailable.",
          hooks.rearmCancellation ? "info" : "error",
        );
        return;
      }
      const match = args.match(/^\s*add\s+([\s\S]*\S)\s*$/i);
      if (!match) {
        ctx.ui.notify("Usage: /todo add <raw> | /todo rearm [#N]", "error");
        return;
      }
      await addTodo(pi, ctx, match[1], hooks);
    },
  });
}

// ---------------------------------------------------------------------------
// /todos slash command
// ---------------------------------------------------------------------------

export function registerTodosCommand(
  pi: ExtensionAPI,
  hooks: TodoAddHooks = {},
): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Show todos or add one with /todos add <request>",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(
          t("command.requires_interactive", ERR_REQUIRES_INTERACTIVE),
          "error",
        );
        return;
      }
      const addMatch = args.match(/^\s*add\s+([\s\S]*\S)\s*$/i);
      if (addMatch) {
        await addTodo(pi, ctx, addMatch[1], hooks);
        return;
      }
      if (args.trim()) {
        ctx.ui.notify("Usage: /todos [add <request>]", "error");
        return;
      }
      const visible = selectVisibleTasks(getState());
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          visible.length
            ? visible
                .map((task) =>
                  formatCommandTaskLine(
                    task,
                    "•",
                    allCancellationIntents(getState()),
                  ),
                )
                .join("\n")
            : "No TODOs",
          "info",
        );
        return;
      }
      if (visible.length === 0) {
        const raw = (await ctx.ui.editor("Add TODO", ""))?.trim();
        if (raw) await addTodo(pi, ctx, raw, hooks);
        return;
      }
      await showTodoDetailView(ctx);
    },
  });
}
