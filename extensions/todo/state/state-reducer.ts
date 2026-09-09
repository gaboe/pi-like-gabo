import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  Task,
  TaskAction,
  TaskMutationParams,
  TaskReview,
  TaskStatus,
} from "../tool/types.js";
import {
  MAX_TASK_ACTIVE_FORM_LENGTH,
  MAX_TASK_DESCRIPTION_LENGTH,
  MAX_TASK_OWNER_LENGTH,
  MAX_TASK_SUBJECT_LENGTH,
  MAX_BLOCKED_BY,
  MAX_WAIT_QUESTION_LENGTH,
  MAX_WAIT_JOB_COUNT,
  MAX_WAIT_JOB_ID_LENGTH,
  isCanonicalArray,
  isTaskReviewScope,
  isBoundedMetadata,
  sanitizeMetadata,
} from "../tool/types.js";
import {
  COMPLETION_REVIEW_MODEL,
  COMPLETION_REVIEWER_ID,
  isTaskArchivable,
  MAX_COMPLETION_REVIEW_ATTEMPTS,
} from "./completion.js";
import {
  challengeVerificationFinding,
  materialOverlapDecision,
  mergeDuplicateItems,
  propagatePrerequisiteFailure,
  recordVerificationExchange,
  recoverInternalVerificationFailure,
} from "./inbox.js";
import { isTransitionValid } from "./invariants.js";
import {
  isPersistableTaskState,
  pruneTodoStateForPersistence,
} from "./replay.js";
import type { TaskState } from "./state.js";
import { detectCycle } from "./task-graph.js";
import { redactTodoText, redactTodoValue } from "./redaction.js";

/**
 * Reducer outcome. Closed tagged union — adding a new action requires extending
 * this union AND the response-envelope's `formatContent` switch (compiler-
 * enforced exhaustive). Mirrors the `Effect` pattern in
 * `packages/rpiv-ask-user-question/state/state-reducer.ts:14-30`.
 *
 * `error` carries the message in-band so callers can pattern-match on
 * `op.kind === "error"` without a side-channel boolean.
 */
export type Op =
  | { kind: "create"; taskId: number }
  | { kind: "update"; id: number; fromStatus: TaskStatus; toStatus: TaskStatus }
  | { kind: "merge"; executionOwnerId: number; duplicateId: number }
  | { kind: "challenge"; id: number }
  | { kind: "delete"; id: number; subject: string }
  | { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean }
  | { kind: "get"; task: Task }
  | { kind: "clear"; count: number }
  | { kind: "error"; message: string };

export interface ApplyResult {
  state: TaskState;
  op: Op;
}

export const MIN_JOB_TIMEOUT_SECONDS = 1;
export const MAX_JOB_TIMEOUT_SECONDS = 86_400;

function nextRevision(state: TaskState): number {
  return (state.revision ?? 0) + 1;
}

function normalizeQuestions(value: string[] | undefined): string[] | undefined {
  if (!value || !isCanonicalArray(value, 8) || value.length < 1)
    return undefined;
  const questions = value.map((question) => question.trim());
  return questions.every(Boolean) &&
    questions.every(
      (question) => question.length <= MAX_WAIT_QUESTION_LENGTH,
    ) &&
    new Set(questions).size === questions.length
    ? questions
    : undefined;
}

function normalizeCompletion(
  params: TaskMutationParams,
): { result: string; evidence: string[] } | undefined {
  if (
    typeof params.result !== "string" ||
    !isCanonicalArray(params.evidence, 8) ||
    params.evidence.length < 1 ||
    params.evidence.length > 8
  )
    return undefined;
  const result = params.result.trim();
  const evidence = params.evidence.map((entry) =>
    typeof entry === "string" ? entry.trim() : "",
  );
  return result && evidence.every(Boolean) ? { result, evidence } : undefined;
}

function errorResult(state: TaskState, message: string): ApplyResult {
  return { state, op: { kind: "error", message } };
}

function taskInputError(
  params: TaskMutationParams,
  allowReservedMetadata = false,
): string | undefined {
  if (!allowReservedMetadata) {
    const reservedMetadataKey = Object.keys(params.metadata ?? {}).find((key) =>
      [
        "inbox",
        "verification",
        "preparation",
        "orchestrator",
        "delegation",
      ].includes(key),
    );
    if (reservedMetadataKey)
      return `metadata.${reservedMetadataKey} is reserved for lifecycle state`;
  }
  const fields = [
    ["subject", params.subject, MAX_TASK_SUBJECT_LENGTH],
    ["description", params.description, MAX_TASK_DESCRIPTION_LENGTH],
    ["activeForm", params.activeForm, MAX_TASK_ACTIVE_FORM_LENGTH],
    ["owner", params.owner, MAX_TASK_OWNER_LENGTH],
  ] as const;
  for (const [name, value, maxLength] of fields) {
    if (value !== undefined && value.length > maxLength)
      return `${name} exceeds the ${maxLength}-character limit`;
  }
  if (
    params.metadata !== undefined &&
    (!isBoundedMetadata(params.metadata) ||
      !isDeepStrictEqual(sanitizeMetadata(params.metadata), params.metadata))
  )
    return "metadata exceeds the bounded replay limit";
  for (const [name, value] of [
    ["blockedBy", params.blockedBy],
    ["addBlockedBy", params.addBlockedBy],
    ["removeBlockedBy", params.removeBlockedBy],
  ] as const) {
    if (value === undefined) continue;
    if (
      !isCanonicalArray(value, MAX_BLOCKED_BY) ||
      value.length > MAX_BLOCKED_BY ||
      new Set(value).size !== value.length ||
      value.some((id) => !Number.isSafeInteger(id) || id <= 0)
    )
      return `${name} exceeds the bounded dependency list or contains invalid/duplicate ids`;
  }
  if (
    params.jobIds !== undefined &&
    (!isCanonicalArray(params.jobIds, MAX_WAIT_JOB_COUNT) ||
      params.jobIds.length === 0 ||
      params.jobIds.some(
        (id) =>
          typeof id !== "string" ||
          id.length === 0 ||
          id.length > MAX_WAIT_JOB_ID_LENGTH ||
          id !== id.trim(),
      ) ||
      new Set(params.jobIds).size !== params.jobIds.length)
  )
    return "jobIds exceeds the bounded job list or contains invalid/duplicate ids";
  return undefined;
}

function metadataBoundsError(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  return metadata === undefined || isBoundedMetadata(metadata)
    ? undefined
    : "metadata exceeds the bounded replay limit";
}

function hasTaskCancellationIntent(state: TaskState, taskId: number): boolean {
  return [
    ...(state.cancellationIntents ?? []),
    ...(state.cancellationOverflow ?? []),
    ...(state.cancellationQuarantine ?? []),
  ].some((intent) => intent.taskId === taskId);
}

function isTaskArchivableInState(state: TaskState, task: Task): boolean {
  return isTaskArchivable(task, {
    hasCancellationIntent: hasTaskCancellationIntent(state, task.id),
  });
}

function isLegacyReviewRemediable(state: TaskState, task: Task): boolean {
  const feedback = task.review?.feedback ?? "";
  const operationalFailure =
    feedback.startsWith(
      "Completion review blocked: bounded review overlay is incomplete (",
    ) ||
    (feedback.startsWith(
      "Completion review blocked: workspace changed during the coherent snapshot;",
    ) &&
      feedback.includes("Automatic completion-review retries exhausted;"));
  if (
    task.review?.status !== "rejected" ||
    !operationalFailure ||
    !task.result?.trim() ||
    !task.evidence?.some((entry) => entry.trim())
  )
    return false;
  return isTaskArchivableInState(state, {
    ...task,
    status: "completed",
    review: { ...task.review, status: "approved" },
  });
}

function boundedMutationState(state: TaskState): TaskState | undefined {
  const propagatedTasks = propagatePrerequisiteFailure(state.tasks);
  const propagated = propagatedTasks.some(
    (task, index) => task !== state.tasks[index],
  )
    ? { ...state, tasks: propagatedTasks }
    : state;
  const bounded = pruneTodoStateForPersistence(propagated);
  return bounded && isPersistableTaskState(bounded) ? bounded : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const NON_SEMANTIC_METADATA_KEYS = new Set(["completionReviewBaseline"]);

function scopeChanged(
  current: Task,
  updated: Task,
  params: TaskMutationParams,
): boolean {
  if (params.subject !== undefined && current.subject !== updated.subject)
    return true;
  if (
    params.description !== undefined &&
    current.description !== updated.description
  )
    return true;
  const dependencies = (task: Task) =>
    [...new Set(task.blockedBy ?? [])].sort((a, b) => a - b);
  if (!isDeepStrictEqual(dependencies(current), dependencies(updated)))
    return true;
  if (!params.metadata) return false;
  return Object.keys(params.metadata).some(
    (key) =>
      !NON_SEMANTIC_METADATA_KEYS.has(key) &&
      !isDeepStrictEqual(current.metadata?.[key], updated.metadata?.[key]),
  );
}

function rotateIncarnation(
  state: TaskState,
  current: Task,
  updated: Task,
  createToken: () => string,
): void {
  const previous = record(current.metadata?.preparation);
  const metadata = { ...updated.metadata };
  metadata.preparation = {
    status: "queued",
    version: typeof previous?.version === "number" ? previous.version + 1 : 1,
    token: createToken(),
    sourceRevision: nextRevision(state),
  };
  delete metadata.delegation;
  delete metadata.verification;
  updated.metadata = metadata;
}

export interface CompletionReviewIdentity {
  taskId: number;
  generation: number;
  token: string;
  completionRevision: number;
}

function matchingPendingReview(
  task: Task | undefined,
  identity: CompletionReviewIdentity,
): task is Task & { review: TaskReview } {
  return Boolean(
    task?.review?.status === "pending" &&
    task.id === identity.taskId &&
    task.review.generation === identity.generation &&
    task.review.token === identity.token &&
    task.review.completionRevision === identity.completionRevision,
  );
}

function replaceTask(state: TaskState, task: Task): TaskState {
  const candidate = {
    ...state,
    tasks: state.tasks.map((candidate) =>
      candidate.id === task.id ? task : candidate,
    ),
    revision: nextRevision(state),
  };
  return isPersistableTaskState(candidate) ? candidate : state;
}

/** Atomically claim one persisted pending review before starting its worker. */
export function claimCompletionReview(
  state: TaskState,
  identity: CompletionReviewIdentity,
  dispatchedAt = Date.now(),
  inputDigest?: string,
): TaskState {
  const task = state.tasks.find(
    (candidate) => candidate.id === identity.taskId,
  );
  if (
    !matchingPendingReview(task, identity) ||
    task.review.dispatchedAt !== undefined
  )
    return state;
  return replaceTask(state, {
    ...task,
    review: {
      ...task.review,
      dispatchedAt,
      ...(inputDigest ? { inputDigest } : {}),
    },
  });
}

export function settleCompletionReview(
  state: TaskState,
  identity: CompletionReviewIdentity,
  result: {
    decision: "approved" | "rejected";
    feedback: string;
    reviewerId: string;
    model: string;
    reviewedAt?: number;
  },
): TaskState {
  const task = state.tasks.find(
    (candidate) => candidate.id === identity.taskId,
  );
  if (!matchingPendingReview(task, identity)) return state;
  const feedback = result.feedback.trim().slice(0, 4_000);
  const rejected = result.decision === "rejected";
  const updated = {
    ...task,
    status: rejected ? "pending" : task.status,
    review: {
      ...task.review,
      status: result.decision,
      reviewedAt: result.reviewedAt ?? Date.now(),
      reviewer: {
        id: result.reviewerId ?? task.review.reviewer.id,
        model: result.model ?? task.review.reviewer.model,
      },
      feedback,
    },
  };
  if (rejected) delete updated.wait;
  const reviewed = recordVerificationExchange(updated as Task, {
    decision: rejected ? "needs-fix" : "approved",
    finding: feedback,
    evidence: task.evidence ?? [],
    rationale: "independent completion review",
  });
  if (reviewed === updated)
    return failCompletionReview(
      state,
      identity,
      "Completion review audit exchange could not be persisted",
      result.reviewedAt,
    );
  const settled = replaceTask(state, reviewed);
  if (rejected || !reviewed.result || !reviewed.evidence?.length)
    return settled;
  const duplicateIds = settled.tasks
    .filter((candidate) => candidate.mergedInto === reviewed.id)
    .map((candidate) => candidate.id);
  if (!duplicateIds.length) return settled;
  const tasks = settled.tasks.map((candidate) => {
    if (!duplicateIds.includes(candidate.id)) return candidate;
    const duplicate = {
      ...candidate,
      status: "completed" as const,
      result: reviewed.result,
      evidence: [...(reviewed.evidence ?? [])],
      review: { ...reviewed.review! },
    };
    delete duplicate.wait;
    return duplicate;
  });
  const propagated = boundedMutationState({
    ...settled,
    tasks,
    revision: nextRevision(settled),
  });
  return propagated ?? settled;
}

export function failCompletionReview(
  state: TaskState,
  identity: CompletionReviewIdentity,
  feedback: string,
  failedAt = Date.now(),
): TaskState {
  const task = state.tasks.find(
    (candidate) => candidate.id === identity.taskId,
  );
  if (!matchingPendingReview(task, identity)) return state;
  const attempts = (task.review.attempts ?? 0) + 1;
  const exhausted = attempts >= MAX_COMPLETION_REVIEW_ATTEMPTS;
  const retryPolicy =
    "Automatic completion-review retries exhausted; explicitly recomplete with changed evidence after remediation.";
  const redactedFailure = redactTodoText(feedback).trim().slice(0, 3_500);
  const review: TaskReview = {
    ...task.review,
    generation: task.review.generation + 1,
    token: randomUUID(),
    failedAt,
    attempts,
    feedback: exhausted
      ? `${redactedFailure}\n${retryPolicy}`.slice(0, 4_000)
      : redactedFailure.slice(0, 4_000),
  };
  delete review.dispatchedAt;
  if (exhausted) review.status = "rejected";
  const failedTask: Task = {
    ...task,
    status: exhausted ? "in_progress" : task.status,
    review,
  };
  return replaceTask(
    state,
    exhausted
      ? recoverInternalVerificationFailure(failedTask, review.feedback ?? "")
      : failedTask,
  );
}

/**
 * Pure reducer: (state, action, params) → (state, op). Mirrors the
 * `applyTaskMutation` of pre-refactor `todo.ts` minus content/details
 * formatting; the response envelope (`tool/response-envelope.ts`) owns
 * formatting, the store (`state/store.ts`) owns commit.
 *
 * Validation is in-line: structural guards (`subject required`, `id required`,
 * `at least one mutable field`) plus state-aware checks (transition legality,
 * dangling/deleted blockedBy, self-block, cycles). Decision: validation stays
 * in-reducer — see Plan §Decisions §Decision 2.
 */
export function applyTaskMutation(
  state: TaskState,
  action: TaskAction,
  params: TaskMutationParams,
  now = Date.now(),
  createToken = randomUUID,
): ApplyResult {
  switch (action) {
    case "create": {
      const inputError = taskInputError(params, true);
      if (inputError) return errorResult(state, inputError);
      if (params.result !== undefined || params.evidence !== undefined) {
        return errorResult(
          state,
          "result and evidence require status completed",
        );
      }
      if (!params.subject?.trim()) {
        return errorResult(state, "subject required for create");
      }
      if (params.blockedBy?.length) {
        for (const dep of params.blockedBy) {
          const depTask = state.tasks.find((t) => t.id === dep);
          if (!depTask)
            return errorResult(state, `blockedBy: #${dep} not found`);
          if (depTask.status === "deleted")
            return errorResult(state, `blockedBy: #${dep} is deleted`);
        }
      }
      const newTask: Task = {
        id: state.nextId,
        subject: redactTodoText(params.subject),
        status: "pending",
      };
      if (params.description)
        newTask.description = redactTodoText(params.description);
      if (params.activeForm)
        newTask.activeForm = redactTodoText(params.activeForm);
      if (params.blockedBy?.length) newTask.blockedBy = [...params.blockedBy];
      if (params.owner) newTask.owner = redactTodoText(params.owner);
      const metadata = redactTodoValue(params.metadata ?? {}) as Record<
        string,
        unknown
      >;
      delete metadata.preparation;
      delete metadata.orchestrator;
      delete metadata.delegation;
      delete metadata.inbox;
      delete metadata.verification;
      if (params.prepare !== false)
        metadata.preparation = {
          status: "queued",
          version: 1,
          token: createToken(),
          sourceRevision: nextRevision(state),
        };
      if (Object.keys(metadata).length) newTask.metadata = metadata;
      const metadataError = metadataBoundsError(newTask.metadata);
      if (metadataError) return errorResult(state, metadataError);

      const newTasks = [...state.tasks, newTask];
      const bounded = boundedMutationState({
        ...state,
        tasks: newTasks,
        nextId: state.nextId + 1,
        revision: nextRevision(state),
      });
      if (!bounded)
        return errorResult(
          state,
          "TODO persistence capacity reached; resolve or clear terminal TODOs before creating more work",
        );
      return {
        state: bounded,
        op: { kind: "create", taskId: newTask.id },
      };
    }

    case "update": {
      const inputError = taskInputError(params);
      if (inputError) return errorResult(state, inputError);
      if (params.id === undefined)
        return errorResult(state, "id required for update");
      const idx = state.tasks.findIndex((t) => t.id === params.id);
      if (idx === -1) return errorResult(state, `#${params.id} not found`);
      const current = state.tasks[idx];
      if (current.status === "deleted")
        return errorResult(state, `#${current.id} is archived and immutable`);
      if (current.mergedInto !== undefined)
        return errorResult(
          state,
          `#${current.id} is merged into #${current.mergedInto} and cannot be updated independently`,
        );
      if (
        current.status === "completed" &&
        (params.result !== undefined || params.evidence !== undefined)
      )
        return errorResult(
          state,
          "result and evidence cannot be edited after completion; rescope and recomplete the task",
        );

      const hasMutation =
        params.subject !== undefined ||
        params.description !== undefined ||
        params.activeForm !== undefined ||
        params.status !== undefined ||
        params.result !== undefined ||
        params.evidence !== undefined ||
        params.owner !== undefined ||
        params.metadata !== undefined ||
        params.questions !== undefined ||
        params.jobIds !== undefined ||
        params.jobMode !== undefined ||
        params.timeoutSeconds !== undefined ||
        (params.addBlockedBy && params.addBlockedBy.length > 0) ||
        (params.removeBlockedBy && params.removeBlockedBy.length > 0);
      if (!hasMutation)
        return errorResult(state, "update requires at least one mutable field");

      let newStatus = current.status;
      if (params.status !== undefined) {
        if (params.status === "deleted")
          return errorResult(state, "use delete to archive a completed task");
        if (!isTransitionValid(current.status, params.status)) {
          return errorResult(
            state,
            `illegal transition ${current.status} → ${params.status}`,
          );
        }
        if (params.status === "completed" && current.wait?.kind === "jobs") {
          return errorResult(
            state,
            "cannot complete while a jobs wait remains active",
          );
        }
        newStatus = params.status;
      }

      const completing =
        current.status !== "completed" && newStatus === "completed";
      if (
        newStatus !== "completed" &&
        (params.result !== undefined || params.evidence !== undefined)
      ) {
        return errorResult(
          state,
          "result and evidence require status completed",
        );
      }
      const completion = completing ? normalizeCompletion(params) : undefined;
      if (completing && !completion) {
        if (typeof params.result !== "string" || !params.result.trim())
          return errorResult(state, "completed requires a non-empty result");
        return errorResult(
          state,
          "completed requires at least one non-empty evidence entry",
        );
      }
      const verification = current.metadata?.verification as
        { challenge?: unknown; state?: unknown } | undefined;
      if (
        completion &&
        current.review?.status === "rejected" &&
        verification?.challenge === undefined &&
        completion.result === current.result &&
        isDeepStrictEqual(completion.evidence, current.evidence)
      ) {
        return errorResult(
          state,
          `completion evidence is unchanged since review rejection: ${current.review.feedback ?? "reviewer requested remediation"}`,
        );
      }

      let wait = current.wait;
      if (newStatus === "waiting:user") {
        const questions = normalizeQuestions(
          params.questions ??
            (wait?.kind === "user" ? wait.questions : undefined),
        );
        if (!questions)
          return errorResult(
            state,
            "waiting:user requires 1-8 unique non-empty questions",
          );
        wait = { kind: "user", questions };
      } else if (newStatus === "waiting:jobs") {
        const previous = wait?.kind === "jobs" ? wait : undefined;
        const reconfigure =
          !previous ||
          params.jobIds !== undefined ||
          params.jobMode !== undefined ||
          params.timeoutSeconds !== undefined;
        if (!reconfigure) {
          wait = previous;
        } else {
          const jobIds = params.jobIds ?? previous?.jobIds;
          const mode = params.jobMode ?? previous?.mode;
          const timeoutSeconds = params.timeoutSeconds;
          if (
            !jobIds?.length ||
            new Set(jobIds).size !== jobIds.length ||
            jobIds.some((id) => !id.trim())
          ) {
            return errorResult(
              state,
              "waiting:jobs requires unique non-empty jobIds",
            );
          }
          if (!mode)
            return errorResult(
              state,
              "waiting:jobs requires jobMode all or any",
            );
          if (
            timeoutSeconds === undefined ||
            !Number.isInteger(timeoutSeconds) ||
            timeoutSeconds < MIN_JOB_TIMEOUT_SECONDS ||
            timeoutSeconds > MAX_JOB_TIMEOUT_SECONDS
          ) {
            return errorResult(
              state,
              `waiting:jobs requires timeoutSeconds ${MIN_JOB_TIMEOUT_SECONDS}-${MAX_JOB_TIMEOUT_SECONDS}`,
            );
          }
          wait = {
            kind: "jobs",
            jobIds: [...jobIds],
            mode,
            deadline: now + timeoutSeconds * 1000,
            settled: {},
            waitToken: createToken(),
            registeredAt: now,
            generation: (previous?.generation ?? 0) + 1,
          };
        }
      } else {
        if (
          params.questions ||
          params.jobIds ||
          params.jobMode ||
          params.timeoutSeconds !== undefined
        ) {
          return errorResult(
            state,
            "wait fields require status waiting:user or waiting:jobs",
          );
        }
        wait = undefined;
      }

      let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
      if (params.removeBlockedBy?.length) {
        const toRemove = new Set(params.removeBlockedBy);
        newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
      }
      if (params.addBlockedBy?.length) {
        for (const dep of params.addBlockedBy) {
          if (dep === current.id)
            return errorResult(state, `cannot block #${current.id} on itself`);
          const depTask = state.tasks.find((t) => t.id === dep);
          if (!depTask)
            return errorResult(state, `addBlockedBy: #${dep} not found`);
          if (depTask.status === "deleted")
            return errorResult(state, `addBlockedBy: #${dep} is deleted`);
          if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
        }
        if (detectCycle(state.tasks, current.id, newBlockedBy)) {
          return errorResult(
            state,
            "addBlockedBy would create a cycle in the blockedBy graph",
          );
        }
      }

      let newMetadata = current.metadata;
      if (params.metadata !== undefined) {
        const merged: Record<string, unknown> = { ...(current.metadata ?? {}) };
        for (const [k, v] of Object.entries(params.metadata)) {
          if (v === null) delete merged[k];
          else merged[k] = redactTodoValue(v);
        }
        newMetadata = Object.keys(merged).length ? merged : undefined;
      }
      const supersedesFailedVerification =
        completion !== undefined && verification?.state === "failed";
      if (supersedesFailedVerification) {
        const { verification: _verification, ...metadata } = newMetadata ?? {};
        newMetadata = Object.keys(metadata).length ? metadata : undefined;
      }
      const preparation = newMetadata?.preparation;
      if (
        completing &&
        preparation &&
        typeof preparation === "object" &&
        ["classifying", "queued", "running"].includes(
          String((preparation as Record<string, unknown>).status),
        )
      ) {
        newMetadata = {
          ...newMetadata,
          preparation: {
            ...(preparation as Record<string, unknown>),
            status: "cancelled",
            activeWorkerIds: [],
          },
        };
      }

      const reviewScope = isTaskReviewScope(
        newMetadata?.completionReviewBaseline,
      )
        ? newMetadata.completionReviewBaseline
        : undefined;
      if (
        completion &&
        newMetadata &&
        Object.hasOwn(newMetadata, "completionReviewBaseline")
      ) {
        const { completionReviewBaseline: _baseline, ...remaining } =
          newMetadata;
        newMetadata = Object.keys(remaining).length ? remaining : undefined;
      }

      const updated: Task = { ...current, status: newStatus };
      if (params.subject !== undefined)
        updated.subject = redactTodoText(params.subject);
      if (params.description !== undefined)
        updated.description = redactTodoText(params.description);
      if (params.activeForm !== undefined)
        updated.activeForm = redactTodoText(params.activeForm);
      if (params.owner !== undefined)
        updated.owner = redactTodoText(params.owner);
      if (newBlockedBy.length) updated.blockedBy = newBlockedBy;
      else delete updated.blockedBy;
      if (newMetadata === undefined) delete updated.metadata;
      else updated.metadata = newMetadata;
      if (wait) updated.wait = wait;
      else delete updated.wait;
      if (completion) {
        const completionRevision = nextRevision(state);
        updated.result = redactTodoText(completion.result);
        updated.evidence = completion.evidence.map(redactTodoText);
        updated.review = {
          status: "pending",
          generation: (current.review?.generation ?? 0) + 1,
          token: createToken(),
          completionRevision,
          requestedAt: now,
          ...(reviewScope ? { scope: reviewScope } : {}),
          reviewer: {
            id: COMPLETION_REVIEWER_ID,
            model: COMPLETION_REVIEW_MODEL,
          },
        };
      } else if (
        newStatus !== "completed" &&
        current.review?.status !== "rejected"
      ) {
        delete updated.result;
        delete updated.evidence;
      }
      if (newStatus === "waiting:user" || newStatus === "waiting:jobs")
        delete updated.waitEvidence;
      if (scopeChanged(current, updated, params)) {
        rotateIncarnation(state, current, updated, createToken);
        if (
          !completion &&
          updated.status === "completed" &&
          (updated.review?.status === "pending" ||
            updated.review?.status === "approved")
        ) {
          updated.status = "pending";
          delete updated.result;
          delete updated.evidence;
          delete updated.review;
        }
      }

      const metadataError = metadataBoundsError(updated.metadata);
      if (metadataError) return errorResult(state, metadataError);

      if (isDeepStrictEqual(updated, current)) {
        return {
          state,
          op: {
            kind: "update",
            id: current.id,
            fromStatus: current.status,
            toStatus: current.status,
          },
        };
      }
      const newTasks = [...state.tasks];
      newTasks[idx] = updated;
      const bounded = boundedMutationState({
        ...state,
        tasks: newTasks,
        revision: nextRevision(state),
      });
      if (!bounded)
        return errorResult(
          state,
          "TODO state exceeds the bounded replay schema; update was rejected",
        );
      return {
        state: bounded,
        op: {
          kind: "update",
          id: updated.id,
          fromStatus: current.status,
          toStatus: updated.status,
        },
      };
    }

    case "merge": {
      if (params.id === undefined)
        return errorResult(state, "id required for merge");
      if (params.duplicateId === undefined)
        return errorResult(state, "duplicateId required for merge");
      const owner = state.tasks.find((task) => task.id === params.id);
      const duplicate = state.tasks.find(
        (task) => task.id === params.duplicateId,
      );
      if (!owner) return errorResult(state, `#${params.id} not found`);
      if (!duplicate)
        return errorResult(state, `#${params.duplicateId} not found`);
      if (owner.id === duplicate.id)
        return errorResult(state, "cannot merge a task into itself");
      if (owner.status === "deleted" || duplicate.status === "deleted")
        return errorResult(state, "cannot merge deleted tasks");
      if (owner.mergedInto !== undefined)
        return errorResult(
          state,
          `execution owner #${owner.id} is already merged`,
        );
      if (duplicate.mergedInto !== undefined)
        return errorResult(
          state,
          `#${duplicate.id} is already merged into #${duplicate.mergedInto}`,
        );
      if (duplicate.status !== "pending" || duplicate.wait)
        return errorResult(
          state,
          "duplicate must be pending without an active wait before merge",
        );
      const preparation = duplicate.metadata?.preparation as
        { status?: unknown; activeWorkerIds?: unknown } | undefined;
      const delegation = duplicate.metadata?.delegation as
        | { status?: unknown; workerId?: unknown; workerIds?: unknown }
        | undefined;
      const hasActivePreparation =
        ["classifying", "queued", "running"].includes(
          String(preparation?.status),
        ) ||
        (Array.isArray(preparation?.activeWorkerIds) &&
          preparation.activeWorkerIds.length > 0);
      const hasActiveDelegation =
        ["running", "cancelling", "interrupted"].includes(
          String(delegation?.status),
        ) ||
        typeof delegation?.workerId === "string" ||
        (Array.isArray(delegation?.workerIds) &&
          delegation.workerIds.length > 0);
      if (hasActivePreparation || hasActiveDelegation)
        return errorResult(
          state,
          "duplicate has active preparation or delegation ownership",
        );
      if (
        owner.status === "completed" &&
        owner.review?.status !== "pending" &&
        owner.review?.status !== "approved"
      )
        return errorResult(
          state,
          "completed execution owner requires a pending or approved review",
        );
      const overlapDecision = materialOverlapDecision(owner, duplicate);
      if (!overlapDecision)
        return errorResult(
          state,
          "merge requires host-validated overlap in requested result and scope",
        );
      const ownerApproved =
        owner.status === "completed" &&
        owner.review?.status === "approved" &&
        typeof owner.result === "string" &&
        owner.result.length > 0 &&
        Array.isArray(owner.evidence) &&
        owner.evidence.length > 0;
      const merged = mergeDuplicateItems(
        state.tasks,
        owner.id,
        duplicate.id,
        ownerApproved
          ? { result: owner.result!, evidence: owner.evidence! }
          : undefined,
        overlapDecision,
      );
      const mergedTasks = ownerApproved
        ? merged.items.map((task) =>
            task.id === duplicate.id
              ? {
                  ...task,
                  status: "completed" as const,
                  review: { ...owner.review! },
                }
              : task,
          )
        : merged.items;
      const bounded = boundedMutationState({
        ...state,
        tasks: mergedTasks,
        revision: nextRevision(state),
      });
      if (!bounded)
        return errorResult(
          state,
          "TODO state exceeds the bounded replay schema; merge was rejected",
        );
      return {
        state: bounded,
        op: {
          kind: "merge",
          executionOwnerId: owner.id,
          duplicateId: duplicate.id,
        },
      };
    }

    case "challenge": {
      if (params.id === undefined)
        return errorResult(state, "id required for challenge");
      const current = state.tasks.find((task) => task.id === params.id);
      if (!current) return errorResult(state, `#${params.id} not found`);
      if (!params.decision || !params.rationale?.trim())
        return errorResult(state, "challenge requires decision and rationale");
      const challenged = challengeVerificationFinding(current, {
        decision: params.decision,
        evidence: params.challengeEvidence,
        rationale: params.rationale,
      });
      if (challenged === current)
        return errorResult(
          state,
          "challenge requires an unresolved finding and persuasive evidence",
        );
      const bounded = boundedMutationState({
        ...state,
        tasks: state.tasks.map((task) =>
          task.id === current.id ? challenged : task,
        ),
        revision: nextRevision(state),
      });
      if (!bounded)
        return errorResult(
          state,
          "TODO state exceeds the bounded replay schema; challenge was rejected",
        );
      return { state: bounded, op: { kind: "challenge", id: current.id } };
    }

    case "list": {
      return {
        state,
        op: {
          kind: "list",
          includeDeleted: params.includeDeleted === true,
          ...(params.status !== undefined
            ? { statusFilter: params.status }
            : {}),
        },
      };
    }

    case "get": {
      if (params.id === undefined)
        return errorResult(state, "id required for get");
      const task = state.tasks.find((t) => t.id === params.id);
      if (!task) return errorResult(state, `#${params.id} not found`);
      return { state, op: { kind: "get", task } };
    }

    case "delete": {
      if (params.id === undefined)
        return errorResult(state, "id required for delete");
      const idx = state.tasks.findIndex((t) => t.id === params.id);
      if (idx === -1) return errorResult(state, `#${params.id} not found`);
      const current = state.tasks[idx];
      if (current.status === "deleted")
        return errorResult(state, `#${current.id} is already deleted`);
      if (!isTaskArchivableInState(state, current)) {
        return errorResult(
          state,
          `cannot delete unresolved #${current.id}; complete it with result, evidence, and approved review first`,
        );
      }
      const unresolvedDuplicates = state.tasks.filter(
        (task) =>
          task.mergedInto === current.id &&
          task.status !== "deleted" &&
          !isTaskArchivableInState(state, task),
      );
      if (unresolvedDuplicates.length)
        return errorResult(
          state,
          `cannot delete execution owner #${current.id}; unresolved duplicates: ${unresolvedDuplicates.map((task) => `#${task.id}`).join(", ")}`,
        );
      const updated: Task = { ...current, status: "deleted" };
      delete updated.wait;
      const newTasks = [...state.tasks];
      newTasks[idx] = updated;
      const bounded = boundedMutationState({
        ...state,
        tasks: newTasks,
        revision: nextRevision(state),
      });
      if (!bounded)
        return errorResult(
          state,
          "TODO state exceeds the bounded replay schema; delete was rejected",
        );
      return {
        state: bounded,
        op: { kind: "delete", id: updated.id, subject: updated.subject },
      };
    }

    case "clear": {
      const manualRemediation = params.decision === "skip";
      const remediationRationale = params.rationale?.trim();
      const remediationEvidence = params.challengeEvidence?.filter((entry) =>
        entry.trim(),
      );
      if (
        params.decision !== undefined &&
        (!manualRemediation ||
          !remediationRationale ||
          !remediationEvidence?.length)
      )
        return errorResult(
          state,
          "manual clear remediation requires decision skip, rationale, and evidence",
        );
      const archivable = (task: Task): boolean =>
        isTaskArchivableInState(state, task) ||
        (manualRemediation && isLegacyReviewRemediable(state, task));
      const unresolved = state.tasks.filter(
        (task) => task.status !== "deleted" && !archivable(task),
      );
      if (unresolved.length > 0) {
        return errorResult(
          state,
          `clear requires all visible tasks completed with owned work settled; unresolved: ${unresolved.map((task) => `#${task.id}`).join(", ")}`,
        );
      }
      const count = state.tasks.filter(archivable).length;
      if (count === 0) return { state, op: { kind: "clear", count } };
      const archived = state.tasks.map((task) => {
        if (!archivable(task)) return task;
        if (!isLegacyReviewRemediable(state, task))
          return { ...task, status: "deleted" as const };
        return {
          ...task,
          status: "deleted" as const,
          metadata: {
            ...(task.metadata ?? {}),
            manualRemediation: {
              kind: "legacy_completion_review_skip",
              at: now,
              rationale: redactTodoText(remediationRationale ?? ""),
              evidence: (remediationEvidence ?? []).map(redactTodoText),
            },
          },
        };
      });
      const bounded = boundedMutationState({
        ...state,
        tasks: archived,
        revision: nextRevision(state),
      });
      if (!bounded)
        return errorResult(
          state,
          "TODO state exceeds the bounded replay schema; clear was rejected",
        );
      return {
        state: bounded,
        op: { kind: "clear", count },
      };
    }
  }
}
