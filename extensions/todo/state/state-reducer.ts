import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Task, TaskAction, TaskMutationParams, TaskReview, TaskStatus } from "../tool/types.js";
import { COMPLETION_REVIEW_MODEL, COMPLETION_REVIEWER_ID, isTaskArchivable } from "./completion.js";
import { isTransitionValid } from "./invariants.js";
import type { TaskState } from "./state.js";
import { detectCycle } from "./task-graph.js";

/**
 * Reducer outcome. Closed tagged union — adding a new action requires extending
 * this union AND the response-envelope's `formatContent` switch (compiler-
 * enforced exhaustive). Mirrors the `Effect` pattern in
 * `packages/rpiv-ask-user-question/state/state-reducer.ts:14-30`.
 *
 * `error` carries the message in-band so callers can pattern-match on
 * `op.kind === "error"` without a side-channel boolean.
 */
export type Op =
	| { kind: "create"; taskId: number }
	| { kind: "update"; id: number; fromStatus: TaskStatus; toStatus: TaskStatus }
	| { kind: "delete"; id: number; subject: string }
	| { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean }
	| { kind: "get"; task: Task }
	| { kind: "clear"; count: number }
	| { kind: "error"; message: string };

export interface ApplyResult {
	state: TaskState;
	op: Op;
}

export const MIN_JOB_TIMEOUT_SECONDS = 1;
export const MAX_JOB_TIMEOUT_SECONDS = 86_400;

function nextRevision(state: TaskState): number {
	return (state.revision ?? 0) + 1;
}

function normalizeQuestions(value: string[] | undefined): string[] | undefined {
	if (!value || value.length < 1 || value.length > 8) return undefined;
	const questions = value.map((question) => question.trim());
	return questions.every(Boolean) && new Set(questions).size === questions.length ? questions : undefined;
}

function normalizeCompletion(params: TaskMutationParams): { result: string; evidence: string[] } | undefined {
	if (typeof params.result !== "string" || !Array.isArray(params.evidence) || params.evidence.length < 1 || params.evidence.length > 8) return undefined;
	const result = params.result.trim();
	const evidence = params.evidence.map((entry) => typeof entry === "string" ? entry.trim() : "");
	return result && evidence.every(Boolean) ? { result, evidence } : undefined;
}

function errorResult(state: TaskState, message: string): ApplyResult {
	return { state, op: { kind: "error", message } };
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function scopeChanged(
	current: Task,
	updated: Task,
	params: TaskMutationParams,
): boolean {
	if (params.subject !== undefined && current.subject !== updated.subject) return true;
	if (params.description !== undefined && current.description !== updated.description) return true;
	const dependencies = (task: Task) => [...new Set(task.blockedBy ?? [])].sort((a, b) => a - b);
	if (!isDeepStrictEqual(dependencies(current), dependencies(updated))) return true;
	if (!params.metadata) return false;
	return Object.keys(params.metadata).some((key) =>
		!isDeepStrictEqual(current.metadata?.[key], updated.metadata?.[key]),
	);
}

function rotateIncarnation(
	state: TaskState,
	current: Task,
	updated: Task,
	createToken: () => string,
): void {
	const previous = record(current.metadata?.preparation);
	const metadata = { ...updated.metadata };
	metadata.preparation = {
		status: "queued",
		version: typeof previous?.version === "number" ? previous.version + 1 : 1,
		token: createToken(),
		sourceRevision: nextRevision(state),
	};
	delete metadata.delegation;
	updated.metadata = metadata;
}

export interface CompletionReviewIdentity {
	taskId: number;
	generation: number;
	token: string;
	completionRevision: number;
}

function matchingPendingReview(task: Task | undefined, identity: CompletionReviewIdentity): task is Task & { review: TaskReview } {
	return Boolean(
		task?.review?.status === "pending" &&
		task.id === identity.taskId &&
		task.review.generation === identity.generation &&
		task.review.token === identity.token &&
		task.review.completionRevision === identity.completionRevision,
	);
}

function replaceTask(state: TaskState, task: Task): TaskState {
	return {
		...state,
		tasks: state.tasks.map((candidate) => candidate.id === task.id ? task : candidate),
		revision: nextRevision(state),
	};
}

/** Atomically claim one persisted pending review before starting its worker. */
export function claimCompletionReview(
	state: TaskState,
	identity: CompletionReviewIdentity,
	dispatchedAt = Date.now(),
): TaskState {
	const task = state.tasks.find((candidate) => candidate.id === identity.taskId);
	if (!matchingPendingReview(task, identity) || task.review.dispatchedAt !== undefined) return state;
	return replaceTask(state, {
		...task,
		review: { ...task.review, dispatchedAt },
	});
}

export function settleCompletionReview(
	state: TaskState,
	identity: CompletionReviewIdentity,
	result: {
		decision: "approved" | "rejected";
		feedback: string;
		reviewerId: string;
		model: string;
		reviewedAt?: number;
	},
): TaskState {
	const task = state.tasks.find((candidate) => candidate.id === identity.taskId);
	if (!matchingPendingReview(task, identity)) return state;
	return replaceTask(state, {
		...task,
		status: result.decision === "rejected" ? "in_progress" : task.status,
		review: {
			...task.review,
			status: result.decision,
			reviewedAt: result.reviewedAt ?? Date.now(),
			reviewer: { id: result.reviewerId, model: result.model },
			feedback: result.feedback.trim().slice(0, 4_000),
		},
	});
}

export function failCompletionReview(
	state: TaskState,
	identity: CompletionReviewIdentity,
	feedback: string,
	failedAt = Date.now(),
): TaskState {
	const task = state.tasks.find((candidate) => candidate.id === identity.taskId);
	if (!matchingPendingReview(task, identity)) return state;
	return replaceTask(state, {
		...task,
		review: {
			...task.review,
			failedAt,
			feedback: feedback.trim().slice(0, 4_000),
		},
	});
}

/**
 * Pure reducer: (state, action, params) → (state, op). Mirrors the
 * `applyTaskMutation` of pre-refactor `todo.ts` minus content/details
 * formatting; the response envelope (`tool/response-envelope.ts`) owns
 * formatting, the store (`state/store.ts`) owns commit.
 *
 * Validation is in-line: structural guards (`subject required`, `id required`,
 * `at least one mutable field`) plus state-aware checks (transition legality,
 * dangling/deleted blockedBy, self-block, cycles). Decision: validation stays
 * in-reducer — see Plan §Decisions §Decision 2.
 */
export function applyTaskMutation(
	state: TaskState,
	action: TaskAction,
	params: TaskMutationParams,
	now = Date.now(),
	createToken = randomUUID,
): ApplyResult {
	switch (action) {
		case "create": {
			if (params.result !== undefined || params.evidence !== undefined) {
				return errorResult(state, "result and evidence require status completed");
			}
			if (!params.subject?.trim()) {
				return errorResult(state, "subject required for create");
			}
			if (params.blockedBy?.length) {
				for (const dep of params.blockedBy) {
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `blockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `blockedBy: #${dep} is deleted`);
				}
			}
			const newTask: Task = {
				id: state.nextId,
				subject: params.subject,
				status: "pending",
			};
			if (params.description) newTask.description = params.description;
			if (params.activeForm) newTask.activeForm = params.activeForm;
			if (params.blockedBy?.length) newTask.blockedBy = [...params.blockedBy];
			if (params.owner) newTask.owner = params.owner;
			if (params.metadata) newTask.metadata = { ...params.metadata };

			const newTasks = [...state.tasks, newTask];
			return {
				state: { ...state, tasks: newTasks, nextId: state.nextId + 1, revision: nextRevision(state) },
				op: { kind: "create", taskId: newTask.id },
			};
		}

		case "update": {
			if (params.id === undefined) return errorResult(state, "id required for update");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];

			const hasMutation =
				params.subject !== undefined ||
				params.description !== undefined ||
				params.activeForm !== undefined ||
				params.status !== undefined ||
				params.result !== undefined ||
				params.evidence !== undefined ||
				params.owner !== undefined ||
				params.metadata !== undefined ||
				params.questions !== undefined ||
				params.jobIds !== undefined ||
				params.jobMode !== undefined ||
				params.timeoutSeconds !== undefined ||
				(params.addBlockedBy && params.addBlockedBy.length > 0) ||
				(params.removeBlockedBy && params.removeBlockedBy.length > 0);
			if (!hasMutation) return errorResult(state, "update requires at least one mutable field");

			let newStatus = current.status;
			if (params.status !== undefined) {
				if (!isTransitionValid(current.status, params.status)) {
					return errorResult(state, `illegal transition ${current.status} → ${params.status}`);
				}
				if (params.status === "completed" && current.wait?.kind === "jobs") {
					return errorResult(state, "cannot complete while a jobs wait remains active");
				}
				newStatus = params.status;
			}

			const completing = current.status !== "completed" && newStatus === "completed";
			if (newStatus !== "completed" && (params.result !== undefined || params.evidence !== undefined)) {
				return errorResult(state, "result and evidence require status completed");
			}
			const completion = completing ? normalizeCompletion(params) : undefined;
			if (completing && !completion) {
				if (typeof params.result !== "string" || !params.result.trim()) return errorResult(state, "completed requires a non-empty result");
				return errorResult(state, "completed requires at least one non-empty evidence entry");
			}

			let wait = current.wait;
			if (newStatus === "waiting:user") {
				const questions = normalizeQuestions(params.questions ?? (wait?.kind === "user" ? wait.questions : undefined));
				if (!questions) return errorResult(state, "waiting:user requires 1-8 unique non-empty questions");
				wait = { kind: "user", questions };
			} else if (newStatus === "waiting:jobs") {
				const previous = wait?.kind === "jobs" ? wait : undefined;
				const reconfigure =
					!previous ||
					params.jobIds !== undefined ||
					params.jobMode !== undefined ||
					params.timeoutSeconds !== undefined;
				if (!reconfigure) {
					wait = previous;
				} else {
					const jobIds = params.jobIds ?? previous?.jobIds;
					const mode = params.jobMode ?? previous?.mode;
					const timeoutSeconds = params.timeoutSeconds;
					if (!jobIds?.length || new Set(jobIds).size !== jobIds.length || jobIds.some((id) => !id.trim())) {
						return errorResult(state, "waiting:jobs requires unique non-empty jobIds");
					}
					if (!mode) return errorResult(state, "waiting:jobs requires jobMode all or any");
					if (
						timeoutSeconds === undefined ||
						!Number.isInteger(timeoutSeconds) ||
						timeoutSeconds < MIN_JOB_TIMEOUT_SECONDS ||
						timeoutSeconds > MAX_JOB_TIMEOUT_SECONDS
					) {
						return errorResult(
							state,
							`waiting:jobs requires timeoutSeconds ${MIN_JOB_TIMEOUT_SECONDS}-${MAX_JOB_TIMEOUT_SECONDS}`,
						);
					}
					wait = {
						kind: "jobs",
						jobIds: [...jobIds],
						mode,
						deadline: now + timeoutSeconds * 1000,
						settled: {},
					};
				}
			} else {
				if (params.questions || params.jobIds || params.jobMode || params.timeoutSeconds !== undefined) {
					return errorResult(state, "wait fields require status waiting:user or waiting:jobs");
				}
				wait = undefined;
			}

			let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
			if (params.removeBlockedBy?.length) {
				const toRemove = new Set(params.removeBlockedBy);
				newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
			}
			if (params.addBlockedBy?.length) {
				for (const dep of params.addBlockedBy) {
					if (dep === current.id) return errorResult(state, `cannot block #${current.id} on itself`);
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `addBlockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `addBlockedBy: #${dep} is deleted`);
					if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
				}
				if (detectCycle(state.tasks, current.id, newBlockedBy)) {
					return errorResult(state, "addBlockedBy would create a cycle in the blockedBy graph");
				}
			}

			let newMetadata = current.metadata;
			if (params.metadata !== undefined) {
				const merged: Record<string, unknown> = { ...(current.metadata ?? {}) };
				for (const [k, v] of Object.entries(params.metadata)) {
					if (v === null) delete merged[k];
					else merged[k] = v;
				}
				newMetadata = Object.keys(merged).length ? merged : undefined;
			}

			const updated: Task = { ...current, status: newStatus };
			if (params.subject !== undefined) updated.subject = params.subject;
			if (params.description !== undefined) updated.description = params.description;
			if (params.activeForm !== undefined) updated.activeForm = params.activeForm;
			if (params.owner !== undefined) updated.owner = params.owner;
			if (newBlockedBy.length) updated.blockedBy = newBlockedBy;
			else delete updated.blockedBy;
			if (newMetadata === undefined) delete updated.metadata;
			else updated.metadata = newMetadata;
			if (wait) updated.wait = wait;
			else delete updated.wait;
			if (completion) {
				const completionRevision = nextRevision(state);
				updated.result = completion.result;
				updated.evidence = completion.evidence;
				updated.review = {
					status: "pending",
					generation: (current.review?.generation ?? 0) + 1,
					token: createToken(),
					completionRevision,
					requestedAt: now,
					reviewer: { id: COMPLETION_REVIEWER_ID, model: COMPLETION_REVIEW_MODEL },
				};
			} else if (newStatus !== "completed" && current.review?.status !== "rejected") {
				delete updated.result;
				delete updated.evidence;
			}
			if (newStatus === "waiting:user" || newStatus === "waiting:jobs") delete updated.waitEvidence;
			if (scopeChanged(current, updated, params)) rotateIncarnation(state, current, updated, createToken);

			if (isDeepStrictEqual(updated, current)) {
				return {
					state,
					op: { kind: "update", id: current.id, fromStatus: current.status, toStatus: current.status },
				};
			}
			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return {
				state: { ...state, tasks: newTasks, revision: nextRevision(state) },
				op: { kind: "update", id: updated.id, fromStatus: current.status, toStatus: newStatus },
			};
		}

		case "list": {
			return {
				state,
				op: {
					kind: "list",
					includeDeleted: params.includeDeleted === true,
					...(params.status !== undefined ? { statusFilter: params.status } : {}),
				},
			};
		}

		case "get": {
			if (params.id === undefined) return errorResult(state, "id required for get");
			const task = state.tasks.find((t) => t.id === params.id);
			if (!task) return errorResult(state, `#${params.id} not found`);
			return { state, op: { kind: "get", task } };
		}

		case "delete": {
			if (params.id === undefined) return errorResult(state, "id required for delete");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];
			if (current.status === "deleted") return errorResult(state, `#${current.id} is already deleted`);
			if (!isTaskArchivable(current)) {
				return errorResult(
					state,
					`cannot delete unresolved #${current.id}; complete it with result, evidence, and approved review first`,
				);
			}
			const updated: Task = { ...current, status: "deleted" };
			delete updated.wait;
			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return {
				state: { ...state, tasks: newTasks, revision: nextRevision(state) },
				op: { kind: "delete", id: updated.id, subject: updated.subject },
			};
		}

		case "clear": {
			const unresolved = state.tasks.filter(
				(task) => task.status !== "deleted" && !isTaskArchivable(task),
			);
			if (unresolved.length > 0) {
				return errorResult(state, `clear requires all visible tasks completed with owned work settled; unresolved: ${unresolved.map((task) => `#${task.id}`).join(", ")}`);
			}
			const count = state.tasks.filter(isTaskArchivable).length;
			if (count === 0) return { state, op: { kind: "clear", count } };
			const archived = state.tasks.map((task) =>
				isTaskArchivable(task) ? { ...task, status: "deleted" as const } : task,
			);
			return {
				state: { ...state, tasks: archived, revision: nextRevision(state) },
				op: { kind: "clear", count },
			};
		}
	}
}
