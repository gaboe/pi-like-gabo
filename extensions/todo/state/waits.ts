import type { JobStateEvent, JobWaitEvidence, Task } from "../tool/types.js";
import type { TaskState } from "./state.js";

const TERMINAL_JOB_STATUSES = new Set(["wake", "succeeded", "failed", "killed", "timed_out"]);

export function isJobStateEvent(value: unknown): value is JobStateEvent {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const event = value as Record<string, unknown>;
	return (
		typeof event.id === "string" &&
		event.id.length > 0 &&
		(event.status === "running" || TERMINAL_JOB_STATUSES.has(event.status as string)) &&
		(event.settledAt === undefined ||
			(typeof event.settledAt === "number" && Number.isFinite(event.settledAt)) ||
			(typeof event.settledAt === "string" && Number.isFinite(Date.parse(event.settledAt)))) &&
		(event.error === undefined || typeof event.error === "string")
	);
}

function evidenceFrom(event: JobStateEvent, now: number): JobWaitEvidence | undefined {
	if (event.status === "running") return undefined;
	return {
		id: event.id,
		status: event.status,
		settledAt:
			typeof event.settledAt === "number"
				? event.settledAt
				: typeof event.settledAt === "string"
					? Date.parse(event.settledAt)
					: now,
		...(event.error ? { error: event.error } : {}),
	};
}

function withRevision(state: TaskState, tasks: Task[]): TaskState {
	return { ...state, tasks, revision: (state.revision ?? 0) + 1 };
}

/** Record a typed terminal job event and wake waits according to their all/any policy. */
export function applyJobState(state: TaskState, event: JobStateEvent, now = Date.now()): TaskState {
	const evidence = evidenceFrom(event, now);
	if (!evidence) return state;
	let changed = false;
	const tasks = state.tasks.map((task) => {
		if (task.status !== "waiting:jobs" || task.wait?.kind !== "jobs" || !task.wait.jobIds.includes(event.id)) {
			return task;
		}
		if (task.wait.settled[event.id]) return task;
		const settled = { ...task.wait.settled, [event.id]: evidence };
		const wake = task.wait.mode === "any" || task.wait.jobIds.every((id) => settled[id]);
		changed = true;
		if (!wake) return { ...task, wait: { ...task.wait, settled } };
		const updated: Task = {
			...task,
			status: "pending",
			waitEvidence: task.wait.jobIds.flatMap((id) => (settled[id] ? [settled[id]] : [])),
		};
		delete updated.wait;
		return updated;
	});
	return changed ? withRevision(state, tasks) : state;
}

/** Orchestrator-owned deadline expiry; provider/job timers are never trusted for this. */
export function expireJobWaits(state: TaskState, now = Date.now()): TaskState {
	let changed = false;
	const tasks = state.tasks.map((task) => {
		if (task.status !== "waiting:jobs" || task.wait?.kind !== "jobs" || task.wait.deadline > now) return task;
		changed = true;
		const evidence = task.wait.jobIds.map(
			(id): JobWaitEvidence =>
				task.wait?.kind === "jobs" && task.wait.settled[id]
					? task.wait.settled[id]
					: { id, status: "timed_out", settledAt: now, error: "Todo wait deadline exceeded" },
		);
		const updated: Task = { ...task, status: "pending", waitEvidence: evidence };
		delete updated.wait;
		return updated;
	});
	return changed ? withRevision(state, tasks) : state;
}

export function nextJobDeadline(state: TaskState): number | undefined {
	let deadline: number | undefined;
	for (const task of state.tasks) {
		if (task.status !== "waiting:jobs" || task.wait?.kind !== "jobs") continue;
		deadline = deadline === undefined ? task.wait.deadline : Math.min(deadline, task.wait.deadline);
	}
	return deadline;
}

export function recoverInterruptedPreparations(state: TaskState): TaskState {
	let changed = false;
	const tasks = state.tasks.map((task) => {
		const preparation = task.metadata?.preparation as Record<string, unknown> | undefined;
		const delegation = task.metadata?.delegation as Record<string, unknown> | undefined;
		const preparationActive =
			preparation && ["classifying", "queued", "running"].includes(String(preparation.status));
		const delegationRunning = delegation?.status === "running";
		if (!preparationActive && !delegationRunning) return task;
		changed = true;
		return {
			...task,
			metadata: {
				...task.metadata,
				...(delegationRunning
					? {
							delegation: {
								...delegation,
								status: "interrupted",
								error: "Inspect current diff/worktree before redispatch",
							},
						}
					: {}),
				...(preparationActive
					? {
							preparation: {
								...preparation,
								status: "failed",
								version: typeof preparation.version === "number" ? preparation.version + 1 : 1,
								sourceRevision: state.revision,
								error: "TODO preparation interrupted by session reload",
							},
						}
					: {}),
			},
		};
	});
	return changed ? withRevision(state, tasks) : state;
}

export function isTaskActionable(task: Task, tasks: readonly Task[]): boolean {
	if (task.status !== "pending" && task.status !== "in_progress") return false;
	const preparation = task.metadata?.preparation as { status?: unknown } | undefined;
	if (task.status === "pending" && ["classifying", "queued", "running"].includes(String(preparation?.status))) return false;
	return (task.blockedBy ?? []).every((id) => tasks.find((candidate) => candidate.id === id)?.status === "completed");
}

export function hasActionableTasks(state: TaskState): boolean {
	return state.tasks.some((task) => isTaskActionable(task, state.tasks));
}

/** Exact persisted question text, without paraphrasing. */
export function formatWaitingUserSummary(state: TaskState): string | undefined {
	const waiting = state.tasks.filter((task) => task.status === "waiting:user" && task.wait?.kind === "user");
	if (!waiting.length) return undefined;
	const lines = ["Waiting for user input:"];
	for (const task of waiting) {
		if (task.wait?.kind !== "user") continue;
		lines.push(`#${task.id} ${task.subject}`, ...task.wait.questions.map((question) => `- ${question}`));
	}
	return lines.join("\n");
}
