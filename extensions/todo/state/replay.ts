import { isDeepStrictEqual } from "node:util";
import type { JobWaitEvidence, Task, TaskStatus, TaskWait } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.js";
import { detectCycle } from "./task-graph.js";

const STATUSES = new Set<TaskStatus>(["pending", "in_progress", "waiting:user", "waiting:jobs", "completed", "deleted"]);
const TERMINAL_JOB_STATUSES = new Set(["wake", "succeeded", "failed", "killed", "timed_out"]);

export const TODO_SNAPSHOT_TYPE = "rpiv-todo:snapshot";
export const TODO_SNAPSHOT_VERSION = 1;
export const TODO_PATCH_VERSION = 2;

export interface TodoSnapshot {
	version: typeof TODO_SNAPSHOT_VERSION;
	revision: number;
	tasks: Task[];
	nextId: number;
	orchestrator?: { setting: "on" | "off" | "auto"; sticky?: boolean };
}

export interface TodoPatch {
	version: typeof TODO_PATCH_VERSION;
	baseRevision: number;
	revision: number;
	upsertedTasks: Task[];
	removedIds: number[];
	taskOrder: number[];
	nextId: number;
	orchestrator: TaskState["orchestrator"] | null;
}

function isEvidence(value: unknown): value is JobWaitEvidence {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const evidence = value as Record<string, unknown>;
	return (
		typeof evidence.id === "string" &&
		evidence.id.length > 0 &&
		TERMINAL_JOB_STATUSES.has(evidence.status as string) &&
		(evidence.settledAt === undefined || (typeof evidence.settledAt === "number" && Number.isFinite(evidence.settledAt))) &&
		(evidence.error === undefined || typeof evidence.error === "string")
	);
}

function isWait(value: unknown): value is TaskWait {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const wait = value as Record<string, unknown>;
	if (wait.kind === "user") {
		return (
			Array.isArray(wait.questions) &&
			wait.questions.length >= 1 &&
			wait.questions.length <= 8 &&
			wait.questions.every((question) => typeof question === "string" && question.trim())
		);
	}
	if (wait.kind !== "jobs") return false;
	const jobIds = wait.jobIds as unknown[];
	if (
		!Array.isArray(jobIds) ||
		jobIds.length < 1 ||
		jobIds.some((id) => typeof id !== "string" || !id) ||
		new Set(jobIds).size !== jobIds.length ||
		(wait.mode !== "all" && wait.mode !== "any") ||
		typeof wait.deadline !== "number" ||
		!Number.isFinite(wait.deadline) ||
		!wait.settled ||
		typeof wait.settled !== "object" ||
		Array.isArray(wait.settled)
	) {
		return false;
	}
	return Object.entries(wait.settled).every(([id, evidence]) => jobIds.includes(id) && isEvidence(evidence) && evidence.id === id);
}

function isTask(value: unknown): value is Task {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const task = value as Record<string, unknown>;
	const valid =
		Number.isSafeInteger(task.id) &&
		(task.id as number) > 0 &&
		typeof task.subject === "string" &&
		task.subject.trim().length > 0 &&
		STATUSES.has(task.status as TaskStatus) &&
		(task.blockedBy === undefined || (Array.isArray(task.blockedBy) && task.blockedBy.every((id) => Number.isSafeInteger(id) && id > 0))) &&
		(task.waitEvidence === undefined || (Array.isArray(task.waitEvidence) && task.waitEvidence.every(isEvidence)));
	if (!valid) return false;
	if (task.status === "waiting:user" || task.status === "waiting:jobs") {
		return isWait(task.wait) && task.wait.kind === task.status.slice("waiting:".length);
	}
	return task.wait === undefined;
}

/** Reject malformed or graph-invalid historical state instead of poisoning the live store. */
export interface LegacyTaskDetails {
	tasks: Task[];
	nextId: number;
}

/** Structural guard for pre-snapshot tool-result replay only. */
export function isLegacyTaskDetails(value: unknown): value is LegacyTaskDetails {
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

export function isTodoSnapshot(value: unknown): value is TodoSnapshot {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const snapshot = value as Record<string, unknown>;
	return (
		snapshot.version === TODO_SNAPSHOT_VERSION &&
		Number.isSafeInteger(snapshot.revision) &&
		(snapshot.revision as number) >= 0 &&
		isLegacyTaskDetails({ tasks: snapshot.tasks, nextId: snapshot.nextId }) &&
		(snapshot.orchestrator === undefined ||
			(typeof snapshot.orchestrator === "object" &&
				snapshot.orchestrator !== null &&
				["on", "off", "auto"].includes((snapshot.orchestrator as { setting?: unknown }).setting as string)))
	);
}

export function isTodoPatch(value: unknown): value is TodoPatch {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const patch = value as Record<string, unknown>;
	return (
		patch.version === TODO_PATCH_VERSION &&
		Number.isSafeInteger(patch.baseRevision) &&
		Number.isSafeInteger(patch.revision) &&
		(patch.baseRevision as number) >= 0 &&
		(patch.revision as number) > (patch.baseRevision as number) &&
		Array.isArray(patch.upsertedTasks) &&
		patch.upsertedTasks.every(isTask) &&
		new Set((patch.upsertedTasks as Task[]).map((task) => task.id)).size === patch.upsertedTasks.length &&
		Array.isArray(patch.removedIds) &&
		patch.removedIds.every((id) => Number.isSafeInteger(id) && id > 0) &&
		new Set(patch.removedIds).size === patch.removedIds.length &&
		Array.isArray(patch.taskOrder) &&
		patch.taskOrder.every((id) => Number.isSafeInteger(id) && id > 0) &&
		new Set(patch.taskOrder).size === patch.taskOrder.length &&
		Number.isSafeInteger(patch.nextId) &&
		(patch.orchestrator === null ||
			(typeof patch.orchestrator === "object" &&
				patch.orchestrator !== null &&
				["on", "off", "auto"].includes((patch.orchestrator as { setting?: unknown }).setting as string)))
	);
}

function cloneTasks(tasks: readonly Task[]): Task[] {
	return tasks.map((task) => ({
		...task,
		blockedBy: task.blockedBy ? [...task.blockedBy] : undefined,
		metadata: task.metadata ? { ...task.metadata } : undefined,
		wait:
			task.wait?.kind === "user"
				? { kind: "user", questions: [...task.wait.questions] }
				: task.wait?.kind === "jobs"
					? {
							...task.wait,
							jobIds: [...task.wait.jobIds],
							settled: { ...task.wait.settled },
						}
					: undefined,
		waitEvidence: task.waitEvidence?.map((evidence) => ({ ...evidence })),
	}));
}

export function createTodoSnapshot(state: TaskState): TodoSnapshot {
	return {
		version: TODO_SNAPSHOT_VERSION,
		revision: state.revision,
		tasks: cloneTasks(state.tasks),
		nextId: state.nextId,
		...(state.orchestrator ? { orchestrator: { ...state.orchestrator } } : {}),
	};
}

export function createTodoPatch(previous: TaskState, next: TaskState): TodoPatch {
	const previousTasks = new Map(previous.tasks.map((task) => [task.id, task]));
	const nextIds = new Set(next.tasks.map((task) => task.id));
	return {
		version: TODO_PATCH_VERSION,
		baseRevision: previous.revision,
		revision: next.revision,
		upsertedTasks: cloneTasks(next.tasks.filter((task) => !isDeepStrictEqual(previousTasks.get(task.id), task))),
		removedIds: previous.tasks.filter((task) => !nextIds.has(task.id)).map((task) => task.id),
		taskOrder: next.tasks.map((task) => task.id),
		nextId: next.nextId,
		orchestrator: next.orchestrator ? { ...next.orchestrator } : null,
	};
}

/** Restore the latest valid todo snapshot from the current conversation branch. */
export function replayFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TaskState {
	let result: TaskState = {
		tasks: [...EMPTY_STATE.tasks],
		nextId: EMPTY_STATE.nextId,
		revision: EMPTY_STATE.revision,
	};
	let sawVersionedSnapshot = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		const e = entry as {
			type?: string;
			customType?: string;
			data?: unknown;
			message?: { role?: string; toolName?: string; details?: unknown };
		};
		if (e.type === "custom" && e.customType === TODO_SNAPSHOT_TYPE) {
			if (isTodoSnapshot(e.data)) {
				sawVersionedSnapshot = true;
				if (e.data.revision >= result.revision) {
					result = {
						tasks: cloneTasks(e.data.tasks),
						nextId: e.data.nextId,
						revision: e.data.revision,
						...(e.data.orchestrator ? { orchestrator: { ...e.data.orchestrator } } : {}),
					};
				}
				continue;
			}
			if (isTodoPatch(e.data) && e.data.baseRevision === result.revision) {
				const removed = new Set(e.data.removedIds);
				const available = new Map(result.tasks.filter((task) => !removed.has(task.id)).map((task) => [task.id, task]));
				for (const task of cloneTasks(e.data.upsertedTasks)) available.set(task.id, task);
				if (available.size !== e.data.taskOrder.length || e.data.taskOrder.some((id) => !available.has(id))) continue;
				const tasks = e.data.taskOrder.map((id) => available.get(id)!);
				const candidate = {
					tasks,
					nextId: e.data.nextId,
					revision: e.data.revision,
					...(e.data.orchestrator ? { orchestrator: { ...e.data.orchestrator } } : {}),
				};
				if (isLegacyTaskDetails(candidate)) {
					result = candidate;
					sawVersionedSnapshot = true;
				}
				continue;
			}
		}
		const message = e.type === "message" ? e.message : undefined;
		if (sawVersionedSnapshot || message?.role !== "toolResult" || message.toolName !== "todo" || !isLegacyTaskDetails(message.details)) continue;
		const tasks = cloneTasks(message.details.tasks);
		const changed = JSON.stringify([result.tasks, result.nextId]) !== JSON.stringify([tasks, message.details.nextId]);
		result = {
			tasks,
			nextId: message.details.nextId,
			revision: changed ? result.revision + 1 : result.revision,
		};
	}
	return result;
}
