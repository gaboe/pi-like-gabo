import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CompactToolEntry } from "../../vendor/pi-tools/extensions/shared/compact-tool-renderer-protocol.js";
import {
	categoryFor,
	commandDisplay,
	compactPath,
	displayTarget,
	humanize,
	nonEmptyLineCount,
	oneLine,
	type ToolCategory,
} from "./format.js";

function transcriptCategory(name: string): ToolCategory | "mutation" {
	const base = name.split(".").pop() ?? name;
	return base === "edit" || base === "write" ? "mutation" : (categoryFor(name) ?? "other");
}

type RenderEntry = CompactToolEntry & { summary?: string; outputLineCount?: number };

function resultSummary(category: ToolCategory, text: string, partial = false): string {
	if (!text) return partial ? "running" : "";
	const lines = nonEmptyLineCount(text);
	if (category === "search") return `${lines} ${lines === 1 ? "result" : "results"}`;
	if (category === "command") {
		const tests = text.match(/\b(\d+)\s+(?:pass|passed)\b/i)?.[1];
		if (tests) return `${tests} tests passed`;
		const last = text.split(/\r?\n/).map(oneLine).filter(Boolean).at(-1) ?? "";
		const summary = last.length > 72 ? `${last.slice(0, 71)}…` : last;
		return lines > 1 ? `${summary} · ${lines} lines` : summary || "completed";
	}
	if (category === "read") return `${lines} ${lines === 1 ? "line" : "lines"}`;
	const first = text.split(/\r?\n/).map(oneLine).find(Boolean) ?? "";
	return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

function duration(entries: ReadonlyArray<RenderEntry>): string {
	const ms = entries.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0);
	if (ms < 1_000) return "";
	const seconds = Math.round(ms / 1_000);
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function aggregate(entries: ReadonlyArray<RenderEntry>, category: ToolCategory): string {
	if (entries.length === 1) return entries[0].summary ?? resultSummary(category, entries[0].output ?? "", entries[0].running);
	if (category !== "read" && category !== "search") return "";
	const total = entries.reduce((sum, entry) => sum + (entry.outputLineCount ?? nonEmptyLineCount(entry.output ?? "")), 0);
	if (!total) return entries.some((entry) => entry.running) ? "running" : "";
	const unit = category === "read" ? "line" : "result";
	return `${total} ${unit}${total === 1 ? "" : "s"}`;
}

function limit(text: string, width: number): string {
	const clean = oneLine(text);
	return clean.length <= width ? clean : `${clean.slice(0, Math.max(0, width - 1))}…`;
}

function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	let rest = oneLine(text);
	while (rest.length > width) {
		const space = rest.lastIndexOf(" ", width);
		const split = space > 0 ? space : width;
		out.push(rest.slice(0, split));
		rest = rest.slice(split).trimStart();
	}
	out.push(rest);
	return out;
}

function renderRow(
	entries: ReadonlyArray<RenderEntry>,
	category: ToolCategory,
	cwd: string,
	width: number,
	theme: Theme,
): string[] {
	const failed = entries.some((entry) => entry.isError);
	const running = entries.some((entry) => entry.running);
	const marker = failed ? theme.fg("error", "✗") : running ? theme.fg("warning", "◇") : theme.fg("success", "◆");
	let body: string;
	if (category === "read") {
		body = `Read ${entries.length} ${entries.length === 1 ? "file" : "files"} · ${entries.map((entry) => displayTarget(category, entry.name, entry.args, cwd)).join(" · ")}`;
	} else if (category === "search") {
		body = `Search ${entries.length} ${entries.length === 1 ? "query" : "queries"} · ${entries.map((entry) => displayTarget(category, entry.name, entry.args, cwd)).join(" · ")}`;
	} else if (category === "command") {
		const display = commandDisplay(entries[0].args, cwd);
		body = display.location ? `Bash · ${display.location}` : "Bash";
	} else {
		body = displayTarget(category, entries[0].name, entries[0].args, cwd);
	}
	const suffix = [aggregate(entries, category), duration(entries), category === "command" ? "Ctrl+O expand" : ""].filter(Boolean).join(" · ");
	const lines = [`${marker} ${theme.fg("muted", limit(suffix ? `${body} · ${suffix}` : body, width - 2))}`];
	if (category === "command") {
		const command = commandDisplay(entries[0].args, cwd).command;
		for (const [index, line] of wrap(command, Math.max(12, width - 6)).entries()) {
			lines.push(theme.fg("muted", `  ${index === 0 ? "$ " : "  "}${line}`));
		}
	}
	if (failed) {
		const evidence = (entries.find((entry) => entry.isError)?.output ?? "")
			.split(/\r?\n/)
			.map(oneLine)
			.filter(Boolean)
			.slice(-3);
		for (const line of evidence) {
			lines.push(theme.fg("error", `  ${limit(line, width - 2)}`));
		}
	}
	return lines;
}

function mutationChanges(entry: CompactToolEntry): Array<{ prefix: "+" | "-"; text: string }> {
	const args = entry.args && typeof entry.args === "object" ? entry.args as Record<string, unknown> : {};
	const edits = Array.isArray(args.edits) ? args.edits : [{
		oldText: args.oldText ?? args.old_string,
		newText: args.newText ?? args.new_string ?? args.content,
	}];
	const changes: Array<{ prefix: "+" | "-"; text: string }> = [];
	for (const edit of edits) {
		if (!edit || typeof edit !== "object") continue;
		const value = edit as Record<string, unknown>;
		for (const line of String(value.oldText ?? value.old_string ?? "").split("\n")) {
			if (line) changes.push({ prefix: "-", text: line });
		}
		for (const line of String(value.newText ?? value.new_string ?? value.content ?? "").split("\n")) {
			if (line) changes.push({ prefix: "+", text: line });
		}
	}
	return changes;
}

function renderMutation(entry: CompactToolEntry, cwd: string, width: number, theme: Theme): string[] {
	const base = entry.name.split(".").pop() ?? entry.name;
	const args = entry.args && typeof entry.args === "object" ? entry.args as Record<string, unknown> : {};
	const rawPath = args.path ?? args.file_path ?? args.filePath ?? args.file;
	const path = compactPath(rawPath, cwd) || "file";
	const marker = entry.isError ? theme.fg("error", "✗") : entry.running ? theme.fg("warning", "◇") : theme.fg("success", "◆");
	const lines = [`${marker} ${theme.fg("toolTitle", `${humanize(base)} ${path}`)}`];
	const changes = mutationChanges(entry);
	if (!changes.length) {
		const summary = resultSummary("other", entry.output ?? "", entry.running);
		if (summary) lines[0] += theme.fg("dim", ` · ${limit(summary, Math.max(10, width - path.length - 10))}`);
		return lines;
	}
	const inner = Math.max(12, width - 2);
	lines.push(theme.fg("dim", `╭${"─".repeat(inner)}╮`));
	for (const change of changes.slice(0, 10)) {
		const plain = limit(`${change.prefix} ${change.text}`, inner - 2);
		const color = change.prefix === "+" ? "toolDiffAdded" : "toolDiffRemoved";
		lines.push(`${theme.fg("dim", "│ ")}${theme.fg(color, plain)}${" ".repeat(Math.max(0, inner - 1 - plain.length))}${theme.fg("dim", "│")}`);
	}
	if (changes.length > 10) {
		const omitted = `… ${changes.length - 10} more lines`;
		lines.push(`${theme.fg("dim", "│ ")}${theme.fg("muted", omitted)}${" ".repeat(Math.max(0, inner - 1 - omitted.length))}${theme.fg("dim", "│")}`);
	}
	lines.push(theme.fg("dim", `╰${"─".repeat(inner)}╯`));
	return lines;
}

export function renderCompactEntries(
	entries: ReadonlyArray<RenderEntry>,
	options: { cwd: string; width: number; theme: Theme },
): string[] {
	const out: string[] = [];
	for (let index = 0; index < entries.length;) {
		const entry = entries[index];
		const category = transcriptCategory(entry.name);
		if (category === "mutation") {
			out.push(...renderMutation(entry, options.cwd, options.width, options.theme));
			index++;
			continue;
		}
		const group = [entry];
		if (category === "read" || category === "search") {
			while (index + group.length < entries.length && transcriptCategory(entries[index + group.length].name) === category) {
				group.push(entries[index + group.length]);
			}
		}
		out.push(...renderRow(group, category, options.cwd, options.width, options.theme));
		index += group.length;
	}
	return out;
}
