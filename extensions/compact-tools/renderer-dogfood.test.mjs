import assert from "node:assert/strict";
import test from "node:test";
import {
  initTheme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import compactTools from "./index.ts";

initTheme("dark", false);

const theme = new Proxy(
  {},
  {
    get: (_target, key) =>
      key === "bold" || key === "italic" || key === "underline"
        ? (text) => text
        : key === "fg" || key === "bg"
          ? (_color, text) => text
          : undefined,
  },
);

function harness() {
  const handlers = new Map();
  const entries = [];
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand() {},
    registerEntryRenderer() {},
    appendEntry(type, data) {
      entries.push({ type, data });
    },
  };
  compactTools(pi);
  const ui = { theme, requestRender() {} };
  const ctx = {
    cwd: "/tmp/worktree",
    ui,
    sessionManager: { getBranch: () => [] },
  };
  return { handlers, entries, ui, ctx };
}

function text(component) {
  return component.render(120).join("\n");
}

function result(value, isError = false, details) {
  return { content: [{ type: "text", text: value }], isError, details };
}

test("real ToolExecutionComponent groups reads and searches, preserves diffs, and expands", async () => {
  const { handlers, ui, ctx } = harness();
  await handlers.get("session_start")({}, ctx);
  handlers.get("agent_start")({}, ctx);

  const readOne = new ToolExecutionComponent(
    "read",
    "r1",
    { path: "/tmp/worktree/src/a.ts" },
    {},
    undefined,
    ui,
    ctx.cwd,
  );
  handlers.get("tool_execution_start")(
    {
      toolCallId: "r1",
      toolName: "read",
      args: { path: "/tmp/worktree/src/a.ts" },
    },
    ctx,
  );
  readOne.updateResult(result("one\ntwo"));
  handlers.get("tool_execution_end")(
    {
      toolCallId: "r1",
      toolName: "read",
      result: result("one\ntwo"),
      isError: false,
    },
    ctx,
  );

  const readTwo = new ToolExecutionComponent(
    "read",
    "r2",
    { path: "/tmp/worktree/src/b.ts" },
    {},
    undefined,
    ui,
    ctx.cwd,
  );
  handlers.get("tool_execution_start")(
    {
      toolCallId: "r2",
      toolName: "read",
      args: { path: "/tmp/worktree/src/b.ts" },
    },
    ctx,
  );
  readTwo.updateResult(result("three\nfour\nfive"));
  handlers.get("tool_execution_end")(
    {
      toolCallId: "r2",
      toolName: "read",
      result: result("three\nfour\nfive"),
      isError: false,
    },
    ctx,
  );

  assert.equal(text(readOne), "");
  assert.match(
    text(readTwo),
    /◆ Read 2 files · src\/a\.ts · src\/b\.ts · 5 lines/,
  );

  const grep = new ToolExecutionComponent(
    "grep",
    "s1",
    { pattern: "JobManager", path: "/tmp/worktree/src" },
    {},
    undefined,
    ui,
    ctx.cwd,
  );
  handlers.get("tool_execution_start")(
    { toolCallId: "s1", toolName: "grep", args: { pattern: "JobManager" } },
    ctx,
  );
  grep.updateResult(result("a.ts:1\nb.ts:2"));
  assert.match(text(grep), /◆ Search 1 query · "JobManager" · 2 results/);

  const edit = new ToolExecutionComponent(
    "edit",
    "e1",
    {
      path: "src/a.ts",
      edits: [{ oldText: "old", newText: "new" }],
    },
    {},
    undefined,
    ui,
    ctx.cwd,
  );
  const diff = "-  1 old\n+  1 new";
  edit.updateResult(
    result("Successfully replaced 1 block", false, {
      diff,
      firstChangedLine: 1,
    }),
  );
  assert.match(text(edit), /edit.*src\/a\.ts/s);
  assert.match(text(edit), /old/);
  assert.match(text(edit), /new/);

  readTwo.setExpanded(true);
  assert.doesNotMatch(text(readTwo), /◆ Read 2 files/);
  assert.match(text(readTwo), /read.*src\/b\.ts/s);
});

test("partial output stays running until final compact summary", async () => {
  const { handlers, ui, ctx } = harness();
  await handlers.get("session_start")({}, ctx);
  const bash = new ToolExecutionComponent(
    "bash",
    "b1",
    { command: "run-tests" },
    {},
    undefined,
    ui,
    ctx.cwd,
  );
  handlers.get("tool_execution_start")(
    { toolCallId: "b1", toolName: "bash", args: { command: "run-tests" } },
    ctx,
  );
  bash.updateResult(result("line one\nline two\nline three"), true);
  handlers.get("tool_execution_update")(
    {
      toolCallId: "b1",
      toolName: "bash",
      partialResult: result("line one\nline two\nline three"),
    },
    ctx,
  );
  assert.match(text(bash), /◇ Bash · running/);
  assert.doesNotMatch(text(bash), /line three|3 lines/);

  bash.updateResult(result("line one\nline two\nline three"), false);
  handlers.get("tool_execution_end")(
    {
      toolCallId: "b1",
      toolName: "bash",
      result: result("line one\nline two\nline three"),
      isError: false,
    },
    ctx,
  );
  assert.match(text(bash), /◆ Bash · line three · 3 lines/);
});

test("real component compacts custom tools and keeps concise error evidence", async () => {
  const { handlers, ui, ctx } = harness();
  await handlers.get("session_start")({}, ctx);

  const workflow = new ToolExecutionComponent(
    "workflow",
    "w1",
    { name: "review", script: "very long script" },
    {},
    undefined,
    ui,
    ctx.cwd,
  );
  handlers.get("tool_execution_start")(
    { toolCallId: "w1", toolName: "workflow", args: { name: "review" } },
    ctx,
  );
  workflow.updateResult(
    result("Completed workflow review\nlarge internal payload"),
  );
  assert.match(text(workflow), /◆ Workflow review · Completed workflow review/);
  assert.doesNotMatch(
    text(workflow),
    /very long script|large internal payload/,
  );

  workflow.updateResult(
    result("first failure\nstack line\ncontext line\nhidden line", true),
    false,
  );
  handlers.get("tool_execution_end")(
    {
      toolCallId: "w1",
      toolName: "workflow",
      result: result(
        "first failure\nstack line\ncontext line\nhidden line",
        true,
      ),
      isError: true,
    },
    ctx,
  );
  assert.match(text(workflow), /✗ Workflow review/);
  assert.match(text(workflow), /first failure/);
  assert.match(text(workflow), /stack line/);
  assert.match(text(workflow), /hidden line/);
});
