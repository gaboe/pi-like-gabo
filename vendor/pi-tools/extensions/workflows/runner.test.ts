import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { test } from "node:test";
import { promisify } from "node:util";
import type {
  AgentSession,
  AgentSessionEventListener,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  assertWorkflowToolPath,
  buildAgentContinuationPrompt,
  createAgentTurnBudget,
  createFirstResponseWatchdog,
  DEFAULT_AGENT_MAX_TURNS,
  guardWorkflowChildTools,
  isolateWorkflowCommand,
  isWorkflowExternalMutation,
  mergeContinuationTranscript,
  MAX_AGENT_MAX_TURNS,
  recordToolExecutionTiming,
  resolveWorkflowAgentCwd,
  runBoundedAgentAttempts,
  shouldContinueAgent,
  supportsPartialStatusSchema,
  supportsSemanticStatusSchema,
  transcriptFromMessages,
  type ToolExecutionTiming,
} from "./runner.ts";

const execFileAsync = promisify(execFile);

test("workflow agents default to the hard twelve-turn maximum", () => {
  assert.equal(DEFAULT_AGENT_MAX_TURNS, 12);
  assert.equal(MAX_AGENT_MAX_TURNS, 12);
});

test("agent turn budget warns before the limit and aborts before the next turn", async () => {
  const steers: string[] = [];
  let aborts = 0;
  const budget = createAgentTurnBudget(6, {
    async steer(message) {
      steers.push(message);
    },
    async abort() {
      aborts++;
    },
  });

  budget.observe({ type: "turn_start" });
  budget.observe({ type: "turn_end", message: {} as never, toolResults: [] });
  await Promise.resolve();
  assert.deepEqual(steers, [
    "Turn budget: 5 turns remain. Stop new exploration, finish current work, and return the required final result.",
  ]);

  for (let turn = 2; turn < 6; turn++) {
    budget.observe({ type: "turn_start" });
    budget.observe({ type: "turn_end", message: {} as never, toolResults: [] });
  }
  assert.equal(budget.isFinalizing(), true);
  assert.match(steers.at(-1) ?? "", /2 turns are reserved/);
  budget.observe({ type: "turn_start" });
  budget.observe({
    type: "turn_end",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tool-1", name: "read", arguments: {} },
      ],
    } as never,
    toolResults: [],
  });
  await Promise.resolve();
  assert.equal(aborts, 1);
  assert.equal(budget.error(), "Agent exceeded its 6-turn limit");
  budget.observe({ type: "turn_start" });
  await Promise.resolve();
  assert.equal(aborts, 1);
});

test("four total turns allow two work turns before finalization", () => {
  const steers: string[] = [];
  const budget = createAgentTurnBudget(4, {
    async steer(message) {
      steers.push(message);
    },
    async abort() {},
  });

  budget.observe({ type: "turn_start" });
  assert.equal(budget.isFinalizing(), false);
  budget.observe({ type: "turn_end", message: {} as never, toolResults: [] });
  budget.observe({ type: "turn_start" });
  assert.equal(budget.isFinalizing(), false);
  budget.observe({ type: "turn_end", message: {} as never, toolResults: [] });
  budget.observe({ type: "turn_start" });
  assert.equal(budget.isFinalizing(), true);
  assert.match(steers.at(-1) ?? "", /one of 2 usable work turns remains/);
});

test("resumable workflow schemas must expose explicit partial status", () => {
  assert.equal(
    supportsPartialStatusSchema({
      type: "object",
      properties: { status: { type: "string", enum: ["done", "partial"] } },
    }),
    true,
  );
  assert.equal(
    supportsPartialStatusSchema({
      type: "object",
      properties: { status: { type: "string", enum: ["done", "blocked"] } },
    }),
    false,
  );
  assert.equal(supportsPartialStatusSchema(undefined), false);
  assert.equal(
    supportsSemanticStatusSchema({
      properties: { status: { enum: ["done", "blocked", "failed"] } },
    }),
    true,
  );
  assert.equal(
    supportsSemanticStatusSchema({
      properties: { status: { enum: ["PASSED", "FAILED"] } },
    }),
    true,
  );
  assert.equal(
    supportsSemanticStatusSchema({
      properties: { status: { enum: ["done", "partial"] } },
    }),
    false,
  );
});

test("bounded continuation only resumes explicit partial or turn-limit outcomes", () => {
  const base = {
    ok: false,
    output: "",
    aborted: false,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 12,
    },
    transcript: [
      {
        role: "toolResult" as const,
        name: "bash",
        text: "dirty worktree remains",
      },
    ],
  };
  assert.equal(
    shouldContinueAgent({
      ...base,
      error: "Agent exceeded its 12-turn limit",
      turnLimitExceeded: true,
    }),
    true,
  );
  assert.equal(
    shouldContinueAgent({ ...base, error: "provider mentioned turn limit" }),
    false,
  );
  assert.equal(
    shouldContinueAgent({ ...base, structured: { status: "partial" } }),
    true,
  );
  assert.equal(
    shouldContinueAgent({ ...base, structured: { status: "blocked" } }),
    false,
  );
  const prompt = buildAgentContinuationPrompt(
    "Implement commit one",
    { ...base, error: "turn limit" },
    2,
    2,
  );
  assert.match(prompt, /CONTINUATION 2\/2/);
  assert.match(prompt, /Inspect git status and diff first/);
  assert.match(prompt, /dirty worktree remains/);
});

test("continuation transcript keeps bounded prior evidence and attempt markers", () => {
  const first = Array.from({ length: 200 }, (_, index) => ({
    role: "toolResult" as const,
    text: `first-${index}`,
  }));
  const second = Array.from({ length: 200 }, (_, index) => ({
    role: "toolResult" as const,
    text: `second-${index}`,
  }));
  const merged = mergeContinuationTranscript(first, second, 2);
  assert.equal(merged.length, 200);
  assert.ok(merged.some((entry) => entry.text === "first-199"));
  assert.ok(
    merged.some(
      (entry) => entry.name === "continuation" && entry.text.includes("2"),
    ),
  );
});

test("bounded continuation starts fresh attempts and stops at done", async () => {
  const controller = new AbortController();
  const prompts: string[] = [];
  let reservations = 0;
  const base = {
    output: "",
    aborted: false,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
    transcript: [],
  };
  const result = await runBoundedAgentAttempts({
    prompt: "finish local patch",
    maxContinuations: 2,
    signal: controller.signal,
    reserveContinuation() {
      reservations++;
    },
    async run(prompt, attempt) {
      prompts.push(prompt);
      return attempt === 1
        ? { ...base, ok: true, structured: { status: "partial" } }
        : { ...base, ok: true, structured: { status: "done" } };
    },
  });
  assert.equal(result.attempts, 2);
  assert.equal(reservations, 1);
  assert.deepEqual(result.outcome.structured, { status: "done" });
  assert.match(prompts[1], /Inspect git status and diff first/);
});

test("agent turn budget does not inject a warning into a one-turn run", async () => {
  let steers = 0;
  const budget = createAgentTurnBudget(1, {
    async steer() {
      steers++;
    },
    async abort() {},
  });
  budget.observe({ type: "turn_start" });
  budget.observe({ type: "turn_end", message: {} as never, toolResults: [] });
  await Promise.resolve();
  assert.equal(steers, 0);
  assert.equal(budget.isFinalizing(), true);
  assert.equal(budget.error(), undefined);
});

test("completed structured output may terminate on the final allowed turn", async () => {
  let aborts = 0;
  const budget = createAgentTurnBudget(1, {
    async steer() {},
    async abort() {
      aborts++;
    },
    isComplete: () => true,
  });
  budget.observe({ type: "turn_start" });
  budget.observe({
    type: "turn_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tool-1",
          name: "structured_output",
          arguments: {},
        },
      ],
    } as never,
    toolResults: [],
  });
  await Promise.resolve();
  assert.equal(aborts, 0);
  assert.equal(budget.error(), undefined);
});

test("workflow child policy blocks shell mutation evasions but permits local verification", () => {
  for (const command of [
    "   git push origin HEAD",
    "printf ready\ngit push origin HEAD",
    "env GIT_TRACE=1 git push origin HEAD",
    "command git push origin HEAD",
    "docker buildx build --push .",
    "bun run gh-tool pr merge --pr 1",
    "kubectl delete job stale",
    "kubectl rollout restart deployment/api",
    "helm upgrade api ./chart",
    "terraform apply -auto-approve",
    "curl -X POST https://example.test/deploy",
    "nohup npm test &",
    "sleep 10 & echo detached",
    "git merge feature",
    "git reset --hard HEAD~1",
    "git clean -fdx",
    "git commit -m unsafe",
    "rm -rf .",
    "find . -delete",
    "git symbolic-ref HEAD refs/heads/new",
    "git reflog expire --expire=now --all",
    "git update-index --assume-unchanged file",
  ]) {
    assert.equal(isWorkflowExternalMutation(command), true, command);
  }
  for (const command of [
    "git diff --check && bun test",
    "cargo build >build.log 2>&1",
    "cargo build &>build.log",
    "cargo build |& tee build.log",
    "espflash save-image --chip esp32s3 app.bin firmware.elf",
  ]) {
    assert.equal(isWorkflowExternalMutation(command), false, command);
  }
  for (const command of [
    "git log --grep=commit",
    "git diff -- docs/branch.md",
    "git branch --show-current",
    "git branch --list feature",
    "git symbolic-ref HEAD",
    "git reflog show",
    "git config --get user.name",
  ]) {
    assert.equal(isWorkflowExternalMutation(command), false, command);
  }
  assert.equal(isWorkflowExternalMutation("kubectl get pods"), false);
  assert.equal(isWorkflowExternalMutation("helm template api ./chart"), false);
  if (process.platform === "darwin") {
    const isolated = isolateWorkflowCommand("printf '%s' \"safe\"");
    assert.match(isolated, /^\/usr\/bin\/sandbox-exec /);
    assert.match(isolated, /deny network\*/);
  } else {
    assert.throws(
      () => isolateWorkflowCommand("git diff --check"),
      /network-denial sandbox/,
    );
  }
});

test("workflow agent cwd accepts trusted descendants and linked Git worktrees", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-trusted-"));
  const worktree = await mkdtemp(join(tmpdir(), "workflow-worktree-"));
  const outside = await mkdtemp(join(tmpdir(), "workflow-untrusted-"));
  try {
    const child = join(root, "child");
    const gitDirectory = join(root, "repo", ".git", "worktrees", "child");
    await mkdir(child, { recursive: true });
    await mkdir(gitDirectory, { recursive: true });
    await writeFile(join(worktree, ".git"), `gitdir: ${gitDirectory}\n`);
    await writeFile(join(outside, ".git"), `gitdir: ${outside}\n`);
    assert.equal(resolveWorkflowAgentCwd(root, "child"), await realpath(child));
    assert.equal(
      resolveWorkflowAgentCwd(root, worktree),
      await realpath(worktree),
    );
    assert.throws(
      () => resolveWorkflowAgentCwd(root, outside),
      /gitdir is outside/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("workflow filesystem tools reject parent and symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-root-"));
  const outside = await mkdtemp(join(tmpdir(), "workflow-outside-"));
  try {
    await writeFile(join(root, "inside.txt"), "ok");
    await writeFile(join(outside, "outside.txt"), "secret");
    await symlink(outside, join(root, "escape"));
    await symlink(join(outside, "future"), join(root, "dangling"));
    assert.doesNotThrow(() => assertWorkflowToolPath(root, "inside.txt"));
    assert.throws(
      () => assertWorkflowToolPath(root, "../outside.txt"),
      /confined/,
    );
    assert.throws(
      () => assertWorkflowToolPath(root, "@/etc/passwd"),
      /aliases/,
    );
    assert.throws(() => assertWorkflowToolPath(root, "~/outside"), /aliases/);
    assert.throws(
      () => assertWorkflowToolPath(root, "escape/outside.txt"),
      /symlinks/,
    );
    assert.throws(
      () => assertWorkflowToolPath(root, "dangling/new.txt"),
      /symlinks/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("workflow shell sandbox confines writes and denies network", async (t) => {
  if (process.platform !== "darwin")
    return t.skip("Darwin sandbox-exec policy");
  await execFileAsync(
    "/bin/sh",
    ["-c", isolateWorkflowCommand("git diff --check", process.cwd())],
    {
      cwd: process.cwd(),
    },
  );
  const outside = join(homedir(), `.pi-workflow-write-test-${process.pid}`);
  await rm(outside, { force: true });
  await assert.rejects(
    execFileAsync(
      "/bin/sh",
      [
        "-c",
        isolateWorkflowCommand(`printf blocked > ${outside}`, process.cwd()),
      ],
      { cwd: process.cwd() },
    ),
  );
  await rm(outside, { force: true });
  const server = createServer((socket) =>
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await assert.rejects(
    execFileAsync(
      "/bin/sh",
      [
        "-c",
        isolateWorkflowCommand(
          `curl -fsS http://127.0.0.1:${address.port}`,
          process.cwd(),
        ),
      ],
      { cwd: process.cwd() },
    ),
  );
});

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function parallelToolMessages(): AgentSession["messages"] {
  return [
    { role: "user", content: "run both", timestamp: 900 },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-a",
          name: "first",
          arguments: { value: 1 },
        },
        {
          type: "toolCall",
          id: "call-b",
          name: "second",
          arguments: { value: 2 },
        },
      ],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture",
      usage: zeroUsage,
      stopReason: "toolUse",
      timestamp: 950,
    },
    {
      role: "toolResult",
      toolCallId: "call-a",
      toolName: "first",
      content: [{ type: "text", text: "first result" }],
      isError: false,
      timestamp: 1_040,
    },
    {
      role: "toolResult",
      toolCallId: "call-b",
      toolName: "second",
      content: [{ type: "text", text: "second result" }],
      isError: false,
      timestamp: 1_041,
    },
  ];
}

test("completed parallel tool calls pair lifecycle timings with calls and results", () => {
  const timings = new Map<string, ToolExecutionTiming>();
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_start",
      toolCallId: "call-a",
      toolName: "first",
      args: { value: 1 },
    },
    1_000,
  );
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_start",
      toolCallId: "call-b",
      toolName: "second",
      args: { value: 2 },
    },
    1_002,
  );
  // Parallel calls can finish in a different order than their result messages.
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_end",
      toolCallId: "call-b",
      toolName: "second",
      result: { content: [{ type: "text", text: "second result" }] },
      isError: false,
    },
    1_012,
  );
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_end",
      toolCallId: "call-a",
      toolName: "first",
      result: { content: [{ type: "text", text: "first result" }] },
      isError: false,
    },
    1_030,
  );

  const transcript = transcriptFromMessages(parallelToolMessages(), timings);
  const toolEntries = transcript.filter((entry) => entry.role === "tool");
  const resultEntries = transcript.filter(
    (entry) => entry.role === "toolResult",
  );

  for (const entries of [toolEntries, resultEntries]) {
    assert.deepEqual(
      entries.map(({ toolCallId, startedAt, finishedAt, durationMs }) => ({
        toolCallId,
        startedAt,
        finishedAt,
        durationMs,
      })),
      [
        {
          toolCallId: "call-a",
          startedAt: 1_000,
          finishedAt: 1_030,
          durationMs: 30,
        },
        {
          toolCallId: "call-b",
          startedAt: 1_002,
          finishedAt: 1_012,
          durationMs: 10,
        },
      ],
    );
  }
});

test("in-flight aborted tool calls retain start timing without completion", () => {
  const timings = new Map<string, ToolExecutionTiming>();
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_start",
      toolCallId: "call-a",
      toolName: "first",
      args: { value: 1 },
    },
    2_000,
  );

  const transcript = transcriptFromMessages(
    parallelToolMessages().slice(0, 2),
    timings,
  );
  const first = transcript.find((entry) => entry.toolCallId === "call-a");

  assert.equal(first?.startedAt, 2_000);
  assert.equal(first?.finishedAt, undefined);
  assert.equal(first?.durationMs, undefined);
  assert.equal(
    transcript.some((entry) => entry.role === "toolResult"),
    false,
  );
});

test("first-response watchdog aborts a silent provider request", async () => {
  let aborted = false;
  const watchdog = createFirstResponseWatchdog(
    async () => {
      aborted = true;
    },
    { timeoutMs: 10, model: "fixture-model" },
  );

  await assert.rejects(
    watchdog.waitFor(new Promise<never>(() => {})),
    /no assistant response event for fixture-model within 10 ms.*stalled/i,
  );
  assert.equal(aborted, true);
});

test("first assistant response disarms the watchdog without limiting the run", async () => {
  const watchdog = createFirstResponseWatchdog(
    async () => {
      throw new Error("watchdog should have been disarmed");
    },
    { timeoutMs: 10 },
  );
  watchdog.markResponse();

  const result = await watchdog.waitFor(
    new Promise<string>((resolve) => setTimeout(() => resolve("done"), 20)),
  );
  assert.equal(result, "done");
});

test("workflow child shell and filesystem tools execute serially", async (t) => {
  if (process.platform !== "darwin")
    return t.skip("Darwin sandbox-exec policy");
  const events: string[] = [];
  const definitions = new Map<string, ToolDefinition>();
  for (const name of ["bash", "read"] as const) {
    definitions.set(name, {
      name,
      label: name,
      description: "fixture",
      parameters: Type.Object({}),
      async execute() {
        events.push(`${name}:start`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        events.push(`${name}:end`);
        return { content: [{ type: "text", text: "ok" }], details: {} };
      },
    });
  }
  const session = {
    getAllTools: () => [...definitions.keys()].map((name) => ({ name })),
    getToolDefinition: (name: string) => definitions.get(name),
    subscribe() {
      return () => {};
    },
  };
  const unsubscribe = guardWorkflowChildTools(
    session,
    100,
    () => false,
    process.cwd(),
  );
  await Promise.all([
    definitions
      .get("bash")!
      .execute("bash", { command: "true" }, undefined, undefined, {} as never),
    definitions
      .get("read")!
      .execute(
        "read",
        { path: "package.json" },
        undefined,
        undefined,
        {} as never,
      ),
  ]);
  assert.deepEqual(events, [
    "bash:start",
    "bash:end",
    "read:start",
    "read:end",
  ]);
  unsubscribe();
});

test("workflow children guard structured, normal, and dynamically registered tools", async () => {
  const structuredResult = {
    content: [{ type: "text" as const, text: "recorded" }],
    details: { value: "fixture" },
    terminate: true,
  };
  const structured = {
    name: "structured_output",
    label: "Structured Output",
    description: "fixture",
    parameters: Type.Object({}),
    async execute() {
      return structuredResult;
    },
  } satisfies ToolDefinition;
  const definitions = new Map<string, ToolDefinition>([
    [structured.name, structured],
  ]);
  let directExecutions = 0;
  let bashCommand: string | undefined;
  definitions.set("bash", {
    name: "bash",
    label: "bash",
    description: "fixture",
    parameters: Type.Object({ command: Type.String() }),
    async execute(_id, params) {
      bashCommand = (params as { command: string }).command;
      return structuredResult;
    },
  });
  for (const name of ["bg_start", "jobs"] as const) {
    definitions.set(name, {
      name,
      label: name,
      description: "fixture",
      parameters: Type.Object({ command: Type.String() }),
      async execute() {
        directExecutions++;
        return structuredResult;
      },
    });
  }
  for (const name of ["crawl", "scrape"] as const) {
    definitions.set(name, {
      name,
      label: name,
      description: "fixture",
      parameters: Type.Object({ timeout: Type.Number() }),
      async execute() {
        directExecutions++;
        return structuredResult;
      },
    });
  }
  let listener: AgentSessionEventListener | undefined;
  const session = {
    getAllTools: () => [...definitions.keys()].map((name) => ({ name })),
    getToolDefinition: (name: string) => definitions.get(name),
    subscribe(next: AgentSessionEventListener) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };

  let finalizing = false;
  const trustedBashExecute = definitions.get("bash")!.execute;
  const unsubscribe = guardWorkflowChildTools(
    session,
    10,
    () => finalizing,
    process.cwd(),
    new Map([["bash", trustedBashExecute]]),
  );
  assert.equal(await structured.execute(), structuredResult);
  for (const name of ["bg_start", "jobs"]) {
    await assert.rejects(
      definitions
        .get(name)!
        .execute(
          "fixture",
          { command: "git status" },
          undefined,
          undefined,
          {} as never,
        ),
      /not in the read\/local-work allowlist/i,
    );
  }
  assert.equal(directExecutions, 0);
  if (process.platform === "darwin") {
    await definitions
      .get("bash")!
      .execute(
        "fixture",
        { command: "git diff --check" },
        undefined,
        undefined,
        {} as never,
      );
    assert.match(bashCommand ?? "", /^\/usr\/bin\/sandbox-exec /);
  } else {
    await assert.rejects(
      definitions
        .get("bash")!
        .execute(
          "fixture",
          { command: "git diff --check" },
          undefined,
          undefined,
          {} as never,
        ),
      /network-denial sandbox/,
    );
  }

  let dynamicSignal: AbortSignal | undefined;
  const dynamic = {
    name: "fetch_content",
    label: "Dynamic Fixture",
    description: "fixture",
    parameters: Type.Object({}),
    async execute(
      _toolCallId: string,
      _params: Record<string, never>,
      signal?: AbortSignal,
    ) {
      dynamicSignal = signal;
      return new Promise<never>(() => {});
    },
  } satisfies ToolDefinition;
  const originalDynamicExecute = dynamic.execute;
  definitions.set(dynamic.name, dynamic);
  listener?.({ type: "message_end", message: {} as never });
  assert.notEqual(dynamic.execute, originalDynamicExecute);

  await assert.rejects(
    dynamic.execute("fixture", {}, undefined),
    /Tool call "fetch_content" timed out after 10 ms\./,
  );
  assert.equal(dynamicSignal?.aborted, true);

  await assert.rejects(
    definitions
      .get("bash")!
      .execute(
        "fixture",
        { command: "git diff --check", timeout: 1200 },
        undefined,
        undefined,
        {} as never,
      ),
    /tool calls are capped.*split this check.*parent/i,
  );
  await assert.rejects(
    definitions
      .get("crawl")!
      .execute("fixture", { timeout: 600 }, undefined, undefined, {} as never),
    /tool calls are capped/i,
  );
  await assert.rejects(
    definitions
      .get("scrape")!
      .execute(
        "fixture",
        { timeout: 300_001 },
        undefined,
        undefined,
        {} as never,
      ),
    /tool calls are capped/i,
  );
  finalizing = true;
  await assert.rejects(
    definitions
      .get("bash")!
      .execute(
        "fixture",
        { command: "git diff --check" },
        undefined,
        undefined,
        {} as never,
      ),
    /finalization mode.*blocked/i,
  );
  assert.equal(await structured.execute(), structuredResult);

  finalizing = false;
  const replacedBash: ToolDefinition = {
    ...definitions.get("bash")!,
    async execute() {
      directExecutions++;
      return structuredResult;
    },
  };
  definitions.set("bash", replacedBash);
  listener?.({ type: "message_end", message: {} as never });
  await assert.rejects(
    replacedBash.execute("fixture", {}, undefined, undefined, {} as never),
    /core tool "bash" was replaced/i,
  );
  assert.equal(directExecutions, 0);
  unsubscribe();
});
