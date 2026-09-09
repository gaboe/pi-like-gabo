import type {
  JobStateEvent,
  JobWaitEvidence,
  Task,
  TaskWait,
} from "../tool/types.js";
import { propagatePrerequisiteFailure, publicTodoState } from "./inbox.js";
import { randomUUID } from "node:crypto";
import {
  cancellationRecoveryError,
  cancellationIntentTargetKey,
  delegationWorkerIds,
  MAX_CANCELLATION_INTENTS,
  normalizeCancellationIds,
  withCancellationLedger,
  type TaskState,
  type TodoCancellationIntent,
} from "./state.js";
import {
  MAX_JOB_EVIDENCE_ERROR_LENGTH,
  MAX_JOB_EVIDENCE_ID_LENGTH,
} from "../tool/types.js";
import {
  COMPLETION_REVIEW_MODEL,
  MAX_COMPLETION_REVIEW_ATTEMPTS,
  completionReviewDecisionQuestion,
  isCompletionReviewDecisionShape,
  isObsoleteCompletionReviewerFailure,
} from "./completion.js";

const TERMINAL_JOB_STATUSES = new Set([
  "wake",
  "succeeded",
  "failed",
  "killed",
  "timed_out",
]);

const PREPARATION_APPROVAL_PENDING = "awaiting_approval";
const JOB_STATE_EVENT_KEYS = new Set([
  "id",
  "status",
  "waitToken",
  "waitRegisteredAt",
  "waitGeneration",
  "waitIncarnation",
  "settledAt",
  "error",
]);

function canonicalJobStateRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return undefined;
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) => typeof key !== "string" || !JOB_STATE_EVENT_KEYS.has(key),
    ) ||
    !keys.includes("id") ||
    !keys.includes("status")
  )
    return undefined;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      return undefined;
  }
  return value as Record<string, unknown>;
}

export function isCompletionReviewDecisionQuestion(
  question: unknown,
  task: Task,
): question is string {
  return (
    typeof question === "string" &&
    completionReviewDecisionQuestion(task) === question
  );
}

export function completionReviewDecision(
  answer: unknown,
): "retry" | "revise" | undefined {
  if (typeof answer !== "string") return undefined;
  const normalized = answer.trim().toLowerCase();
  return normalized === "retry" || normalized === "revise"
    ? normalized
    : undefined;
}

function isExplicitNoWorkAcknowledgement(
  answer: unknown,
  taskId: number,
): boolean {
  if (typeof answer !== "string") return false;
  const normalized = answer
    .trim()
    .toLowerCase()
    .replace(/[.,!?]+$/, "");
  return new Set([
    "no work",
    "acknowledge no work",
    "close as no work",
    `acknowledge no work for todo #${taskId}`,
    `close todo #${taskId} as no work`,
  ]).has(normalized);
}

export interface UserWaitResponse {
  taskId?: number;
  todoToken?: string;
  question?: string;
  answer?: string;
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
}

type DeferredCompletionReviewDecision = {
  version: 1;
  decision: "retry" | "revise";
  taskId: number;
  reviewGeneration: number;
  reviewToken: string;
  reviewCompletionRevision: number;
  reviewRequestedAt: number;
  reviewAttempts: number;
  reviewFeedback: string;
  reviewFailedAt?: number;
  preparationToken?: string;
};

function deferredCompletionReviewDecision(
  task: Task,
): DeferredCompletionReviewDecision | undefined {
  const value = task.metadata?.completionReviewDecision;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const marker = value as Partial<DeferredCompletionReviewDecision>;
  const review = task.review;
  if (task.status !== "waiting:user" || task.wait?.kind !== "user")
    return undefined;
  const preparationToken = preparationOf(task)?.token;
  if (
    marker.version !== 1 ||
    (marker.decision !== "retry" && marker.decision !== "revise") ||
    marker.taskId !== task.id ||
    !review ||
    review.status !== "rejected" ||
    marker.reviewGeneration !== review.generation ||
    marker.reviewToken !== review.token ||
    marker.reviewCompletionRevision !== review.completionRevision ||
    marker.reviewRequestedAt !== review.requestedAt ||
    marker.reviewAttempts !== review.attempts ||
    marker.reviewFeedback !== (review.feedback ?? "") ||
    marker.reviewFailedAt !== review.failedAt ||
    marker.preparationToken !==
      (typeof preparationToken === "string" ? preparationToken : undefined) ||
    completionReviewDecisionQuestion(task) === undefined
  )
    return undefined;
  return marker as DeferredCompletionReviewDecision;
}

function deferredCompletionReviewMarker(
  task: Task,
  decision: "retry" | "revise",
): DeferredCompletionReviewDecision | undefined {
  const review = task.review;
  const attempts = review?.attempts;
  if (
    !review ||
    review.status !== "rejected" ||
    completionReviewDecisionQuestion(task) === undefined ||
    typeof attempts !== "number" ||
    !Number.isSafeInteger(attempts)
  )
    return undefined;
  const preparationToken = preparationOf(task)?.token;
  return {
    version: 1,
    decision,
    taskId: task.id,
    reviewGeneration: review.generation,
    reviewToken: review.token,
    reviewCompletionRevision: review.completionRevision,
    reviewRequestedAt: review.requestedAt,
    reviewAttempts: attempts,
    reviewFeedback: review.feedback ?? "",
    ...(review.failedAt === undefined
      ? {}
      : { reviewFailedAt: review.failedAt }),
    ...(typeof preparationToken === "string" ? { preparationToken } : {}),
  };
}

function restoreCompletionReviewQuestion(task: Task): Task {
  const question = completionReviewDecisionQuestion(task);
  const metadata = clearMetadataFields(task, ["completionReviewDecision"]);
  if (!question) {
    const remaining =
      task.wait?.kind === "user"
        ? task.wait.questions.filter(
            (candidate) => !isCompletionReviewDecisionShape(candidate, task.id),
          )
        : [];
    const restored: Task = {
      ...task,
      ...(remaining.length
        ? {
            status: "waiting:user" as const,
            wait: { kind: "user" as const, questions: remaining },
          }
        : { status: "in_progress" as const }),
    };
    if (!remaining.length) delete restored.wait;
    if (metadata) restored.metadata = metadata;
    else delete restored.metadata;
    return restored;
  }
  const existingQuestions: string[] =
    task.wait?.kind === "user"
      ? task.wait.questions.filter(
          (candidate) => !isCompletionReviewDecisionShape(candidate, task.id),
        )
      : [];
  const questions = existingQuestions.includes(question)
    ? existingQuestions
    : [...existingQuestions, question];
  const restored = {
    ...task,
    status: "waiting:user" as const,
    wait: { kind: "user" as const, questions },
  };
  if (metadata) restored.metadata = metadata;
  else delete restored.metadata;
  return restored;
}

function preparationOf(task: Task): Record<string, unknown> | undefined {
  const value = task.metadata?.preparation;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function clearMetadataFields(
  task: Task,
  fields: readonly string[],
): Record<string, unknown> | undefined {
  const metadata = task.metadata ? { ...task.metadata } : undefined;
  if (!metadata) return undefined;
  for (const field of fields) delete metadata[field];
  return Object.keys(metadata).length ? metadata : undefined;
}

export function gatePreparedTasksForApproval(state: TaskState): TaskState {
  return migrateLegacyPreparedApprovals(state);
}

export function isJobStateEvent(value: unknown): value is JobStateEvent {
  const event = canonicalJobStateRecord(value);
  if (!event) return false;
  return (
    typeof event.id === "string" &&
    event.id.length > 0 &&
    event.id.length <= MAX_JOB_EVIDENCE_ID_LENGTH &&
    event.id === event.id.trim() &&
    (event.status === "running" ||
      TERMINAL_JOB_STATUSES.has(event.status as string)) &&
    (event.waitToken === undefined ||
      (typeof event.waitToken === "string" &&
        event.waitToken.length > 0 &&
        event.waitToken.length <= 128)) &&
    (event.waitRegisteredAt === undefined ||
      (typeof event.waitRegisteredAt === "number" &&
        Number.isFinite(event.waitRegisteredAt))) &&
    (event.waitGeneration === undefined ||
      (typeof event.waitGeneration === "number" &&
        Number.isSafeInteger(event.waitGeneration) &&
        event.waitGeneration >= 1)) &&
    (event.waitIncarnation === undefined ||
      (typeof event.waitIncarnation === "string" &&
        event.waitIncarnation.length > 0)) &&
    ((event.waitToken === undefined &&
      event.waitRegisteredAt === undefined &&
      event.waitGeneration === undefined) ||
      (event.waitToken !== undefined &&
        event.waitRegisteredAt !== undefined &&
        event.waitGeneration !== undefined)) &&
    (event.settledAt === undefined ||
      (typeof event.settledAt === "number" &&
        Number.isFinite(event.settledAt)) ||
      (typeof event.settledAt === "string" &&
        Number.isFinite(Date.parse(event.settledAt)))) &&
    (event.error === undefined || typeof event.error === "string")
  );
}

export function normalizeJobStateEvent(
  value: unknown,
): JobStateEvent | undefined {
  if (!isJobStateEvent(value)) return undefined;
  const event = value as JobStateEvent;
  return {
    id: event.id,
    status: event.status,
    ...(event.waitToken === undefined ? {} : { waitToken: event.waitToken }),
    ...(event.waitRegisteredAt === undefined
      ? {}
      : { waitRegisteredAt: event.waitRegisteredAt }),
    ...(event.waitGeneration === undefined
      ? {}
      : { waitGeneration: event.waitGeneration }),
    ...(event.waitIncarnation === undefined
      ? {}
      : { waitIncarnation: event.waitIncarnation }),
    ...(event.settledAt === undefined ? {} : { settledAt: event.settledAt }),
    ...(event.error === undefined
      ? {}
      : { error: event.error.slice(0, MAX_JOB_EVIDENCE_ERROR_LENGTH) }),
  };
}

export function matchesJobWaitRegistration(
  wait: Extract<TaskWait, { kind: "jobs" }>,
  event: JobStateEvent,
): boolean {
  if (
    wait.waitToken === undefined ||
    wait.registeredAt === undefined ||
    wait.generation === undefined ||
    event.waitToken !== wait.waitToken ||
    event.waitRegisteredAt !== wait.registeredAt ||
    event.waitGeneration !== wait.generation
  )
    return false;
  const incarnation = wait.incarnations?.[event.id];
  if (incarnation === undefined || event.waitIncarnation !== incarnation)
    return false;
  if (event.settledAt === undefined) return true;
  const settledAt =
    typeof event.settledAt === "number"
      ? event.settledAt
      : Date.parse(event.settledAt);
  return settledAt >= wait.registeredAt!;
}

function evidenceFrom(
  event: JobStateEvent,
  now: number,
): JobWaitEvidence | undefined {
  if (event.status === "running") return undefined;
  return {
    id: event.id,
    status: event.status,
    // Host receipt time is evidence time; provider clocks never extend deadlines.
    settledAt: now,
    ...(event.error
      ? {
          error: event.error.slice(0, MAX_JOB_EVIDENCE_ERROR_LENGTH),
        }
      : {}),
  };
}

function withRevision(state: TaskState, tasks: Task[]): TaskState {
  return { ...state, tasks, revision: (state.revision ?? 0) + 1 };
}

function jobWaitDescriptorKey(value: {
  id: string;
  waitToken: string;
  registeredAt: number;
  generation: number;
}): string {
  return JSON.stringify([
    value.id,
    value.waitToken,
    value.registeredAt,
    value.generation,
  ]);
}

/** Apply a fully validated registration acknowledgement batch in one traversal. */
export function applyJobStateBatch(
  state: TaskState,
  events: readonly JobStateEvent[],
  now = Date.now(),
): TaskState {
  const replies = new Map<string, JobStateEvent>();
  for (const rawEvent of events) {
    const event = normalizeJobStateEvent(rawEvent);
    if (
      !event ||
      event.waitToken === undefined ||
      event.waitRegisteredAt === undefined ||
      event.waitGeneration === undefined ||
      event.waitIncarnation === undefined
    )
      return state;
    const key = jobWaitDescriptorKey({
      id: event.id,
      waitToken: event.waitToken,
      registeredAt: event.waitRegisteredAt,
      generation: event.waitGeneration,
    });
    if (replies.has(key)) return state;
    replies.set(key, event);
  }
  const expected = new Map<string, string | undefined>();
  for (const task of state.tasks) {
    const wait = task.wait;
    if (
      task.status !== "waiting:jobs" ||
      wait?.kind !== "jobs" ||
      wait.waitToken === undefined ||
      wait.registeredAt === undefined ||
      wait.generation === undefined
    )
      continue;
    for (const id of wait.jobIds) {
      const key = jobWaitDescriptorKey({
        id,
        waitToken: wait.waitToken,
        registeredAt: wait.registeredAt,
        generation: wait.generation,
      });
      if (expected.has(key)) return state;
      expected.set(key, wait.incarnations?.[id]);
    }
  }
  if (expected.size !== replies.size) return state;
  for (const [key, event] of replies) {
    const incarnation = expected.get(key);
    if (
      !expected.has(key) ||
      (incarnation !== undefined && incarnation !== event.waitIncarnation)
    )
      return state;
  }

  let changed = false;
  const tasks = state.tasks.map((task) => {
    const wait = task.wait;
    if (
      task.status !== "waiting:jobs" ||
      wait?.kind !== "jobs" ||
      wait.waitToken === undefined ||
      wait.registeredAt === undefined ||
      wait.generation === undefined
    )
      return task;
    let incarnations = wait.incarnations;
    let settled = wait.settled;
    for (const id of wait.jobIds) {
      const event = replies.get(
        jobWaitDescriptorKey({
          id,
          waitToken: wait.waitToken,
          registeredAt: wait.registeredAt,
          generation: wait.generation,
        }),
      );
      if (!event) continue;
      const existing = incarnations?.[id];
      if (existing !== undefined && existing !== event.waitIncarnation)
        return task;
      if (existing === undefined)
        incarnations = { ...incarnations, [id]: event.waitIncarnation! };
      const boundWait =
        incarnations === wait.incarnations ? wait : { ...wait, incarnations };
      if (
        event.status === "running" ||
        settled[id] ||
        !matchesJobWaitRegistration(boundWait, event)
      )
        continue;
      const evidence = evidenceFrom(event, now);
      if (evidence) settled = { ...settled, [id]: evidence };
    }
    if (incarnations === wait.incarnations && settled === wait.settled)
      return task;
    changed = true;
    const updatedWait = {
      ...wait,
      ...(incarnations === wait.incarnations ? {} : { incarnations }),
      ...(settled === wait.settled ? {} : { settled }),
    };
    const wake =
      updatedWait.mode === "any"
        ? updatedWait.jobIds.some((id) => updatedWait.settled[id])
        : updatedWait.jobIds.every((id) => updatedWait.settled[id]);
    if (!wake) return { ...task, wait: updatedWait };
    const updated: Task = {
      ...task,
      status: "pending",
      waitEvidence: updatedWait.jobIds.flatMap((id) =>
        updatedWait.settled[id] ? [updatedWait.settled[id]] : [],
      ),
    };
    delete updated.wait;
    return updated;
  });
  return changed ? withRevision(state, tasks) : state;
}

/** Record a typed terminal job event and wake waits according to their all/any policy. */
export function applyJobState(
  state: TaskState,
  event: JobStateEvent,
  now = Date.now(),
): TaskState {
  const normalized = normalizeJobStateEvent(event);
  if (!normalized) return state;
  event = normalized;
  const evidence = evidenceFrom(event, now);
  if (!evidence) return state;
  let changed = false;
  const tasks = state.tasks.map((task) => {
    if (
      task.status !== "waiting:jobs" ||
      task.wait?.kind !== "jobs" ||
      !task.wait.jobIds.includes(event.id) ||
      !matchesJobWaitRegistration(task.wait, event)
    ) {
      return task;
    }
    if (task.wait.settled[event.id]) return task;
    const settled = { ...task.wait.settled, [event.id]: evidence };
    const wake =
      task.wait.mode === "any" || task.wait.jobIds.every((id) => settled[id]);
    changed = true;
    if (!wake) return { ...task, wait: { ...task.wait, settled } };
    const updated: Task = {
      ...task,
      status: "pending",
      waitEvidence: task.wait.jobIds.flatMap((id) =>
        settled[id] ? [settled[id]] : [],
      ),
    };
    delete updated.wait;
    return updated;
  });
  return changed ? withRevision(state, tasks) : state;
}

export function nextJobDeadline(
  state: TaskState,
  now = Date.now(),
): number | undefined {
  let deadline: number | undefined;
  for (const task of state.tasks) {
    if (
      task.status !== "waiting:jobs" ||
      task.wait?.kind !== "jobs" ||
      (task.wait.reconciliationAttempts ?? 0) >= 3 ||
      task.wait.deadline <= now
    )
      continue;
    deadline =
      deadline === undefined
        ? task.wait.deadline
        : Math.min(deadline, task.wait.deadline);
  }
  return deadline;
}

function addressedTask(
  state: TaskState,
  response: UserWaitResponse | undefined,
): Task | undefined {
  if (!response) return undefined;
  return state.tasks.find((task) => {
    if (task.status !== "waiting:user" || task.wait?.kind !== "user")
      return false;
    if (response.taskId !== undefined && task.id !== response.taskId)
      return false;
    const preparation = preparationOf(task);
    if (
      response.todoToken !== undefined &&
      preparation?.token !== response.todoToken
    )
      return false;
    if (response.preparationTokenPresent !== undefined) {
      const currentTokenPresent = typeof preparation?.token === "string";
      if (response.preparationTokenPresent !== currentTokenPresent)
        return false;
      if (currentTokenPresent && preparation?.token !== response.todoToken)
        return false;
    }
    if (
      response.reviewGeneration !== undefined ||
      response.reviewToken !== undefined ||
      response.reviewCompletionRevision !== undefined ||
      response.reviewRequestedAt !== undefined ||
      response.reviewFailedAtPresent !== undefined ||
      response.reviewAttempts !== undefined ||
      response.reviewFeedback !== undefined ||
      response.completionQuestion !== undefined
    ) {
      const review = task.review;
      const currentFailedAtPresent = Boolean(
        review && Object.hasOwn(review, "failedAt"),
      );
      if (
        !review ||
        review.status !== "rejected" ||
        review.generation !== response.reviewGeneration ||
        review.token !== response.reviewToken ||
        review.completionRevision !== response.reviewCompletionRevision ||
        review.requestedAt !== response.reviewRequestedAt ||
        response.reviewFailedAtPresent !== currentFailedAtPresent ||
        (currentFailedAtPresent &&
          review.failedAt !== response.reviewFailedAt) ||
        review.attempts !== response.reviewAttempts ||
        (review.feedback ?? "") !== response.reviewFeedback ||
        !isCompletionReviewDecisionQuestion(
          response.completionQuestion,
          task,
        ) ||
        response.question !== response.completionQuestion
      )
        return false;
    }
    return (
      response.question === undefined ||
      task.wait.questions.includes(response.question)
    );
  });
}

export function resumeWaitingUserTasks(
  state: TaskState,
  response?: UserWaitResponse,
): TaskState {
  let changed = false;
  const tasks = state.tasks.map((task) => {
    if (task.status !== "waiting:user") return task;
    const preparation = preparationOf(task);
    const target = response ? addressedTask(state, response) : undefined;
    const addressed = response ? target?.id === task.id : true;
    if (!addressed) return task;
    const completionQuestion =
      task.wait?.kind === "user"
        ? task.wait.questions.find((question) =>
            isCompletionReviewDecisionQuestion(question, task),
          )
        : undefined;
    const responseIsCompletion = Boolean(
      response &&
      completionQuestion &&
      response.question === completionQuestion,
    );
    const hasDeferredDecision = Boolean(
      task.metadata && Object.hasOwn(task.metadata, "completionReviewDecision"),
    );
    const deferredDecision = deferredCompletionReviewDecision(task);
    if (hasDeferredDecision && !deferredDecision) {
      changed = true;
      return restoreCompletionReviewQuestion(task);
    }
    const decision = responseIsCompletion
      ? completionReviewDecision(response?.answer)
      : deferredDecision?.decision;
    if (responseIsCompletion && !decision) return task;
    const applyCompletionDecision = (
      candidate: Task,
      selected: "retry" | "revise",
    ): Task => {
      const currentReview = candidate.review;
      if (!currentReview || currentReview.status !== "rejected")
        return candidate;
      const review = {
        ...currentReview,
        status:
          selected === "retry" ? ("pending" as const) : ("rejected" as const),
        generation: currentReview.generation + 1,
        token: randomUUID(),
        completionRevision: state.revision + 1,
        requestedAt: Date.now(),
        feedback:
          selected === "revise"
            ? "Evidence revision requested by the user."
            : currentReview.feedback,
      };
      delete review.dispatchedAt;
      delete review.reviewedAt;
      delete review.failedAt;
      delete review.attempts;
      delete review.inputDigest;
      const metadata = clearMetadataFields(candidate, [
        "askUserCorrelation",
        "completionReviewDecision",
      ]);
      const updated = {
        ...candidate,
        status:
          selected === "retry" ? ("completed" as const) : ("pending" as const),
        review,
      };
      if (metadata) updated.metadata = metadata;
      else delete updated.metadata;
      delete updated.wait;
      return updated;
    };
    if (
      responseIsCompletion &&
      task.wait?.kind === "user" &&
      task.wait.questions.length > 1
    ) {
      changed = true;
      const remaining = task.wait.questions.filter(
        (question) => question !== response?.question,
      );
      const metadata = clearMetadataFields(task, ["askUserCorrelation"]) ?? {};
      if (!decision) return task;
      const marker = deferredCompletionReviewMarker(task, decision);
      if (!marker) return task;
      metadata.completionReviewDecision = marker;
      return {
        ...task,
        status: "waiting:user" as const,
        wait: { kind: "user" as const, questions: remaining },
        metadata,
      };
    }
    if (
      response &&
      task.wait?.kind === "user" &&
      task.wait.questions.length > 1
    ) {
      if (
        !response.question ||
        !task.wait.questions.includes(response.question)
      )
        return task;
      changed = true;
      const remaining = task.wait.questions.filter(
        (question) => question !== response.question,
      );
      if (decision && completionQuestion && remaining.length === 0)
        return applyCompletionDecision(task, decision);
      const updated = {
        ...task,
        status: "waiting:user" as const,
        wait: {
          kind: "user" as const,
          questions: remaining,
        },
      };
      const metadata = clearMetadataFields(task, ["askUserCorrelation"]);
      if (metadata) updated.metadata = metadata;
      else delete updated.metadata;
      return updated;
    }
    if (decision && (completionQuestion || deferredDecision !== undefined)) {
      changed = true;
      return applyCompletionDecision(task, decision);
    }
    if (preparation?.status === "not_needed") {
      if (
        !response ||
        response.taskId !== task.id ||
        response.todoToken !== preparation.token ||
        response.question !==
          (task.wait?.kind === "user" ? task.wait.questions[0] : undefined) ||
        !isExplicitNoWorkAcknowledgement(response.answer, task.id)
      )
        return task;
      changed = true;
      const completed = {
        ...task,
        status: "completed" as const,
        result: "No work required; explicitly acknowledged.",
        evidence: ["User explicitly acknowledged that no work is required."],
      };
      const metadata = clearMetadataFields(task, ["askUserCorrelation"]);
      if (metadata) completed.metadata = metadata;
      else delete completed.metadata;
      delete completed.wait;
      return completed;
    }
    if (preparation?.status === "insufficient") {
      if (
        !response ||
        typeof response.answer !== "string" ||
        !response.answer.trim()
      )
        return task;
      changed = true;
      const resumed = { ...task, status: "pending" as const };
      delete resumed.wait;
      const metadata = clearMetadataFields(task, ["askUserCorrelation"]) ?? {};
      const nextPreparation = { ...preparation };
      delete nextPreparation.approval;
      delete nextPreparation.approvalQuestion;
      metadata.preparation = {
        ...nextPreparation,
        status: "queued",
        classifier: { status: "pending" },
        reprepareRequested: true,
        clarification: response.answer.slice(0, 1_000),
      };
      resumed.metadata = metadata;
      return resumed;
    }
    changed = true;
    const resumed: Task = {
      ...task,
      status: "pending" as const,
    };
    const metadata = clearMetadataFields(task, ["askUserCorrelation"]);
    if (metadata) resumed.metadata = metadata;
    else delete resumed.metadata;
    delete resumed.wait;
    return resumed;
  });
  return changed ? withRevision(state, tasks) : state;
}

/** Migrate legacy prepared approval markers without creating a new permission gate. */
export function migrateLegacyPreparedApprovals(state: TaskState): TaskState {
  let changed = false;
  const tasks = state.tasks.map((task) => {
    const preparation = preparationOf(task);
    if (!preparation) return task;
    const approvalPending =
      preparation.status === PREPARATION_APPROVAL_PENDING ||
      preparation.approval === PREPARATION_APPROVAL_PENDING;
    const isApprovalShapedQuestion = (question: string): boolean => {
      const direct = /^\s*approve\s+todo\s+#(\d+)\b/i.exec(question);
      if (direct) return Number(direct[1]) === task.id;
      const prepared =
        /^\s*(?:approve|continue with|accept)(?:\s+the)?\s+prepared\s+plan(?:\s+for\s+todo\s+#(\d+)\b)?/i.exec(
          question,
        );
      return (
        prepared !== null &&
        (prepared[1] === undefined || Number(prepared[1]) === task.id)
      );
    };
    const approvalQuestions =
      task.wait?.kind === "user"
        ? task.wait.questions.filter(isApprovalShapedQuestion)
        : [];
    const genuineQuestions =
      task.wait?.kind === "user"
        ? task.wait.questions.filter(
            (question) => !approvalQuestions.includes(question),
          )
        : [];
    if (approvalPending) {
      changed = true;
      const nextPreparation = { ...preparation };
      delete nextPreparation.approval;
      delete nextPreparation.approvalRequired;
      delete nextPreparation.approvalQuestion;
      delete nextPreparation.approvalFeedbackQuestion;
      const updated = {
        ...task,
        ...(task.status === "waiting:user"
          ? genuineQuestions.length > 0
            ? {
                status: "waiting:user" as const,
                wait: { kind: "user" as const, questions: genuineQuestions },
              }
            : { status: "pending" as const }
          : {}),
        metadata: {
          ...task.metadata,
          preparation: {
            ...nextPreparation,
            status: "ready",
          },
        },
      };
      if (updated.status === "pending") delete updated.wait;
      return updated;
    }
    if (preparation.status !== "ready") return task;
    if (
      preparation.approval === undefined &&
      preparation.approvalRequired === undefined &&
      preparation.approvalQuestion === undefined &&
      preparation.approvalFeedbackQuestion === undefined
    )
      return task;
    changed = true;
    const nextPreparation = { ...preparation };
    delete nextPreparation.approval;
    delete nextPreparation.approvalRequired;
    delete nextPreparation.approvalQuestion;
    delete nextPreparation.approvalFeedbackQuestion;
    const updated = {
      ...task,
      ...(task.status === "waiting:user"
        ? genuineQuestions.length > 0
          ? {
              status: "waiting:user" as const,
              wait: { kind: "user" as const, questions: genuineQuestions },
            }
          : { status: "pending" as const }
        : {}),
      metadata: {
        ...task.metadata,
        preparation: nextPreparation,
      },
    };
    if (updated.status === "pending") delete updated.wait;
    return updated;
  });
  return changed ? { ...state, tasks } : state;
}

/** A pending review claim belongs to the prior worker generation after replay. */
export function recoverStaleCompletionReviewClaims(
  state: TaskState,
): TaskState {
  let changed = false;
  const tasks = state.tasks.map((task) => {
    if (
      task.review?.status !== "pending" ||
      task.review.dispatchedAt === undefined
    )
      return task;
    changed = true;
    const review = { ...task.review };
    delete review.dispatchedAt;
    return { ...task, review };
  });
  return changed ? withRevision(state, tasks) : state;
}

export function recoverRejectedCompletionReviews(state: TaskState): TaskState {
  let changed = false;
  const tasks = state.tasks.map((task) => {
    const verification = task.metadata?.verification as
      { state?: unknown } | undefined;
    if (isObsoleteCompletionReviewerFailure(task)) {
      changed = true;
      const review = {
        ...task.review,
        status: "pending" as const,
        attempts: 0,
        reviewer: {
          ...task.review.reviewer,
          model: COMPLETION_REVIEW_MODEL,
        },
      };
      delete review.dispatchedAt;
      delete review.reviewedAt;
      delete review.failedAt;
      delete review.feedback;
      const { verification: _verification, ...metadata } = task.metadata ?? {};
      const recovered = {
        ...task,
        status: "completed" as const,
        review,
        ...(Object.keys(metadata).length ? { metadata } : {}),
      };
      if (!Object.keys(metadata).length) delete recovered.metadata;
      delete recovered.wait;
      return recovered;
    }
    if (
      verification?.state === "failed" ||
      task.review?.status !== "rejected" ||
      (task.status !== "in_progress" && task.status !== "waiting:user")
    )
      return task;
    const hasDeferredDecision = Boolean(
      task.metadata && Object.hasOwn(task.metadata, "completionReviewDecision"),
    );
    if (hasDeferredDecision) {
      if (deferredCompletionReviewDecision(task)) return task;
      changed = true;
      return restoreCompletionReviewQuestion(task);
    }
    if (
      task.status === "waiting:user" &&
      task.wait?.kind === "user" &&
      task.wait.questions.some((question) =>
        isCompletionReviewDecisionShape(question, task.id),
      )
    ) {
      changed = true;
      return restoreCompletionReviewQuestion(task);
    }
    changed = true;
    const recovered = { ...task, status: "pending" as const };
    delete recovered.wait;
    return recovered;
  });
  return changed
    ? withRevision(state, propagatePrerequisiteFailure(tasks))
    : state;
}

export function recoverInterruptedPreparations(state: TaskState): TaskState {
  let changed = false;
  let capacityExceeded = false;
  const cancellationIntents = [...(state.cancellationIntents ?? [])];
  const cancellationOverflow = [...(state.cancellationOverflow ?? [])];
  const cancellationQuarantine = [...(state.cancellationQuarantine ?? [])];
  const hasIntent = (intent: TodoCancellationIntent) => {
    const key = cancellationIntentTargetKey(intent);
    return (
      cancellationIntents.some(
        (candidate) => cancellationIntentTargetKey(candidate) === key,
      ) ||
      cancellationOverflow.some(
        (candidate) => cancellationIntentTargetKey(candidate) === key,
      ) ||
      cancellationQuarantine.some(
        (candidate) => cancellationIntentTargetKey(candidate) === key,
      )
    );
  };
  const admitIntents = (
    required: readonly TodoCancellationIntent[],
  ): boolean => {
    const unique = new Map(
      required.map((intent) => [cancellationIntentTargetKey(intent), intent]),
    );
    if (
      [...unique.keys()].some(
        (key) =>
          cancellationQuarantine.some(
            (intent) => cancellationIntentTargetKey(intent) === key,
          ) &&
          !cancellationIntents.some(
            (intent) => cancellationIntentTargetKey(intent) === key,
          ) &&
          !cancellationOverflow.some(
            (intent) => cancellationIntentTargetKey(intent) === key,
          ),
      )
    ) {
      return false;
    }
    const missing = [...unique.values()].filter((intent) => !hasIntent(intent));
    const free =
      MAX_CANCELLATION_INTENTS -
      cancellationIntents.length +
      MAX_CANCELLATION_INTENTS -
      cancellationOverflow.length;
    if (missing.length > free) {
      capacityExceeded = true;
      return false;
    }
    for (const intent of missing) {
      if (cancellationIntents.length < MAX_CANCELLATION_INTENTS)
        cancellationIntents.push(intent);
      else cancellationOverflow.push(intent);
    }
    if (missing.length) changed = true;
    return true;
  };
  const overflowBeforePromotion = cancellationOverflow.length;
  while (
    cancellationIntents.length < MAX_CANCELLATION_INTENTS &&
    cancellationOverflow.length
  ) {
    const next = cancellationOverflow.shift()!;
    if (!hasIntent(next)) cancellationIntents.push(next);
  }
  if (cancellationOverflow.length !== overflowBeforePromotion) changed = true;
  const preparationIntents = (
    task: Task,
    preparation: Record<string, unknown>,
  ): TodoCancellationIntent[] | undefined => {
    const useCancellationPair =
      typeof preparation.cancellationToken === "string";
    const token = useCancellationPair
      ? preparation.cancellationToken
      : preparation.token;
    if (typeof token !== "string" || !token.trim()) return undefined;
    const rawIds = [
      ...(Array.isArray(preparation.activeWorkerIds)
        ? preparation.activeWorkerIds
        : []),
      ...(Array.isArray(preparation.cancellationIds)
        ? preparation.cancellationIds
        : []),
      preparation.subagentId,
    ].filter((id): id is string => typeof id === "string");
    const rawWorkerGeneration = useCancellationPair
      ? preparation.cancellationWorkerGeneration
      : preparation.workerGeneration;
    const workerGeneration = Number.isSafeInteger(rawWorkerGeneration)
      ? Number(rawWorkerGeneration)
      : 0;
    return normalizeCancellationIds(rawIds).map((id) => ({
      kind: "preparation",
      taskId: task.id,
      token,
      ids: [id],
      generation: 1,
      attempts: 0,
      workerGeneration,
    }));
  };
  const delegationIntents = (
    task: Task,
    delegation: Record<string, unknown>,
  ): TodoCancellationIntent[] => {
    const token = delegation.todoToken;
    if (typeof token !== "string" || !token.trim()) return [];
    const rawIds = delegationWorkerIds(delegation);
    const generation =
      Number.isSafeInteger(delegation.cancellationGeneration) &&
      Number(delegation.cancellationGeneration) > 0
        ? Number(delegation.cancellationGeneration)
        : 1;
    return normalizeCancellationIds(rawIds).map((id) => ({
      kind: "delegation",
      taskId: task.id,
      token,
      ids: [id],
      generation,
      attempts: 0,
    }));
  };
  const hasDelegationIntent = (
    task: Task,
    delegation: Record<string, unknown>,
    id: string,
  ) =>
    [...cancellationIntents, ...cancellationOverflow].some(
      (intent) =>
        intent.kind === "delegation" &&
        intent.taskId === task.id &&
        intent.token === delegation.todoToken &&
        intent.ids.length === 1 &&
        intent.ids[0] === id,
    );
  const requirements = new Map<
    number,
    {
      preparationActive: boolean;
      delegationNeedsCancellation: boolean;
      preparationIntents?: TodoCancellationIntent[];
      delegationIntents: TodoCancellationIntent[];
    }
  >();
  for (const task of state.tasks) {
    const preparation = task.metadata?.preparation as
      Record<string, unknown> | undefined;
    const delegation = task.metadata?.delegation as
      Record<string, unknown> | undefined;
    const preparationActive =
      task.status !== "completed" &&
      task.status !== "deleted" &&
      preparation &&
      ["classifying", "queued", "running"].includes(String(preparation.status));
    const delegationIds = delegationWorkerIds(delegation);
    const delegationStatus = String(delegation?.status);
    const delegationNeedsCancellation =
      !!delegation &&
      (["running", "interrupted"].includes(delegationStatus) ||
        (delegationStatus === "cancelling" &&
          delegationIds.some(
            (id) => !hasDelegationIntent(task, delegation, id),
          )));
    if (preparationActive || delegationNeedsCancellation) {
      requirements.set(task.id, {
        preparationActive: Boolean(preparationActive),
        delegationNeedsCancellation,
        preparationIntents: preparationActive
          ? preparationIntents(task, preparation)
          : undefined,
        delegationIntents:
          delegationNeedsCancellation && delegation
            ? delegationIntents(task, delegation)
            : [],
      });
    }
  }
  const requiredIntents = [...requirements.values()].flatMap((requirement) => [
    ...(requirement.preparationIntents ?? []),
    ...requirement.delegationIntents,
  ]);
  const admitted = admitIntents(requiredIntents);
  const tasks = state.tasks.map((task) => {
    const requirement = requirements.get(task.id);
    if (!requirement) return task;
    if (
      !admitted ||
      (requirement.preparationActive && !requirement.preparationIntents)
    )
      return task;
    changed = true;
    const preparation = task.metadata?.preparation as
      Record<string, unknown> | undefined;
    const delegation = task.metadata?.delegation as
      Record<string, unknown> | undefined;
    return {
      ...task,
      metadata: {
        ...task.metadata,
        ...(requirement.delegationNeedsCancellation && delegation
          ? {
              delegation: {
                ...delegation,
                status: "cancelling",
                error: "Cancel persisted worker before redispatch",
                cancellationGeneration:
                  Number.isSafeInteger(delegation.cancellationGeneration) &&
                  Number(delegation.cancellationGeneration) > 0
                    ? Number(delegation.cancellationGeneration)
                    : 1,
                cancellationTaskStatus: task.status,
                cancellationAttempts: Number.isSafeInteger(
                  delegation.cancellationAttempts,
                )
                  ? Number(delegation.cancellationAttempts)
                  : 0,
              },
            }
          : {}),
        ...(requirement.preparationActive && preparation
          ? {
              preparation: {
                ...preparation,
                status: "failed",
                code: "preparation_interrupted",
                version:
                  typeof preparation.version === "number"
                    ? preparation.version + 1
                    : 1,
                sourceRevision: state.revision,
                error: "TODO preparation interrupted by session reload",
              },
            }
          : {}),
      },
    };
  });
  const capacityError = cancellationRecoveryError(
    cancellationIntents.length,
    cancellationOverflow.length,
    cancellationQuarantine.length,
    capacityExceeded,
  );
  const capacityChanged = capacityError !== state.cancellationCapacityError;
  return changed || capacityExceeded || capacityChanged
    ? withRevision(
        withCancellationLedger(
          { ...state },
          {
            intents: cancellationIntents,
            overflow: cancellationOverflow,
            quarantine: cancellationQuarantine,
            capacityError,
          },
        ),
        tasks,
      )
    : state;
}

export function isTaskActionable(task: Task, tasks: readonly Task[]): boolean {
  if (
    task.mergedInto !== undefined ||
    task.status === "completed" ||
    task.status === "deleted"
  )
    return false;
  const lifecycle = publicTodoState(task);
  const preparation = task.metadata?.preparation as
    | { status?: unknown; code?: unknown; classifier?: { status?: unknown } }
    | undefined;
  const recoveryOnly =
    preparation?.status === "failed" &&
    ["preparation_failed", "preparation_interrupted"].includes(
      String(preparation.code),
    );
  const verification = task.metadata?.verification as
    { state?: unknown; recovery?: unknown; failure?: unknown } | undefined;
  const review = task.review;
  const completionReviewRecovery =
    review?.status === "rejected" &&
    review.attempts === MAX_COMPLETION_REVIEW_ATTEMPTS &&
    typeof review.token === "string" &&
    review.token.length > 0 &&
    Number.isSafeInteger(review.completionRevision) &&
    typeof review.failedAt === "number" &&
    verification?.state === "failed" &&
    verification.recovery === "manual" &&
    verification.failure === review.feedback;
  if (
    !recoveryOnly &&
    !completionReviewRecovery &&
    lifecycle !== "ready" &&
    lifecycle !== "in_progress"
  )
    return false;
  if (
    preparation?.status === "ready" &&
    preparation.classifier?.status === "pending"
  )
    return false;
  const delegation = task.metadata?.delegation as
    { status?: unknown } | undefined;
  if (
    delegation?.status === "running" ||
    delegation?.status === "interrupted" ||
    delegation?.status === "cancelling"
  )
    return false;
  return (task.blockedBy ?? []).every(
    (id) =>
      tasks.find((candidate) => candidate.id === id) !== undefined &&
      publicTodoState(tasks.find((candidate) => candidate.id === id)!) ===
        "completed",
  );
}

export function hasActionableTasks(state: TaskState): boolean {
  return state.tasks.some((task) => isTaskActionable(task, state.tasks));
}

/** Exact persisted question text, without paraphrasing. */
export function formatWaitingUserSummary(state: TaskState): string | undefined {
  const waiting = state.tasks.filter(
    (task) => task.status === "waiting:user" && task.wait?.kind === "user",
  );
  if (!waiting.length) return undefined;
  const lines = ["Waiting for user input:"];
  for (const task of waiting) {
    if (task.wait?.kind !== "user") continue;
    lines.push(
      `#${task.id} ${task.subject}`,
      ...task.wait.questions.map((question) => `- ${question}`),
    );
  }
  return lines.join("\n");
}
