import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { emitTelemetry } from "../telemetry/protocol.js";
import type { JobsAdapter } from "./jobs-adapter.js";
import {
	isTodoToken,
	SUBAGENT_DELEGATION_STATE_CHANNEL,
	SUBAGENT_WAIT_STATE_CHANNEL,
	type SubagentDelegationState,
	type SubagentWaitState,
} from "../../vendor/pi-tools/extensions/shared/subagent-wait-protocol.js";
import {
	createTodoPatch,
	createTodoSnapshot,
	TODO_SNAPSHOT_TYPE,
} from "./state/replay.js";
import type { TaskState } from "./state/state.js";
import { commitState, getState } from "./state/store.js";
import {
	applyJobState,
	expireJobWaits,
	formatWaitingUserSummary,
	hasActionableTasks,
	isTaskActionable,
	nextJobDeadline,
	recoverInterruptedPreparations,
	recoverRejectedCompletionReviews,
	resumeWaitingUserTasks,
} from "./state/waits.js";
import type { JobStateEvent, Task } from "./tool/types.js";
import { getBackgroundSubagentService } from "../../vendor/pi-tools/extensions/shared/background-subagent-protocol.js";
import {
	claimCompletionReview,
	failCompletionReview,
	settleCompletionReview,
	type CompletionReviewIdentity,
} from "./state/state-reducer.js";
import {
	stickyOrchestrator,
	type OrchestratorSetting,
} from "./orchestrator.js";
import {
	COMPLETION_REVIEW_MODEL,
	isCompletionReviewDispatchable,
	isTaskArchivable,
	nextCompletionReviewRetryAt,
} from "./state/completion.js";

const FULL_SNAPSHOT_INTERVAL = 100;
const REVIEW_DIFF_LIMIT = 24_000;
const REVIEW_DIFF_TIMEOUT_MS = 15_000;
const CHATGPT_PRO_USAGE_LIMIT =
	"You have hit your ChatGPT usage limit (pro plan).";

export function isChatGptProUsageLimit(errorMessage: unknown): boolean {
	return (
		typeof errorMessage === "string" &&
		errorMessage.startsWith(CHATGPT_PRO_USAGE_LIMIT)
	);
}
const execFileAsync = promisify(execFile);

export function parseCompletionReviewResponse(
	response: string,
): { decision: "approved" | "rejected"; feedback: string } | undefined {
	const trimmed = response.trim();
	const json = trimmed.startsWith("```")
		? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
		: trimmed;
	try {
		const value = JSON.parse(json) as Record<string, unknown>;
		if (
			(value.decision !== "approved" && value.decision !== "rejected") ||
			typeof value.feedback !== "string" ||
			!value.feedback.trim()
		)
			return undefined;
		return { decision: value.decision, feedback: value.feedback.trim() };
	} catch {
		return undefined;
	}
}

async function boundedGitDiff(cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["diff", "--no-ext-diff", "--no-textconv", "--unified=3", "--"],
			// maxBuffer bounds output size, not time — and this runs BEFORE service.run,
			// so the worker's own timeoutMs cannot cover a hung Git process.
			{
				cwd,
				maxBuffer: REVIEW_DIFF_LIMIT * 4,
				timeout: REVIEW_DIFF_TIMEOUT_MS,
			},
		);
		const diff = String(stdout);
		if (!diff) return "(current git diff is empty)";
		return diff.length <= REVIEW_DIFF_LIMIT
			? diff
			: `${diff.slice(0, REVIEW_DIFF_LIMIT)}\n[diff truncated at ${REVIEW_DIFF_LIMIT} characters]`;
	} catch (error) {
		return `(current git diff unavailable: ${String(error).slice(0, 512)})`;
	}
}

export function completionReviewCwd(task: Task, fallback: string): string {
	const preparation = task.metadata?.preparation;
	if (!preparation || typeof preparation !== "object") return fallback;
	const analysisCwd = (preparation as { analysisCwd?: unknown }).analysisCwd;
	return typeof analysisCwd === "string" && isAbsolute(analysisCwd)
		? analysisCwd
		: fallback;
}

export function completionReviewPrompt(task: Task, diff: string): string {
	return `Independently review completion of TODO #${task.id}. Judge only whether the result and evidence satisfy the original TODO. Reject concrete gaps; do not perform implementation.

Classify the TODO from its original request before using the diff:
- For implementation or file-editing work, require the claimed change and focused verification to be supported by the evidence and diff.
- For research, analysis, investigation, or drafting work, an empty diff is expected and is not a rejection reason. Judge whether the evidence identifies concrete sources, commands, excerpts, or links and answers every requested question.
- Treat unrelated pre-existing diff content as neither proof nor a defect.

For example, reject a documentation TODO that requested a Mermaid diagram or GitHub links when the reported result or diff omits them, even if other edits are correct.

Original TODO subject:
${task.subject}

Original TODO description:
${task.description ?? "(none)"}

Completion result:
${task.result ?? "(missing)"}

Completion evidence:
${(task.evidence ?? []).map((entry) => `- ${entry}`).join("\n") || "(missing)"}

Bounded current git diff snapshot:
\`\`\`diff
${diff}
\`\`\`

Return exactly one JSON object with no extra text:
{"decision":"approved|rejected","feedback":"Concrete review findings and rationale."}`;
}

export function persistTodoSnapshot(
	pi: Pick<ExtensionAPI, "appendEntry">,
	state = getState(),
	previous = getState(),
): void {
	const data =
		state.revision > previous.revision &&
		state.revision % FULL_SNAPSHOT_INTERVAL !== 0
			? createTodoPatch(previous, state)
			: createTodoSnapshot(state);
	pi.appendEntry(TODO_SNAPSHOT_TYPE, data);
}

export class AutoContinuationGuard {
	private queued = false;
	private autoTurnRevision: number | undefined;
	private noProgressTurns = 0;

	markQueued(): void {
		this.queued = true;
	}

	onAgentStart(revision: number): void {
		if (this.queued) this.autoTurnRevision = revision;
		else {
			this.autoTurnRevision = undefined;
			this.noProgressTurns = 0;
		}
		this.queued = false;
	}

	canContinue(revision: number): boolean {
		if (this.autoTurnRevision !== undefined) {
			this.noProgressTurns =
				revision === this.autoTurnRevision ? this.noProgressTurns + 1 : 0;
			this.autoTurnRevision = undefined;
		}
		return this.noProgressTurns < 2;
	}

	reset(): void {
		this.queued = false;
		this.autoTurnRevision = undefined;
		this.noProgressTurns = 0;
	}
}

const COMPLETION_REPORT = `All visible TODOs passed independent completion review. Call todo clear to archive the approved batch, then send one context-preserving completion report with:
- Outcome: what the user can do now.
- Before → now: the important behavior change and root cause.
- Key code changes: affected paths plus short before/after or diff snippets for non-trivial code changes; omit this section when no code changed and never dump a large raw diff.
- How it works now: the resulting flow and component interactions.
- Verification: exact checks and results.
- Usage or manual step: only when the user must do something.
- Remaining caveats: skipped work, risks, or none.
Keep detail proportional to the change, but preserve enough implementation context that the user does not need the lost agent conversation.`;

export function hasCompletedBatch(state = getState()): boolean {
	const visible = state.tasks.filter((task) => task.status !== "deleted");
	return visible.length > 0 && visible.every(isTaskArchivable);
}

export function yieldInProgressTasks(state: TaskState): TaskState {
	const tasks = state.tasks.map((task) =>
		task.status === "in_progress" ? { ...task, status: "pending" as const } : task,
	);
	return tasks.some((task, index) => task !== state.tasks[index])
		? { ...state, tasks, revision: state.revision + 1 }
		: state;
}

function taskContinuation(
	task: ReturnType<typeof getState>["tasks"][number],
): string {
	const start =
		task.status === "pending"
			? "Mark it in_progress, then start it now."
			: "Continue it now.";
	const preparation = task.metadata?.preparation as
		| { status?: unknown }
		| undefined;
	if (
		preparation?.status === "failed" &&
		(preparation as { code?: unknown }).code === "preparation_failed"
	) {
		return `TODO #${task.id} preparation failed after two attempts. Do not continue implementation from guessed facts. Retry once with a fresh Preparation Analyst, or escalate the missing facts to the user; keep the TODO unresolved.`;
	}
	const prepared =
		preparation?.status === "ready"
			? ` Call todo get for #${task.id} first and use its prepared scope, steps, risks, and candidate questions.`
			: "";
	const rejection =
		task.review?.status === "rejected"
			? ` Address completion review feedback before recompleting: ${task.review.feedback ?? "reviewer requested remediation"}`
			: "";
	return `Continue actionable TODO #${task.id} ${task.subject}. ${start}${prepared}${rejection} Do not poll unrelated waiting jobs; their monitors will wake those TODOs.`;
}

export function actionableContinuation(state = getState()): string {
	const task =
		state.tasks.find(
			(candidate) =>
				candidate.status === "in_progress" &&
				isTaskActionable(candidate, state.tasks),
		) ??
		state.tasks.find(
			(candidate) =>
				candidate.status === "pending" &&
				isTaskActionable(candidate, state.tasks),
		);
	if (!task)
		return "Continue the actionable TODO tasks. Update TODO state as work progresses.";
	return taskContinuation(task);
}

export class TodoScheduler {
	private active = false;
	private context: ExtensionContext | undefined;
	private generation = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private reviewRetryTimer: ReturnType<typeof setTimeout> | undefined;
	private continuationPending = false;
	private agentRunning = false;
	private completionReviewPending = false;
	private lastQuestionSummary: string | undefined;
	private readonly guard = new AutoContinuationGuard();
	private readonly completionGuard = new AutoContinuationGuard();
	private readonly stopJobs: () => void;
	private readonly stopSubagentWaits: () => void;
	private readonly stopSubagentDelegations: () => void;
	private waitingSubagentIds = new Set<string>();
	private readonly delegatedWorkerOwners = new Map<
		string,
		{ taskId: number; token: string }
	>();
	private readonly interruptedWorkerOwners = new Map<
		string,
		{ taskId: number; token: string }
	>();
	private automationPaused = false;
	private turnHadToolProgress = false;
	private readonly cancellationsInFlight = new Set<string>();

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly jobs: JobsAdapter,
		private readonly onStateChanged: () => void,
	) {
		this.stopJobs = jobs.onState((event) =>
			this.handleJobState(event, event.status === "killed"),
		);
		this.stopSubagentWaits =
			pi.events?.on(SUBAGENT_WAIT_STATE_CHANNEL, (value) => {
				const ids = (value as SubagentWaitState | undefined)?.ids;
				this.waitingSubagentIds = new Set(
					Array.isArray(ids)
						? ids.filter((id): id is string => typeof id === "string")
						: [],
				);
			}) ?? (() => {});
		this.stopSubagentDelegations =
			pi.events?.on(SUBAGENT_DELEGATION_STATE_CHANNEL, (value) =>
				this.reconcileDelegations(value as SubagentDelegationState | undefined),
			) ?? (() => {});
	}

	private cancellationRequest(
		taskId: number,
		todoToken: string,
		ids: string[],
	):
		| {
				taskId: number;
				todoToken: string;
				taskStatus: string;
				generation: number;
				ids: string[];
		  }
		| undefined {
		const state = getState();
		const task = state.tasks.find((candidate) => candidate.id === taskId);
		const delegation = task?.metadata?.delegation as
			| Record<string, unknown>
			| undefined;
		if (
			!task ||
			delegation?.todoId !== taskId ||
			delegation.todoToken !== todoToken
		)
			return undefined;
		const priorIds = Array.isArray(delegation.subagentIds)
			? delegation.subagentIds
			: [];
		const sameIntent =
			delegation.status === "cancelling" &&
			delegation.cancellationTaskStatus === task.status &&
			priorIds.length === ids.length &&
			priorIds.every((id, index) => id === ids[index]);
		const priorGeneration =
			Number.isSafeInteger(delegation.cancellationGeneration) &&
			Number(delegation.cancellationGeneration) > 0
				? Number(delegation.cancellationGeneration)
				: 0;
		const generation = sameIntent
			? Math.max(1, priorGeneration)
			: priorGeneration === Number.MAX_SAFE_INTEGER
				? 1
				: priorGeneration + 1;
		const priorAttempts = Number.isSafeInteger(delegation.cancellationAttempts)
			? Math.max(0, Number(delegation.cancellationAttempts))
			: 0;
		const nextDelegation = {
			status: "cancelling",
			subagentIds: [...ids],
			subagentId: ids[0],
			todoId: taskId,
			todoToken,
			cancellationGeneration: generation,
			cancellationTaskStatus: task.status,
			cancellationAttempts: Math.min(3, priorAttempts + 1),
		};
		const tasks = state.tasks.map((candidate) =>
			candidate.id === taskId
				? {
						...candidate,
						metadata: {
							...candidate.metadata,
							delegation: nextDelegation,
						},
					}
				: candidate,
		);
		const next = { ...state, tasks, revision: state.revision + 1 };
		persistTodoSnapshot(this.pi, next);
		commitState(next);
		return {
			taskId,
			todoToken,
			taskStatus: task.status,
			generation,
			ids: [...ids],
		};
	}

	private settleCancellation(
		request: {
			taskId: number;
			todoToken: string;
			taskStatus: string;
			generation: number;
			ids: string[];
		},
		status: "cancelling" | "cancelled",
		error?: unknown,
	): boolean {
		const state = getState();
		const task = state.tasks.find(
			(candidate) => candidate.id === request.taskId,
		);
		const delegation = task?.metadata?.delegation as
			| Record<string, unknown>
			| undefined;
		const ids = Array.isArray(delegation?.subagentIds)
			? delegation.subagentIds
			: [];
		if (
			!task ||
			task.status !== request.taskStatus ||
			delegation?.status !== "cancelling" ||
			delegation.todoId !== request.taskId ||
			delegation.todoToken !== request.todoToken ||
			delegation.cancellationGeneration !== request.generation ||
			ids.length !== request.ids.length ||
			!ids.every((id, index) => id === request.ids[index])
		)
			return false;
		const nextDelegation = {
			...delegation,
			status,
			...(error === undefined
				? {}
				: { cancellationError: String(error).slice(0, 512) }),
		};
		if (error === undefined) delete nextDelegation.cancellationError;
		const tasks = state.tasks.map((candidate) =>
			candidate.id === request.taskId
				? {
						...candidate,
						metadata: {
							...candidate.metadata,
							delegation: nextDelegation,
						},
					}
				: candidate,
		);
		const next = { ...state, tasks, revision: state.revision + 1 };
		persistTodoSnapshot(this.pi, next);
		commitState(next);
		return true;
	}

	private cancelOwners(
		ids: readonly string[],
		target?: { taskId: number; token: string },
	): boolean {
		const bounded = [...new Set(ids)].filter(Boolean).sort().slice(0, 64);
		if (!bounded.length) return false;
		let request:
			| {
					taskId: number;
					todoToken: string;
					taskStatus: string;
					generation: number;
					ids: string[];
			  }
			| undefined;
		if (target) {
			const task = getState().tasks.find(
				(candidate) => candidate.id === target.taskId,
			);
			const delegation = task?.metadata?.delegation as
				| Record<string, unknown>
				| undefined;
			const currentIds = Array.isArray(delegation?.subagentIds)
				? delegation.subagentIds
				: [];
			const currentGeneration = Number(delegation?.cancellationGeneration);
			const currentKey = `${target.taskId}\0${target.token}\0${currentGeneration}\0${bounded.join("\0")}`;
			if (
				delegation?.status === "cancelling" &&
				delegation.cancellationTaskStatus === task?.status &&
				currentIds.length === bounded.length &&
				currentIds.every((id, index) => id === bounded[index]) &&
				this.cancellationsInFlight.has(currentKey)
			)
				return false;
			request = this.cancellationRequest(target.taskId, target.token, bounded);
			if (!request) return false;
		}
		const key = request
			? `${request.taskId}\0${request.todoToken}\0${request.generation}\0${bounded.join("\0")}`
			: `0\0\0${bounded.join("\0")}`;
		if (this.cancellationsInFlight.has(key)) return false;
		this.cancellationsInFlight.add(key);
		const service = getBackgroundSubagentService();
		const cancellation = service?.cancel
			? service.cancel(bounded)
			: Promise.reject(new Error("Subagent cancellation service unavailable"));
		void cancellation.then(
			() => {
				this.cancellationsInFlight.delete(key);
				if (request && this.settleCancellation(request, "cancelled"))
					this.stateChanged(false);
			},
			(error) => {
				this.cancellationsInFlight.delete(key);
				if (request && this.settleCancellation(request, "cancelling", error))
					this.onStateChanged();
			},
		);
		return Boolean(request);
	}

	private invalidateStaleWorkerOwners(state = getState()): boolean {
		const staleIds = new Set<string>();
		const terminal = new Map<number, { token: string; ids: string[] }>();
		for (const task of state.tasks) {
			if (task.status !== "completed" && task.status !== "deleted") continue;
			const delegation = task.metadata?.delegation as
				| Record<string, unknown>
				| undefined;
			if (
				!["running", "interrupted", "cancelling"].includes(
					String(delegation?.status),
				) ||
				delegation?.todoId !== task.id ||
				!isTodoToken(delegation.todoToken)
			)
				continue;
			const ids = (
				Array.isArray(delegation.subagentIds)
					? delegation.subagentIds
					: [delegation.subagentId]
			).filter((id): id is string => typeof id === "string" && id.length > 0);
			terminal.set(task.id, {
				token: delegation.todoToken,
				ids: [...new Set(ids)].slice(0, 64),
			});
		}
		for (const owners of [
			this.delegatedWorkerOwners,
			this.interruptedWorkerOwners,
		]) {
			for (const [id, owner] of owners) {
				const task = state.tasks.find(
					(candidate) => candidate.id === owner.taskId,
				);
				const preparation = task?.metadata?.preparation as
					| { token?: unknown }
					| undefined;
				if (
					task?.status !== "completed" &&
					task?.status !== "deleted" &&
					preparation?.token === owner.token
				)
					continue;
				owners.delete(id);
				staleIds.add(id);
			}
		}
		let changed = false;
		for (const [taskId, owned] of terminal) {
			for (const id of owned.ids) staleIds.delete(id);
			changed =
				this.cancelOwners(owned.ids, { taskId, token: owned.token }) || changed;
		}
		this.cancelOwners([...staleIds]);
		return changed;
	}

	private pruneDelegatedWorkerOwners(state = getState()): boolean {
		return this.invalidateStaleWorkerOwners(state);
	}

	private hydrateInterruptedWorkerOwners(state = getState()): void {
		this.delegatedWorkerOwners.clear();
		this.interruptedWorkerOwners.clear();
		for (const task of state.tasks) {
			const preparation = task.metadata?.preparation as
				| { token?: unknown }
				| undefined;
			const delegation = task.metadata?.delegation as
				| Record<string, unknown>
				| undefined;
			if (
				delegation?.status !== "interrupted" ||
				delegation.todoId !== task.id ||
				!isTodoToken(preparation?.token) ||
				delegation.todoToken !== preparation.token
			)
				continue;
			const ids = Array.isArray(delegation.subagentIds)
				? delegation.subagentIds
				: [delegation.subagentId];
			for (const id of [...new Set(ids)].slice(0, 64)) {
				if (typeof id === "string" && id)
					this.interruptedWorkerOwners.set(id, {
						taskId: task.id,
						token: preparation.token,
					});
			}
		}
	}

	private reconcileDelegations(
		stateValue: SubagentDelegationState | undefined,
	): void {
		const invalidated = this.pruneDelegatedWorkerOwners();
		let state = getState();
		const nextOwners = new Map<string, { taskId: number; token: string }>();
		const lateTerminal = new Map<number, { token: string; ids: string[] }>();
		const lateStale = new Set<string>();
		for (const entry of Array.isArray(stateValue?.delegations)
			? stateValue.delegations.slice(0, 64)
			: []) {
			if (
				!entry ||
				typeof entry.id !== "string" ||
				!Number.isInteger(entry.todo_id) ||
				Number(entry.todo_id) <= 0 ||
				!isTodoToken(entry.todo_token)
			)
				continue;
			const task = state.tasks.find(
				(candidate) => candidate.id === entry.todo_id,
			);
			if (task?.status === "completed" || task?.status === "deleted") {
				const delegation = task.metadata?.delegation as
					| Record<string, unknown>
					| undefined;
				if (
					delegation?.todoId === task.id &&
					delegation.todoToken === entry.todo_token
				) {
					const current = lateTerminal.get(task.id);
					if (current) current.ids.push(entry.id);
					else
						lateTerminal.set(task.id, {
							token: entry.todo_token,
							ids: [entry.id],
						});
				} else lateStale.add(entry.id);
				continue;
			}
			const interrupted = this.interruptedWorkerOwners.get(entry.id);
			if (
				interrupted &&
				interrupted.taskId === entry.todo_id &&
				interrupted.token === entry.todo_token
			)
				continue;
			const preparation = task?.metadata?.preparation as
				| { token?: unknown }
				| undefined;
			if (task && preparation?.token === entry.todo_token)
				nextOwners.set(entry.id, {
					taskId: entry.todo_id!,
					token: entry.todo_token,
				});
			else lateStale.add(entry.id);
		}
		for (const [taskId, owned] of lateTerminal)
			this.cancelOwners(owned.ids, { taskId, token: owned.token });
		this.cancelOwners([...lateStale]);
		state = getState();

		const group = (
			owners: ReadonlyMap<string, { taskId: number; token: string }>,
		) => {
			const grouped = new Map<number, { token: string; ids: string[] }>();
			for (const [id, owner] of owners) {
				const current = grouped.get(owner.taskId);
				if (current) current.ids.push(id);
				else grouped.set(owner.taskId, { token: owner.token, ids: [id] });
			}
			return grouped;
		};
		const liveByTask = group(nextOwners);
		const priorByTask = group(this.delegatedWorkerOwners);
		const tasks = state.tasks.map((task) => {
			const live = liveByTask.get(task.id);
			if (live) {
				const ids = live.ids.slice(0, 64);
				const delegation = task.metadata?.delegation as
					| Record<string, unknown>
					| undefined;
				if (
					delegation?.status === "running" &&
					delegation.todoId === task.id &&
					delegation.todoToken === live.token &&
					delegation.subagentId === ids[0] &&
					Array.isArray(delegation.subagentIds) &&
					delegation.subagentIds.length === ids.length &&
					delegation.subagentIds.every((id, index) => id === ids[index])
				)
					return task;
				return {
					...task,
					metadata: {
						...task.metadata,
						delegation: {
							status: "running",
							subagentIds: ids,
							subagentId: ids[0],
							todoId: task.id,
							todoToken: live.token,
						},
					},
				};
			}

			const prior = priorByTask.get(task.id);
			const preparation = task.metadata?.preparation as
				| { token?: unknown }
				| undefined;
			const delegation = task.metadata?.delegation as
				| Record<string, unknown>
				| undefined;
			if (
				!prior ||
				preparation?.token !== prior.token ||
				delegation?.status === "interrupted"
			)
				return task;
			const ids = prior.ids.slice(0, 64);
			if (
				delegation?.status === "settled" &&
				delegation.todoToken === prior.token &&
				Array.isArray(delegation.subagentIds) &&
				delegation.subagentIds.length === ids.length &&
				delegation.subagentIds.every((id, index) => id === ids[index])
			)
				return task;
			return {
				...task,
				metadata: {
					...task.metadata,
					delegation: {
						status: "settled",
						subagentIds: ids,
						subagentId: ids[0],
						todoId: task.id,
						todoToken: prior.token,
					},
				},
			};
		});

		this.delegatedWorkerOwners.clear();
		for (const [id, owner] of nextOwners)
			this.delegatedWorkerOwners.set(id, owner);
		if (tasks.every((task, index) => task === state.tasks[index])) {
			if (invalidated) this.stateChanged(false);
			return;
		}
		const updated = { ...state, tasks, revision: state.revision + 1 };
		persistTodoSnapshot(this.pi, updated);
		commitState(updated);
		this.stateChanged(false);
	}

	getGeneration(): number {
		return this.generation;
	}

	isCurrent(generation: number): boolean {
		return generation === this.generation;
	}

	activate(ctx: ExtensionContext, resetAutomation = true): void {
		this.generation++;
		this.active = true;
		this.context = ctx;
		if (resetAutomation) {
			this.automationPaused = false;
			this.continuationPending = false;
			this.agentRunning = false;
			this.lastQuestionSummary = undefined;
			this.completionReviewPending = false;
			this.guard.reset();
			this.completionGuard.reset();
		}
		this.clearTimer();
		this.cancellationsInFlight.clear();
		const recovered = recoverRejectedCompletionReviews(
			recoverInterruptedPreparations(getState()),
		);
		if (recovered !== getState()) {
			persistTodoSnapshot(this.pi, recovered);
			commitState(recovered);
			this.onStateChanged();
		}
		this.hydrateInterruptedWorkerOwners(getState());
		if (this.invalidateStaleWorkerOwners()) this.stateChanged(false);
		this.expireDeadlines();
		this.armDeadline();
		this.scheduleCompletionReviews();
		const generation = this.generation;
		void this.reconcileJobs(generation).finally(() => {
			if (generation === this.generation && hasActionableTasks(getState())) {
				this.queueContinuation(actionableContinuation(getState()));
			}
		});
	}

	pauseAutomation(): void {
		this.automationPaused = true;
		// interruptOwners only persists "interrupted" metadata and hands back the
		// ids — without the cancel, paused automation still burns worker capacity.
		// disableOrchestrator() already does this; it awaits, but pause is sync and
		// called from settle handlers, so fire-and-forget.
		const interrupted = this.interruptOwners(false, false);
		if (interrupted.length) {
			void getBackgroundSubagentService()?.cancel?.(interrupted);
		}
		this.continuationPending = false;
		if (this.reviewRetryTimer) clearTimeout(this.reviewRetryTimer);
		this.reviewRetryTimer = undefined;
		this.guard.reset();
		this.completionGuard.reset();
		this.completionReviewPending = false;
	}

	interruptForUserWork(): void {
		this.pauseAutomation();
		const current = getState();
		const yielded = yieldInProgressTasks(current);
		if (yielded === current) return;
		persistTodoSnapshot(this.pi, yielded);
		commitState(yielded);
		this.onStateChanged();
	}

	resumeAutomation(): void {
		this.automationPaused = false;
		const resumed = resumeWaitingUserTasks(getState());
		if (resumed === getState()) return;
		persistTodoSnapshot(this.pi, resumed);
		commitState(resumed);
	}

	hasAutomationWork(): boolean {
		return (
			this.delegatedWorkerOwners.size > 0 ||
			getState().tasks.some((task) =>
				["pending", "in_progress", "waiting:jobs"].includes(task.status),
			)
		);
	}

	packageAssignmentError(
		todoId: number,
		todoToken: string,
		setting: OrchestratorSetting,
	): string | undefined {
		if (!this.active) return "package_handoff assignment gate unavailable.";
		if (this.automationPaused)
			return "package_handoff assignment gate is paused.";
		const state = getState();
		const task = state.tasks.find((candidate) => candidate.id === todoId);
		const preparation = task?.metadata?.preparation as
			| { status?: unknown; token?: unknown }
			| undefined;
		if (
			!task ||
			task.status === "completed" ||
			task.status === "deleted" ||
			preparation?.status !== "ready" ||
			preparation.token !== todoToken
		)
			return "package_handoff assignment requires a ready matching unresolved TODO incarnation.";
		const mode = (task.metadata?.orchestrator as { mode?: unknown } | undefined)
			?.mode;
		if (setting === "off")
			return "package_handoff assignment is disabled because orchestrator setting is off.";
		if (mode !== "provisional" && mode !== "sticky")
			return "package_handoff target TODO is direct. Execute it in the parent; do not assign a Package Worker or edit reserved orchestration metadata.";
		return undefined;
	}

	authorizePackageAssignment(
		todoId: number,
		todoToken: string,
		subagentId: string,
	): void {
		const state = getState();
		const task = state.tasks.find((candidate) => candidate.id === todoId);
		const preparation = task?.metadata?.preparation as
			| { token?: unknown }
			| undefined;
		if (
			!task ||
			task.status === "completed" ||
			task.status === "deleted" ||
			preparation?.token !== todoToken
		)
			throw new Error(
				"Package assignment ownership changed before publication.",
			);

		const ids = [...this.delegatedWorkerOwners]
			.filter(
				([id, owner]) =>
					id !== subagentId &&
					owner.taskId === todoId &&
					owner.token === todoToken,
			)
			.map(([id]) => id)
			.concat(subagentId)
			.slice(0, 64);
		const delegation = task.metadata?.delegation as
			| Record<string, unknown>
			| undefined;
		if (
			delegation?.status !== "running" ||
			delegation.todoId !== todoId ||
			delegation.todoToken !== todoToken ||
			!Array.isArray(delegation.subagentIds) ||
			delegation.subagentIds.length !== ids.length ||
			!delegation.subagentIds.every((id, index) => id === ids[index])
		) {
			const updated = {
				...state,
				tasks: state.tasks.map((candidate) =>
					candidate.id === todoId
						? {
								...candidate,
								metadata: {
									...candidate.metadata,
									delegation: {
										status: "running",
										subagentIds: ids,
										subagentId: ids[0],
										todoId,
										todoToken,
									},
								},
							}
						: candidate,
				),
				revision: state.revision + 1,
			};
			persistTodoSnapshot(this.pi, updated);
			commitState(updated);
		}

		this.delegatedWorkerOwners.set(subagentId, {
			taskId: todoId,
			token: todoToken,
		});
		const interrupted = this.interruptedWorkerOwners.get(subagentId);
		if (interrupted?.taskId === todoId && interrupted.token === todoToken)
			this.interruptedWorkerOwners.delete(subagentId);
	}

	private commitReviewState(next: ReturnType<typeof getState>): boolean {
		if (next === getState()) return false;
		persistTodoSnapshot(this.pi, next);
		commitState(next);
		return true;
	}

	private scheduleCompletionReviews(): void {
		const ctx = this.context;
		// Guarded here rather than at the stateChanged() call site: a paused
		// scheduler must not spend automation capacity on background reviews, and
		// every caller reaches dispatch through this method.
		if (!this.active || !ctx || this.automationPaused) return;
		for (const task of getState().tasks) {
			if (!isCompletionReviewDispatchable(task, Date.now())) continue;
			void this.runCompletionReview(task, ctx);
		}
		this.armCompletionReviewRetry();
	}

	/**
	 * Re-armed on every sweep, not only after a failure, so a review left retryable
	 * by a previous session is picked up after replay too. Without this, a backoff
	 * that expires while the TODO list is idle waits for unrelated activity.
	 */
	private armCompletionReviewRetry(): void {
		if (this.reviewRetryTimer) clearTimeout(this.reviewRetryTimer);
		this.reviewRetryTimer = undefined;
		if (!this.active || this.automationPaused) return;
		const retryAt = nextCompletionReviewRetryAt(getState().tasks);
		if (retryAt === undefined) return;
		const generation = this.generation;
		this.reviewRetryTimer = setTimeout(
			() => {
				this.reviewRetryTimer = undefined;
				if (generation !== this.generation) return;
				this.scheduleCompletionReviews();
			},
			Math.max(0, retryAt - Date.now()),
		);
		this.reviewRetryTimer.unref?.();
	}

	private async runCompletionReview(
		task: Task,
		ctx: ExtensionContext,
	): Promise<void> {
		const review = task.review;
		if (!review) return;
		const identity: CompletionReviewIdentity = {
			taskId: task.id,
			generation: review.generation,
			token: review.token,
			completionRevision: review.completionRevision,
		};
		const claimed = claimCompletionReview(getState(), identity);
		if (!this.commitReviewState(claimed)) return;
		this.onStateChanged();

		try {
			const service = getBackgroundSubagentService();
			if (!service) throw new Error("Background subagent service unavailable");
			const reviewCwd = completionReviewCwd(task, ctx.cwd);
			const result = await service.run({
				title: `TODO #${task.id} completion review`,
				cwd: reviewCwd,
				model: COMPLETION_REVIEW_MODEL,
				reasoningEffort: "low",
				maxTurns: 4,
				timeoutMs: 120_000,
				allowedTools: [],
				noExtensions: true,
				parent: {
					parentCwd: ctx.cwd,
					projectTrusted: ctx.isProjectTrusted(),
					inheritedModel: ctx.model
						? { provider: ctx.model.provider, id: ctx.model.id }
						: undefined,
					inheritedThinkingLevel: "low",
					modelRegistry: ctx.modelRegistry,
				},
				prompt: completionReviewPrompt(task, await boundedGitDiff(reviewCwd)),
			});
			if (result.status !== "done")
				throw new Error(result.error ?? "Review worker failed");
			const parsed = parseCompletionReviewResponse(result.output);
			if (!parsed)
				throw new Error("Review worker returned malformed decision JSON");
			const next = settleCompletionReview(getState(), identity, {
				...parsed,
				reviewerId: result.id,
				model: COMPLETION_REVIEW_MODEL,
			});
			if (this.commitReviewState(next)) this.stateChanged();
		} catch (error) {
			const next = failCompletionReview(
				getState(),
				identity,
				`Independent review did not complete: ${String(error)}`,
			);
			if (this.commitReviewState(next)) this.onStateChanged();
		}
	}

	private requestCompletionReport(deliverAs: "steer" | "followUp"): void {
		if (this.completionReviewPending || !hasCompletedBatch()) return;
		if (deliverAs === "followUp") {
			if (!this.queueContinuation(COMPLETION_REPORT, this.completionGuard))
				return;
		} else {
			this.pi.sendMessage(
				{
					customType: "rpiv-todo:completion-report",
					content: COMPLETION_REPORT,
					display: false,
				},
				{ triggerTurn: true, deliverAs },
			);
		}
		this.completionReviewPending = true;
	}

	stateChanged(autoStartIdle = true): void {
		this.invalidateStaleWorkerOwners();
		this.clearStickyIfSettled();
		this.armDeadline();
		this.onStateChanged();
		this.scheduleCompletionReviews();
		const state = getState();
		if (this.automationPaused) return;
		if (hasCompletedBatch(state)) this.requestCompletionReport("steer");
		else this.completionReviewPending = false;
		void this.reconcileJobs(this.generation);
		if (
			autoStartIdle &&
			!this.agentRunning &&
			hasActionableTasks(state) &&
			!this.continuationPending
		) {
			const delegated = this.delegatedWorkerContinuation(state);
			if (!delegated.waiting || delegated.content)
				this.queueContinuation(
					delegated.content ?? actionableContinuation(state),
				);
		}
	}

	onAgentStart(): void {
		this.agentRunning = true;
		this.continuationPending = false;
		this.turnHadToolProgress = false;
		const revision = getState().revision;
		this.guard.onAgentStart(revision);
		this.completionGuard.onAgentStart(revision);
	}

	recordToolProgress(): void {
		if (this.agentRunning) this.turnHadToolProgress = true;
	}

	isContinuationPending(): boolean {
		return this.continuationPending;
	}

	onAgentSettled(
		_ctx: ExtensionContext,
		aborted = false,
		usageLimited = false,
	): void {
		this.agentRunning = false;
		if (aborted || usageLimited) {
			this.continuationPending = false;
			this.guard.reset();
			this.completionGuard.reset();
			if (usageLimited) this.pauseAutomation();
			return;
		}
		this.onAgentEnd();
	}

	onAgentEnd(): void {
		if (this.automationPaused) return;
		const state = getState();
		const summary = hasActionableTasks(state)
			? undefined
			: formatWaitingUserSummary(state);
		if (!summary) this.lastQuestionSummary = undefined;
		if (summary && summary !== this.lastQuestionSummary) {
			this.pi.sendMessage(
				{
					customType: "rpiv-todo:waiting-user",
					content: summary,
					display: true,
				},
				{ triggerTurn: false },
			);
			this.lastQuestionSummary = summary;
		}
		const delegated = this.delegatedWorkerContinuation(state);
		if (delegated.waiting) {
			this.guard.reset();
			if (delegated.content) this.queueContinuation(delegated.content);
			return;
		}
		if (
			this.waitingSubagentIds.size > 0 &&
			state.tasks.some(
				(task) =>
					task.status === "in_progress" && isTaskActionable(task, state.tasks),
			)
		) {
			this.guard.reset();
			return;
		}
		if (hasCompletedBatch(state)) {
			if (this.completionReviewPending) {
				this.completionReviewPending = false;
				return;
			}
			if (this.continuationPending) return;
			if (!this.completionGuard.canContinue(state.revision)) {
				this.pi.sendMessage(
					{
						customType: "rpiv-todo:completion-paused",
						content:
							"Automatic TODO completion review paused after two turns without clearing the finished batch or creating follow-up work.",
						display: true,
					},
					{ triggerTurn: false },
				);
				return;
			}
			this.requestCompletionReport("followUp");
			return;
		}
		this.completionGuard.reset();
		if (!hasActionableTasks(state) || this.continuationPending) return;
		if (this.turnHadToolProgress) this.guard.reset();
		if (!this.guard.canContinue(state.revision)) {
			const pending = state.tasks.find(
				(task) =>
					task.status === "pending" && isTaskActionable(task, state.tasks),
			);
			if (pending) {
				emitTelemetry(this.pi.events, {
					type: "todo_no_progress",
					taskId: pending.id,
					status: pending.status,
				});
				this.guard.reset();
				this.queueContinuation(actionableContinuation(state));
				return;
			}
			for (const task of state.tasks) {
				if (isTaskActionable(task, state.tasks)) {
					emitTelemetry(this.pi.events, {
						type: "todo_no_progress",
						taskId: task.id,
						status: task.status,
					});
				}
			}
			this.pi.sendMessage(
				{
					customType: "rpiv-todo:auto-paused",
					content:
						"Automatic TODO continuation paused after two turns without task progress.",
					display: true,
				},
				{ triggerTurn: false },
			);
			return;
		}
		this.queueContinuation(actionableContinuation(state));
	}

	dispose(): void {
		this.generation++;
		this.clearTimer();
		if (this.reviewRetryTimer) clearTimeout(this.reviewRetryTimer);
		this.reviewRetryTimer = undefined;
		this.stopJobs();
		this.stopSubagentWaits();
		this.stopSubagentDelegations();
		this.waitingSubagentIds.clear();
		this.delegatedWorkerOwners.clear();
		this.interruptedWorkerOwners.clear();
		this.cancellationsInFlight.clear();
		this.context = undefined;
		this.active = false;
	}

	async disableOrchestrator(): Promise<void> {
		this.continuationPending = false;
		const ids = this.interruptOwners(true, true);
		const state = getState();
		if (state.orchestrator?.setting !== "off" || state.orchestrator?.sticky) {
			const next = {
				...state,
				revision: state.revision + 1,
				orchestrator: { setting: "off" as const, sticky: false },
			};
			persistTodoSnapshot(this.pi, next);
			commitState(next);
			this.onStateChanged();
		}
		if (ids.length) await getBackgroundSubagentService()?.cancel?.(ids);
	}

	private interruptOwners(
		orchestrationOnly: boolean,
		unresolvedOnly: boolean,
	): string[] {
		const state = getState();
		const ids: string[] = [];
		const ownedTasks = new Set<number>();
		for (const [id, owner] of this.delegatedWorkerOwners) {
			const task = state.tasks.find(
				(candidate) => candidate.id === owner.taskId,
			);
			const mode = (
				task?.metadata?.orchestrator as { mode?: unknown } | undefined
			)?.mode;
			const preparation = task?.metadata?.preparation as
				| { token?: unknown }
				| undefined;
			if (
				task &&
				(!unresolvedOnly ||
					(task.status !== "completed" && task.status !== "deleted")) &&
				preparation?.token === owner.token &&
				(!orchestrationOnly || mode === "provisional" || mode === "sticky")
			) {
				ids.push(id);
				ownedTasks.add(task.id);
				this.interruptedWorkerOwners.set(id, owner);
			}
		}
		const tasks = state.tasks.map((task) =>
			ownedTasks.has(task.id) &&
			(task.metadata?.delegation as { status?: unknown } | undefined)
				?.status === "running"
				? {
						...task,
						metadata: {
							...task.metadata,
							delegation: {
								...(task.metadata!.delegation as Record<string, unknown>),
								status: "interrupted",
							},
						},
					}
				: task,
		);
		if (tasks.some((task, index) => task !== state.tasks[index])) {
			const next = { ...state, tasks, revision: state.revision + 1 };
			persistTodoSnapshot(this.pi, next);
			commitState(next);
			this.onStateChanged();
		}
		return ids;
	}

	private clearStickyIfSettled(): void {
		const state = getState();
		if (!state.orchestrator?.sticky) return;
		const orchestrationOpen = state.tasks.some((task) => {
			const mode = (
				task.metadata?.orchestrator as { mode?: unknown } | undefined
			)?.mode;
			return (
				(mode === "provisional" || mode === "sticky") &&
				task.status !== "completed" &&
				task.status !== "deleted"
			);
		});
		const ownedBusy = state.tasks.some((task) => {
			const mode = (
				task.metadata?.orchestrator as { mode?: unknown } | undefined
			)?.mode;
			const delegation = task.metadata?.delegation as
				| { status?: unknown }
				| undefined;
			return (
				(mode === "provisional" || mode === "sticky") &&
				(delegation?.status === "running" ||
					delegation?.status === "interrupted" ||
					task.wait?.kind === "jobs")
			);
		});
		if (orchestrationOpen || ownedBusy) return;
		const next = {
			...state,
			revision: state.revision + 1,
			orchestrator: { ...state.orchestrator, sticky: false },
		};
		persistTodoSnapshot(this.pi, next);
		commitState(next);
	}

	private delegatedWorkerContinuation(state: ReturnType<typeof getState>): {
		waiting: boolean;
		content?: string;
	} {
		this.pruneDelegatedWorkerOwners(state);
		state = getState();
		const delegatedTask = state.tasks.find((task) => {
			const preparation = task.metadata?.preparation as
				| { token?: unknown }
				| undefined;
			return (
				task.status === "in_progress" &&
				[...this.delegatedWorkerOwners.values()].some(
					(owner) =>
						owner.taskId === task.id && owner.token === preparation?.token,
				) &&
				isTaskActionable(task, state.tasks)
			);
		});
		if (!delegatedTask) return { waiting: false };
		const pending = state.tasks.find(
			(task) =>
				task.status === "pending" && isTaskActionable(task, state.tasks),
		);
		return {
			waiting: true,
			...(pending ? { content: taskContinuation(pending) } : {}),
		};
	}

	private handleJobState(
		event: JobStateEvent,
		requestContinuation = true,
	): void {
		const eventTime =
			typeof event.settledAt === "number"
				? event.settledAt
				: typeof event.settledAt === "string"
					? Date.parse(event.settledAt)
					: Date.now();
		const afterExpiry = expireJobWaits(getState(), eventTime);
		const next = applyJobState(afterExpiry, event, eventTime);
		if (next === getState()) return;
		persistTodoSnapshot(this.pi, next);
		commitState(next);
		this.stateChanged(false);
		if (requestContinuation && hasActionableTasks(next)) {
			this.queueContinuation(
				`Job ${event.id} settled as ${event.status}; continue the now-pending TODO task.`,
			);
		}
	}

	private expireDeadlines(): void {
		const next = expireJobWaits(getState());
		if (next === getState()) return;
		persistTodoSnapshot(this.pi, next);
		commitState(next);
		this.stateChanged(false);
		if (hasActionableTasks(next)) {
			this.queueContinuation(
				"A TODO job-wait deadline expired; inspect its evidence and continue the pending task.",
			);
		}
	}

	private armDeadline(): void {
		this.clearTimer();
		const deadline = nextJobDeadline(getState());
		if (deadline === undefined) return;
		const generation = this.generation;
		this.timer = setTimeout(
			() => {
				if (generation !== this.generation) return;
				this.expireDeadlines();
				this.armDeadline();
			},
			Math.max(0, deadline - Date.now()),
		);
		this.timer.unref?.();
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	private queueContinuation(content: string, guard = this.guard): boolean {
		if (this.automationPaused || !this.active || this.continuationPending)
			return false;
		const state = getState();
		if (state.orchestrator?.setting !== "off") {
			const promoted = state.tasks.map(stickyOrchestrator);
			if (promoted.some((task, index) => task !== state.tasks[index])) {
				const next = {
					...state,
					tasks: promoted,
					revision: state.revision + 1,
					orchestrator: {
						setting: state.orchestrator?.setting ?? "auto",
						sticky: true,
					},
				};
				persistTodoSnapshot(this.pi, next);
				commitState(next);
				this.onStateChanged();
			}
		}
		this.continuationPending = true;
		guard.markQueued();
		this.pi.sendMessage(
			{ customType: "rpiv-todo:auto-continue", content, display: false },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		return true;
	}

	private async reconcileJobs(generation: number): Promise<void> {
		const ids = [
			...new Set(
				getState().tasks.flatMap((task) =>
					task.wait?.kind === "jobs" ? task.wait.jobIds : [],
				),
			),
		];
		if (!ids.length) return;
		const jobs = await this.jobs.query(ids);
		if (!jobs || generation !== this.generation) return;
		for (const id of ids) {
			const event = jobs.get(id) ?? {
				id,
				status: "failed" as const,
				error: "Job no longer exists",
			};
			if (event.status !== "running") this.handleJobState(event);
		}
	}
}
