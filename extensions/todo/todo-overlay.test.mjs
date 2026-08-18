import assert from "node:assert/strict";
import test from "node:test";
import { replaceState, getState } from "./state/store.ts";
import { TodoOverlay } from "./todo-overlay.ts";
import { DEFAULT_PROMPT_GUIDELINES } from "./todo.ts";
import {
	formatCommandTaskLine,
	formatOverlayTaskLine,
	renderTodoCall,
	renderTodoResult,
} from "./view/format.ts";

const theme = {
	fg: (_color, text) => text,
	bold: (text) => text,
	strikethrough: (text) => text,
};

test("TODO guidance requires full-plan decomposition and safe parallel execution", () => {
	assert.ok(
		DEFAULT_PROMPT_GUIDELINES.some((line) =>
			line.includes("whole known execution plan into separate TODOs"),
		),
	);
	assert.ok(
		DEFAULT_PROMPT_GUIDELINES.some(
			(line) =>
				line.includes("start every safe independent unit") &&
				line.includes("Same feature, PR, or stack is not itself a conflict"),
		),
	);
});

test("TODO preparation renders as active work without changing driver status", () => {
	const task = {
		id: 7,
		subject: "Prepare task details",
		status: "pending",
		metadata: {
			preparation: {
				status: "running",
				progress: "inspecting repository",
			},
		},
	};
	assert.equal(
		formatOverlayTaskLine(task, theme, true),
		"◐ #7 Prepare task details (preparing: inspecting repository)",
	);
	assert.equal(
		formatCommandTaskLine(task, "○"),
		"  ◐ #7 Prepare task details (preparing: inspecting repository)",
	);
});

test("TODO hygiene hides completed tasks while retaining audit state", () => {
	let widget;
	const ui = {
		setWidget(_key, content) {
			widget = content;
		},
	};
	const overlay = new TodoOverlay();
	overlay.setUICtx(ui);
	replaceState({
		tasks: [{ id: 1, subject: "done", status: "completed" }],
		nextId: 2,
		revision: 1,
	});
	overlay.hideAllCompletedTasks();
	assert.equal(widget, undefined);
	assert.equal(getState().tasks[0].status, "completed");

	replaceState({
		tasks: [
			{ id: 1, subject: "done", status: "completed" },
			{ id: 2, subject: "next", status: "pending" },
		],
		nextId: 3,
		revision: 2,
	});
	overlay.update();
	assert.equal(typeof widget, "function");
	const component = widget({ requestRender() {} }, theme);
	const lines = component.render(120);
	assert.match(lines.join("\n"), /Todos \(0\/1\)/);
	assert.match(lines.join("\n"), /next/);
	assert.doesNotMatch(lines.join("\n"), /done/);
	overlay.dispose();
});

test("TODO overlay keeps completion visible until independent review approves it", () => {
	let widget;
	const overlay = new TodoOverlay();
	overlay.setUICtx({
		setWidget(_key, content) {
			widget = content;
		},
	});
	replaceState({
		tasks: [
			{
				id: 1,
				subject: "await review",
				status: "completed",
				review: { status: "pending" },
			},
		],
		nextId: 2,
		revision: 1,
	});
	overlay.hideAllCompletedTasks();
	assert.equal(typeof widget, "function");
	const component = widget({ requestRender() {} }, theme);
	assert.match(component.render(120).join("\n"), /◐ await review \(reviewing completion\)/);
	overlay.dispose();
});

test("TODO overlay shows queued automatic continuation", () => {
	let widget;
	const overlay = new TodoOverlay(() => true);
	overlay.setUICtx({
		setWidget(_key, content) {
			widget = content;
		},
	});
	replaceState({
		tasks: [{ id: 1, subject: "continue work", status: "in_progress" }],
		nextId: 2,
		revision: 1,
	});
	overlay.update();
	const component = widget({ requestRender() {} }, theme);
	assert.match(component.render(120).join("\n"), /Resuming TODO…/);
	overlay.dispose();
});

test("TODO rendering explains dependency updates instead of echoing pending", () => {
	const task = {
		id: 28,
		subject: "Verify review-triage bot coverage",
		status: "pending",
		blockedBy: [27],
	};
	const state = { tasks: [task], nextId: 29, revision: 1 };
	const call = renderTodoCall(
		{ action: "update", id: 28, removeBlockedBy: [27] },
		theme,
		state,
	)
		.render(120)
		.join("\n");
	assert.match(call, /Verify review-triage bot coverage/);
	assert.match(call, /− blocker #27/);
	const result = renderTodoResult(
		{
			details: {
				action: "update",
				params: { id: 28, removeBlockedBy: [27] },
				tasks: [{ ...task, blockedBy: undefined }],
				nextId: 29,
			},
		},
		theme,
	)
		.render(120)
		.join("\n")
		.trimEnd();
	assert.equal(result, "✓ removed blocker #27");
});

test("TODO waiting display shows only remaining jobs and partial progress", () => {
	const task = {
		id: 27,
		subject: "Validate AGENTS.md content",
		status: "waiting:jobs",
		wait: {
			kind: "jobs",
			jobIds: ["job-be", "job-fe"],
			mode: "all",
			deadline: Date.now() + 1_000,
			settled: { "job-be": { id: "job-be", status: "succeeded" } },
		},
	};
	assert.match(
		formatOverlayTaskLine(task, theme, true),
		/\(all: job-fe · 1\/2 settled\)/,
	);
	assert.match(
		formatCommandTaskLine(task, "◌"),
		/\(all: job-fe · 1\/2 settled\)/,
	);
});
