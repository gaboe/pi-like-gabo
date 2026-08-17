import assert from "node:assert/strict";
import test from "node:test";
import { Editor } from "@earendil-works/pi-tui";
import {
	aggregateFleetStates,
	FleetView,
	isStale,
	STALE_AFTER_MS,
} from "./fleet-view.ts";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";

function state() {
	return {
		source: "subagents",
		items: [
			{
				source: "subagents",
				kind: "subagent",
				id: "sa-1",
				title: "inspect fleet",
				status: "running",
				startedAt: 10,
			},
		],
	};
}

function harness() {
	const editor = Object.create(Editor.prototype);
	const tui = {
		focusedComponent: editor,
		renders: 0,
		requestRender() {
			this.renders++;
		},
	};
	const theme = {
		fg: (_color, text) => text,
		bold: (text) => text,
	};
	let input;
	let unsubscribed = 0;
	let editorText = "";
	const widgetCalls = [];
	const widgetComponents = [];
	const ui = {
		onTerminalInput(handler) {
			input = handler;
			return () => unsubscribed++;
		},
		getEditorText: () => editorText,
		setWidget(key, content, options) {
			widgetCalls.push({ key, content, options });
			if (typeof content === "function")
				widgetComponents.push(content(tui, theme));
		},
	};
	const opened = [];
	const fleet = new FleetView(ui, (request) => opened.push(request));
	return {
		fleet,
		input: (data) => input(data),
		opened,
		tui,
		editor,
		widgetCalls,
		widgetComponents,
		setEditorText: (text) => (editorText = text),
		unsubscribed: () => unsubscribed,
	};
}

test("fleet aggregation combines producers and expires settled metadata", () => {
	const now = 10_000;
	const items = aggregateFleetStates(
		[
			{
				source: "subagents",
				items: [
					{
						source: "subagents",
						kind: "subagent",
						id: "running-sub",
						title: "running",
						status: "running",
						startedAt: 30,
					},
					{
						source: "subagents",
						kind: "subagent",
						id: "recent-sub",
						title: "recent",
						status: "done",
						startedAt: 20,
						settledAt: 9_999,
					},
					{
						source: "subagents",
						kind: "subagent",
						id: "old-sub",
						title: "old",
						status: "done",
						startedAt: 1,
						settledAt: 1,
					},
				],
			},
			{
				source: "jobs",
				items: [
					{
						source: "jobs",
						kind: "job",
						id: "job-1",
						title: "root gate",
						status: "running",
						startedAt: 25,
					},
				],
			},
			{
				source: "workflows",
				items: [
					{
						source: "workflows",
						kind: "workflow-run",
						id: "wf-1",
						title: "workflow",
						status: "running",
						startedAt: 10,
					},
					{
						source: "workflows",
						kind: "workflow-agent",
						id: "wf-1:1",
						parentId: "wf-1",
						agentIndex: 1,
						title: "worker",
						status: "running",
						startedAt: 11,
					},
				],
			},
		],
		now,
	);
	assert.deepEqual(
		items.map((item) => item.id),
		["wf-1", "wf-1:1", "recent-sub", "job-1", "running-sub"],
	);
});

test("fleet stale boundary requires truthful activity timestamps", () => {
	const item = state().items[0];
	assert.equal(isStale(item, 10 + STALE_AFTER_MS), false);
	assert.equal(
		isStale({ ...item, updatedAt: 100 }, 100 + STALE_AFTER_MS - 1),
		false,
	);
	assert.equal(
		isStale({ ...item, lastActivityAt: 100 }, 100 + STALE_AFTER_MS),
		true,
	);
});

test("fleet gives running items a distinct active marker", () => {
	const h = harness();
	h.fleet.setState(state());
	const rendered = h.widgetComponents[0].render(120).join("\n");
	assert.match(rendered, /◯ ● agent {2}inspect fleet/);
	h.fleet.dispose();
});

test("fleet keys enter, navigate, open, escape, and pass normal input through", () => {
	const h = harness();
	h.fleet.setState(state());
	assert.deepEqual(h.input(DOWN), { consume: true });
	assert.deepEqual(h.input(DOWN), { consume: true });
	assert.deepEqual(h.input(ENTER), { consume: true });
	assert.deepEqual(h.opened, [
		{ source: "subagents", kind: "subagent", id: "sa-1" },
	]);

	assert.deepEqual(h.input(DOWN), { consume: true });
	assert.equal(h.input("x"), undefined);
	assert.equal(h.input(ENTER), undefined);
	assert.deepEqual(h.input(DOWN), { consume: true });
	assert.deepEqual(h.input(UP), { consume: true });

	h.fleet.setState({ source: "subagents", items: [] });
	h.fleet.setState({
		source: "jobs",
		items: [
			{
				source: "jobs",
				kind: "job",
				id: "job-1",
				title: "root gate",
				status: "running",
				startedAt: 1,
			},
		],
	});
	assert.deepEqual(h.input(DOWN), { consume: true });
	assert.deepEqual(h.input(DOWN), { consume: true });
	assert.deepEqual(h.input(ENTER), { consume: true });
	assert.deepEqual(h.opened.at(-1), {
		source: "jobs",
		kind: "job",
		id: "job-1",
	});

	h.fleet.setState({ source: "jobs", items: [] });
	h.fleet.setState({
		source: "workflows",
		items: [
			{
				source: "workflows",
				kind: "workflow-run",
				id: "wf-1",
				title: "workflow",
				status: "running",
				startedAt: 1,
			},
			{
				source: "workflows",
				kind: "workflow-agent",
				id: "wf-1:2",
				parentId: "wf-1",
				agentIndex: 2,
				title: "worker",
				status: "running",
				startedAt: 2,
			},
		],
	});
	assert.deepEqual(h.input(DOWN), { consume: true });
	assert.deepEqual(h.input(DOWN), { consume: true });
	assert.deepEqual(h.input(DOWN), { consume: true });
	assert.deepEqual(h.input(ENTER), { consume: true });
	assert.deepEqual(h.opened.at(-1), {
		source: "workflows",
		kind: "workflow-agent",
		id: "wf-1:2",
		parentId: "wf-1",
		agentIndex: 2,
	});
	h.fleet.dispose();
});

test("fleet ignores nonempty prompts and every non-editor focus owner", () => {
	const h = harness();
	h.fleet.setState(state());

	h.setEditorText("draft");
	assert.equal(h.input(DOWN), undefined);
	h.setEditorText("");
	h.tui.focusedComponent = {};
	assert.equal(h.input(DOWN), undefined);
	h.tui.focusedComponent = Object.create(Editor.prototype);
	assert.equal(h.input(DOWN), undefined);
	h.tui.focusedComponent = h.editor;
	assert.deepEqual(h.input(DOWN), { consume: true });
	h.tui.focusedComponent = {};
	assert.equal(h.input(DOWN), undefined);
	h.fleet.dispose();
});

test("fleet repaints only for visible changes and clears its timer", () => {
	const originalNow = Date.now;
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	let now = 1_000;
	const ticks = [];
	const cleared = [];
	Date.now = () => now;
	globalThis.setInterval = (callback) => {
		ticks.push(callback);
		return 1;
	};
	globalThis.clearInterval = (timer) => cleared.push(timer);

	try {
		const h = harness();
		h.fleet.setState(state());
		assert.equal(ticks.length, 1);
		ticks[0]();
		assert.equal(h.tui.renders, 0, "unchanged tick does not repaint");

		now = 2_000;
		ticks[0]();
		assert.equal(h.tui.renders, 1, "elapsed time repaint stays fresh");
		ticks[0]();
		assert.equal(h.tui.renders, 1, "same elapsed output does not repaint");

		h.fleet.setState({
			...state(),
			items: [{ ...state().items[0], title: "updated fleet" }],
		});
		assert.equal(h.tui.renders, 2, "changed item repaints");
		h.fleet.dispose();
		assert.deepEqual(cleared, [1]);
	} finally {
		Date.now = originalNow;
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	}
});

test("fleet registers one widget and releases input, widget, timer, and state", () => {
	const h = harness();
	h.fleet.setState(state());
	h.fleet.setState(state());
	assert.equal(
		h.widgetCalls.filter((call) => typeof call.content === "function").length,
		1,
	);

	h.fleet.dispose();
	assert.equal(h.unsubscribed(), 1);
	assert.equal(h.widgetCalls.at(-1).content, undefined);
	assert.equal(h.input(DOWN), undefined);
	h.fleet.setState(state());
	assert.equal(
		h.widgetCalls.filter((call) => typeof call.content === "function").length,
		1,
	);
});
