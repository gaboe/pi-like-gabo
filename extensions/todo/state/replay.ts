import type { Task, TaskDetails, TaskStatus } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.js";
import { detectCycle } from "./task-graph.js";

const STATUSES = new Set<TaskStatus>(["pending", "in_progress", "completed", "deleted"]);

function isTask(value: unknown): value is Task {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const task = value as Record<string, unknown>;
	return Number.isSafeInteger(task.id) &&
		(task.id as number) > 0 &&
		typeof task.subject === "string" &&
		task.subject.trim().length > 0 &&
		STATUSES.has(task.status as TaskStatus) &&
		(task.blockedBy === undefined ||
			(Array.isArray(task.blockedBy) && task.blockedBy.every((id) => Number.isSafeInteger(id) && id > 0)));
}

/** Reject malformed or graph-invalid historical state instead of poisoning the live store. */
export function isTaskDetails(value: unknown): value is TaskDetails {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const details = value as Record<string, unknown>;
	if (!Array.isArray(details.tasks) || !details.tasks.every(isTask) || !Number.isSafeInteger(details.nextId)) return false;
	const tasks = details.tasks as Task[];
	const ids = new Set(tasks.map((task) => task.id));
	const maxId = tasks.reduce((max, task) => Math.max(max, task.id), 0);
	if (ids.size !== tasks.length || (details.nextId as number) <= maxId) return false;
	if (tasks.some((task) => task.blockedBy?.some((id) => !ids.has(id) || id === task.id))) return false;
	return !detectCycle(tasks, -1, []);
}

/** Restore the latest valid todo snapshot from the current conversation branch. */
export function replayFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TaskState {
	let result: TaskState = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
	for (const entry of ctx.sessionManager.getBranch()) {
		const e = entry as { type?: string; message?: { role?: string; toolName?: string; details?: unknown } };
		const message = e.type === "message" ? e.message : undefined;
		if (message?.role !== "toolResult" || message.toolName !== "todo" || !isTaskDetails(message.details)) continue;
		result = {
			tasks: message.details.tasks.map((task) => ({ ...task, blockedBy: task.blockedBy ? [...task.blockedBy] : undefined })),
			nextId: message.details.nextId,
		};
	}
	return result;
}
