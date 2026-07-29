import assert from "node:assert/strict";
import test from "node:test";
import { buildTranscriptLines } from "../../vendor/pi-tools/extensions/subagents/src/ui/transcript.ts";
import { setCompactToolRenderer } from "../../vendor/pi-tools/extensions/shared/compact-tool-renderer-protocol.ts";
import { renderCompactEntries } from "./shared-render.ts";

const theme = new Proxy({}, {
	get: (_target, key) => key === "bold" || key === "italic" || key === "underline"
		? (text) => text
		: key === "fg" || key === "bg"
			? (_color, text) => text
			: undefined,
});

function snapshot(transcript, liveTools = []) {
	return {
		id: "sa-1",
		backend: "pi",
		title: "review",
		prompt: "review",
		cwd: "/tmp/worktree",
		status: "running",
		createdAt: 0,
		meta: { backend: "pi" },
		usage: {},
		transcript,
		liveTools,
		queued: [],
		finalText: "",
		turns: 0,
	};
}

test("subagent takeover uses the shared renderer for grouped reads and detailed edits", () => {
	setCompactToolRenderer({ version: 1, enabled: () => true, render: renderCompactEntries });
	const transcript = [
		{ kind: "assistant", parts: [{ type: "toolCall", toolId: "r1", name: "read", argsPreview: JSON.stringify({ path: "/tmp/worktree/src/a.ts" }) }] },
		{ kind: "toolResult", toolId: "r1", name: "read", isError: false, outputPreview: "one\ntwo" },
		{ kind: "assistant", parts: [{ type: "toolCall", toolId: "r2", name: "read", argsPreview: JSON.stringify({ path: "/tmp/worktree/src/b.ts" }) }] },
		{ kind: "toolResult", toolId: "r2", name: "read", isError: false, outputPreview: "three\nfour\nfive" },
		{ kind: "assistant", parts: [{ type: "toolCall", toolId: "e1", name: "edit", argsPreview: JSON.stringify({ path: "/tmp/worktree/src/a.ts", edits: [{ oldText: "old value", newText: "new value" }] }) }] },
		{ kind: "toolResult", toolId: "e1", name: "edit", isError: false, outputPreview: "Successfully replaced 1 block" },
	];

	const output = buildTranscriptLines(snapshot(transcript), 100, theme).join("\n");
	assert.match(output, /◆ Read 2 files · src\/a\.ts · src\/b\.ts · 5 lines/);
	assert.match(output, /◆ Edit src\/a\.ts/);
	assert.match(output, /- old value/);
	assert.match(output, /\+ new value/);
	assert.doesNotMatch(output, /output:|argsPreview/);
});

test("subagent live tools use shared compact rows", () => {
	setCompactToolRenderer({ version: 1, enabled: () => true, render: renderCompactEntries });
	const output = buildTranscriptLines(
		snapshot([], [
			{ toolId: "s1", name: "grep", argsPreview: JSON.stringify({ pattern: "JobManager" }), outputPreview: "a.ts:1\nb.ts:2" },
			{ toolId: "s2", name: "grep", argsPreview: JSON.stringify({ pattern: "dispose" }), outputPreview: "b.ts:4" },
		]),
		100,
		theme,
	).join("\n");
	assert.match(output, /◇ Search 2 queries · "JobManager" · "dispose" · 3 results/);
});

test("bash rows compact the worktree but keep the full command and expansion hint", () => {
	const command = "bun run check --filter Products --configuration Release";
	const output = renderCompactEntries([{
		toolId: "b1",
		name: "bash",
		args: { command: `cd /tmp/worktrees/core-332-nsure-lock-role && ${command}` },
		output: "setup complete\n1895 passed",
		running: false,
		isError: false,
	}], { cwd: "/tmp/worktree", width: 100, theme }).join("\n");
	assert.match(output, /Bash · core-332-nsure-lock-role · 1895 tests passed · Ctrl\+O expand/);
	assert.match(output, new RegExp(`\\$ ${command}`));
	assert.doesNotMatch(output, /\/tmp\/worktrees/);
});

test("cached final summaries avoid rescanning normal output", () => {
	const output = renderCompactEntries([{
		toolId: "r-cache",
		name: "read",
		args: { path: "/tmp/worktree/src/a.ts" },
		output: "this output is deliberately not counted",
		summary: "42 lines",
		outputLineCount: 42,
		running: false,
		isError: false,
	}], { cwd: "/tmp/worktree", width: 100, theme }).join("\n");
	assert.match(output, /Read 1 file · src\/a\.ts · 42 lines/);
});

test("failed Bash rows show the failure tail instead of successful early output", () => {
	const output = renderCompactEntries([{
		toolId: "b-error",
		name: "bash",
		args: { command: "submit-all" },
		output: "first branch submitted\nsecond branch submitted\nthird branch submitted\nconflict in final branch\nsubmit aborted\nCommand exited with code 1",
		running: false,
		isError: true,
	}], { cwd: "/tmp/worktree", width: 100, theme }).join("\n");
	assert.match(output, /conflict in final branch/);
	assert.match(output, /submit aborted/);
	assert.doesNotMatch(output, /first branch submitted/);
});

test("long shell tokens wrap by terminal width instead of one character per row", () => {
	const token = "x".repeat(90);
	const lines = renderCompactEntries([{
		toolId: "b2",
		name: "bash",
		args: { command: `python3 -c ${token}` },
		output: "done",
		running: false,
		isError: false,
	}], { cwd: "/tmp/worktree", width: 40, theme });
	assert.ok(lines.length < 8, lines.join("\n"));
	assert.ok(lines.some((line) => line.includes("x".repeat(20))));
	assert.equal(lines.some((line) => /^\s+x\s*$/.test(line)), false);
});
