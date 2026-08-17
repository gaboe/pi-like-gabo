import { resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BackgroundTerminalAdapter } from "./background-terminal-adapter.js";
import { JobManager } from "./manager.js";
import { JobStore } from "./store.js";
import { emitTelemetry, jobLifecycleTelemetry } from "../telemetry/protocol.js";
import type {
	JobCondition,
	JobDefinition,
	JobLifecycleEvent,
	JobRecord,
	JobStateEvent,
} from "./types.js";
import {
	AUTOMATION_PAUSE_CHANNEL,
	type AutomationPauseRequest,
} from "../../vendor/pi-tools/extensions/shared/automation-pause-protocol.js";
import {
	onFleetOpen,
	onFleetQuery,
	publishFleetState,
	type FleetOpenRequest,
	type JobFleetItem,
} from "../../vendor/pi-tools/extensions/shared/fleet-protocol.js";

const ConditionSchema = Type.Object({
	type: StringEnum(["regex", "jsonpath"] as const),
	expression: Type.String(),
	flags: Type.Optional(Type.String()),
	operator: Type.Optional(
		StringEnum([
			"exists",
			"equals",
			"notEquals",
			"in",
			"matches",
			"greaterThan",
			"lessThan",
		] as const),
	),
	value: Type.Optional(Type.Unknown()),
	action: StringEnum(["wake", "complete", "failure"] as const),
});

const ParamsSchema = Type.Object({
	action: StringEnum([
		"start",
		"status",
		"list",
		"get",
		"stop",
		"restart",
		"delete",
	] as const),
	id: Type.Optional(Type.String()),
	kind: Type.Optional(StringEnum(["command", "websocket", "poll"] as const)),
	title: Type.Optional(Type.String()),
	command: Type.Optional(Type.String()),
	working_dir: Type.Optional(Type.String()),
	url: Type.Optional(Type.String()),
	interval_ms: Type.Optional(Type.Integer()),
	conditions: Type.Optional(Type.Array(ConditionSchema)),
	timeout_ms: Type.Optional(Type.Integer()),
	deadline: Type.Optional(Type.Number()),
	restart_policy: Type.Optional(StringEnum(["never", "idempotent"] as const)),
	dedupe_jsonpath: Type.Optional(Type.String()),
	resume_query: Type.Optional(Type.String()),
	cursor_jsonpath: Type.Optional(Type.String()),
	binary: Type.Optional(StringEnum(["reject", "base64"] as const)),
	max_frame_bytes: Type.Optional(Type.Integer()),
});

class FollowupDelivery {
	private readonly pending = new Map<string, JobLifecycleEvent>();
	private timer?: NodeJS.Timeout;
	private lastFlush = 0;
	private closed = false;

	constructor(private readonly pi: ExtensionAPI) {}

	push(event: JobLifecycleEvent) {
		if (this.closed || !["wake", "completed", "failed"].includes(event.type))
			return;
		this.pending.delete(event.jobId);
		this.pending.set(event.jobId, event);
		while (this.pending.size > 50)
			this.pending.delete(this.pending.keys().next().value!);
		if (this.timer) return;
		this.timer = setTimeout(
			() => this.flush(),
			Math.max(300, 1_000 - (Date.now() - this.lastFlush)),
		);
	}

	consume(id: string) {
		this.pending.delete(id);
	}

	close() {
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.pending.clear();
	}

	private flush() {
		this.timer = undefined;
		if (this.closed || this.pending.size === 0) return;
		const events = [...this.pending.values()].slice(0, 20);
		for (const event of events) this.pending.delete(event.jobId);
		this.lastFlush = Date.now();
		const content = events
			.map((event) => {
				const sample = event.event?.data.replace(/\s+/g, " ").slice(0, 300);
				return `[${event.type}] ${event.jobId} ${event.title}${event.reason ? `: ${event.reason}` : ""}${sample ? `\n${sample}` : ""}`;
			})
			.join("\n\n");
		try {
			this.pi.sendMessage(
				{
					customType: "jobs-lifecycle",
					content,
					display: true,
					details: { events },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch (error) {
			console.error("jobs: follow-up delivery failed", error);
		}
		if (this.pending.size > 0)
			this.timer = setTimeout(() => this.flush(), 1_000);
	}
}

function requireId(id: string | undefined) {
	if (!id?.trim()) throw new Error("id is required for this action.");
	return id.trim();
}

function definitionFrom(
	params: {
		kind?: "command" | "websocket" | "poll";
		title?: string;
		command?: string;
		working_dir?: string;
		url?: string;
		interval_ms?: number;
		conditions?: Array<{
			type: "regex" | "jsonpath";
			expression: string;
			flags?: string;
			operator?:
				| "exists"
				| "equals"
				| "notEquals"
				| "in"
				| "matches"
				| "greaterThan"
				| "lessThan";
			value?: unknown;
			action: "wake" | "complete" | "failure";
		}>;
		timeout_ms?: number;
		deadline?: number;
		restart_policy?: "never" | "idempotent";
		dedupe_jsonpath?: string;
		resume_query?: string;
		cursor_jsonpath?: string;
		binary?: "reject" | "base64";
		max_frame_bytes?: number;
	},
	cwd: string,
): JobDefinition {
	if (!params.kind) throw new Error("kind is required for start.");
	if (!params.title) throw new Error("title is required for start.");
	const common = {
		title: params.title,
		conditions: (params.conditions ?? []) as JobCondition[],
		...(params.timeout_ms === undefined
			? {}
			: { timeoutMs: params.timeout_ms }),
		...(params.deadline === undefined ? {} : { deadline: params.deadline }),
		...(params.dedupe_jsonpath
			? { dedupeJsonPath: params.dedupe_jsonpath }
			: {}),
	};
	if (params.kind === "command") {
		if (!params.command)
			throw new Error("command is required for command jobs.");
		return {
			...common,
			kind: "command",
			command: params.command,
			cwd: resolve(cwd, params.working_dir ?? "."),
			restartPolicy: params.restart_policy ?? "never",
		};
	}
	if (!params.url) throw new Error("url is required for network jobs.");
	return {
		...common,
		kind: params.kind,
		url: params.url,
		...(params.kind === "poll"
			? { intervalMs: params.interval_ms ?? 5_000 }
			: {}),
		...(params.resume_query ? { resumeQuery: params.resume_query } : {}),
		...(params.cursor_jsonpath
			? { cursorJsonPath: params.cursor_jsonpath }
			: {}),
		binary: params.binary ?? "reject",
		maxFrameBytes: params.max_frame_bytes ?? 256 * 1024,
	};
}

export async function withHerdrBlocked<T>(
	events: ExtensionAPI["events"],
	label: string,
	wait: () => Promise<T>,
): Promise<T> {
	try {
		events.emit("herdr:blocked", { active: true, label });
		return await wait();
	} finally {
		events.emit("herdr:blocked", { active: false });
	}
}

export function jobFleetItems(jobs: JobRecord[]): JobFleetItem[] {
	return jobs.map((job) => ({
		source: "jobs",
		kind: "job",
		id: job.id,
		title: job.definition.title,
		status:
			job.status === "starting" || job.status === "running"
				? "running"
				: job.status === "completed"
					? "done"
					: job.status === "failed"
						? "error"
						: "aborted",
		startedAt: job.startedAt ?? job.createdAt,
		...(job.settledAt === undefined ? {} : { settledAt: job.settledAt }),
		detail: `${job.definition.kind} · attempt ${job.attempt}`,
	}));
}

export function jobsStatus(jobs: JobRecord[]): string | undefined {
	const active = jobs.filter(
		(job) => job.status === "starting" || job.status === "running",
	);
	if (active.length === 0) return undefined;
	return `jobs: ■ ${active.length} running`;
}

function summary(job: JobRecord) {
	const elapsed = Math.max(
		0,
		Math.round(
			((job.settledAt ?? Date.now()) - (job.startedAt ?? job.createdAt)) / 1000,
		),
	);
	return `${job.id}  ${job.status.padEnd(11)} ${job.definition.kind.padEnd(9)} ${job.definition.title} (${elapsed}s, ${job.events.length} queued${job.droppedEvents ? `, ${job.droppedEvents} dropped` : ""})`;
}

function detail(job: JobRecord) {
	const events = job.events
		.slice(-10)
		.map(
			(event) =>
				`${event.sequence} ${event.source}: ${event.data.slice(0, 1_000)}`,
		)
		.join("\n");
	return `${summary(job)}\nattempt: ${job.attempt}\nlog: ${job.logPath}${job.error ? `\nerror: ${job.error}` : ""}${events ? `\n\n${events}` : ""}`;
}

function stateEvent(job: JobRecord, wake = false): JobStateEvent {
	const status = wake
		? "wake"
		: job.status === "completed"
			? "succeeded"
			: job.status === "failed" && /timeout|deadline/i.test(job.error ?? "")
				? "timed_out"
				: job.status === "failed"
					? "failed"
					: job.status === "stopped" || job.status === "interrupted"
						? "killed"
						: "running";
	return {
		id: job.id,
		status,
		...(job.settledAt === undefined ? {} : { settledAt: job.settledAt }),
		...(job.error ? { error: job.error } : {}),
	};
}

export function installJobSessionListeners(
	events: ExtensionAPI["events"],
	handlers: {
		query(value: unknown): void;
		fleetQuery(): void;
		fleetOpen(request: FleetOpenRequest): void;
		automationPause(value: unknown): void;
	},
): () => void {
	const stops = [
		events.on("jobs:query", handlers.query),
		onFleetQuery(events, handlers.fleetQuery),
		onFleetOpen(events, handlers.fleetOpen),
		events.on(AUTOMATION_PAUSE_CHANNEL, handlers.automationPause),
	];
	let stopped = false;
	return () => {
		if (stopped) return;
		stopped = true;
		for (const stop of stops) stop();
	};
}

export default function (pi: ExtensionAPI) {
	let manager: JobManager | undefined;
	let managerReady: Promise<JobManager> | undefined;
	let context: ExtensionContext | undefined;
	let adapter: BackgroundTerminalAdapter | undefined;
	let delivery: FollowupDelivery | undefined;
	let stopSessionListeners: (() => void) | undefined;

	const handleQuery = (value: unknown) => {
		if (!manager || !value || typeof value !== "object") return;
		const request = value as { ids?: unknown; respond?: unknown };
		if (
			!Array.isArray(request.ids) ||
			!request.ids.every((id) => typeof id === "string") ||
			typeof request.respond !== "function"
		)
			return;
		const ids = new Set(request.ids);
		request.respond(
			manager
				.list()
				.filter((job) => ids.has(job.id))
				.map((job) => stateEvent(job)),
		);
	};
	const updateStatus = () => {
		const jobs = manager?.list() ?? [];
		publishFleetState(pi.events, {
			source: "jobs",
			items: jobFleetItems(jobs),
		});
		if (!context || context.mode !== "tui") return;
		context.ui.setStatus("jobs", jobsStatus(jobs));
	};
	const handleFleetOpen = (request: FleetOpenRequest) => {
		if (
			request.source !== "jobs" ||
			request.kind !== "job" ||
			!context ||
			context.mode !== "tui" ||
			!manager
		)
			return;
		try {
			delivery?.consume(request.id);
			context.ui.notify(detail(manager.get(request.id)), "info");
		} catch (error) {
			context.ui.notify(
				error instanceof Error ? error.message : String(error),
				"error",
			);
		}
	};
	const handleAutomationPause = (value: unknown) => {
		const request = value as AutomationPauseRequest | undefined;
		if (!request || request.reason !== "double-escape" || !manager) return;
		const ids = manager
			.list()
			.filter(
				(job) =>
					(job.definition.kind !== "command" || !job.backendId) &&
					(job.status === "starting" || job.status === "running"),
			)
			.map((job) => job.id);
		if (ids.length === 0) return;
		request.acknowledge("jobs", ids.length);
		void Promise.allSettled(ids.map((id) => manager!.stop(id)));
	};

	const getManager = async () => {
		if (!managerReady)
			throw new Error("Jobs extension has not received session_start yet.");
		return await managerReady;
	};

	pi.on("session_start", async (_event, ctx) => {
		stopSessionListeners?.();
		stopSessionListeners = installJobSessionListeners(pi.events, {
			query: handleQuery,
			fleetQuery: updateStatus,
			fleetOpen: handleFleetOpen,
			automationPause: handleAutomationPause,
		});
		delivery?.close();
		delivery = new FollowupDelivery(pi);
		context = ctx;
		managerReady = (async () => {
			adapter = new BackgroundTerminalAdapter();
			try {
				await adapter.connect();
			} catch (error) {
				ctx.ui.notify(
					`Jobs: command backend unavailable (${error instanceof Error ? error.message : String(error)}). WebSocket/poll jobs remain available.`,
					"warning",
				);
			}
			manager = new JobManager(new JobStore(), adapter, {
				onLifecycle(event) {
					emitTelemetry(pi.events, jobLifecycleTelemetry(event));
					pi.events.emit("jobs:lifecycle", event);
					if (
						[
							"started",
							"restarted",
							"wake",
							"completed",
							"failed",
							"stopped",
							"interrupted",
						].includes(event.type)
					) {
						const job = manager
							?.list()
							.find((candidate) => candidate.id === event.jobId);
						if (job) {
							const state = stateEvent(job, event.type === "wake");
							pi.events.emit(
								"jobs:state",
								event.type === "wake"
									? { ...state, settledAt: event.at }
									: state,
							);
						}
					}
					delivery?.push(event);
					updateStatus();
				},
				async approveNetwork(request) {
					if (!context || context.mode !== "tui" || !context.hasUI)
						return false;
					const scope = request.restricted.length
						? `\nRestricted scope: ${request.restricted.join(", ")}`
						: "";
					const ui = context.ui;
					return withHerdrBlocked(pi.events, "Approve job network scope?", () =>
						ui.confirm(
							"Approve job network scope?",
							`Allow this job to connect to exactly:\n${request.endpoint}\nPinned addresses: ${request.addresses.join(", ")}${scope}\n\nAny DNS address-set change requires approval again.`,
						),
					);
				},
			});
			await manager.initialize(ctx.sessionManager.getSessionId(), ctx.cwd);
			updateStatus();
			return manager;
		})();
		await managerReady;
	});

	pi.on("session_shutdown", async () => {
		if (context?.mode === "tui") context.ui.setStatus("jobs", undefined);
		publishFleetState(pi.events, { source: "jobs", items: [] });
		context = undefined;
		delivery?.close();
		delivery = undefined;
		stopSessionListeners?.();
		stopSessionListeners = undefined;
		await manager?.dispose();
		publishFleetState(pi.events, { source: "jobs", items: [] });
		adapter?.dispose();
		manager = undefined;
		managerReady = undefined;
	});

	pi.registerTool({
		name: "jobs",
		label: "Manage Jobs",
		description:
			"Start and manage persistent local command, WebSocket, and HTTP polling jobs. Actions: start, status, list, get, stop, restart, delete. Jobs wake the agent only when a wake/completion/failure condition matches or a command settles. Network jobs require exact-scope TUI approval.",
		promptSnippet:
			"Run and monitor long-lived command, WebSocket, and HTTP jobs with event conditions and durable resume",
		promptGuidelines: [
			"Use jobs start instead of blocking bash for servers, watchers, CI waits, periodic checks, and event streams; continue other actionable TODOs after start.",
			"Proactively use a job when a command will likely exceed 30 seconds and independent TODO work can continue, when external state must be checked more than once, or when an event should wake a TODO. Keep blocking bash for short one-shot checks whose result is immediately required.",
			"At the first repeated manual status check, replace polling with a bounded command, HTTP, or WebSocket monitor rather than issuing another check.",
			"For command monitors, emit one complete text or JSON event per line. Use wake conditions for reusable monitors, complete/failure conditions for terminal waits, and bounded timeouts/deadlines.",
			"After starting a job required by a TODO, set that TODO to waiting:jobs with the returned job id. A wake event makes the TODO pending while the monitor remains running; re-arm the TODO after handling when continued monitoring is required.",
			"Do not poll jobs repeatedly. Completion and matching wake events arrive as follow-ups; use status/get only when current output is needed.",
		],
		parameters: ParamsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const jobs = await getManager();
			if (params.action === "start") {
				const job = await jobs.start(definitionFrom(params, ctx.cwd));
				return {
					content: [{ type: "text", text: `Started ${summary(job)}` }],
					details: job,
				};
			}
			if (params.action === "list") {
				const records = jobs.list();
				return {
					content: [
						{
							type: "text",
							text: records.length
								? records.map(summary).join("\n")
								: "No jobs.",
						},
					],
					details: {
						jobs: records.map((job) => ({
							id: job.id,
							status: job.status,
							kind: job.definition.kind,
							title: job.definition.title,
							createdAt: job.createdAt,
							settledAt: job.settledAt,
						})),
					},
				};
			}
			const id = requireId(params.id);
			if (params.action === "status") {
				delivery?.consume(id);
				const job = jobs.get(id);
				return {
					content: [{ type: "text", text: summary(job) }],
					details: job,
				};
			}
			if (params.action === "get") {
				delivery?.consume(id);
				const job = jobs.get(id);
				return { content: [{ type: "text", text: detail(job) }], details: job };
			}
			if (params.action === "stop") {
				const job = await jobs.stop(id);
				return {
					content: [{ type: "text", text: summary(job) }],
					details: job,
				};
			}
			if (params.action === "restart") {
				const job = await jobs.restart(id);
				return {
					content: [{ type: "text", text: summary(job) }],
					details: job,
				};
			}
			await jobs.delete(id);
			delivery?.consume(id);
			return {
				content: [{ type: "text", text: `Deleted ${id}.` }],
				details: { id },
			};
		},
	});

	pi.registerCommand("jobs", {
		description: "List jobs or inspect one: /jobs [id]",
		handler: async (args, ctx) => {
			try {
				const jobs = await getManager();
				const id = args.trim();
				const text = id
					? detail(jobs.get(id))
					: jobs.list().map(summary).join("\n") || "No jobs.";
				ctx.ui.notify(text, "info");
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});
}

export type { JobLifecycleEvent, JobStateEvent } from "./types.js";
