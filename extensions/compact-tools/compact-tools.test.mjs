import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	categoryFor,
	commandDisplay,
	commandTarget,
	compactPath,
	customTarget,
	displayTarget,
	errorPreview,
	resultSummary,
} from "./format.ts";
import {
	compactionThresholds,
	normalizeBatchCalls,
	registerToolBatch,
	TOOL_BATCH_PARAMETERS,
} from "./index.ts";

const cwd = "/tmp/worktrees/feature";

test("compacts before summarization approaches the model context limit", () => {
	assert.deepEqual(compactionThresholds(272_000), {
		compactAt: 100_000,
		rearmAt: 80_000,
	});
	assert.deepEqual(compactionThresholds(undefined), {
		compactAt: 100_000,
		rearmAt: 80_000,
	});
});

test("tool_batch schema accepts and normalizes rg/fd compatibility aliases", () => {
	assert.ok(TOOL_BATCH_PARAMETERS.properties.calls.items.properties.tool.enum.includes("rg"));
	assert.ok(TOOL_BATCH_PARAMETERS.properties.calls.items.properties.tool.enum.includes("fd"));
	assert.deepEqual(
		normalizeBatchCalls([
			{ tool: "rg", args: { pattern: "needle", path: "src", fixed_strings: true } },
			{ tool: "fd", args: { pattern: "test", path: "src", limit: 20 } },
			{ tool: "edit", args: { path: "src/a.ts" } },
		]),
		[
			{ tool: "grep", args: { pattern: "needle", path: "src", literal: true } },
			{ tool: "find", args: { pattern: "*test*", path: "src", limit: 20 } },
		],
	);
});

test("tool_batch registration leaves standalone rg/fd definitions untouched", () => {
	const standaloneRg = { name: "rg", execute: Symbol("rg") };
	const standaloneFd = { name: "fd", execute: Symbol("fd") };
	const registry = new Map([["rg", standaloneRg], ["fd", standaloneFd]]);
	registerToolBatch({ registerTool(tool) { registry.set(tool.name, tool); } }, cwd);
	assert.equal(registry.get("rg"), standaloneRg);
	assert.equal(registry.get("fd"), standaloneFd);
	assert.equal(registry.get("tool_batch").name, "tool_batch");
	assert.deepEqual([...registry.keys()], ["rg", "fd", "tool_batch"]);
});

test("tool_batch executes rg/fd aliases through grep/find", async () => {
	const directory = await mkdtemp(join(tmpdir(), "tool-batch-aliases-"));
	await writeFile(join(directory, "sample.test.ts"), "const needle = true;\n");
	let definition;
	registerToolBatch({ registerTool(tool) { definition = tool; } }, directory);
	const result = await definition.execute(
		"call",
		{
			calls: [
				{ tool: "rg", args: { pattern: "needle", path: directory } },
				{ tool: "fd", args: { pattern: "test", path: directory } },
			],
		},
		undefined,
	);
	const text = result.content[0].text;
	assert.match(text, /1\. grep/);
	assert.match(text, /sample\.test\.ts/);
	assert.match(text, /2\. find/);
});

test("categorizes general tools without taking edit rendering", () => {
	assert.equal(categoryFor("read"), "read");
	assert.equal(categoryFor("grep"), "search");
	assert.equal(categoryFor("web_search"), "search");
	assert.equal(categoryFor("bash"), "command");
	assert.equal(categoryFor("workflow"), "other");
	assert.equal(categoryFor("edit"), undefined);
	assert.equal(categoryFor("write"), undefined);
});

test("removes workspace prefixes from paths and commands", () => {
	assert.equal(
		compactPath(`${cwd}/extensions/jobs/manager.ts`, cwd),
		"extensions/jobs/manager.ts",
	);
	assert.equal(
		displayTarget(
			"read",
			"read",
			{ path: `${cwd}/extensions/jobs/manager.ts` },
			cwd,
		),
		"extensions/jobs/manager.ts",
	);
	assert.deepEqual(
		commandDisplay({ command: `cd ${cwd} && bun run check` }, cwd),
		{
			command: "bun run check",
			location: ".",
		},
	);
	assert.equal(
		commandTarget({ command: `cd ${cwd} && bun run check` }, cwd),
		". · bun run check",
	);
});

test("keeps external paths intact", () => {
	assert.equal(compactPath("/var/log/system.log", cwd), "/var/log/system.log");
});

test("summarizes results without exposing full output", () => {
	const result = {
		content: [{ type: "text", text: "a.ts:1\na.ts:2\nb.ts:8\n" }],
	};
	assert.equal(resultSummary("search", result), "3 results");
	assert.equal(
		resultSummary("command", {
			content: [{ type: "text", text: "82 pass\n0 fail" }],
		}),
		"82 tests passed",
	);
	assert.equal(
		resultSummary("other", {
			content: [{ type: "text", text: "Updated task #4\nlarge payload" }],
		}),
		"Updated task #4",
	);
});

test("shows concise custom-tool intent and bounded errors", () => {
	assert.equal(
		customTarget("todo", { action: "update", id: 4 }),
		"Todo update",
	);
	assert.equal(customTarget("workflow", { name: "review" }), "Workflow review");
	assert.deepEqual(
		errorPreview({
			content: [{ type: "text", text: "first\nsecond\nthird\nfourth" }],
		}),
		["second", "third", "fourth"],
	);
});
