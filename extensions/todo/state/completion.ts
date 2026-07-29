import type { Task } from "../tool/types.js";

export function isTaskArchivable(task: Task): boolean {
  if (task.status !== "completed" || task.wait?.kind === "jobs") return false;
  const delegation = task.metadata?.delegation as
    { status?: unknown } | undefined;
  return !["running", "interrupted", "cancelling"].includes(
    String(delegation?.status),
  );
}
