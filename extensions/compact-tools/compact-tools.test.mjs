import assert from "node:assert/strict";
import test from "node:test";
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
import { compactionThresholds } from "./index.ts";

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
