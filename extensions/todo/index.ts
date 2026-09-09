/**
 * rpiv-todo — Pi extension. Registers the `todo` tool, `/todos` slash
 * command, and the persistent TodoOverlay widget.
 *
 * TUI chrome strings localize at render time via the i18n bridge. Strings are
 * registered with rpiv-i18n here, once, at module init — but only when the
 * SDK is actually installed. If `@juicesharp/rpiv-i18n` is missing (standalone
 * install of just this package), the dynamic-load shim no-ops and the bridge's
 * `t(key, fallback)` returns the inline English literal at every call site.
 * The extension stays online either way.
 *
 * Adding a locale: drop `locales/<code>.json` next to en.json (mirroring the
 * key set). No edit needed here — `registerLocalesFromDir` iterates
 * `SUPPORTED_LOCALES` from the SDK. See `@juicesharp/rpiv-i18n` README →
 * "Contributing translations" for the full convention.
 *
 * Extracted from rpiv-pi@7525a5d. Tool name "todo" and widget key
 * "rpiv-todos" preserved verbatim so existing session history replays
 * correctly after upgrade.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emitTelemetry } from "../telemetry/protocol.js";
import { loadConfig, orchestratorEnabled } from "./config.js";
import { orchestratorFooterStatus } from "./orchestrator.js";
import { JobsAdapter } from "./jobs-adapter.js";
import {
  captureCompletionReviewScope,
  completionReviewCwd,
  isChatGptProUsageLimit,
  TodoScheduler,
  persistTodoSnapshot,
} from "./scheduler.js";
import { publicTodoState } from "./state/inbox.js";
import { replayFromBranch } from "./state/replay.js";
import {
  commitState,
  getState,
  replaceState,
  subscribeState,
} from "./state/store.js";
import {
  cancellationIntentTargetKey,
  CANCELLATION_CAPACITY_ERROR,
  allCancellationIntents,
  cancellationRecoveryError,
  MAX_CANCELLATION_INTENTS,
  MAX_CANCELLATION_RECOVERY_ENTRIES,
  mergeCancellationIntents,
  withCancellationLedger,
  type TodoCancellationIntent,
} from "./state/state.js";
import {
  registerOrchestratorCommand,
  registerTodoAddCommand,
  registerTodosCommand,
  registerTodoTool,
  rearmTodoPreparationCancellations,
  disposeTodoPreparationCancellations,
  retryTodoPreparationCancellations,
  adoptTodoPreparationCancellationOwners,
  captureTodoPreparationCancellationOwners,
  hasTodoPreparationCancellationProof,
  getAnalysisQueue,
  startPreparation,
  TOOL_NAME,
} from "./todo.js";
import {
  isCompletionReviewDecisionQuestion,
  type UserWaitResponse,
} from "./state/waits.js";
import { TodoOverlay } from "./todo-overlay.js";
import { completionReviewFooterStatus } from "./view/format.js";
import {
  AUTOMATION_PAUSE_CHANNEL,
  type AutomationPauseRequest,
} from "../../vendor/pi-tools/extensions/shared/automation-pause-protocol.js";
import { registerPackageAssignmentGate } from "../../vendor/pi-tools/extensions/shared/assignment-gate-protocol.js";
import type { Task } from "./tool/types.js";

// pi-core's ExtensionRunner throws this exact phrase from an invalidated ctx
// proxy after session replacement/reload. Match the stable substring so genuine
// replay bugs still propagate instead of being silently swallowed.
function isStaleCtxError(e: unknown): boolean {
  return /stale after session replacement/.test(String(e));
}

export function awakenedQueuedPreparations(
  previous: readonly Task[],
  next: readonly Task[],
): Task[] {
  const prior = new Map(previous.map((task) => [task.id, task]));
  return next.filter((task) => {
    const before = prior.get(task.id);
    const preparation = task.metadata?.preparation as
      { status?: unknown; token?: unknown } | undefined;
    const previousPreparation = before?.metadata?.preparation as
      { token?: unknown } | undefined;
    return (
      before !== undefined &&
      before.status !== task.status &&
      ["pending", "in_progress"].includes(task.status) &&
      preparation?.status === "queued" &&
      typeof preparation.token === "string" &&
      preparation.token === previousPreparation?.token
    );
  });
}

function askUserDetails(value: unknown):
  | {
      cancelled?: boolean;
      explanationRequested?: boolean;
      question: string;
      answer?: string;
    }
  | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const details = value as Record<string, unknown>;
  if (
    (details.cancelled === undefined ||
      typeof details.cancelled === "boolean") &&
    (details.explanationRequested === undefined ||
      typeof details.explanationRequested === "boolean") &&
    typeof details.question === "string" &&
    details.question.trim().length > 0
  ) {
    if (details.answers !== undefined && !Array.isArray(details.answers))
      return undefined;
    if (
      details.answers === undefined &&
      typeof details.answer === "string" &&
      details.answer.trim().length > 0
    )
      return {
        cancelled: details.cancelled,
        explanationRequested: details.explanationRequested,
        question: details.question,
        answer: details.answer,
      };
    if (
      details.answer === null &&
      Array.isArray(details.answers) &&
      details.answers.length > 0 &&
      details.answers.every(
        (answer) => typeof answer === "string" && answer.trim().length > 0,
      )
    )
      return {
        cancelled: details.cancelled,
        explanationRequested: details.explanationRequested,
        question: details.question,
        answer: details.answers.map((answer) => answer.trim()).join(", "),
      };
    if (
      (details.cancelled === true || details.explanationRequested === true) &&
      (details.answer === undefined ||
        details.answer === "" ||
        (details.answer === null && details.answers === undefined))
    )
      return {
        cancelled: details.cancelled,
        explanationRequested: details.explanationRequested,
        question: details.question,
      };
  }
  return undefined;
}

type AskUserCorrelation = {
  toolCallId: string;
  taskId: number;
  invokedQuestion: string;
  preparationToken?: string;
  questions: string[];
  kind: "ordinary" | "completion-review";
  lifecycleNonce: number;
  preparationTokenPresent?: boolean;
  completionQuestion?: string;
  reviewGeneration?: number;
  reviewToken?: string;
  reviewCompletionRevision?: number;
  reviewRequestedAt?: number;
  reviewFailedAtPresent?: boolean;
  reviewFailedAt?: number;
  reviewAttempts?: number;
  reviewFeedback?: string;
  retryable?: boolean;
  retryAttempts?: number;
};

type TodoCancellationStatus = "cancelling" | "failed" | "exhausted";

type TodoCancellationTelemetry = {
  taskId: number;
  status: TodoCancellationStatus;
};

function cancellationStatus(
  attempts: unknown,
  error: unknown,
): TodoCancellationStatus {
  const boundedAttempts =
    Number.isSafeInteger(attempts) && Number(attempts) >= 0
      ? Number(attempts)
      : 0;
  if (boundedAttempts >= 3) return "exhausted";
  if (typeof error === "string") return "failed";
  return "cancelling";
}

function cancellationStates(
  state: ReturnType<typeof getState>,
): Map<number, TodoCancellationTelemetry> {
  const intents = allCancellationIntents(state);
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  const states = new Map<number, TodoCancellationTelemetry>();
  const severity = (status: TodoCancellationStatus): number =>
    status === "exhausted" ? 3 : status === "failed" ? 2 : 1;
  const add = (taskId: number, status: TodoCancellationStatus): void => {
    const prior = states.get(taskId);
    if (!prior || severity(status) > severity(prior.status))
      states.set(taskId, { taskId, status });
  };
  for (const intent of intents) {
    add(intent.taskId, cancellationStatus(intent.attempts, intent.error));
  }
  for (const task of tasks.values()) {
    const delegation = task.metadata?.delegation as
      | {
          status?: unknown;
          cancellationAttempts?: unknown;
          cancellationError?: unknown;
          cancellationGeneration?: unknown;
        }
      | undefined;
    if (
      !intents.some((intent) => intent.taskId === task.id) &&
      (["interrupted", "cancelling"].includes(String(delegation?.status)) ||
        typeof delegation?.cancellationError === "string")
    ) {
      add(
        task.id,
        cancellationStatus(
          delegation?.cancellationAttempts,
          delegation?.cancellationError,
        ),
      );
    }
  }
  return states;
}

export function interruptsTodoAutomation(text: string): boolean {
  return (
    /(?:^|\s)(?:\/skill:|\$)pi-like-gabo-reflect(?:\s|$)/i.test(text) ||
    /<skill\s+name=["']pi-like-gabo-reflect["']/i.test(text)
  );
}

export default function (pi: ExtensionAPI) {
  // Todo overlay widget — constructed lazily at the first session_start with UI.
  let todoOverlay: TodoOverlay | undefined;
  let stopStateTelemetry: (() => void) | undefined;
  const queuedPreparationStarts = new Set<string>();
  let runAborted = false;
  let runUsageLimited = false;
  const globalOrchestratorEnabled = orchestratorEnabled(loadConfig());
  let orchestratorSetting: "on" | "off" | "auto" = globalOrchestratorEnabled
    ? "auto"
    : "off";
  let updateOrchestratorStatus = () => {};
  let clearOrchestratorStatus = () => {};
  const jobs = new JobsAdapter(pi.events);
  const scheduler = new TodoScheduler(pi, jobs, () => todoOverlay?.update());
  let lifecycleGeneration = 0;
  let askUserLifecycleNonce = 0;
  let askUserSessionActive = false;
  const sessionToolGenerations = new Map<
    string,
    { generation: number; toolName: string }
  >();
  // Tool call IDs are host-owned invocation identities. Once observed, an ID
  // is never reusable in this extension process because terminal events carry
  // no independent invocation token.
  const retiredToolCallIds = new Set<string>();
  const retiredAskUserToolCallIds = new Set<string>();
  const forbiddenAskUserToolCallIds = new Set<string>();
  const retireToolCallId = (toolCallId: string): void => {
    retiredToolCallIds.delete(toolCallId);
    retiredToolCallIds.add(toolCallId);
  };
  const retireAskUserToolCallId = (toolCallId: string): void => {
    retiredAskUserToolCallIds.add(toolCallId);
    retireToolCallId(toolCallId);
  };
  const forbidAskUserToolCallId = (toolCallId: string): void => {
    forbiddenAskUserToolCallIds.add(toolCallId);
    retireToolCallId(toolCallId);
  };
  let unregisterAssignmentGate: (() => void) | undefined;
  const retireSessionToolCalls = (): void => {
    for (const [toolCallId, ownership] of sessionToolGenerations) {
      if (ownership.toolName === "ask_user")
        retireAskUserToolCallId(toolCallId);
      else forbidAskUserToolCallId(toolCallId);
    }
    sessionToolGenerations.clear();
  };
  const rotateAskUserLifecycle = (): void => {
    askUserLifecycleNonce++;
  };
  const clearAskUserCorrelations = (
    state: ReturnType<typeof getState>,
  ): ReturnType<typeof getState> => {
    let changed = false;
    const tasks = state.tasks.map((task) => {
      if (!task.metadata || !Object.hasOwn(task.metadata, "askUserCorrelation"))
        return task;
      changed = true;
      const metadata = { ...task.metadata };
      delete metadata.askUserCorrelation;
      return { ...task, metadata };
    });
    return changed ? { ...state, tasks, revision: state.revision + 1 } : state;
  };
  const replayWithoutAskUserCorrelations = (
    state: ReturnType<typeof getState>,
  ): ReturnType<typeof getState> => {
    const cleared = clearAskUserCorrelations(state);
    if (cleared !== state) persistTodoSnapshot(pi, cleared, state);
    return cleared;
  };
  const emitCancellationTransitions = (
    previous: ReturnType<typeof getState>,
    next: ReturnType<typeof getState>,
  ): void => {
    const previousCancellations = cancellationStates(previous);
    const nextCancellations = cancellationStates(next);
    for (const key of new Set([
      ...previousCancellations.keys(),
      ...nextCancellations.keys(),
    ])) {
      const before = previousCancellations.get(key);
      const after = nextCancellations.get(key);
      if (!after) {
        if (before)
          emitTelemetry(pi.events, {
            type: "todo_cancellation",
            status: "settled",
          });
        continue;
      }
      if (before?.status === after.status) continue;
      emitTelemetry(pi.events, {
        type: "todo_cancellation",
        status: after.status,
      });
    }
  };
  const mergeRecoveryOwners = (owners: readonly TodoCancellationIntent[]) => {
    const merged = new Map<string, TodoCancellationIntent>();
    for (const owner of owners) {
      const key = cancellationIntentTargetKey(owner);
      const prior = merged.get(key);
      merged.set(
        key,
        prior ? mergeCancellationIntents([prior], [owner]).intents[0] : owner,
      );
    }
    return [...merged.values()];
  };
  const mergeRecoveryLedger = (owners: readonly TodoCancellationIntent[]) => {
    const merged = new Map<string, TodoCancellationIntent>();
    for (const owner of owners) {
      const key = cancellationIntentTargetKey(owner);
      const prior = merged.get(key);
      merged.set(
        key,
        prior ? mergeCancellationIntents([prior], [owner]).intents[0] : owner,
      );
    }
    const values = [...merged.values()];
    if (values.length > MAX_CANCELLATION_RECOVERY_ENTRIES)
      throw new Error(
        "TODO cancellation recovery exceeds replay bound; branch transition held",
      );
    return {
      intents: values.slice(0, MAX_CANCELLATION_INTENTS),
      overflow: values.slice(
        MAX_CANCELLATION_INTENTS,
        MAX_CANCELLATION_INTENTS * 2,
      ),
      quarantine: values.slice(MAX_CANCELLATION_INTENTS * 2),
    };
  };
  let failClosedRecoveryOwners: TodoCancellationIntent[] = [];
  const preserveFailClosedRecovery = (
    owners: readonly TodoCancellationIntent[],
  ): void => {
    const pending = mergeRecoveryOwners([
      ...failClosedRecoveryOwners,
      ...owners,
    ]);
    if (!pending.length) return;
    const current = getState();
    try {
      const ledger = mergeRecoveryLedger([
        ...(current.cancellationIntents ?? []),
        ...(current.cancellationOverflow ?? []),
        ...(current.cancellationQuarantine ?? []),
        ...pending,
      ]);
      const next = withCancellationLedger(
        { ...current, revision: current.revision + 1 },
        {
          intents: ledger.intents,
          overflow: ledger.overflow,
          quarantine: ledger.quarantine,
          capacityError:
            cancellationRecoveryError(
              ledger.intents.length,
              ledger.overflow.length,
              ledger.quarantine.length,
            ) ?? current.cancellationCapacityError,
        },
      );
      persistTodoSnapshot(pi, next, current);
      replaceState(next);
      failClosedRecoveryOwners = [];
    } catch {
      const fallback = {
        ...current,
        cancellationCapacityError: CANCELLATION_CAPACITY_ERROR,
        revision: current.revision + 1,
      };
      try {
        persistTodoSnapshot(pi, fallback, current);
        replaceState(fallback);
      } catch {
        // Keep the proof in memory for the next replacement/recovery attempt.
      }
      failClosedRecoveryOwners = pending;
    }
  };
  const failClosedSessionTree = (): void => {
    askUserSessionActive = false;
    lifecycleGeneration++;
    rotateAskUserLifecycle();
    retireSessionToolCalls();
    unregisterAssignmentGate?.();
    unregisterAssignmentGate = undefined;
    stopStateTelemetry?.();
    stopStateTelemetry = undefined;
    updateOrchestratorStatus = () => {};
    clearOrchestratorStatus = () => {};
    scheduler.setPreparationRequester(() => {});
    disposeTodoPreparationCancellations(pi);
    scheduler.dispose();
  };
  const failClosedWithRecovery = (
    handoff: readonly TodoCancellationIntent[],
  ): void => {
    let preserved = [...handoff];
    try {
      preserved = mergeRecoveryOwners([
        ...preserved,
        ...scheduler.captureCancellationHandoff(),
        ...scheduler.captureAbandonedCancellationIntents(getState()),
        ...captureTodoPreparationCancellationOwners(pi),
      ]);
    } catch {
      // Preserve the already captured proof if a late observer cannot be read.
    }
    preserveFailClosedRecovery(preserved);
    failClosedSessionTree();
  };
  const refreshAssignmentGate = (setting = orchestratorSetting) => {
    const unregisterPrevious = unregisterAssignmentGate;
    unregisterAssignmentGate = registerPackageAssignmentGate(
      ({ todoId, todoToken, workerCwd, targetBinding }) => {
        if (!globalOrchestratorEnabled || setting === "off")
          return "package_handoff assignment gate is off.";
        return scheduler.packageAssignmentError(
          todoId,
          todoToken,
          setting,
          workerCwd,
          targetBinding,
        );
      },
      ({ todoId, todoToken, subagentId, workerCwd, targetBinding }) =>
        scheduler.authorizePackageAssignment(
          todoId,
          todoToken,
          subagentId,
          workerCwd,
          targetBinding,
        ),
      ({ todoId, todoToken, subagentId }) =>
        scheduler.rollbackPackageAssignment(
          todoId,
          todoToken,
          subagentId,
          "package handoff start or abort failed",
        ),
    );
    unregisterPrevious?.();
  };
  const replayedOrchestratorSetting = (
    state: ReturnType<typeof getState>,
  ): "on" | "off" | "auto" =>
    globalOrchestratorEnabled ? (state.orchestrator?.setting ?? "auto") : "off";
  const rebindOrchestratorRuntime = (): void => {
    orchestratorSetting = replayedOrchestratorSetting(getState());
    refreshAssignmentGate(orchestratorSetting);
    updateOrchestratorStatus();
  };
  pi.events.on(AUTOMATION_PAUSE_CHANNEL, (value) => {
    const request = value as AutomationPauseRequest | undefined;
    if (
      !request ||
      request.reason !== "double-escape" ||
      !scheduler.hasAutomationWork()
    )
      return;
    request.acknowledge("todo", 1);
    scheduler.pauseAutomation();
  });

  const todoAddHooks = {
    getGeneration: () => scheduler.getGeneration(),
    isCurrent: (generation: number) => scheduler.isCurrent(generation),
    onStateChanged: () => scheduler.stateChanged(),
    orchestrator: () => orchestratorSetting,
    listCancellationRecovery: () => {
      const taskIds = [
        ...new Set(
          allCancellationIntents(getState()).map((intent) => intent.taskId),
        ),
      ].sort((a, b) => a - b);
      if (!taskIds.length) return "No TODO cancellation recovery is available.";
      return `Recoverable cancellation TODOs: ${taskIds.map((id) => `#${id}`).join(", ")}. Use /todo rearm #N.`;
    },
    admitDelegationCancellation: (
      state: ReturnType<typeof getState>,
      task: Task,
      generation: number,
    ) => scheduler.admitDelegationCancellation(state, task, generation),
    rearmCancellation: (taskId: number) => {
      const state = getState();
      const task = state.tasks.find((candidate) => candidate.id === taskId);
      const taskIntents = allCancellationIntents(state).filter(
        (intent) => intent.taskId === taskId,
      );
      if (!task && !taskIntents.length) return `TODO #${taskId} was not found.`;
      if (!task) {
        const hasProof = taskIntents.every(
          (intent) =>
            intent.orphaned === true &&
            (intent.kind === "delegation"
              ? scheduler.hasCancellationOwnerProof(intent)
              : hasTodoPreparationCancellationProof(pi, intent)),
        );
        if (!hasProof)
          return `TODO #${taskId} cancellation cannot be safely re-armed: ownership proof is unavailable.`;
        const intentTokens = [
          ...new Set(taskIntents.map((intent) => intent.token)),
        ];
        const rearmedPreparation = rearmTodoPreparationCancellations(
          pi,
          taskId,
          intentTokens,
        );
        const rearmedDelegation = scheduler.rearmCancellationIntents(
          taskId,
          intentTokens,
        );
        if (!rearmedPreparation && !rearmedDelegation)
          return `TODO #${taskId} has no exhausted cancellation to re-arm.`;
        scheduler.stateChanged(false);
        return `Re-armed cancellation for TODO #${taskId}; retrying now.`;
      }
      const preparation = task.metadata?.preparation as
        { token?: unknown } | undefined;
      const delegation = task.metadata?.delegation as
        { todoToken?: unknown } | undefined;
      const tokens = [preparation?.token, delegation?.todoToken].filter(
        (token): token is string =>
          typeof token === "string" && token.trim().length > 0,
      );
      if (!taskIntents.length)
        return `TODO #${taskId} has no pending cancellation to re-arm.`;
      const staleIncarnation = taskIntents.some(
        (intent) => !tokens.includes(intent.token),
      );
      if (
        staleIncarnation &&
        taskIntents.some(
          (intent) =>
            !tokens.includes(intent.token) &&
            (intent.kind === "delegation"
              ? !scheduler.hasCancellationOwnerProof(intent)
              : !hasTodoPreparationCancellationProof(pi, intent)),
        )
      )
        return `TODO #${taskId} cancellation cannot be safely re-armed: ownership proof is unavailable.`;
      if (
        staleIncarnation &&
        (!["pending", "in_progress", "completed", "deleted"].includes(
          task.status,
        ) ||
          taskIntents.some((intent) => intent.attempts < 3))
      )
        return `TODO #${taskId} cancellation belongs to a stale incarnation.`;
      const intentTokens = [
        ...new Set(taskIntents.map((intent) => intent.token)),
      ];
      const rearmedPreparation = rearmTodoPreparationCancellations(
        pi,
        taskId,
        intentTokens,
      );
      const rearmedDelegation = scheduler.rearmCancellationIntents(
        taskId,
        intentTokens,
      );
      if (!rearmedPreparation && !rearmedDelegation)
        return `TODO #${taskId} has no exhausted cancellation to re-arm.`;
      scheduler.stateChanged(false);
      return `Re-armed cancellation for TODO #${taskId}; retrying now.`;
    },
  };
  const setPreparationContext = (
    ctx: Parameters<typeof startPreparation>[1],
  ) => {
    scheduler.setPreparationRequester((task, request) =>
      startPreparation(pi, ctx, request, task, todoAddHooks),
    );
  };
  registerTodoTool(pi, {
    jobs,
    onStateChanged: () => scheduler.stateChanged(),
    preparation: todoAddHooks,
    orchestrator: () => orchestratorSetting,
    lifecycle: {
      getGeneration: () => lifecycleGeneration,
      isActive: () => askUserSessionActive,
    },
    captureCompletionReviewScope: (task, fallbackCwd) => {
      const cwd = completionReviewCwd(task, fallbackCwd);
      return cwd
        ? captureCompletionReviewScope(cwd)
        : Promise.resolve(undefined);
    },
  });
  registerOrchestratorCommand(
    pi,
    () => orchestratorSetting,
    async (value) => {
      const nextSetting = globalOrchestratorEnabled ? value : "off";
      const state = getState();
      const offPlan =
        nextSetting === "off" ? scheduler.prepareOrchestratorOff() : undefined;
      const orchestrator =
        offPlan?.state.orchestrator ??
        (state.orchestrator?.sticky === undefined
          ? { setting: nextSetting }
          : { setting: nextSetting, sticky: state.orchestrator.sticky });
      const next = {
        ...(offPlan?.state ?? state),
        revision: state.revision + 1,
        orchestrator,
      };
      persistTodoSnapshot(pi, next, state);
      commitState(next);
      if (nextSetting === "off") {
        orchestratorSetting = "off";
        try {
          refreshAssignmentGate("off");
        } catch {
          unregisterAssignmentGate?.();
          unregisterAssignmentGate = undefined;
        }
        try {
          if (offPlan) scheduler.dispatchOrchestratorOff(offPlan);
        } catch {
          // The committed off mode and durable cancellation ledger remain
          // authoritative; dispatch is replayable recovery.
        }
        return;
      }
      try {
        refreshAssignmentGate(nextSetting);
        orchestratorSetting = nextSetting;
      } catch (error) {
        const current = getState();
        const rollback = {
          ...current,
          revision: current.revision + 1,
        };
        if (state.orchestrator === undefined)
          delete (rollback as { orchestrator?: unknown }).orchestrator;
        else rollback.orchestrator = { ...state.orchestrator };
        persistTodoSnapshot(pi, rollback, current);
        commitState(rollback);
        throw error;
      }
    },
  );
  registerTodoAddCommand(pi, todoAddHooks);
  registerTodosCommand(pi, todoAddHooks);

  pi.on("session_start", async (_event, ctx) => {
    askUserSessionActive = false;
    retireSessionToolCalls();
    const generation = ++lifecycleGeneration;
    rotateAskUserLifecycle();
    const schedulerHandoff = scheduler.captureCancellationHandoff();
    const preparationHandoff = captureTodoPreparationCancellationOwners(pi);
    const recoveryHandoff = mergeRecoveryOwners([
      ...failClosedRecoveryOwners,
      ...schedulerHandoff,
      ...preparationHandoff,
    ]);
    try {
      stopStateTelemetry?.();
      replaceState(replayWithoutAskUserCorrelations(replayFromBranch(ctx)));
      setPreparationContext(ctx);
      orchestratorSetting = replayedOrchestratorSetting(getState());
      if (!globalOrchestratorEnabled) {
        await scheduler.disableOrchestrator();
        if (generation !== lifecycleGeneration) {
          failClosedWithRecovery(recoveryHandoff);
          return;
        }
      }
      clearOrchestratorStatus();
      updateOrchestratorStatus = () => {
        if (ctx.mode !== "tui") return;
        const state = getState();
        ctx.ui.setStatus(
          "orchestrator",
          orchestratorFooterStatus(
            state.tasks,
            orchestratorSetting,
            state.orchestrator?.sticky,
          ),
        );
        ctx.ui.setStatus(
          "todo-completion-review",
          completionReviewFooterStatus(state.tasks),
        );
      };
      clearOrchestratorStatus = () => {
        if (ctx.mode !== "tui") return;
        ctx.ui.setStatus("orchestrator", undefined);
        ctx.ui.setStatus("todo-completion-review", undefined);
      };
      updateOrchestratorStatus();
      stopStateTelemetry = subscribeState((previous, next) => {
        updateOrchestratorStatus();
        const liveQueuedTokens = new Set(
          next.tasks.flatMap((task) => {
            const preparation = task.metadata?.preparation as
              { status?: unknown; token?: unknown } | undefined;
            return preparation?.status === "queued" &&
              typeof preparation.token === "string"
              ? [preparation.token]
              : [];
          }),
        );
        for (const token of queuedPreparationStarts)
          if (!liveQueuedTokens.has(token))
            queuedPreparationStarts.delete(token);
        for (const task of awakenedQueuedPreparations(
          previous.tasks,
          next.tasks,
        )) {
          const token = (task.metadata?.preparation as { token: string }).token;
          if (queuedPreparationStarts.has(token)) continue;
          queuedPreparationStarts.add(token);
          queueMicrotask(() => {
            const current = getState().tasks.find(
              (candidate) => candidate.id === task.id,
            );
            const preparation = current?.metadata?.preparation as
              { status?: unknown; token?: unknown } | undefined;
            if (
              !current ||
              preparation?.status !== "queued" ||
              preparation.token !== token
            )
              return;
            startPreparation(
              pi,
              ctx,
              current.description ?? current.subject,
              current,
              todoAddHooks,
              getAnalysisQueue(pi),
            );
          });
        }
        const prior = new Map(
          previous.tasks
            .filter((task) => task.status !== "deleted")
            .map((task) => [task.id, publicTodoState(task)]),
        );
        for (const task of next.tasks) {
          if (task.status === "deleted") {
            prior.delete(task.id);
            continue;
          }
          const status = publicTodoState(task);
          const previousStatus = prior.get(task.id);
          prior.delete(task.id);
          if (previousStatus === status) continue;
          emitTelemetry(pi.events, {
            type: "todo_state",
            status,
          });
        }
        scheduler.setCancellationRecoveryBlocked(
          next.cancellationCapacityError === CANCELLATION_CAPACITY_ERROR,
        );
        emitCancellationTransitions(previous, next);
      });
      for (const { status } of cancellationStates(getState()).values()) {
        emitTelemetry(pi.events, {
          type: "todo_cancellation",
          status,
        });
      }
      scheduler.setCancellationRecoveryBlocked(
        getState().cancellationCapacityError === CANCELLATION_CAPACITY_ERROR,
      );
      scheduler.activate(ctx);
      scheduler.adoptAbandonedCancellationOwners(recoveryHandoff);
      adoptTodoPreparationCancellationOwners(pi, recoveryHandoff);
      scheduler.retryAdoptedCancellationOwners();
      retryTodoPreparationCancellations(pi, recoveryHandoff);
      rebindOrchestratorRuntime();
      if (ctx.hasUI) {
        todoOverlay ??= new TodoOverlay(() =>
          scheduler.isContinuationPending(),
        );
        todoOverlay.setUICtx(ctx.ui);
        todoOverlay.resetCompletedDisplayState();
        todoOverlay.hideAllCompletedTasks();
      }
      askUserSessionActive = true;
    } catch (error) {
      failClosedWithRecovery(recoveryHandoff);
      if (!isStaleCtxError(error)) throw error;
    }
  });

  pi.on("session_compact", async (_event, ctx) => {
    askUserSessionActive = false;
    retireSessionToolCalls();
    lifecycleGeneration++;
    rotateAskUserLifecycle();
    const previous = getState();
    const schedulerHandoff = scheduler.captureCancellationHandoff();
    const preparationHandoff = captureTodoPreparationCancellationOwners(pi);
    const recoveryHandoff = mergeRecoveryOwners([
      ...failClosedRecoveryOwners,
      ...schedulerHandoff,
      ...preparationHandoff,
    ]);
    // Auto-compaction races session disposal: pi-core invalidates the
    // extension runner while still emitting session_compact, so `ctx` may be
    // a dead proxy whose getters throw the stale error. The compacting session
    // is being discarded — the replacement session's session_start replays
    // state — so keep current state on a stale ctx. Other errors are real
    // replay bugs and must propagate.
    try {
      let replayed = false;
      let replayedState = previous;
      replayedState = replayWithoutAskUserCorrelations(replayFromBranch(ctx));
      replaceState(replayedState);
      replayed = true;
      if (replayed) emitCancellationTransitions(previous, replayedState);
      if (replayed) {
        scheduler.setCancellationRecoveryBlocked(
          replayedState.cancellationCapacityError ===
            CANCELLATION_CAPACITY_ERROR,
        );
        setPreparationContext(ctx);
        scheduler.activate(ctx, false);
        const recoveryOwners = mergeRecoveryOwners([...recoveryHandoff]);
        scheduler.adoptAbandonedCancellationOwners(recoveryOwners);
        adoptTodoPreparationCancellationOwners(pi, recoveryOwners);
        scheduler.retryAdoptedCancellationOwners();
        retryTodoPreparationCancellations(pi, recoveryOwners);
        rebindOrchestratorRuntime();
        askUserSessionActive = true;
      }
      todoOverlay?.resetCompletedDisplayState();
      todoOverlay?.hideAllCompletedTasks();
    } catch (e) {
      failClosedWithRecovery(recoveryHandoff);
      if (!isStaleCtxError(e)) throw e;
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    askUserSessionActive = false;
    retireSessionToolCalls();
    lifecycleGeneration++;
    rotateAskUserLifecycle();
    const previous = getState();
    const abandonedOwners = mergeRecoveryOwners([
      ...failClosedRecoveryOwners,
      ...scheduler.captureAbandonedCancellationIntents(previous),
      ...captureTodoPreparationCancellationOwners(pi),
    ]);
    try {
      let replayed = false;
      let replayedState = previous;
      const branchState = replayFromBranch(ctx);
      const clearedBranchState = clearAskUserCorrelations(branchState);
      const ledger = mergeRecoveryLedger([
        ...(clearedBranchState.cancellationIntents ?? []),
        ...(clearedBranchState.cancellationOverflow ?? []),
        ...(clearedBranchState.cancellationQuarantine ?? []),
        ...abandonedOwners,
      ]);
      const capacityError = cancellationRecoveryError(
        ledger.intents.length,
        ledger.overflow.length,
        ledger.quarantine.length,
      );
      const merged =
        JSON.stringify(ledger.intents) ===
          JSON.stringify(clearedBranchState.cancellationIntents ?? []) &&
        JSON.stringify(ledger.overflow) ===
          JSON.stringify(clearedBranchState.cancellationOverflow ?? []) &&
        JSON.stringify(ledger.quarantine) ===
          JSON.stringify(clearedBranchState.cancellationQuarantine ?? []) &&
        capacityError === clearedBranchState.cancellationCapacityError &&
        clearedBranchState === branchState
          ? clearedBranchState
          : withCancellationLedger(
              {
                ...clearedBranchState,
                revision: clearedBranchState.revision + 1,
              },
              {
                intents: ledger.intents,
                overflow: ledger.overflow,
                quarantine: ledger.quarantine,
                capacityError,
              },
            );
      const migratedCompletionReview = merged.tasks.some((task) => {
        if (task.review?.token !== `legacy-completion-${String(task.id)}`)
          return false;
        return (
          previous.tasks.find((candidate) => candidate.id === task.id)?.review
            ?.token !== task.review.token
        );
      });
      if (merged !== branchState || migratedCompletionReview)
        persistTodoSnapshot(pi, merged, previous);
      replaceState(merged);
      replayedState = merged;
      replayed = true;
      if (replayed) emitCancellationTransitions(previous, replayedState);
      if (replayed)
        scheduler.setCancellationRecoveryBlocked(
          replayedState.cancellationCapacityError ===
            CANCELLATION_CAPACITY_ERROR,
        );
      if (replayed) {
        const recoveryQuarantined =
          replayedState.cancellationCapacityError ===
          CANCELLATION_CAPACITY_ERROR;
        setPreparationContext(ctx);
        scheduler.activate(ctx);
        if (
          recoveryQuarantined &&
          getState().cancellationCapacityError !== CANCELLATION_CAPACITY_ERROR
        ) {
          const restored = {
            ...getState(),
            cancellationCapacityError: CANCELLATION_CAPACITY_ERROR,
            revision: getState().revision + 1,
          };
          persistTodoSnapshot(pi, restored, getState());
          commitState(restored);
          replayedState = restored;
        }
      }
      if (replayed) {
        const recoveryOwners = mergeRecoveryOwners([...abandonedOwners]);
        scheduler.adoptAbandonedCancellationOwners(recoveryOwners);
        adoptTodoPreparationCancellationOwners(pi, recoveryOwners);
      }
      if (replayed) scheduler.retryAdoptedCancellationOwners();
      if (replayed) retryTodoPreparationCancellations(pi, abandonedOwners);
      if (replayed) {
        rebindOrchestratorRuntime();
        askUserSessionActive = true;
      }
      todoOverlay?.resetCompletedDisplayState();
      todoOverlay?.hideAllCompletedTasks();
    } catch (e) {
      failClosedWithRecovery(abandonedOwners);
      if (!isStaleCtxError(e)) throw e;
    }
  });

  pi.on("session_shutdown", async () => {
    askUserSessionActive = false;
    retireSessionToolCalls();
    lifecycleGeneration++;
    rotateAskUserLifecycle();
    const state = getState();
    const cleared = clearAskUserCorrelations(state);
    if (cleared !== state) {
      persistTodoSnapshot(pi, cleared, state);
      replaceState(cleared);
    }
    stopStateTelemetry?.();
    stopStateTelemetry = undefined;
    clearOrchestratorStatus();
    updateOrchestratorStatus = () => {};
    clearOrchestratorStatus = () => {};
    unregisterAssignmentGate?.();
    unregisterAssignmentGate = undefined;
    disposeTodoPreparationCancellations(pi);
    scheduler.dispose();
    jobs.dispose();
    todoOverlay?.dispose();
    todoOverlay = undefined;
  });

  // Reads getTodos() at render time; do NOT call replayFromBranch here
  // (branch is stale — message_end runs after tool_execution_end).
  pi.on("tool_execution_start", async (event) => {
    if (!askUserSessionActive) return;
    if (
      typeof event.toolCallId !== "string" ||
      !event.toolCallId.trim() ||
      typeof event.toolName !== "string" ||
      !event.toolName.trim()
    )
      return;
    if (
      retiredToolCallIds.has(event.toolCallId) ||
      retiredAskUserToolCallIds.has(event.toolCallId) ||
      forbiddenAskUserToolCallIds.has(event.toolCallId) ||
      sessionToolGenerations.has(event.toolCallId)
    )
      return;
    sessionToolGenerations.set(event.toolCallId, {
      generation: lifecycleGeneration,
      toolName: event.toolName,
    });
    if (event.toolName !== "ask_user") return;
    const question = (event as { args?: { question?: unknown } }).args
      ?.question;
    if (typeof question !== "string" || !question.trim()) return;
    const state = getState();
    const candidates = state.tasks.filter((task) => {
      return (
        task.status === "waiting:user" &&
        task.wait?.kind === "user" &&
        task.wait.questions.includes(question)
      );
    });
    if (candidates.length !== 1) return;
    const task = candidates[0];
    if (!task.wait || task.wait.kind !== "user") return;
    const existing = task.metadata?.askUserCorrelation as
      AskUserCorrelation | undefined;
    const existingPreparation = task.metadata?.preparation as
      { token?: unknown } | undefined;
    const existingTokenPresent = typeof existingPreparation?.token === "string";
    const existingReview = task.review;
    const currentQuestions = task.wait.questions;
    if (
      existing &&
      (!existing.retryable ||
        (existing.retryAttempts ?? 0) >= 3 ||
        existing.invokedQuestion !== question ||
        existing.taskId !== task.id ||
        existing.lifecycleNonce !== askUserLifecycleNonce ||
        existing.questions.length !== currentQuestions.length ||
        existing.questions.some(
          (candidate, index) => candidate !== currentQuestions[index],
        ) ||
        existing.preparationTokenPresent !== existingTokenPresent ||
        (existingTokenPresent &&
          existing.preparationToken !== existingPreparation?.token) ||
        (existing.kind === "completion-review" &&
          (existingReview?.status !== "rejected" ||
            existing.reviewGeneration !== existingReview.generation ||
            existing.reviewToken !== existingReview.token ||
            existing.reviewCompletionRevision !==
              existingReview.completionRevision ||
            existing.reviewRequestedAt !== existingReview.requestedAt ||
            existing.reviewFailedAtPresent !==
              Object.hasOwn(existingReview, "failedAt") ||
            (existing.reviewFailedAtPresent &&
              existing.reviewFailedAt !== existingReview.failedAt) ||
            existing.reviewAttempts !== existingReview.attempts ||
            existing.reviewFeedback !== (existingReview.feedback ?? ""))))
    )
      return;
    const completionQuestion = task.wait.questions.find((candidate) =>
      isCompletionReviewDecisionQuestion(candidate, task),
    );
    const completionReview =
      question === completionQuestion && task.review?.status === "rejected"
        ? task.review
        : undefined;
    const preparation = task.metadata?.preparation as
      | {
          token?: unknown;
        }
      | undefined;
    const correlation: AskUserCorrelation = {
      toolCallId: event.toolCallId,
      taskId: task.id,
      invokedQuestion: question,
      preparationTokenPresent: typeof preparation?.token === "string",
      ...(typeof preparation?.token === "string"
        ? { preparationToken: preparation.token }
        : {}),
      questions: [...task.wait.questions],
      kind: completionReview ? "completion-review" : "ordinary",
      lifecycleNonce: askUserLifecycleNonce,
      ...(existing ? { retryAttempts: (existing.retryAttempts ?? 0) + 1 } : {}),
      ...(completionReview
        ? {
            completionQuestion: question,
            reviewGeneration: completionReview.generation,
            reviewToken: completionReview.token,
            reviewCompletionRevision: completionReview.completionRevision,
            reviewRequestedAt: completionReview.requestedAt,
            reviewFailedAtPresent: Object.hasOwn(completionReview, "failedAt"),
            ...(completionReview.failedAt === undefined
              ? {}
              : { reviewFailedAt: completionReview.failedAt }),
            reviewAttempts: completionReview.attempts,
            reviewFeedback: completionReview.feedback ?? "",
          }
        : {}),
    };
    const next = {
      ...state,
      tasks: state.tasks.map((candidate) =>
        candidate.id === task.id
          ? {
              ...candidate,
              metadata: {
                ...candidate.metadata,
                askUserCorrelation: correlation,
              },
            }
          : candidate,
      ),
      revision: state.revision + 1,
    };
    persistTodoSnapshot(pi, next);
    commitState(next);
  });
  pi.on("tool_execution_end", async (event) => {
    if (!askUserSessionActive) return;
    if (typeof event.toolCallId !== "string" || !event.toolCallId.trim())
      return;
    const ownership = sessionToolGenerations.get(event.toolCallId);
    if (
      !ownership ||
      ownership.generation !== lifecycleGeneration ||
      ownership.toolName !== event.toolName
    )
      return;
    sessionToolGenerations.delete(event.toolCallId);
    if (ownership.toolName === "ask_user")
      retireAskUserToolCallId(event.toolCallId);
    else forbidAskUserToolCallId(event.toolCallId);
    if (event.toolName === "ask_user") {
      const details = askUserDetails(
        (event as { result?: { details?: unknown } }).result?.details,
      );
      const state = getState();
      const correlatedTasks = state.tasks.filter((task) => {
        const correlation = task.metadata?.askUserCorrelation as
          AskUserCorrelation | undefined;
        return Boolean(
          correlation &&
          correlation.toolCallId === event.toolCallId &&
          correlation.taskId === task.id &&
          correlation.lifecycleNonce === askUserLifecycleNonce,
        );
      });
      const candidates = details
        ? correlatedTasks.filter((task) => {
            const correlation = task.metadata
              ?.askUserCorrelation as AskUserCorrelation;
            if (correlation.invokedQuestion !== details.question) return false;
            if (
              task.status !== "waiting:user" ||
              task.wait?.kind !== "user" ||
              task.wait.questions.some(
                (question) => !correlation.questions.includes(question),
              ) ||
              !task.wait.questions.includes(details.question) ||
              !correlation.questions.includes(details.question)
            )
              return false;
            const preparation = task.metadata?.preparation as
              | {
                  token?: unknown;
                }
              | undefined;
            const currentToken =
              typeof preparation?.token === "string"
                ? preparation.token
                : undefined;
            const currentTokenPresent = typeof preparation?.token === "string";
            if (correlation.kind === "completion-review") {
              const review = task.review;
              const currentFailedAtPresent = Boolean(
                review && Object.hasOwn(review, "failedAt"),
              );
              return Boolean(
                review?.status === "rejected" &&
                correlation.completionQuestion ===
                  correlation.invokedQuestion &&
                isCompletionReviewDecisionQuestion(
                  correlation.invokedQuestion,
                  task,
                ) &&
                correlation.preparationTokenPresent === currentTokenPresent &&
                (!currentTokenPresent ||
                  correlation.preparationToken === currentToken) &&
                review.generation === correlation.reviewGeneration &&
                review.token === correlation.reviewToken &&
                review.completionRevision ===
                  correlation.reviewCompletionRevision &&
                review.requestedAt === correlation.reviewRequestedAt &&
                correlation.reviewFailedAtPresent === currentFailedAtPresent &&
                (!currentFailedAtPresent ||
                  review.failedAt === correlation.reviewFailedAt) &&
                review.attempts === correlation.reviewAttempts &&
                (review.feedback ?? "") === correlation.reviewFeedback,
              );
            }
            return (
              correlation.preparationTokenPresent === currentTokenPresent &&
              (!currentTokenPresent ||
                correlation.preparationToken === currentToken)
            );
          })
        : [];
      const target = candidates.length === 1 ? candidates[0] : undefined;
      const response =
        target &&
        details &&
        typeof details.answer === "string" &&
        !details.cancelled &&
        !details.explanationRequested
          ? ({
              taskId: target.id,
              todoToken: (
                target.metadata?.askUserCorrelation as AskUserCorrelation
              ).preparationToken,
              question: (
                target.metadata?.askUserCorrelation as AskUserCorrelation
              ).invokedQuestion,
              answer: details.answer,
              ...((target.metadata?.askUserCorrelation as AskUserCorrelation)
                .kind === "completion-review"
                ? {
                    reviewGeneration: (
                      target.metadata?.askUserCorrelation as AskUserCorrelation
                    ).reviewGeneration,
                    reviewToken: (
                      target.metadata?.askUserCorrelation as AskUserCorrelation
                    ).reviewToken,
                    reviewCompletionRevision: (
                      target.metadata?.askUserCorrelation as AskUserCorrelation
                    ).reviewCompletionRevision,
                    preparationTokenPresent: (
                      target.metadata?.askUserCorrelation as AskUserCorrelation
                    ).preparationTokenPresent,
                    completionQuestion: (
                      target.metadata?.askUserCorrelation as AskUserCorrelation
                    ).completionQuestion,
                    reviewRequestedAt: (
                      target.metadata?.askUserCorrelation as AskUserCorrelation
                    ).reviewRequestedAt,
                    reviewFailedAtPresent: (
                      target.metadata?.askUserCorrelation as AskUserCorrelation
                    ).reviewFailedAtPresent,
                    reviewFailedAt: (
                      target.metadata?.askUserCorrelation as AskUserCorrelation
                    ).reviewFailedAt,
                    reviewAttempts: (
                      target.metadata?.askUserCorrelation as AskUserCorrelation
                    ).reviewAttempts,
                    reviewFeedback: (
                      target.metadata?.askUserCorrelation as AskUserCorrelation
                    ).reviewFeedback,
                  }
                : {}),
            } satisfies UserWaitResponse)
          : undefined;
      if (response && !event.isError) {
        scheduler.recordToolProgress();
        scheduler.resumeAutomation(response);
        const correlation = target?.metadata?.askUserCorrelation as
          AskUserCorrelation | undefined;
        if (
          correlation &&
          !getState().tasks.some(
            (task) => task.metadata?.askUserCorrelation === correlation,
          )
        )
          scheduler.redispatchCompletionReviewDecision();
        return;
      }
      if (correlatedTasks.length > 0) {
        const retryable = {
          ...state,
          tasks: state.tasks.map((task) => {
            if (!correlatedTasks.includes(task)) return task;
            return {
              ...task,
              metadata: {
                ...task.metadata,
                askUserCorrelation: {
                  ...(task.metadata?.askUserCorrelation as AskUserCorrelation),
                  retryable: true,
                },
              },
            };
          }),
          revision: state.revision + 1,
        };
        persistTodoSnapshot(pi, retryable, state);
        commitState(retryable);
      }
      return;
    }
    if (event.isError) return;
    scheduler.recordToolProgress();
    if (event.toolName !== TOOL_NAME) return;
    todoOverlay?.update();
  });

  pi.on("input", async (event) => {
    if (!askUserSessionActive) return;
    if (event.source !== "interactive" && event.source !== "rpc") return;
    if (
      typeof event.text !== "string" ||
      event.text.trimStart().startsWith("/")
    )
      return;
    if (interruptsTodoAutomation(event.text)) {
      scheduler.interruptForUserWork();
      return;
    }
    // Ordinary input is new user work, not an answer to a durable question.
    // Only the correlated ask_user tool result may resolve waiting:user.
  });

  pi.on("agent_start", async () => {
    if (!askUserSessionActive) return;
    runAborted = false;
    runUsageLimited = false;
    scheduler.onAgentStart();
    todoOverlay?.hideCompletedTasksFromPreviousTurn();
    todoOverlay?.update();
  });

  pi.on("agent_end", async (event) => {
    if (!askUserSessionActive) return;
    for (let index = event.messages.length - 1; index >= 0; index--) {
      const message = event.messages[index] as {
        role?: string;
        stopReason?: string;
        errorMessage?: string;
      };
      if (message.role !== "assistant") continue;
      runAborted = message.stopReason === "aborted";
      runUsageLimited = isChatGptProUsageLimit(message.errorMessage);
      break;
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!askUserSessionActive) return;
    scheduler.onAgentSettled(ctx, runAborted, runUsageLimited);
    runAborted = false;
    runUsageLimited = false;
    todoOverlay?.hideAllCompletedTasks();
  });
}
