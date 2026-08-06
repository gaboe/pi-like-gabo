import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

// ---------------------------------------------------------------------------
// Tool / command identity — verbatim string boundaries.
// Tool name "todo" is the persistence key for branch replay (filtering
// `toolResult.toolName === "todo"`) AND the permissions entry at
// `templates/pi-permissions.jsonc:26`. DO NOT rename.
// ---------------------------------------------------------------------------

export const TOOL_NAME = "todo";
export const TOOL_LABEL = "Todo";
export const COMMAND_NAME = "todos";

// ---------------------------------------------------------------------------
// User-facing strings (kept stable for /todos UX parity).
// ---------------------------------------------------------------------------

export const ERR_REQUIRES_INTERACTIVE = "/todos requires interactive mode";
export const MSG_NO_TODOS = "No todos yet. Ask the agent to add some!";

// ---------------------------------------------------------------------------
// Public domain types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "waiting:user" | "waiting:jobs" | "completed" | "deleted";

export type JobStatus = "running" | "wake" | "succeeded" | "failed" | "killed" | "timed_out";

export interface JobStateEvent {
	id: string;
	status: JobStatus;
	settledAt?: number | string;
	error?: string;
}

export interface JobWaitEvidence {
	id: string;
	status: Exclude<JobStatus, "running">;
	settledAt?: number;
	error?: string;
}

export type TaskWait =
	| { kind: "user"; questions: string[] }
	| {
			kind: "jobs";
			jobIds: string[];
			mode: "all" | "any";
			deadline: number;
			settled: Record<string, JobWaitEvidence>;
	  };

export type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear";

export type TaskReviewStatus = "pending" | "approved" | "rejected";

export interface TaskReview {
	status: TaskReviewStatus;
	generation: number;
	token: string;
	completionRevision: number;
	requestedAt: number;
	dispatchedAt?: number;
	reviewedAt?: number;
	failedAt?: number;
	/** Failed dispatches so far. Drives retry backoff and the give-up transition. */
	attempts?: number;
	reviewer: { id: string; model: string };
	feedback?: string;
}

export interface Task {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TaskStatus;
	/** Required audit record when status is completed. */
	result?: string;
	evidence?: string[];
	review?: TaskReview;
	blockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
	wait?: TaskWait;
	waitEvidence?: JobWaitEvidence[];
}

/**
 * Bounded renderer projection. Versioned custom snapshots own replay; legacy
 * tool-result snapshots remain accepted by `state/replay.ts`.
 */
export interface TaskDetails {
	action: TaskAction;
	params: Pick<TaskMutationParams, "status" | "addBlockedBy" | "removeBlockedBy">;
	task?: Pick<Task, "status">;
	error?: string;
}

/**
 * Open-shape input bag the reducer accepts. Stays an interface so the index
 * signature (`[key: string]: unknown`) lets the runtime pass through TypeBox
 * `Static<typeof TodoParamsSchema>` without `as` casts.
 */
export interface TaskMutationParams {
	[key: string]: unknown;
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: TaskStatus;
	result?: string;
	evidence?: string[];
	blockedBy?: number[];
	addBlockedBy?: number[];
	removeBlockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
	id?: number;
	includeDeleted?: boolean;
	questions?: string[];
	jobIds?: string[];
	jobMode?: "all" | "any";
	timeoutSeconds?: number;
}

// ---------------------------------------------------------------------------
// TypeBox parameter schema — every `description` doubles as LLM-facing prompt
// copy. Field order and wording are pinned by registration tests and the
// pre-refactor schema at `packages/rpiv-todo/todo.ts:512-573`.
// ---------------------------------------------------------------------------

export const TodoParamsSchema = Type.Object({
	action: StringEnum(["create", "update", "list", "get", "delete", "clear"] as const),
	subject: Type.Optional(Type.String({ description: "Task subject line (required for create)" })),
	description: Type.Optional(Type.String({ description: "Long-form task description" })),
	activeForm: Type.Optional(
		Type.String({
			description: "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')",
		}),
	),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "waiting:user", "waiting:jobs", "completed", "deleted"] as const, {
			description: "Target status (update) or list filter (list)",
		}),
	),
	result: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 4_000,
			description: "Concrete outcome required when completing a task; trimmed and stored for audit",
		}),
	),
	evidence: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), {
			minItems: 1,
			maxItems: 8,
			description: "One to eight concrete verification entries required when completing a task; trimmed and stored for audit",
		}),
	),
	questions: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
			minItems: 1,
			maxItems: 8,
			description: "Exact concrete questions required when setting status to waiting:user (1-8)",
		}),
	),
	jobIds: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
			minItems: 1,
			maxItems: 64,
			description: "Unique running job ids required when setting status to waiting:jobs",
		}),
	),
	jobMode: Type.Optional(
		StringEnum(["all", "any"] as const, {
			description: "Wake after all linked jobs settle or after any linked job settles",
		}),
	),
	timeoutSeconds: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 86400,
			description: "Bounded relative timeout in seconds for waiting:jobs (1-86400); the extension owns the deadline",
		}),
	),
	blockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Initial blockedBy ids (create only)",
		}),
	),
	addBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Task ids to add to blockedBy (update only, additive merge)",
		}),
	),
	removeBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Task ids to remove from blockedBy (update only, additive merge)",
		}),
	),
	owner: Type.Optional(Type.String({ description: "Agent/owner assigned to this task" })),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description:
				"Arbitrary metadata except reserved orchestration keys; pass null value for a key to delete that key on update",
		}),
	),
	id: Type.Optional(
		Type.Number({
			description: "Task id (required for update, get, delete)",
		}),
	),
	includeDeleted: Type.Optional(
		Type.Boolean({
			description: "If true, list action returns deleted (tombstoned) tasks as well. Default: false.",
		}),
	),
});

export type TodoParams = Static<typeof TodoParamsSchema>;
