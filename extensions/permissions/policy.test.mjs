import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzePath,
  classifyTool,
  createAuditEvent,
  createBoundedAuditRecorder,
  observeToolCall,
} from "./policy.ts";

test("canonical path analysis handles existing, nonexistent, symlink, and escape targets", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "permissions-"));
  const root = path.join(parent, "root");
  const outside = path.join(parent, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(path.join(root, "file.txt"), "ok");
  symlinkSync(outside, path.join(root, "link"));

  assert.equal(analyzePath("file.txt", root).containment, "inside");
  assert.equal(analyzePath("new/deep.txt", root).containment, "inside");
  assert.equal(analyzePath("link/new.txt", root).containment, "outside");

  const missingOutside = path.join(outside, "missing.txt");
  symlinkSync(missingOutside, path.join(root, "broken-link"));
  assert.equal(analyzePath("broken-link", root).containment, "unknown");
  writeFileSync(missingOutside, "created");
  assert.equal(analyzePath("broken-link", root).containment, "outside");

  assert.equal(analyzePath("../escape.txt", root).escaped, true);
  assert.equal(analyzePath(pathToFileURL(path.join(root, "file.txt")).href, root).containment, "inside");
  assert.equal(analyzePath("~/permissions-home-test", root).targetExists, false);
});

test("classifies built-in and current custom tools, leaving unknown tools unknown", () => {
  assert.equal(classifyTool("read"), "read");
  assert.equal(classifyTool("edit"), "local-write");
  assert.equal(classifyTool("bash"), "process");
  assert.equal(classifyTool("fetch_content"), "network");
  assert.equal(classifyTool("ask_user"), "external");
  assert.equal(classifyTool("subagent_spawn"), "orchestration");
  assert.equal(classifyTool("future_tool"), "unknown");
});

test("audit event is bounded and omits secrets and command payloads", () => {
  const root = mkdtempSync(path.join(tmpdir(), "audit-"));
  const secret = "TOKEN=super-secret curl https://example.test/private?q=secret";
  const event = createAuditEvent("bash", { command: secret, apiKey: "hidden", path: "new.txt" }, root);
  const serialized = JSON.stringify(event);

  assert.equal(event.decision, "observe");
  assert.equal(event.mode, "observe-only");
  assert.equal(event.paths[0].containment, "inside");
  assert.equal(serialized.includes("super-secret"), false);
  assert.equal(serialized.includes("apiKey"), false);
  assert.ok(serialized.length < 500);
});

test("observe-only hook never returns a blocking decision and recorder stays bounded", () => {
  const emitted = [];
  const recorder = createBoundedAuditRecorder((event) => emitted.push(event), 2);
  const result = observeToolCall({ toolName: "unknown_tool", input: {} }, process.cwd(), recorder.record);
  observeToolCall({ toolName: "read", input: {} }, process.cwd(), recorder.record);
  observeToolCall({ toolName: "write", input: {} }, process.cwd(), recorder.record);

  assert.equal(result, undefined);
  assert.equal(emitted.length, 3);
  assert.equal(recorder.snapshot().length, 2);
  assert.equal(emitted[0].category, "unknown");
  recorder.reset();
  assert.deepEqual(recorder.snapshot(), []);
});

test("Pi tool_call handler observes and returns undefined", async () => {
  const handlers = new Map();
  const emitted = [];
  const { default: permissions } = await import("./index.ts");
  permissions({
    on: (name, handler) => handlers.set(name, handler),
    events: { emit: (name, event) => emitted.push([name, event]) },
  });

  const result = handlers.get("tool_call")({ toolName: "bash", input: { command: "secret" } }, { cwd: process.cwd() });
  assert.equal(result, undefined);
  assert.equal(emitted.length, 1);
  assert.equal(JSON.stringify(emitted).includes("secret"), false);

  const throwingHandlers = new Map();
  permissions({
    on: (name, handler) => throwingHandlers.set(name, handler),
    events: { emit: () => { throw new Error("observer failed"); } },
  });
  assert.equal(
    throwingHandlers.get("tool_call")({ toolName: "write", input: { path: "x" } }, { cwd: process.cwd() }),
    undefined,
  );
});
