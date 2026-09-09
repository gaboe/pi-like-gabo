import type { TaskStatus } from "../tool/types.js";

/** Local package intentionally stays English-only to avoid an optional executable dependency. */
export function t(_key: string, fallback: string): string {
  return fallback;
}

export function formatStatusLabel(status: TaskStatus): string {
  if (status === "in_progress") return "in progress";
  return status.replace(":", ": ");
}
