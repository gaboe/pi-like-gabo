import type { TaskStatus } from "../tool/types.js";

/**
 * Allowed forward transitions per source status. `completed` is one-way to
 * `deleted` (never back to `in_progress`); `deleted` is terminal.
 *
 * Idempotent same→same is checked separately in `isTransitionValid` so this
 * table only enumerates actual transitions.
 */
export const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
	pending: new Set(["in_progress", "waiting:user", "waiting:jobs", "completed", "deleted"]),
	in_progress: new Set(["pending", "waiting:user", "waiting:jobs", "completed", "deleted"]),
	"waiting:user": new Set(["pending", "in_progress", "waiting:jobs", "completed", "deleted"]),
	"waiting:jobs": new Set(["pending", "in_progress", "waiting:user", "completed", "deleted"]),
	completed: new Set(["deleted"]),
	deleted: new Set(),
};

export function isTransitionValid(from: TaskStatus, to: TaskStatus): boolean {
	if (from === to) return true;
	return VALID_TRANSITIONS[from].has(to);
}
