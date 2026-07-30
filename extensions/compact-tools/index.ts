import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	categoryFor,
	displayTarget,
	resultSummary,
	resultText,
	nonEmptyLineCount,
	type ToolCategory,
} from "./format.js";
import { renderCompactEntries } from "./shared-render.js";
import {
	getCompactToolRenderer,
	setCompactToolRenderer,
	type CompactToolRendererApi,
} from "../../vendor/pi-tools/extensions/shared/compact-tool-renderer-protocol.js";
import { boundToolResultHistory } from "./context-budget.js";

const CONFIG_ENTRY = "compact-tools-config";
const SUMMARY_ENTRY = "compact-tools-summary";
const PATCH_KEY = Symbol.for("pi-plugins.compact-tools.patch.v1");
const STATE_KEY = Symbol.for("pi-plugins.compact-tools.state.v1");
const PATCH_OWNER = Symbol("pi-plugins.compact-tools.patch-owner");
const RENDERER_OWNER = Symbol("pi-plugins.compact-tools.renderer-owner");
const COMPACT_CONTEXT_AT_TOKENS = 100_000;
const REARM_CONTEXT_COMPACTION_AT_TOKENS = 80_000;
const MAX_WIDTH = 110;

type ToolInfo = {
	id: string;
	name: string;
	category: ToolCategory;
	args: unknown;
	target: string;
	hidden: boolean;
	running: boolean;
	isError: boolean;
	startedAt?: number;
	durationMs?: number;
	result?: unknown;
	compactOutput?: string;
	compactSummary?: string;
	outputLineCount?: number;
	finalResult?: unknown;
	group?: ToolInfo[];
	invalidate?: () => void;
};

type Stats = {
	startedAt: number;
	reads: number;
	searches: number;
	commands: number;
	mutations: number;
	others: number;
	failed: number;
};

type RuntimeState = {
	enabled: boolean;
	cwd: string;
	theme?: Theme;
	tools: Map<string, ToolInfo>;
	group: ToolInfo[];
	components: Set<any>;
	stats: Stats;
};

type Summary = Omit<Stats, "startedAt"> & { durationMs: number };

function newStats(): Stats {
	return { startedAt: Date.now(), reads: 0, searches: 0, commands: 0, mutations: 0, others: 0, failed: 0 };
}

function runtime(): RuntimeState {
	const root = globalThis as typeof globalThis & { [STATE_KEY]?: RuntimeState };
	return root[STATE_KEY] ??= {
		enabled: true,
		cwd: process.cwd(),
		tools: new Map(),
		group: [],
		components: new Set(),
		stats: newStats(),
	};
}

const state = runtime();
const rendererApi: CompactToolRendererApi = {
	version: 1,
	enabled: () => state.enabled,
	render: renderCompactEntries,
};
Object.defineProperty(rendererApi, RENDERER_OWNER, { value: true });

function isOwnedRenderer(api: CompactToolRendererApi | undefined): boolean {
	return !!api && (api as CompactToolRendererApi & { [RENDERER_OWNER]?: boolean })[RENDERER_OWNER] === true;
}

function resetRun() {
	state.tools = new Map();
	state.group = [];
	state.stats = newStats();
}

function capture(ctx: ExtensionContext) {
	state.cwd = ctx.cwd;
	state.theme = ctx.ui.theme;
}

function groupable(info: ToolInfo): boolean {
	return info.category === "read" || info.category === "search";
}

function joinGroup(info: ToolInfo) {
	if (!groupable(info)) {
		state.group = [];
		return;
	}
	if (state.group.at(-1)?.category !== info.category) state.group = [];
	if (!state.group.some((item) => item.id === info.id)) state.group.push(info);
	for (const item of state.group) item.group = state.group;
	for (const item of state.group.slice(0, -1)) item.hidden = true;
	state.group.at(-2)?.invalidate?.();
}

function hydrate(id: string, name: string, args: unknown, isError = false): ToolInfo | undefined {
	const category = categoryFor(name);
	if (!category) {
		state.group = [];
		return undefined;
	}
	let info = state.tools.get(id);
	if (!info) {
		info = {
			id,
			name,
			category,
			args,
			target: displayTarget(category, name, args, state.cwd),
			hidden: false,
			running: false,
			isError,
		};
		state.tools.set(id, info);
		joinGroup(info);
	}
	return info;
}

function recordStart(name: string) {
	const category = categoryFor(name);
	if (!category) {
		state.stats.mutations++;
		state.group = [];
		return;
	}
	if (category === "read") state.stats.reads++;
	else if (category === "search") state.stats.searches++;
	else if (category === "command") state.stats.commands++;
	else state.stats.others++;
}

function begin(id: string, name: string, args: unknown) {
	recordStart(name);
	const info = hydrate(id, name, args);
	if (!info) return;
	info.args = args;
	info.target = displayTarget(info.category, name, args, state.cwd);
	info.running = true;
	info.startedAt = Date.now();
	info.invalidate?.();
}

function finalizeOutput(info: ToolInfo, result: unknown) {
	if (info.finalResult === result) return;
	info.finalResult = result;
	info.result = result;
	info.compactOutput = resultText(result);
	info.compactSummary = resultSummary(info.category, result);
	info.outputLineCount = nonEmptyLineCount(info.compactOutput);
}

function finish(id: string, result: unknown, isError: boolean, partial: boolean) {
	const info = state.tools.get(id);
	if (!info) return;
	if (!partial) finalizeOutput(info, result);
	info.isError ||= isError;
	if (!partial) {
		info.running = false;
		if (info.startedAt) info.durationMs = Date.now() - info.startedAt;
		if (isError) {
			state.stats.failed++;
			const prior = (info.group ?? []).filter((item) => item !== info);
			if (prior.length) {
				for (const item of prior) item.group = prior;
				prior.at(-1)!.hidden = false;
				prior.at(-1)!.invalidate?.();
			}
			info.group = [info];
			info.hidden = false;
			state.group = [];
		}
	}
	info.invalidate?.();
}

function activeGroup(info: ToolInfo): ToolInfo[] {
	return groupable(info) && info.group?.length ? info.group : [info];
}

function compactLines(info: ToolInfo, theme: Theme): string[] {
	return renderCompactEntries(
		activeGroup(info).map((item) => ({
			toolId: item.id,
			name: item.name,
			args: item.args,
			output: item.compactOutput ?? "",
			summary: item.compactSummary,
			outputLineCount: item.outputLineCount,
			isError: item.isError,
			running: item.running,
			durationMs: item.durationMs,
		})),
		{ cwd: state.cwd, width: Math.min(process.stdout.columns || 100, MAX_WIDTH), theme },
	);
}

type RendererPatch = {
	owner: symbol;
	originalUpdateDisplay: (...args: any[]) => any;
	originalRender: (...args: any[]) => any;
	updateDisplay: (...args: any[]) => any;
	render: (...args: any[]) => any;
};

function patchRenderer() {
	const proto = ToolExecutionComponent.prototype as any;
	if (typeof proto.updateDisplay !== "function" || typeof proto.render !== "function") return;
	const prior = proto[PATCH_KEY] as RendererPatch | undefined;
	const originalUpdateDisplay = prior?.originalUpdateDisplay ?? proto.updateDisplay;
	const originalRender = prior?.originalRender ?? proto.render;

	const updateDisplay = function compactToolsUpdateDisplay(this: any) {
		const category = categoryFor(this.toolName ?? "");
		if (!state.enabled || !category || this.expanded || !this.toolCallId || !this.selfRenderContainer?.clear) {
			this.__compactToolsActive = false;
			this.__compactToolsHidden = false;
			return originalUpdateDisplay.call(this);
		}
		state.components.add(this);
		const invalidate = () => {
			this.invalidate?.();
			this.ui?.requestRender?.();
		};
		const info = hydrate(this.toolCallId, this.toolName, this.args, this.result?.isError ?? false)!;
		info.args = this.args;
		info.target = displayTarget(category, this.toolName, this.args, state.cwd);
		info.invalidate = invalidate;
		if (this.result) {
			info.isError ||= this.result.isError ?? false;
			info.running = this.isPartial ?? false;
			if (!info.running) finalizeOutput(info, this.result);
		}
		if (info.hidden) {
			this.__compactToolsActive = true;
			this.__compactToolsHidden = true;
			return;
		}
		if (!state.theme) return originalUpdateDisplay.call(this);
		this.__compactToolsActive = true;
		this.__compactToolsHidden = false;
		this.selfRenderContainer.clear();
		for (const line of compactLines(info, state.theme)) {
			this.selfRenderContainer.addChild(new Text(line, 0, 0));
		}
	};

	const render = function compactToolsRender(this: any, width: number) {
		if (this.hideComponent || this.__compactToolsHidden) return [];
		if (this.__compactToolsActive) return this.selfRenderContainer.render(width);
		return originalRender.call(this, width);
	};
	proto.updateDisplay = updateDisplay;
	proto.render = render;
	proto[PATCH_KEY] = { owner: PATCH_OWNER, originalUpdateDisplay, originalRender, updateDisplay, render } satisfies RendererPatch;
}

function restoreRendererPatch() {
	const proto = ToolExecutionComponent.prototype as any;
	const patch = proto[PATCH_KEY] as RendererPatch | undefined;
	if (!patch || patch.owner !== PATCH_OWNER) return;
	if (proto.updateDisplay === patch.updateDisplay) proto.updateDisplay = patch.originalUpdateDisplay;
	if (proto.render === patch.render) proto.render = patch.originalRender;
	if (proto.updateDisplay === patch.originalUpdateDisplay && proto.render === patch.originalRender) delete proto[PATCH_KEY];
}

function refresh() {
	let ui: any;
	for (const component of state.components) {
		try {
			component.invalidate?.();
			ui ??= component.ui;
		} catch {
			state.components.delete(component);
		}
	}
	ui?.requestRender?.();
}

function restoreConfig(ctx: ExtensionContext) {
	state.enabled = true;
	for (const entry of ctx.sessionManager.getBranch()) {
		const data = entry.type === "custom" ? entry.data as { enabled?: unknown } | undefined : undefined;
		if (entry.type === "custom" && entry.customType === CONFIG_ENTRY && typeof data?.enabled === "boolean") {
			state.enabled = data.enabled;
		}
	}
}

function summaryText(data: Summary): string {
	const parts = [
		data.reads && `Read ${data.reads}`,
		data.searches && `Search ${data.searches}`,
		data.mutations && `Edit/write ${data.mutations}`,
		data.commands && `Bash ${data.commands}`,
		data.others && `Other ${data.others}`,
		data.failed && `${data.failed} failed`,
	].filter(Boolean);
	if (!parts.length) return "";
	const seconds = Math.round(data.durationMs / 1000);
	return `${parts.join(" · ")}${seconds ? ` · ${seconds}s` : ""}`;
}

export default function compactTools(pi: ExtensionAPI) {
	let contextCompactionArmed = true;
	const priorRenderer = getCompactToolRenderer();
	setCompactToolRenderer(rendererApi);
	patchRenderer();
	pi.on("context", (event) => ({ messages: boundToolResultHistory(event.messages) }));
	pi.on("turn_end", (_event, ctx) => {
		const tokens = ctx.getContextUsage()?.tokens;
		if (tokens == null) return;
		if (tokens <= REARM_CONTEXT_COMPACTION_AT_TOKENS) {
			contextCompactionArmed = true;
			return;
		}
		if (tokens <= COMPACT_CONTEXT_AT_TOKENS || !contextCompactionArmed) return;
		contextCompactionArmed = false;
		ctx.compact({
			onError: (error) => {
				contextCompactionArmed = true;
				if (ctx.hasUI) ctx.ui.notify(`Automatic context compaction failed: ${error.message}`, "warning");
			},
		});
	});
	pi.registerCommand("compact-tools", {
		description: "Toggle general compact tool rendering.",
		handler: async (args, ctx) => {
			capture(ctx);
			const value = args.trim().toLowerCase();
			if (value === "status") {
				ctx.ui.notify(`Compact tools: ${state.enabled ? "on" : "off"}`, "info");
				return;
			}
			if (value && value !== "on" && value !== "off" && value !== "toggle") {
				ctx.ui.notify("Usage: /compact-tools [on|off|toggle|status]", "warning");
				return;
			}
			state.enabled = value === "on" || (value !== "off" && !state.enabled);
			pi.appendEntry(CONFIG_ENTRY, { enabled: state.enabled });
			refresh();
			ctx.ui.notify(`Compact tools: ${state.enabled ? "on" : "off"}`, "info");
		},
	});
	pi.registerEntryRenderer<Summary>(SUMMARY_ENTRY, (entry, _options, theme) => {
		if (!entry.data) return undefined;
		const text = summaryText(entry.data);
		return text ? new Text(theme.fg("dim", text), 0, 0) : undefined;
	});
	pi.on("session_shutdown", () => {
		restoreRendererPatch();
		if (getCompactToolRenderer() === rendererApi) setCompactToolRenderer(isOwnedRenderer(priorRenderer) ? undefined : priorRenderer);
		state.components.clear();
	});
	pi.on("session_start", async (_event, ctx) => {
		contextCompactionArmed = true;
		restoreConfig(ctx);
		capture(ctx);
		resetRun();
		state.components = new Set();
	});
	pi.on("agent_start", (_event, ctx) => {
		capture(ctx);
		resetRun();
	});
	pi.on("message_update", (event) => {
		if (event.assistantMessageEvent?.type === "text_delta" && event.assistantMessageEvent.delta?.trim()) state.group = [];
	});
	pi.on("tool_execution_start", (event, ctx) => {
		capture(ctx);
		begin(event.toolCallId, event.toolName, event.args);
	});
	pi.on("tool_execution_update", (event, ctx) => {
		capture(ctx);
		finish(event.toolCallId, event.partialResult, false, true);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		capture(ctx);
		finish(event.toolCallId, event.result, event.isError, false);
	});
	pi.on("agent_end", () => {
		const { startedAt, ...counts } = state.stats;
		const summary = { ...counts, durationMs: Date.now() - startedAt };
		if (summaryText(summary)) pi.appendEntry(SUMMARY_ENTRY, summary);
		state.group = [];
	});
}
