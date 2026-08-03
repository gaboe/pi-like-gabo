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
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  getBackgroundSubagentService,
  type BackgroundSubagentProgress,
} from "../../vendor/pi-tools/extensions/shared/background-subagent-protocol.js";
import { loadConfig, validateGuidanceFields } from "./config.js";
import { classifyOrchestration, markOrchestrator, ORCHESTRATOR_GUIDANCE, orchestratorStatus, requestOrchestratorClassification, type OrchestratorClassification, type OrchestratorSetting } from "./orchestrator.js";
import {
  applyPreparationCAS,
  cancelTodoPreparation,
  provisionalTodoSubject,
  requestTodoAnalysis,
  requestTodoReorder,
  todoPreparationPolicy,
  type TodoAnalysis,
  type TodoEnrichment,
} from "./enrichment.js";
import type { JobsAdapter } from "./jobs-adapter.js";
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
  "Before implementing multi-step work, translate the whole known execution plan into separate TODOs. Use one task per meaningful phase so progress is visible; never collapse a known multi-phase plan into one umbrella task or invent speculative microtasks.",
  "When starting any task, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one driver task should be in_progress at a time; that bookkeeping rule does not serialize execution, and one driver task may own multiple safe parallel workers.",
  "Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
  "When all visible tasks become completed, follow the automatic completion review: create TODOs for anything missing and continue, or call todo clear to archive the completed batch and give one context-preserving completion report with outcome, before→now behavior, key paths and short code snippets, resulting flow, exact verification, usage steps, and remaining caveats. Clear must never remove unresolved tasks.",
  "Task status supports pending, in_progress, waiting:user, waiting:jobs, completed, and deleted. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.",
  "When work needs user input, set waiting:user with 1-8 exact concrete questions. When work depends on running jobs, set waiting:jobs with unique jobIds, jobMode all/any, and timeoutSeconds; job outcomes wake the task to pending with evidence and never complete it.",
  "Use blockedBy only for true execution prerequisites. Do not block research, review, or other independently useful work on a broad parent task. Before waiting or saying work must happen after a running operation, scan the TODO graph and current plan, then start every safe independent unit up to the worker limit. Same feature, PR, or stack is not itself a conflict: serialize only exact write-set, worktree/ref, or result-freshness conflicts; use isolated worktrees or pinned read-only snapshots to prepare blocked integration work in parallel when safe. When every pending task is blocked while a job runs, reassess dependencies once, remove obsolete or overbroad edges, and continue independent work; never remove a genuine dependency merely to stay busy. On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.",
  "list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
  "Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
  "Before starting a task whose metadata.preparation is ready, call todo get and verify its prepared scope, steps, risks, and candidate questions against current code. Candidate questions are suggestions: ask only those still required, using waiting:user.",
  ORCHESTRATOR_GUIDANCE,
];

export interface TodoRuntimeHooks {
  jobs?: Pick<JobsAdapter, "validateRunning">;
  onStateChanged?: () => void;
  preparation?: TodoAddHooks;
  orchestrator?: () => OrchestratorSetting;
}

const RESERVED_METADATA_KEYS = new Set([
  "delegation",
  "orchestrator",
  "preparation",
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
      "Manage a task list for tracking multi-step progress. Actions: create, update, list, get, delete, clear. Clear archives completed tasks and rejects unresolved work. Statuses: pending, in_progress, waiting:user, waiting:jobs, completed, deleted. Waiting jobs wake to pending with evidence; they never auto-complete.",
    promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
    promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
    parameters: TodoParamsSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const previous = mutationTail;
      let release!: () => void;
      mutationTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        let current = getState();
        const inputParams = params as TaskMutationParams;
        const reservedKey = reservedMetadataKey(inputParams);
        if (reservedKey) {
          return buildToolResult(params.action, inputParams, current, {
            kind: "error",
            message: `metadata.${reservedKey} is reserved for pi-plugins; use the task's classified mode instead of editing orchestration metadata`,
          });
        }
        const mutationParams: TaskMutationParams =
          params.action === "create"
            ? {
                ...inputParams,
                subject: provisionalTodoSubject(inputParams.subject ?? ""),
                ...(inputParams.description === undefined
                  ? { description: inputParams.subject }
                  : {}),
                metadata: {
                  ...markOrchestrator({ id: 0, subject: "", status: "pending", metadata: inputParams.metadata }, hooks.orchestrator?.() ?? "auto", classifyOrchestration(inputParams.description ?? inputParams.subject ?? ""), "raw").metadata,
                  preparation: {
                    status: "queued",
                    version: 1,
                    token: randomUUID(),
                    sourceRevision: current.revision,
                  },
                },
              }
            : inputParams;
        const existing =
          params.action === "update" && mutationParams.id !== undefined
            ? current.tasks.find((task) => task.id === mutationParams.id)
            : undefined;
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
          const error = await hooks.jobs?.validateRunning(jobIds);
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
        if (result.state !== current) {
          persistTodoSnapshot(pi, result.state);
          commitState(result.state);
          hooks.onStateChanged?.();
          const mutatedId =
            result.op.kind === "update" || result.op.kind === "delete"
              ? result.op.id
              : undefined;
          const previousTask = mutatedId === undefined
            ? undefined
            : current.tasks.find((task) => task.id === mutatedId);
          const updatedTask = mutatedId === undefined
            ? undefined
            : result.state.tasks.find((task) => task.id === mutatedId);
          const previousToken = (previousTask?.metadata?.preparation as { token?: unknown } | undefined)?.token;
          const updatedToken = (updatedTask?.metadata?.preparation as { token?: unknown } | undefined)?.token;
          const incarnationChanged = previousToken !== updatedToken;
          const completed =
            previousTask?.status !== "completed" &&
            updatedTask?.status === "completed";
          if (
            previousTask &&
            (params.action === "delete" || incarnationChanged || completed)
          ) {
            const cancellation = cancelTodoPreparation(previousTask).catch(
              () => undefined,
            );
            if (typeof previousToken === "string")
              enqueue.cancel(previousTask.id, previousToken, cancellation);
          }
          let task;
          if (result.op.kind === "create") {
            const createdTaskId = result.op.taskId;
            task = result.state.tasks.find(
              (candidate) => candidate.id === createdTaskId,
            );
          } else if (
            incarnationChanged &&
            updatedTask?.status !== "completed" &&
            updatedTask?.status !== "deleted"
          ) {
            task = updatedTask;
          }
          if (task && hooks.preparation) {
            const preparationRaw =
              result.op.kind === "create"
                ? (task.description ?? task.subject)
                : [task.subject, task.description]
                    .filter((value, index, values) =>
                      Boolean(value) && values.indexOf(value) === index,
                    )
                    .join("\n\n");
            startPreparation(
              pi,
              _ctx as ExtensionCommandContext,
              preparationRaw,
              task,
              hooks.preparation,
              enqueue,
            );
          }
        }
        return buildToolResult(
          params.action,
          mutationParams,
          result.state,
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

export interface TodoAddHooks {
  enrich?: (
    ctx: ExtensionCommandContext,
    raw: string,
  ) => Promise<TodoEnrichment | undefined>;
  analyze?: (
    ctx: ExtensionCommandContext,
    raw: string,
    classification: TodoEnrichment,
    onSpawn?: (id: string) => void,
    onProgress?: (progress: BackgroundSubagentProgress) => void,
  ) => Promise<TodoAnalysis>;
  reorder?: (
    ctx: ExtensionCommandContext,
    snapshot: TodoReorderSnapshot,
    tasks: ReturnType<typeof getState>["tasks"],
  ) => Promise<number[] | undefined>;
  getGeneration?: () => number;
  isCurrent?: (generation: number) => boolean;
  onStateChanged?: () => void;
  orchestrator?: () => OrchestratorSetting;
  classify?: (
    ctx: ExtensionCommandContext,
    raw: string,
    prepared?: Record<string, unknown>,
    onSpawn?: (id: string) => void,
  ) => Promise<OrchestratorClassification>;
}

interface AnalysisSlot {
  taskId: number;
  token: string;
  work: () => Promise<void>;
  cancelled: boolean;
  resolve: () => void;
  release?: () => void;
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
      slot.release = release;
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
      if (slot === active)
        void cancellation.then(slot.release, slot.release);
      else pump();
    },
  };
}

const analysisQueues = new WeakMap<
  object,
  ReturnType<typeof createAnalysisQueue>
>();

function getAnalysisQueue(pi: ExtensionAPI): ReturnType<typeof createAnalysisQueue> {
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
  ctx: ExtensionCommandContext,
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

function startPreparation(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  raw: string,
  task: import("./tool/types.js").Task,
  hooks: TodoAddHooks,
  enqueue = createAnalysisQueue(),
): void {
  const generation = hooks.getGeneration?.() ?? 0;
  const resolved = todoPreparationPolicy(raw);
  let preparationTask = task;
  const token = (task.metadata?.preparation as { token?: unknown } | undefined)?.token;
  const refreshPreparationTask = () => {
    const current = getState().tasks.find((candidate) => candidate.id === task.id);
    if (
      !current ||
      (current.metadata?.preparation as { token?: unknown } | undefined)?.token !== token
    )
      return false;
    preparationTask = current;
    return true;
  };
  const trackWorker = (id: string, active: boolean) => {
    if (!refreshPreparationTask()) {
      if (active)
        void getBackgroundSubagentService()
          ?.cancel?.([id])
          .catch(() => undefined);
      return false;
    }
    const state = getState();
    const currentPreparation = preparationTask.metadata?.preparation as Record<string, unknown>;
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
      if (active)
        void getBackgroundSubagentService()
          ?.cancel?.([id])
          .catch(() => undefined);
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
        const result = await (hooks.classify ?? requestOrchestratorClassification)(
          ctx,
          raw,
          prepared,
          (id) => {
            if (!active) {
              void getBackgroundSubagentService()?.cancel?.([id]).catch(() => undefined);
              return;
            }
            workerId = id;
            trackWorker(id, true);
          },
        );
        return result;
      } catch {
      } finally {
        active = false;
        if (workerId) trackWorker(workerId, false);
      }
    }
    return undefined;
  };
  const applyRawClassification = () => classify().then((classification) => {
    if (
      !classification ||
      (hooks.isCurrent && !hooks.isCurrent(generation)) ||
      !refreshPreparationTask()
    )
      return;
    const state = getState();
    const currentPreparation = preparationTask.metadata?.preparation as Record<string, unknown>;
    if (
      !["queued", "running"].includes(String(currentPreparation.status))
    )
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
          ? markOrchestrator(candidate, hooks.orchestrator?.() ?? "auto", classification, "raw", (candidate.metadata?.orchestrator as { mode?: "direct" | "provisional" | "sticky" } | undefined)?.mode)
          : candidate,
      ),
    };
    persistDetachedState(pi, classified, hooks);
    preparationTask = classified.tasks.find((candidate) => candidate.id === task.id)!;
  });
  const rawApplied = applyRawClassification();
  const runPreparation = async () => {
    if (
      (hooks.isCurrent && !hooks.isCurrent(generation)) ||
      !refreshPreparationTask()
    )
      return;
    const latest = getState();
    const queuedPreparation = preparationTask.metadata?.preparation as Record<string, unknown>;
    const running = applyPreparationCAS(latest, preparationTask, {
      ...queuedPreparation,
      status: "running",
      analysisRoot: resolved.analysisRoot,
      analysisKind: resolved.analysisKind,
    });
    if (running === latest) return;
    persistDetachedState(pi, running, hooks);
    preparationTask = running.tasks.find((candidate) => candidate.id === task.id)!;
    let analysisWorkerId: string | undefined;
    const onSpawn = (subagentId: string) => {
      analysisWorkerId = subagentId;
      if (
        (hooks.isCurrent && !hooks.isCurrent(generation)) ||
        !refreshPreparationTask()
      ) {
        void getBackgroundSubagentService()
          ?.cancel?.([subagentId])
          .catch(() => undefined);
        return;
      }
      if (!trackWorker(subagentId, true)) return;
      const currentPreparation = preparationTask.metadata?.preparation as Record<string, unknown>;
      const withId = applyPreparationCAS(getState(), preparationTask, {
        ...currentPreparation,
        status: "running",
        analysisRoot: resolved.analysisRoot,
        analysisKind: resolved.analysisKind,
        subagentId,
      });
      if (withId === getState()) {
        void getBackgroundSubagentService()?.cancel?.([subagentId]).catch(() => undefined);
        return;
      }
      persistDetachedState(pi, withId, hooks);
      preparationTask = withId.tasks.find((candidate) => candidate.id === task.id)!;
    };
    const onProgress = (progress: BackgroundSubagentProgress) => {
      if (
        progress.id !== analysisWorkerId ||
        (hooks.isCurrent && !hooks.isCurrent(generation)) ||
        !refreshPreparationTask()
      ) {
        void getBackgroundSubagentService()
          ?.cancel?.([progress.id])
          .catch(() => undefined);
        return;
      }
      const currentPreparation = preparationTask.metadata?.preparation as Record<string, unknown>;
      const next = applyPreparationCAS(
        getState(),
        preparationTask,
        {
          ...currentPreparation,
          status: "running",
          analysisRoot: resolved.analysisRoot,
          analysisKind: resolved.analysisKind,
          subagentId: progress.id,
          progress: progress.stage,
          progressAt: progress.at,
        },
        progress.subject,
      );
      if (next === getState()) {
        void getBackgroundSubagentService()?.cancel?.([progress.id]).catch(() => undefined);
        return;
      }
      persistDetachedState(pi, next, hooks);
      preparationTask = next.tasks.find((candidate) => candidate.id === task.id)!;
    };
    try {
      let prepared: TodoAnalysis | undefined;
      let preparationError: unknown;
      for (let attempt = 0; attempt < 2 && !prepared; attempt++) {
        analysisWorkerId = undefined;
        try { prepared = await (hooks.analyze ?? requestTodoAnalysis)(ctx, raw, resolved, onSpawn, onProgress); }
        catch (error) { preparationError = error; }
        finally {
          const settledWorkerId = analysisWorkerId;
          analysisWorkerId = undefined;
          if (settledWorkerId) trackWorker(settledWorkerId, false);
        }
      }
      if (!prepared) throw preparationError ?? new Error("TODO preparation failed twice");
      await rawApplied;
      if (
        (hooks.isCurrent && !hooks.isCurrent(generation)) ||
        !refreshPreparationTask()
      )
        return;
      const status = (prepared as unknown as { status?: unknown }).status;
      const currentPreparation = preparationTask.metadata?.preparation as Record<string, unknown>;
      const ready = applyPreparationCAS(
        getState(),
        preparationTask,
        {
          ...currentPreparation,
          status:
            status === "insufficient" || status === "not_needed"
              ? status
              : "ready",
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
          analysisRoot: resolved.analysisRoot,
          analysisKind: resolved.analysisKind,
          analysisCwd: prepared.analysisCwd,
          classifier: { status: "pending" },
        },
        prepared.subject,
      );
      if (ready !== getState()) {
        persistDetachedState(pi, ready, hooks);
        preparationTask = ready.tasks.find((candidate) => candidate.id === task.id)!;
        const classified = await classify(
          prepared as unknown as Record<string, unknown>,
        );
        if (
          (hooks.isCurrent && !hooks.isCurrent(generation)) ||
          !refreshPreparationTask()
        )
          return;
        const fallback = classified ?? { ...classifyOrchestration(raw, prepared as unknown as Record<string, unknown>), fallback: "prepared classifier failed twice; structural fallback" };
        const currentPreparation = preparationTask.metadata?.preparation as Record<string, unknown>;
        const classifiedState = applyPreparationCAS(getState(), preparationTask, {
          ...currentPreparation,
          classifier: { status: classified ? "ready" : "fallback", fallback: fallback.fallback },
        });
        if (classifiedState === getState()) return;
        const classifiedTask = classifiedState.tasks.find((candidate) => candidate.id === task.id)!;
        const updated = {
          ...classifiedState,
          tasks: classifiedState.tasks.map((candidate) =>
            candidate.id === task.id
              ? markOrchestrator(candidate, hooks.orchestrator?.() ?? "auto", fallback, "prepared", (candidate.metadata?.orchestrator as { mode?: "direct" | "provisional" | "sticky" } | undefined)?.mode)
              : candidate,
          ),
        };
        persistDetachedState(pi, updated, hooks);
      }
    } catch (error) {
      if (
        (hooks.isCurrent && !hooks.isCurrent(generation)) ||
        !refreshPreparationTask()
      )
        return;
      const currentPreparation = preparationTask.metadata?.preparation as Record<string, unknown>;
      const failed = applyPreparationCAS(getState(), preparationTask, {
        ...currentPreparation,
        status: "failed",
        code: "preparation_failed",
        error: String(error).slice(0, 500),
        analysisRoot: resolved.analysisRoot,
        analysisKind: resolved.analysisKind,
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
      ...markOrchestrator({ id: 0, subject: "", status: "pending" }, hooks.orchestrator?.() ?? "auto", classifyOrchestration(raw), "raw").metadata,
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

export function registerOrchestratorCommand(pi: ExtensionAPI, get: () => OrchestratorSetting, set: (value: OrchestratorSetting) => Promise<void>): void {
  pi.registerCommand("orchestrator", { description: "Set orchestrator mode: /orchestrator on|off|auto", handler: async (args, ctx) => {
    const value = args.trim() as OrchestratorSetting;
    if (!(["on", "off", "auto"] as string[]).includes(value)) { ctx.ui.notify("Usage: /orchestrator on|off|auto", "error"); return; }
    await set(value); ctx.ui.notify(orchestratorStatus(getState().tasks, get(), getState().orchestrator?.sticky), "info");
  }});
}

export function registerTodoAddCommand(
  pi: ExtensionAPI,
  hooks: TodoAddHooks = {},
): void {
  pi.registerCommand("todo", {
    description: "Add a TODO immediately: /todo add <raw>",
    handler: async (args, ctx) => {
      const match = args.match(/^\s*add\s+([\s\S]*\S)\s*$/i);
      if (!match) {
        ctx.ui.notify("Usage: /todo add <raw>", "error");
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
            ? visible.map((task) => formatCommandTaskLine(task, "•")).join("\n")
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
