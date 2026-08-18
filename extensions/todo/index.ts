/**
 * rpiv-todo — Pi extension. Registers the `todo` tool, `/todos` slash
 * command, and the persistent TodoOverlay widget.
 *
 * TUI chrome strings localize at render time via the i18n bridge. Strings are
 * registered with rpiv-i18n here, once, at module init — but only when the
 * SDK is actually installed. If `@juicesharp/rpiv-i18n` is missing (standalone
 * install of just this package), the dynamic-load shim no-ops and the bridge's
 * `t(key, fallback)` returns the inline English literal at every call site.
 * The extension stays online either way.
 *
 * Adding a locale: drop `locales/<code>.json` next to en.json (mirroring the
 * key set). No edit needed here — `registerLocalesFromDir` iterates
 * `SUPPORTED_LOCALES` from the SDK. See `@juicesharp/rpiv-i18n` README →
 * "Contributing translations" for the full convention.
 *
 * Extracted from rpiv-pi@7525a5d. Tool name "todo" and widget key
 * "rpiv-todos" preserved verbatim so existing session history replays
 * correctly after upgrade.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emitTelemetry } from "../telemetry/protocol.js";
import { loadConfig, orchestratorEnabled } from "./config.js";
import { orchestratorFooterStatus } from "./orchestrator.js";
import { JobsAdapter } from "./jobs-adapter.js";
import {
	isChatGptProUsageLimit,
	TodoScheduler,
	persistTodoSnapshot,
} from "./scheduler.js";
import { replayFromBranch } from "./state/replay.js";
import {
	commitState,
	getState,
	replaceState,
	subscribeState,
} from "./state/store.js";
import {
	registerOrchestratorCommand,
	registerTodoAddCommand,
	registerTodosCommand,
	registerTodoTool,
	TOOL_NAME,
} from "./todo.js";
import { TodoOverlay } from "./todo-overlay.js";
import {
	AUTOMATION_PAUSE_CHANNEL,
	type AutomationPauseRequest,
} from "../../vendor/pi-tools/extensions/shared/automation-pause-protocol.js";
import { registerPackageAssignmentGate } from "../../vendor/pi-tools/extensions/shared/assignment-gate-protocol.js";

// pi-core's ExtensionRunner throws this exact phrase from an invalidated ctx
// proxy after session replacement/reload. Match the stable substring so genuine
// replay bugs still propagate instead of being silently swallowed.
function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

export function interruptsTodoAutomation(text: string): boolean {
	return /(?:^|\s)(?:\/skill:|\$)pi-like-gabo-reflect(?:\s|$)/i.test(text)
		|| /<skill\s+name=["']pi-like-gabo-reflect["']/i.test(text);
}

export default function (pi: ExtensionAPI) {
	// Todo overlay widget — constructed lazily at the first session_start with UI.
	let todoOverlay: TodoOverlay | undefined;
	let stopStateTelemetry: (() => void) | undefined;
	let runAborted = false;
	let runUsageLimited = false;
	const globalOrchestratorEnabled = orchestratorEnabled(loadConfig());
	let orchestratorSetting: "on" | "off" | "auto" = globalOrchestratorEnabled
		? "auto"
		: "off";
	let updateOrchestratorStatus = () => {};
	let clearOrchestratorStatus = () => {};
	const jobs = new JobsAdapter(pi.events);
	const scheduler = new TodoScheduler(pi, jobs, () => todoOverlay?.update());
	let lifecycleGeneration = 0;
	let unregisterAssignmentGate: (() => void) | undefined;
	const refreshAssignmentGate = () => {
		const unregisterPrevious = unregisterAssignmentGate;
		unregisterAssignmentGate = registerPackageAssignmentGate(
			({ todoId, todoToken }) => {
				if (!globalOrchestratorEnabled || orchestratorSetting === "off")
					return "package_handoff assignment gate is off.";
				return scheduler.packageAssignmentError(
					todoId,
					todoToken,
					orchestratorSetting,
				);
			},
			({ todoId, todoToken, subagentId }) =>
				scheduler.authorizePackageAssignment(todoId, todoToken, subagentId),
		);
		unregisterPrevious?.();
	};
	pi.events.on(AUTOMATION_PAUSE_CHANNEL, (value) => {
		const request = value as AutomationPauseRequest | undefined;
		if (
			!request ||
			request.reason !== "double-escape" ||
			!scheduler.hasAutomationWork()
		)
			return;
		request.acknowledge("todo", 1);
		scheduler.pauseAutomation();
	});

	const todoAddHooks = {
		getGeneration: () => scheduler.getGeneration(),
		isCurrent: (generation: number) => scheduler.isCurrent(generation),
		onStateChanged: () => scheduler.stateChanged(),
		orchestrator: () => orchestratorSetting,
	};
	registerTodoTool(pi, {
		jobs,
		onStateChanged: () => scheduler.stateChanged(),
		preparation: todoAddHooks,
		orchestrator: () => orchestratorSetting,
	});
	registerOrchestratorCommand(
		pi,
		() => orchestratorSetting,
		async (value) => {
			orchestratorSetting = globalOrchestratorEnabled ? value : "off";
			refreshAssignmentGate();
			if (orchestratorSetting === "off") return scheduler.disableOrchestrator();
			const state = getState();
			const next = {
				...state,
				revision: state.revision + 1,
				orchestrator: {
					setting: orchestratorSetting,
					sticky: state.orchestrator?.sticky,
				},
			};
			persistTodoSnapshot(pi, next);
			commitState(next);
		},
	);
	registerTodoAddCommand(pi, todoAddHooks);
	registerTodosCommand(pi, todoAddHooks);

	pi.on("session_start", async (_event, ctx) => {
		const generation = ++lifecycleGeneration;
		stopStateTelemetry?.();
		replaceState(replayFromBranch(ctx));
		orchestratorSetting = globalOrchestratorEnabled
			? (getState().orchestrator?.setting ?? "auto")
			: "off";
		if (!globalOrchestratorEnabled) {
			await scheduler.disableOrchestrator();
			if (generation !== lifecycleGeneration) return;
		}
		clearOrchestratorStatus();
		updateOrchestratorStatus = () => {
			if (ctx.mode === "tui")
				ctx.ui.setStatus(
					"orchestrator",
					orchestratorFooterStatus(
						getState().tasks,
						orchestratorSetting,
						getState().orchestrator?.sticky,
					),
				);
		};
		clearOrchestratorStatus = () => {
			if (ctx.mode === "tui") ctx.ui.setStatus("orchestrator", undefined);
		};
		updateOrchestratorStatus();
		stopStateTelemetry = subscribeState((previous, next) => {
			updateOrchestratorStatus();
			const prior = new Map(
				previous.tasks.map((task) => [task.id, task.status]),
			);
			for (const task of next.tasks) {
				const previousStatus = prior.get(task.id);
				prior.delete(task.id);
				if (previousStatus === task.status) continue;
				emitTelemetry(pi.events, {
					type: "todo_state",
					taskId: task.id,
					status: task.status,
				});
			}
			for (const taskId of prior.keys()) {
				emitTelemetry(pi.events, {
					type: "todo_state",
					taskId,
					status: "deleted",
				});
			}
		});
		scheduler.activate(ctx);
		refreshAssignmentGate();
		if (ctx.hasUI) {
			todoOverlay ??= new TodoOverlay(() => scheduler.isContinuationPending());
			todoOverlay.setUICtx(ctx.ui);
			todoOverlay.resetCompletedDisplayState();
			todoOverlay.hideAllCompletedTasks();
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		// Auto-compaction races session disposal: pi-core invalidates the
		// extension runner while still emitting session_compact, so `ctx` may be
		// a dead proxy whose getters throw the stale error. The compacting session
		// is being discarded — the replacement session's session_start replays
		// state — so keep current state on a stale ctx. Other errors are real
		// replay bugs and must propagate.
		let replayed = false;
		try {
			replaceState(replayFromBranch(ctx));
			replayed = true;
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
		if (replayed) scheduler.activate(ctx, false);
		todoOverlay?.resetCompletedDisplayState();
		todoOverlay?.hideAllCompletedTasks();
	});

	pi.on("session_tree", async (_event, ctx) => {
		let replayed = false;
		try {
			replaceState(replayFromBranch(ctx));
			replayed = true;
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
		if (replayed) scheduler.activate(ctx);
		todoOverlay?.resetCompletedDisplayState();
		todoOverlay?.hideAllCompletedTasks();
	});

	pi.on("session_shutdown", async () => {
		lifecycleGeneration++;
		stopStateTelemetry?.();
		stopStateTelemetry = undefined;
		clearOrchestratorStatus();
		updateOrchestratorStatus = () => {};
		clearOrchestratorStatus = () => {};
		unregisterAssignmentGate?.();
		unregisterAssignmentGate = undefined;
		scheduler.dispose();
		jobs.dispose();
		todoOverlay?.dispose();
		todoOverlay = undefined;
	});

	// Reads getTodos() at render time; do NOT call replayFromBranch here
	// (branch is stale — message_end runs after tool_execution_end).
	pi.on("tool_execution_end", async (event) => {
		if (event.isError) return;
		scheduler.recordToolProgress();
		if (event.toolName === "ask_user") {
			const details = event.result.details as
				| { cancelled?: boolean; explanationRequested?: boolean }
				| undefined;
			if (!details?.cancelled && !details?.explanationRequested)
				scheduler.resumeAutomation();
			return;
		}
		if (event.toolName !== TOOL_NAME) return;
		todoOverlay?.update();
	});

	pi.on("input", async (event) => {
		if (event.source !== "interactive" && event.source !== "rpc") return;
		if (interruptsTodoAutomation(event.text)) {
			scheduler.interruptForUserWork();
			return;
		}
		scheduler.resumeAutomation();
	});

	pi.on("agent_start", async () => {
		runAborted = false;
		runUsageLimited = false;
		scheduler.onAgentStart();
		todoOverlay?.hideCompletedTasksFromPreviousTurn();
		todoOverlay?.update();
	});

	pi.on("agent_end", async (event) => {
		for (let index = event.messages.length - 1; index >= 0; index--) {
			const message = event.messages[index] as {
				role?: string;
				stopReason?: string;
				errorMessage?: string;
			};
			if (message.role !== "assistant") continue;
			runAborted = message.stopReason === "aborted";
			runUsageLimited = isChatGptProUsageLimit(message.errorMessage);
			break;
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		scheduler.onAgentSettled(ctx, runAborted, runUsageLimited);
		runAborted = false;
		runUsageLimited = false;
		todoOverlay?.hideAllCompletedTasks();
	});
}
