import type { Task } from "../tool/types.js";

// Background-subagent model policy currently supports canonical Luna/Terra tiers, not Spark.
export const COMPLETION_REVIEW_MODEL = "openai-codex/gpt-5.6-luna";
export const COMPLETION_REVIEWER_ID = "background-subagent";

/** Failed dispatches tolerated before a review gives up and hands the task back. */
export const MAX_COMPLETION_REVIEW_ATTEMPTS = 3;
const COMPLETION_REVIEW_RETRY_BASE_MS = 30_000;

/** Doubles per attempt, so a service that is down is not retried once per state change. */
export function completionReviewRetryDelayMs(attempts: number): number {
  return COMPLETION_REVIEW_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);
}

/**
 * A review with `dispatchedAt` is owned by a live worker. A failed one is
 * retryable once its backoff elapses — without that, one transient failure left
 * the task pending forever and therefore never archivable.
 */
export function isCompletionReviewDispatchable(task: Task, now = Date.now()): boolean {
  const review = task.review;
  if (review?.status !== "pending" || review.dispatchedAt !== undefined) return false;
  if (review.failedAt === undefined) return true;
  return now - review.failedAt >= completionReviewRetryDelayMs(review.attempts ?? 1);
}

/**
 * Earliest wall-clock time a failed review becomes dispatchable, or undefined if
 * none is waiting. The scheduler only sweeps on state changes, so without a timer
 * armed at this instant an idle TODO list never retries at all.
 */
export function nextCompletionReviewRetryAt(tasks: readonly Task[]): number | undefined {
  let earliest: number | undefined;
  for (const task of tasks) {
    const review = task.review;
    if (review?.status !== "pending" || review.dispatchedAt !== undefined) continue;
    if (review.failedAt === undefined) continue;
    const at = review.failedAt + completionReviewRetryDelayMs(review.attempts ?? 1);
    if (earliest === undefined || at < earliest) earliest = at;
  }
  return earliest;
}

export function isTaskArchivable(task: Task): boolean {
  if (task.status !== "completed" || task.wait?.kind === "jobs") return false;
  // A completed task with NO review predates the review requirement and arrives
  // that way from snapshot replay. Treating it as unapproved strands it forever:
  // nothing re-requests a review for an already-completed task.
  if (task.review !== undefined && task.review.status !== "approved") return false;
  const delegation = task.metadata?.delegation as
    { status?: unknown } | undefined;
  return !["running", "interrupted", "cancelling"].includes(
    String(delegation?.status),
  );
}
