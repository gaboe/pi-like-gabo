import type { Task } from "../tool/types.js";

// Background-subagent model policy currently supports canonical Luna/Terra tiers, not Spark.
export const COMPLETION_REVIEW_MODEL = "openai-codex/gpt-5.6-luna";
export const COMPLETION_REVIEWER_ID = "background-subagent";

export function isTaskArchivable(task: Task): boolean {
  if (
    task.status !== "completed" ||
    task.review?.status !== "approved" ||
    task.wait?.kind === "jobs"
  )
    return false;
  const delegation = task.metadata?.delegation as
    { status?: unknown } | undefined;
  return !["running", "interrupted", "cancelling"].includes(
    String(delegation?.status),
  );
}
