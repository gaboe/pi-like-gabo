import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import todoExtension from "../todo/index.ts";
import { __resetState } from "../todo/todo.ts";
import { getState } from "../todo/state/store.ts";
import {
	TELEMETRY_CHANNEL,
	backgroundTerminalTelemetry,
	categorizeTelemetryError,
	jobLifecycleTelemetry,
	normalizeTelemetryEvent,
} from "./protocol.ts";
import { TELEMETRY_FILE, TelemetryWriter } from "./writer.ts";

class Bus {
	handlers = new Map();
	on(channel, handler) {
		const handlers = this.handlers.get(channel) ?? new Set();
		handlers.add(handler);
		this.handlers.set(channel, handlers);
		return () => handlers.delete(handler);
	}
	emit(channel, value) {
		for (const handler of this.handlers.get(channel) ?? []) handler(value);
	}
}

test("schema allowlists metadata and drops producer payloads", () => {
	const mapped = jobLifecycleTelemetry({
		type: "failed",
		jobId: "job-deadbeef",
		kind: "poll",
		status: "failed",
		attempt: 2,
		durationMs: 45,
		title: "secret title",
		reason: "token=secret",
		event: { data: "prompt and output" },
		url: "https://secret.example/path",
	});
	const record = normalizeTelemetryEvent({
		...mapped,
		prompt: "private prompt",
		toolArguments: { command: "rm secret" },
		path: "/private/file",
	}, 0);
	assert.deepEqual(record, {
		v: 1,
		ts: "1970-01-01T00:00:00.000Z",
		type: "job",
		jobId: "job-deadbeef",
		action: "failed",
		kind: "poll",
		status: "failed",
		attempt: 2,
		durationMs: 45,
	});
	assert.doesNotMatch(JSON.stringify(record), /secret|prompt|command|url|path|title|reason|event/i);
	assert.equal(normalizeTelemetryEvent({ ...mapped, jobId: "/private/file" }), undefined);
	assert.equal(categorizeTelemetryError("provider leaked token abc"), "provider");
});

test("background terminal mapping excludes command, output, path, and error text", () => {
	const event = backgroundTerminalTelemetry({
		id: "bt-3",
		status: "failed",
		createdAt: 100,
		settledAt: 160,
		exitCode: 9,
		command: "print-secret",
		cwd: "/private/work",
		errorText: "token=secret",
		stdout: { text: "secret output" },
	}, "settle");
	assert.deepEqual(event, {
		type: "background_terminal",
		terminalId: "bt-3",
		phase: "settle",
		status: "failed",
		durationMs: 60,
		exitCategory: "nonzero",
	});
});

test("writer enforces private permissions and bounded rotation", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-telemetry-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "telemetry");
	const writer = new TelemetryWriter(directory, { maxBytes: 360, archives: 2 });
	await Promise.all(Array.from({ length: 20 }, (_, index) => writer.write({
		type: "todo_state",
		taskId: index + 1,
		status: index % 2 ? "completed" : "pending",
	})));
	await writer.close();
	assert.equal((await stat(directory)).mode & 0o777, 0o700);
	const files = (await readdir(directory)).sort();
	assert.deepEqual(files, [TELEMETRY_FILE, `${TELEMETRY_FILE}.1`, `${TELEMETRY_FILE}.2`]);
	for (const file of files) {
		assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
		for (const line of (await readFile(join(directory, file), "utf8")).trim().split("\n")) {
			assert.equal(JSON.parse(line).v, 1);
		}
	}
});

test("TODO producer emits state and no-progress metadata only", async () => {
	__resetState();
	const bus = new Bus();
	const lifecycle = new Map();
	let tool;
	const events = [];
	bus.on(TELEMETRY_CHANNEL, (event) => events.push(event));
	const pi = {
		events: bus,
		on(name, handler) {
			const handlers = lifecycle.get(name) ?? [];
			handlers.push(handler);
			lifecycle.set(name, handlers);
		},
		registerTool(definition) {
			tool = definition;
		},
		registerCommand() {},
		appendEntry() {},
		sendMessage() {},
	};
	todoExtension(pi);
	const ctx = { hasUI: false, sessionManager: { getBranch: () => [] } };
	await lifecycle.get("session_start")[0]({}, ctx);
	await tool.execute("call", { action: "create", subject: "never logged" });
	await tool.execute("call", { action: "update", id: 1, description: "also never logged" });
	for (let attempt = 0; attempt < 20; attempt++) {
		const status = getState().tasks[0]?.metadata?.preparation?.status;
		if (status !== "queued" && status !== "running") break;
		await new Promise((resolve) => setImmediate(resolve));
	}
	await lifecycle.get("agent_settled")[0]({}, ctx);
	await lifecycle.get("agent_start")[0]();
	await lifecycle.get("agent_settled")[0]({}, ctx);
	await lifecycle.get("agent_start")[0]();
	await lifecycle.get("agent_settled")[0]({}, ctx);
	assert.deepEqual(events.filter((event) => event.type.startsWith("todo")), [
		{ type: "todo_state", taskId: 1, status: "pending" },
		{ type: "todo_no_progress", taskId: 1, status: "pending" },
	]);
	await lifecycle.get("session_shutdown")[0]();
});
