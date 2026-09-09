import type { Task } from "../tool/types.js";
import { delegationWorkerIds } from "./state.js";
import { publicTodoState } from "./inbox.js";

// Kept independent from the configured candidate so a bad selector edit still falls back.
const COMPLETION_REVIEW_FALLBACK_MODEL = "openai-codex/gpt-5.6-luna" as const;
const SUPPORTED_COMPLETION_REVIEW_MODELS = new Set([
  "openai-codex/gpt-5.6-luna",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-sol",
]);

export const COMPLETION_REVIEW_MODEL = "openai-codex/gpt-5.6-luna" as const;
export const COMPLETION_REVIEWER_ID = "background-subagent";

export function resolveCompletionReviewModel(candidate: string): string {
  return SUPPORTED_COMPLETION_REVIEW_MODELS.has(candidate)
    ? candidate
    : COMPLETION_REVIEW_FALLBACK_MODEL;
}

/** Failed dispatches tolerated before a review gives up and hands the task back. */
export const MAX_COMPLETION_REVIEW_ATTEMPTS = 3;
const COMPLETION_REVIEW_RETRY_BASE_MS = 30_000;

export function isObsoleteCompletionReviewerFailure(
  task: Task,
): task is Task & { review: NonNullable<Task["review"]> } {
  return Boolean(
    task.review?.status === "rejected" &&
    task.review.reviewer.model !== COMPLETION_REVIEW_MODEL &&
    task.review.feedback?.includes("model is not supported"),
  );
}

const COMPLETION_REVIEW_QUESTION_SUFFIX =
  ". Choose whether to retry or revise evidence.";

export function isCompletionReviewDecisionShape(
  question: unknown,
  taskId: number,
): question is string {
  return (
    typeof question === "string" &&
    question.startsWith(
      `Completion review for TODO #${taskId} failed repeatedly: `,
    ) &&
    question.endsWith(COMPLETION_REVIEW_QUESTION_SUFFIX)
  );
}

export function completionReviewDecisionQuestion(
  _task: Pick<Task, "id" | "review">,
): string | undefined {
  return undefined;
}

/** Doubles per attempt, so a service that is down is not retried once per state change. */
export function completionReviewRetryDelayMs(attempts: number): number {
  return COMPLETION_REVIEW_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);
}

/**
 * A review with `dispatchedAt` is owned by a live worker. A failed one is
 * retryable once its backoff elapses — without that, one transient failure left
 * the task pending forever and therefore never archivable.
 */
export function isCompletionReviewDispatchable(
  task: Task,
  now = Date.now(),
): boolean {
  const review = task.review;
  if (
    review?.status !== "pending" ||
    review.dispatchedAt !== undefined ||
    hasActiveCompletionOwner(task)
  )
    return false;
  if (review.failedAt === undefined) return true;
  return (
    now - review.failedAt >= completionReviewRetryDelayMs(review.attempts ?? 1)
  );
}

/**
 * Earliest wall-clock time a failed review becomes dispatchable, or undefined if
 * none is waiting. The scheduler only sweeps on state changes, so without a timer
 * armed at this instant an idle TODO list never retries at all.
 */
export function nextCompletionReviewRetryAt(
  tasks: readonly Task[],
  cancellingTaskIds: ReadonlySet<number> = new Set(),
): number | undefined {
  let earliest: number | undefined;
  for (const task of tasks) {
    const review = task.review;
    if (
      review?.status !== "pending" ||
      review.dispatchedAt !== undefined ||
      hasActiveCompletionOwner(task) ||
      cancellingTaskIds.has(task.id)
    )
      continue;
    if (review.failedAt === undefined) continue;
    const at =
      review.failedAt + completionReviewRetryDelayMs(review.attempts ?? 1);
    if (earliest === undefined || at < earliest) earliest = at;
  }
  return earliest;
}

function hasActiveCompletionOwner(task: Task): boolean {
  const preparation = task.metadata?.preparation as
    { status?: unknown; activeWorkerIds?: unknown } | undefined;
  if (
    ["classifying", "queued", "running", "cancelling"].includes(
      String(preparation?.status),
    ) ||
    (Array.isArray(preparation?.activeWorkerIds) &&
      preparation.activeWorkerIds.length > 0)
  )
    return true;
  const delegation = task.metadata?.delegation as
    Record<string, unknown> | undefined;
  const delegationStatus = String(delegation?.status);
  return (
    ["running", "interrupted", "cancelling"].includes(delegationStatus) ||
    (!["settled", "cancelled"].includes(delegationStatus) &&
      delegationWorkerIds(delegation).length > 0)
  );
}

export function isTaskArchivable(
  task: Task,
  options: { hasCancellationIntent?: boolean } = {},
): boolean {
  if (
    options.hasCancellationIntent ||
    task.status !== "completed" ||
    publicTodoState(task) !== "completed" ||
    task.wait?.kind === "jobs" ||
    typeof task.result !== "string" ||
    !task.result.trim() ||
    !Array.isArray(task.evidence) ||
    task.evidence.length === 0 ||
    task.evidence.some((entry) => typeof entry !== "string" || !entry.trim())
  )
    return false;
  return task.review?.status === "approved" && !hasActiveCompletionOwner(task);
}
