import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  defineTool,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Cause } from "effect";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import {
  BackendRegistry,
  type SubagentBackend,
  type SubagentSession,
} from "./src/backend.ts";
import {
  createHandoffOnlyToolGate,
  createLiveToolGate,
  createNestedWorkerTool,
  createRootNestedExecutionGuard,
} from "./src/backends/pi.ts";
import {
  NESTED_NAME_MAX_BYTES,
  NESTED_OUTPUT_MAX_BYTES,
  NESTED_PROMPT_MAX_BYTES,
  type BackendName,
  type BackendSpawnTask,
  type ParentContext,
  type RunOutcome,
  type SpawnTask,
  type SubagentEvent,
} from "./src/domain.ts";
import {
  SubagentManager,
  SubagentManagerLive,
  type SubagentManagerShape,
} from "./src/manager.ts";
import { runTool } from "./src/runtime.ts";
import { currentDelegationState } from "../shared/subagent-wait-protocol.ts";
import {
  acquireWorkspaceMutationLease,
  resetWorkspaceMutationRegistryForTests,
} from "../shared/workspace-mutation-lease.ts";

afterEach(resetWorkspaceMutationRegistryForTests);

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: true,
};

function packageTask(title: string): SpawnTask {
  return {
    prompt: title,
    title,
    cwd: process.cwd(),
    maxTurns: 24,
    outputContract: "package_handoff",
    parent,
  };
}

function controlledBackend(
  name: BackendName,
  beforeSpawn?: (task: BackendSpawnTask, index: number) => Effect.Effect<void>,
  onSend?: (
    task: BackendSpawnTask,
    index: number,
    text: string,
    emit: (event: SubagentEvent) => void,
  ) => Effect.Effect<void>,
  onInterrupt?: (
    task: BackendSpawnTask,
    index: number,
    emit: (event: SubagentEvent) => void,
  ) => Effect.Effect<void>,
  onFinalize?: (task: BackendSpawnTask, index: number) => Effect.Effect<void>,
) {
  const tasks: BackendSpawnTask[] = [];
  const emitters: Array<(event: SubagentEvent) => void> = [];
  let disposals = 0;
  const backend: SubagentBackend = {
    name,
    capabilities: {
      steering: true,
      modelSelection: true,
      reasoningEffort: true,
    },
    available: Effect.succeed(true),
    spawn: (task) =>
      Effect.gen(function* () {
        const index = tasks.length;
        tasks.push(task);
        if (beforeSpawn) yield* beforeSpawn(task, index);
        const events = yield* Queue.make<SubagentEvent, Cause.Done>();
        const emit = (event: SubagentEvent) => Queue.offerUnsafe(events, event);
        emitters.push(emit);
        yield* Effect.addFinalizer(() =>
          (onFinalize?.(task, index) ?? Effect.void).pipe(
            Effect.andThen(
              Effect.sync(() => {
                disposals++;
                Queue.endUnsafe(events);
              }),
            ),
          ),
        );
        return {
          meta: Effect.succeed({ backend: name }),
          events: Stream.fromQueue(events),
          start: onSend?.(task, index, task.prompt, emit) ?? Effect.void,
          send: (text) => onSend?.(task, index, text, emit) ?? Effect.void,
          interrupt:
            onInterrupt?.(task, index, emit) ??
            Effect.sync(() => {
              emit({ _tag: "RunSettled", outcome: { _tag: "Interrupted" } });
            }),
        } satisfies SubagentSession;
      }),
  };
  return {
    backend,
    tasks,
    emitEvent(index: number, event: SubagentEvent) {
      emitters[index]?.(event);
    },
    emit(index: number, outcome: RunOutcome) {
      emitters[index]?.({ _tag: "RunSettled", outcome });
    },
    get disposals() {
      return disposals;
    },
  };
}

const validHandoff = JSON.stringify({
  status: "done",
  acceptance: [{ criterion: "test", passed: true, evidence: ["pass"] }],
  changed_paths: [],
  checks: [{ name: "test", result: "pass" }],
  review: "reviewed",
  remaining_work: [],
  risks: [],
});

function createRuntime(backends: SubagentBackend[]) {
  return ManagedRuntime.make(
    SubagentManagerLive.pipe(
      Layer.provide(
        Layer.succeed(
          BackendRegistry,
          new Map(backends.map((backend) => [backend.name, backend])),
        ),
      ),
    ),
  );
}

async function withManager(
  backends: SubagentBackend[],
  run: (
    manager: SubagentManagerShape,
    runtime: ReturnType<typeof createRuntime>,
  ) => Promise<void>,
) {
  const runtime = createRuntime(backends);
  try {
    await run(await runtime.runPromise(SubagentManager), runtime);
  } finally {
    await runtime.dispose();
  }
}

async function expectReject(effect: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(effect, pattern);
}

test("root bash is marked before execution and permanently closes later nested spawn", async () => {
  let releaseBash!: () => void;
  const bash = defineTool({
    name: "bash",
    label: "bash",
    description: "controlled bash",
    parameters: Type.Object({}),
    async execute() {
      await new Promise<void>((resolve) => {
        releaseBash = resolve;
      });
      return {
        content: [{ type: "text" as const, text: "done" }],
        details: {},
      };
    },
  });
  let spawns = 0;
  const guard = createRootNestedExecutionGuard(async () => ({
    id: `sa-${++spawns}`,
    status: "done",
    output: "done",
  }));
  const session = {
    getToolDefinition: (name: string) => (name === "bash" ? bash : undefined),
  } as Pick<AgentSession, "getToolDefinition"> as AgentSession;
  guard.apply(session);

  await guard.spawn({ prompt: "first", title: "first", role: "reviewer" });
  const running = bash.execute("bash", {}, undefined, undefined, {} as never);
  await assert.rejects(
    guard.spawn({ prompt: "late", title: "late", role: "reviewer" }),
    /root bash already ran/,
  );
  releaseBash();
  await running;
  assert.equal(spawns, 1);
});

test("real Pi tool batches serialize root mutations around nested spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-nested-batch-"));
  const events: string[] = [];
  let active: string | undefined;
  const tracked = (name: "write" | "edit" | "bash") =>
    defineTool({
      name,
      label: name,
      description: `controlled ${name}`,
      parameters: Type.Object({}),
      async execute() {
        assert.equal(active, undefined, `${name} overlapped ${active}`);
        active = name;
        events.push(`${name}:start`);
        await new Promise<void>((resolve) => setImmediate(resolve));
        events.push(`${name}:end`);
        active = undefined;
        return {
          content: [{ type: "text" as const, text: name }],
          details: {},
        };
      },
    });
  const nested = createNestedWorkerTool(async () => {
    assert.equal(active, undefined, `nested overlapped ${active}`);
    active = "nested";
    events.push("nested:start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    events.push("nested:end");
    active = undefined;
    return { id: "sa-nested", status: "done", output: "reviewed" };
  });
  const faux = fauxProvider({ provider: "batch-test" });
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("write", {}, { id: "write" }),
        fauxToolCall(
          "package_worker_spawn",
          { prompt: "review", name: "review", role: "reviewer" },
          { id: "nested" },
        ),
        fauxToolCall("edit", {}, { id: "edit" }),
        fauxToolCall("bash", {}, { id: "bash" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  const modelRuntime = await ModelRuntime.create({ modelsPath: null });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey("batch-test", "test-key");
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: join(root, "agent"),
    modelRuntime,
    model: faux.getModel(),
    sessionManager: SessionManager.inMemory(root),
    customTools: [tracked("write"), tracked("edit"), tracked("bash"), nested],
    tools: ["write", "edit", "bash", "package_worker_spawn"],
  });
  try {
    await session.prompt("run controlled batch");
    assert.deepEqual(events, [
      "write:start",
      "write:end",
      "nested:start",
      "nested:end",
      "edit:start",
      "edit:end",
      "bash:start",
      "bash:end",
    ]);
    assert.equal(nested.executionMode, "sequential");
  } finally {
    session.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("real Pi wrappers revoke every tool body in the assistant-event gap", async () => {
  for (const mode of ["authority", "handoff"] as const) {
    const root = mkdtempSync(join(tmpdir(), `pi-live-gate-${mode}-`));
    const calls = new Map<string, number>();
    const names = ["read", "write", "edit", "bash", "package_worker_spawn"];
    const tools = names.map((name) =>
      defineTool({
        name,
        label: name,
        description: name,
        executionMode: "sequential",
        parameters: Type.Object({}),
        async execute() {
          calls.set(name, (calls.get(name) ?? 0) + 1);
          return {
            content: [{ type: "text" as const, text: name }],
            details: {},
          };
        },
      }),
    );
    const faux = fauxProvider({ provider: `gate-${mode}` });
    faux.setResponses([
      fauxAssistantMessage(
        names.map((name) => fauxToolCall(name, {}, { id: name })),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const modelRuntime = await ModelRuntime.create({ modelsPath: null });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey(`gate-${mode}`, "test-key");
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: join(root, "agent"),
      modelRuntime,
      model: faux.getModel(),
      sessionManager: SessionManager.inMemory(root),
      customTools: tools,
      tools: names,
    });
    let revoked = false;
    const gate =
      mode === "authority"
        ? createLiveToolGate(
            () => (revoked ? "terminal TODO" : undefined),
            "Package Worker authority revoked",
          )
        : createHandoffOnlyToolGate();
    gate.apply(session);
    const stop = session.subscribe((event) => {
      if (event.type !== "message_end" || event.message.role !== "assistant")
        return;
      if (mode === "authority") revoked = true;
      else (gate as ReturnType<typeof createHandoffOnlyToolGate>).enter();
    });
    try {
      await session.prompt("dispatch tools");
      assert.deepEqual(Object.fromEntries(calls), {});
    } finally {
      stop();
      session.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("only a root Pi package worker can spawn depth-one approved roles", async () => {
  const pi = controlledBackend("pi");
  await withManager([pi.backend], async (manager, runtime) => {
    await expectReject(
      runTool(
        runtime,
        manager.spawnNested("missing", {
          prompt: "review",
          title: "review",
          role: "reviewer",
        }),
      ),
      /unknown/,
    );

    const ordinary = await runTool(
      runtime,
      manager.spawn("pi", {
        ...packageTask("ordinary"),
        outputContract: undefined,
      }),
    );
    await expectReject(
      runTool(
        runtime,
        manager.spawnNested(ordinary.id, {
          prompt: "review",
          title: "review",
          role: "reviewer",
        }),
      ),
      /root Pi Package Worker/,
    );

    const root = await runTool(
      runtime,
      manager.spawn("pi", packageTask("root")),
    );
    assert.deepEqual(root.lineage, { depth: 0, role: "package-worker" });
    assert.equal(typeof pi.tasks[1]?.nestedSpawn, "function");

    const child = await runTool(
      runtime,
      manager.spawnNested(root.id, {
        prompt: "review",
        title: "review",
        role: "reviewer",
        maxTurns: 8,
      }),
    );
    assert.deepEqual(child.lineage, {
      parentId: root.id,
      depth: 1,
      role: "reviewer",
    });
    assert.equal(child.maxTurns, 8);
    assert.equal(pi.tasks[2]?.nestedSpawn, undefined);
    assert.equal(pi.tasks[2]?.cwd, root.cwd);
    assert.equal(pi.tasks[2]?.parent, parent);

    const before = pi.tasks.length;
    await expectReject(
      runTool(
        runtime,
        manager.spawnNested(child.id, {
          prompt: "again",
          title: "again",
          role: "verifier",
        }),
      ),
      /root Pi Package Worker/,
    );
    assert.equal(pi.tasks.length, before);
  });
});

test("nested roles inherit package policy and receive no orchestration tools", async () => {
  const pi = controlledBackend("pi");
  await withManager([pi.backend], async (manager, runtime) => {
    const root = await runTool(
      runtime,
      manager.spawn("pi", packageTask("root")),
    );
    for (const role of ["reviewer", "verifier", "finding-fixer"] as const) {
      const child = await runTool(
        runtime,
        manager.spawnNested(root.id, {
          prompt: role,
          title: role,
          role,
        }),
      );
      const task = pi.tasks.at(-1);
      assert.equal(task?.noExtensions, true);
      assert.equal(
        task?.nestedMutationPolicy,
        role === "finding-fixer" ? "finding-fixer" : "read-only",
      );
      assert.equal(!!task?.mutationLeaseOwner, role === "finding-fixer");
      assert.deepEqual(
        task?.allowedTools,
        role === "finding-fixer" ? ["read", "edit", "write"] : ["read"],
      );
      for (const denied of [
        "subagent_spawn",
        "workflow",
        "todo",
        "ask_user",
        "jobs",
        "bg_start",
      ])
        assert.equal(task?.allowedTools?.includes(denied), false);
      await runTool(runtime, manager.cancel([child.id]));
      assert.equal(manager.view.get(root.id)?.status, "running");
    }
  });
});

test("Pi root and nested backends synchronously share package turn claims", async () => {
  const pi = controlledBackend("pi");
  await withManager([pi.backend], async (manager, runtime) => {
    const root = await runTool(
      runtime,
      manager.spawn("pi", { ...packageTask("claimed-root"), maxTurns: 5 }),
    );
    assert.equal(pi.tasks[0]?.claimTurn?.(), true);
    pi.emitEvent(0, {
      _tag: "AssistantMessage",
      parts: [{ type: "text", text: "root accepted" }],
    });

    const child = await runTool(
      runtime,
      manager.spawnNested(root.id, {
        prompt: "use remaining budget",
        title: "claimed-child",
        role: "finding-fixer",
        maxTurns: 3,
      }),
    );
    assert.equal(child.maxTurns, 3);
    for (let turn = 0; turn < 3; turn++) {
      assert.equal(pi.tasks[1]?.claimTurn?.(), true);
      pi.emitEvent(1, {
        _tag: "AssistantMessage",
        parts: [{ type: "text", text: `child-${turn}` }],
      });
    }
    let overflowMutationRan = false;
    if (pi.tasks[1]?.claimTurn?.()) overflowMutationRan = true;
    assert.equal(overflowMutationRan, false);
    assert.equal(pi.tasks[0]?.claimTurn?.(), true);
    pi.emitEvent(0, {
      _tag: "AssistantMessage",
      parts: [{ type: "text", text: "root final accepted" }],
    });
    await new Promise<void>((resolve) => {
      const done = () =>
        manager.view.get(child.id)?.turns === 3 &&
        manager.view.get(root.id)?.turns === 2;
      if (done()) return resolve();
      const stop = manager.view.subscribe(() => {
        if (!done()) return;
        stop();
        resolve();
      });
    });
    assert.equal(manager.view.get(root.id)?.turns, 2);
    assert.equal(manager.view.get(child.id)?.turns, 3);
  });
});

test("nested maxTurns 1, 2, 3, and 8 remain exact and enforce the shared package limit", async () => {
  for (const maxTurns of [1, 2, 3, 8]) {
    const pi = controlledBackend("pi");
    await withManager([pi.backend], async (manager, runtime) => {
      const root = await runTool(
        runtime,
        manager.spawn("pi", packageTask(`root-${maxTurns}`)),
      );
      for (let turn = maxTurns; turn < root.maxTurns; turn++)
        pi.emitEvent(0, {
          _tag: "AssistantMessage",
          parts: [{ type: "text", text: `root-${turn}` }],
        });
      await new Promise<void>((resolve) => {
        if (manager.view.get(root.id)?.turns === root.maxTurns - maxTurns)
          return resolve();
        const stop = manager.view.subscribeTo(root.id, () => {
          if (manager.view.get(root.id)?.turns !== root.maxTurns - maxTurns)
            return;
          stop();
          resolve();
        });
      });

      const child = await runTool(
        runtime,
        manager.spawnNested(root.id, {
          prompt: "verify exact limit",
          title: `limit-${maxTurns}`,
          role: "verifier",
          maxTurns,
        }),
      );
      assert.equal(child.maxTurns, maxTurns);
      assert.equal(pi.tasks[1]?.maxTurns, maxTurns);
      for (let turn = 0; turn < maxTurns; turn++)
        pi.emitEvent(1, {
          _tag: "AssistantMessage",
          parts: [{ type: "text", text: `child-${turn}` }],
        });
      pi.emitEvent(1, {
        _tag: "AssistantMessage",
        parts: [{ type: "text", text: "overflow" }],
      });
      await runTool(runtime, manager.waitFor([child.id]));
      assert.equal(manager.view.get(child.id)?.turns, maxTurns);
      assert.equal(
        manager.view.get(child.id)?.errorText,
        `Subagent reached its ${maxTurns}-turn limit.`,
      );
      assert.equal(manager.view.get(root.id)?.status, "running");
    });
  }
});

test("nested spawn rejects insufficient shared package budget rather than truncating", async () => {
  const pi = controlledBackend("pi");
  await withManager([pi.backend], async (manager, runtime) => {
    const root = await runTool(
      runtime,
      manager.spawn("pi", { ...packageTask("limited-root"), maxTurns: 5 }),
    );
    for (let turn = 0; turn < 2; turn++) {
      assert.equal(pi.tasks[0]?.claimTurn?.(), true);
      pi.emitEvent(0, {
        _tag: "AssistantMessage",
        parts: [{ type: "text", text: `root-${turn}` }],
      });
    }
    await new Promise<void>((resolve) => {
      if (manager.view.get(root.id)?.turns === 2) return resolve();
      const stop = manager.view.subscribeTo(root.id, () => {
        if (manager.view.get(root.id)?.turns !== 2) return;
        stop();
        resolve();
      });
    });
    await expectReject(
      runTool(
        runtime,
        manager.spawnNested(root.id, {
          prompt: "needs four",
          title: "four",
          role: "verifier",
          maxTurns: 4,
        }),
      ),
      /requested 4 turns but only 3 package turns remain/,
    );
    assert.equal(pi.tasks.length, 1);
    assert.equal(manager.view.get(root.id)?.turns, 2);
    assert.equal(pi.tasks[0]?.claimTurn?.(), true);
  });
});

test("nested final-turn tool batches complete for exact limits 1, 2, and 3", async () => {
  for (const maxTurns of [1, 2, 3]) {
    const pi = controlledBackend("pi");
    await withManager([pi.backend], async (manager, runtime) => {
      const root = await runTool(
        runtime,
        manager.spawn("pi", packageTask(`tool-root-${maxTurns}`)),
      );
      const child = await runTool(
        runtime,
        manager.spawnNested(root.id, {
          prompt: "complete final tool batch",
          title: `tool-limit-${maxTurns}`,
          role: "verifier",
          maxTurns,
        }),
      );
      for (let turn = 1; turn < maxTurns; turn++)
        pi.emitEvent(1, {
          _tag: "AssistantMessage",
          parts: [{ type: "text", text: `turn-${turn}` }],
        });
      pi.emitEvent(1, {
        _tag: "AssistantMessage",
        parts: [
          {
            type: "toolCall",
            toolId: "final-tool",
            name: "read",
          },
        ],
      });
      pi.emitEvent(1, {
        _tag: "ToolStart",
        toolId: "final-tool",
        name: "read",
      });
      pi.emitEvent(1, {
        _tag: "ToolEnd",
        toolId: "final-tool",
        name: "read",
        isError: false,
        outputPreview: "evidence",
      });
      pi.emitEvent(1, {
        _tag: "AssistantMessage",
        parts: [{ type: "text", text: "must not execute" }],
      });
      await runTool(runtime, manager.waitFor([child.id]));
      const settled = manager.view.get(child.id);
      assert.equal(settled?.turns, maxTurns);
      assert.equal(
        settled?.errorText,
        `Subagent reached its ${maxTurns}-turn limit.`,
      );
      assert.ok(
        settled?.transcript.some(
          (item) =>
            item.kind === "toolResult" &&
            item.toolId === "final-tool" &&
            item.outputPreview === "evidence",
        ),
      );
    });
  }
});

test("Package Worker mutation cwd rejects Git administration data before backend spawn", async () => {
  const pi = controlledBackend("pi");
  const repository = mkdtempSync(join(tmpdir(), "pi-package-git-admin-"));
  try {
    mkdirSync(join(repository, ".git", "hooks"), { recursive: true });
    await withManager([pi.backend], async (manager, runtime) => {
      await expectReject(
        runTool(
          runtime,
          manager.spawn("pi", {
            ...packageTask("admin-root"),
            cwd: join(repository, ".git", "hooks"),
          }),
        ),
        /inside Git administration data/,
      );
      assert.equal(pi.tasks.length, 0);
    });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("shared package limit preserves the reserved handoff correction turn", async () => {
  const pi = controlledBackend("pi", undefined, (_task, index, text, emit) =>
    Effect.sync(() => {
      if (index !== 0 || !text.startsWith("Mechanical Handoff Gate rejected"))
        return;
      emit({ _tag: "UserMessage", text });
      emit({ _tag: "RunStarted" });
      emit({
        _tag: "AssistantMessage",
        parts: [{ type: "text", text: validHandoff }],
      });
      emit({
        _tag: "RunSettled",
        outcome: { _tag: "Completed", finalText: validHandoff },
      });
    }),
  );
  await withManager([pi.backend], async (manager, runtime) => {
    const root = await runTool(
      runtime,
      manager.spawn("pi", { ...packageTask("root"), maxTurns: 4 }),
    );
    const child = await runTool(
      runtime,
      manager.spawnNested(root.id, {
        prompt: "verify",
        title: "verify",
        role: "verifier",
        maxTurns: 3,
      }),
    );
    for (let turn = 0; turn < 3; turn++)
      pi.emitEvent(1, {
        _tag: "AssistantMessage",
        parts: [{ type: "text", text: `child-${turn}` }],
      });
    pi.emit(1, { _tag: "Completed", finalText: "verified" });
    await runTool(runtime, manager.waitFor([child.id]));

    pi.emitEvent(0, {
      _tag: "AssistantMessage",
      parts: [{ type: "text", text: '{"status":"done"}' }],
    });
    pi.emit(0, { _tag: "Completed", finalText: '{"status":"done"}' });
    await runTool(runtime, manager.waitFor([root.id]));
    assert.equal(manager.view.get(root.id)?.turns, 2);
    assert.equal(manager.view.get(root.id)?.handoff?.status, "done");
    assert.equal(manager.view.get(root.id)?.status, "done");
  });
});

test("roots and nested workers share global MAX_RUNNING", async () => {
  const pi = controlledBackend("pi");
  await withManager([pi.backend], async (manager, runtime) => {
    const roots = [];
    for (let index = 0; index < 3; index++)
      roots.push(
        await runTool(
          runtime,
          manager.spawn("pi", packageTask(`root-${index}`)),
        ),
      );
    await runTool(
      runtime,
      manager.spawnNested(roots[0]!.id, {
        prompt: "review",
        title: "review",
        role: "reviewer",
      }),
    );
    await expectReject(
      runTool(runtime, manager.spawn("pi", packageTask("fifth"))),
      /Max 4 subagents/,
    );
  });
});

test(
  "natural root completion drains blocked child before capacity, workspace, delegation, and result release",
  { timeout: 2_000 },
  async () => {
    let childInterrupts = 0;
    let interruptStarted!: () => void;
    let releaseChild!: () => void;
    const started = new Promise<void>((resolve) => {
      interruptStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const pi = controlledBackend(
      "pi",
      undefined,
      undefined,
      (_task, index, emit) =>
        index === 1
          ? Effect.promise(async () => {
              childInterrupts++;
              interruptStarted();
              await blocked;
              emit({
                _tag: "RunSettled",
                outcome: { _tag: "Interrupted" },
              });
            })
          : Effect.sync(() =>
              emit({
                _tag: "RunSettled",
                outcome: { _tag: "Interrupted" },
              }),
            ),
    );
    const rootCwd = mkdtempSync(join(tmpdir(), "pi-root-drain-"));
    const fillerCwds = [
      mkdtempSync(join(tmpdir(), "pi-root-filler-")),
      mkdtempSync(join(tmpdir(), "pi-root-filler-")),
    ];
    try {
      await withManager([pi.backend], async (manager, runtime) => {
        const settled: string[] = [];
        manager.view.setOnSettled((snapshot) => settled.push(snapshot.id));
        const root = await runTool(
          runtime,
          manager.spawn("pi", {
            ...packageTask("root"),
            cwd: rootCwd,
            todoId: 146,
            todoToken: "prep-146",
          }),
        );
        const child = await runTool(
          runtime,
          manager.spawnNested(root.id, {
            prompt: "blocked review",
            title: "review",
            role: "reviewer",
          }),
        );
        const fillers = [];
        for (let index = 0; index < fillerCwds.length; index++)
          fillers.push(
            await runTool(
              runtime,
              manager.spawn("pi", {
                ...packageTask(`filler-${index}`),
                cwd: fillerCwds[index]!,
              }),
            ),
          );

        pi.emit(0, { _tag: "Completed", finalText: validHandoff });
        await started;
        let rootWaitSettled = false;
        const rootWait = runTool(runtime, manager.waitFor([root.id])).then(
          () => {
            rootWaitSettled = true;
          },
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(rootWaitSettled, false);
        assert.equal(manager.view.get(root.id)?.status, "running");
        assert.equal(manager.view.get(child.id)?.status, "running");
        assert.deepEqual(currentDelegationState(manager.view.list()), {
          delegations: [{ id: root.id, todo_id: 146, todo_token: "prep-146" }],
        });
        assert.throws(
          () => acquireWorkspaceMutationLease(rootCwd),
          /overlapping managed worker is live/,
        );
        await expectReject(
          runTool(runtime, manager.spawn("pi", packageTask("replacement"))),
          /Max 4 subagents/,
        );

        releaseChild();
        await rootWait;
        assert.equal(childInterrupts, 1);
        assert.equal(manager.view.get(child.id)?.errorText, "Run was aborted");
        assert.equal(manager.view.get(root.id)?.status, "done");
        assert.deepEqual(settled.slice(0, 2), [child.id, root.id]);
        assert.deepEqual(currentDelegationState(manager.view.list()), {
          delegations: [],
        });
        acquireWorkspaceMutationLease(rootCwd).close();
        await runTool(runtime, manager.cancel(fillers.map(({ id }) => id)));
      });
    } finally {
      releaseChild();
      rmSync(rootCwd, { recursive: true, force: true });
      for (const cwd of fillerCwds)
        rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test(
  "concurrent root cancellation single-flights blocked descendant drain",
  { timeout: 2_000 },
  async () => {
    let childInterrupts = 0;
    let interruptStarted!: () => void;
    let releaseChild!: () => void;
    const started = new Promise<void>((resolve) => {
      interruptStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const pi = controlledBackend(
      "pi",
      undefined,
      undefined,
      (_task, index, emit) =>
        index === 1
          ? Effect.promise(async () => {
              childInterrupts++;
              interruptStarted();
              await blocked;
              emit({
                _tag: "RunSettled",
                outcome: { _tag: "Interrupted" },
              });
            })
          : Effect.sync(() =>
              emit({
                _tag: "RunSettled",
                outcome: { _tag: "Interrupted" },
              }),
            ),
    );
    await withManager([pi.backend], async (manager, runtime) => {
      const settled: string[] = [];
      manager.view.setOnSettled((snapshot) => settled.push(snapshot.id));
      const root = await runTool(
        runtime,
        manager.spawn("pi", packageTask("root")),
      );
      const child = await runTool(
        runtime,
        manager.spawnNested(root.id, {
          prompt: "blocked review",
          title: "review",
          role: "reviewer",
        }),
      );

      const first = runTool(runtime, manager.cancel([root.id]));
      const second = runTool(runtime, manager.cancel([root.id]));
      await started;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(manager.view.get(root.id)?.status, "running");
      assert.equal(manager.view.get(child.id)?.status, "running");
      assert.equal(childInterrupts, 1);
      releaseChild();
      const reports = await Promise.all([first, second]);
      assert.equal(reports[0][0]?.cancelled, true);
      assert.equal(reports[1][0]?.cancelled, true);
      assert.equal(childInterrupts, 1);
      assert.equal(manager.view.get(root.id)?.errorText, "Run was aborted");
      assert.equal(manager.view.get(child.id)?.errorText, "Run was aborted");
      assert.equal(settled.filter((id) => id === root.id).length, 1);
      assert.equal(settled.filter((id) => id === child.id).length, 1);
    });
  },
);

test("stale parent after blocked child spawn closes child without registration", async () => {
  let releaseChild = () => {};
  let childStarted!: () => void;
  const childSpawnStarted = new Promise<void>((resolve) => {
    childStarted = resolve;
  });
  const pi = controlledBackend("pi", (_task, index) =>
    index === 1
      ? Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              childStarted();
              releaseChild = resolve;
            }),
        )
      : Effect.void,
  );
  await withManager([pi.backend], async (manager, runtime) => {
    const root = await runTool(
      runtime,
      manager.spawn("pi", packageTask("root")),
    );
    const child = runTool(
      runtime,
      manager.spawnNested(root.id, {
        prompt: "blocked review",
        title: "review",
        role: "finding-fixer",
      }),
    );
    await childSpawnStarted;
    pi.emit(0, { _tag: "Completed", finalText: validHandoff });
    const rootWait = runTool(runtime, manager.waitFor([root.id]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(manager.view.get(root.id)?.status, "running");
    releaseChild();
    await expectReject(child, /stopped|cancelled/);
    await rootWait;
    assert.equal(manager.view.get(root.id)?.status, "done");
    assert.deepEqual(
      manager.view.list().map(({ id }) => id),
      [root.id],
    );
    assert.equal(pi.disposals, 1);
    acquireWorkspaceMutationLease(process.cwd()).close();
  });
});

test("stale parent keeps child that began model execution visible", async () => {
  let releaseChild = () => {};
  let childStarted!: () => void;
  const childModelStarted = new Promise<void>((resolve) => {
    childStarted = resolve;
  });
  const pi = controlledBackend("pi", undefined, (_task, index) =>
    index === 1
      ? Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              childStarted();
              releaseChild = resolve;
            }),
        )
      : Effect.void,
  );
  await withManager([pi.backend], async (manager, runtime) => {
    const root = await runTool(
      runtime,
      manager.spawn("pi", packageTask("root")),
    );
    const starting = runTool(
      runtime,
      manager.spawnNested(root.id, {
        prompt: "started review",
        title: "review",
        role: "reviewer",
      }),
    );
    await childModelStarted;
    pi.emit(0, { _tag: "Completed", finalText: validHandoff });
    const rootWait = runTool(runtime, manager.waitFor([root.id]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(manager.view.get(root.id)?.status, "running");
    releaseChild();
    await expectReject(starting, /stopped|cancelled/);
    await rootWait;
    const child = manager.view
      .list()
      .find((snapshot) => snapshot.lineage?.parentId === root.id);
    assert.ok(child);
    await runTool(runtime, manager.waitFor([child.id]));
    assert.equal(manager.view.get(child.id)?.status, "error");
    assert.equal(
      manager.view.list().some(({ id }) => id === child.id),
      true,
    );
  });
});

test("nested tool abort cancels child wait and leaves root running", async () => {
  let childStarted!: () => void;
  const childSpawnStarted = new Promise<void>((resolve) => {
    childStarted = resolve;
  });
  const pi = controlledBackend("pi", (_task, index) =>
    index === 1 ? Effect.sync(childStarted) : Effect.void,
  );
  await withManager([pi.backend], async (manager, runtime) => {
    const root = await runTool(
      runtime,
      manager.spawn("pi", packageTask("root")),
    );
    const controller = new AbortController();
    const nested = pi.tasks[0]!.nestedSpawn!(
      { prompt: "review", title: "review", role: "reviewer" },
      controller.signal,
    );
    await childSpawnStarted;
    controller.abort();
    await assert.rejects(nested);
    const child = manager.view
      .list()
      .find((snapshot) => snapshot.lineage?.parentId === root.id);
    assert.equal(child?.status, "error");
    assert.equal(child?.errorText, "Run was aborted");
    assert.equal(manager.view.get(root.id)?.status, "running");
  });
});

test("nested requests and parent-observed results are bounded", async () => {
  let childStarted!: () => void;
  const childSpawnStarted = new Promise<void>((resolve) => {
    childStarted = resolve;
  });
  const pi = controlledBackend("pi", (_task, index) =>
    index === 1 ? Effect.sync(childStarted) : Effect.void,
  );
  await withManager([pi.backend], async (manager, runtime) => {
    const root = await runTool(
      runtime,
      manager.spawn("pi", packageTask("root")),
    );
    const before = pi.tasks.length;
    await expectReject(
      runTool(
        runtime,
        manager.spawnNested(root.id, {
          prompt: "é".repeat(NESTED_PROMPT_MAX_BYTES / 2 + 1),
          title: "review",
          role: "reviewer",
        }),
      ),
      /prompt.*at most/,
    );
    await expectReject(
      runTool(
        runtime,
        manager.spawnNested(root.id, {
          prompt: "review",
          title: "x".repeat(NESTED_NAME_MAX_BYTES + 1),
          role: "reviewer",
        }),
      ),
      /name.*at most/,
    );
    assert.equal(pi.tasks.length, before);

    const resultPromise = pi.tasks[0]!.nestedSpawn!({
      prompt: "review",
      title: "review",
      role: "reviewer",
    });
    await childSpawnStarted;
    pi.emit(1, {
      _tag: "Completed",
      finalText: "é".repeat(NESTED_OUTPUT_MAX_BYTES),
    });
    const result = await resultPromise;
    assert.ok(Buffer.byteLength(result.output) <= NESTED_OUTPUT_MAX_BYTES);
  });

  const signal = new AbortController().signal;
  let observedSignal: AbortSignal | undefined;
  const tool = createNestedWorkerTool(async (_request, receivedSignal) => {
    observedSignal = receivedSignal;
    return {
      id: "sa-large",
      status: "error",
      output: "é".repeat(NESTED_OUTPUT_MAX_BYTES),
      error: "é".repeat(NESTED_OUTPUT_MAX_BYTES),
    };
  });
  const schema = tool.parameters as unknown as {
    properties: { prompt: { maxLength: number }; name: { maxLength: number } };
  };
  assert.equal(schema.properties.prompt.maxLength, NESTED_PROMPT_MAX_BYTES);
  assert.equal(schema.properties.name.maxLength, NESTED_NAME_MAX_BYTES);
  const toolResult = await tool.execute(
    "call",
    { prompt: "review", name: "review", role: "reviewer" },
    signal,
    undefined,
    {} as never,
  );
  assert.equal(observedSignal, signal);
  const observed = JSON.parse(
    (toolResult.content[0] as { type: "text"; text: string }).text,
  ) as { output: string; error: string };
  assert.ok(Buffer.byteLength(observed.output) <= NESTED_OUTPUT_MAX_BYTES);
  assert.ok(Buffer.byteLength(observed.error) <= NESTED_OUTPUT_MAX_BYTES);
});

test("root cancellation cascades while nested-only cancellation leaves root running", async () => {
  const pi = controlledBackend("pi");
  await withManager([pi.backend], async (manager, runtime) => {
    const firstRoot = await runTool(
      runtime,
      manager.spawn("pi", packageTask("first")),
    );
    const firstChild = await runTool(
      runtime,
      manager.spawnNested(firstRoot.id, {
        prompt: "review",
        title: "review",
        role: "reviewer",
      }),
    );
    await runTool(runtime, manager.cancel([firstChild.id]));
    assert.equal(manager.view.get(firstRoot.id)?.status, "running");
    assert.equal(manager.view.get(firstChild.id)?.status, "error");
    await runTool(runtime, manager.cancel([firstRoot.id]));

    const secondRoot = await runTool(
      runtime,
      manager.spawn("pi", packageTask("second")),
    );
    const secondChild = await runTool(
      runtime,
      manager.spawnNested(secondRoot.id, {
        prompt: "fix",
        title: "fix",
        role: "finding-fixer",
      }),
    );
    await runTool(runtime, manager.cancel([secondRoot.id]));
    assert.equal(manager.view.get(secondRoot.id)?.status, "error");
    assert.equal(manager.view.get(secondChild.id)?.status, "error");
  });
});

test(
  "forced cancellation retains root and child until blocked Pi finalizer acknowledges closure",
  { timeout: 8_000 },
  async () => {
    let finalizerStarted!: () => void;
    let releaseFinalizer!: () => void;
    const started = new Promise<void>((resolve) => {
      finalizerStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseFinalizer = resolve;
    });
    const pi = controlledBackend(
      "pi",
      undefined,
      undefined,
      (_task, index) => (index === 1 ? Effect.never : Effect.void),
      (_task, index) =>
        index === 1
          ? Effect.promise(async () => {
              finalizerStarted();
              await blocked;
            })
          : Effect.void,
    );
    const rootCwd = mkdtempSync(join(tmpdir(), "pi-forced-root-"));
    const fillerCwds = [
      mkdtempSync(join(tmpdir(), "pi-forced-filler-")),
      mkdtempSync(join(tmpdir(), "pi-forced-filler-")),
    ];
    try {
      await withManager([pi.backend], async (manager, runtime) => {
        const settled: string[] = [];
        manager.view.setOnSettled(({ id }) => settled.push(id));
        const root = await runTool(
          runtime,
          manager.spawn("pi", {
            ...packageTask("root"),
            cwd: rootCwd,
            todoId: 146,
            todoToken: "prep-146",
          }),
        );
        const child = await runTool(
          runtime,
          manager.spawnNested(root.id, {
            prompt: "blocked review",
            title: "review",
            role: "reviewer",
          }),
        );
        const fillers = await Promise.all(
          fillerCwds.map((cwd, index) =>
            runTool(
              runtime,
              manager.spawn("pi", {
                ...packageTask(`filler-${index}`),
                cwd,
              }),
            ),
          ),
        );
        const cancellation = runTool(runtime, manager.cancel([root.id]));
        await started;
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        assert.equal(manager.view.get(root.id)?.status, "running");
        assert.equal(manager.view.get(child.id)?.status, "running");
        assert.deepEqual(settled, []);
        assert.deepEqual(currentDelegationState(manager.view.list()), {
          delegations: [{ id: root.id, todo_id: 146, todo_token: "prep-146" }],
        });
        assert.throws(
          () => acquireWorkspaceMutationLease(rootCwd),
          /overlapping managed worker is live/,
        );
        await expectReject(
          runTool(runtime, manager.spawn("pi", packageTask("replacement"))),
          /Max 4 subagents/,
        );

        releaseFinalizer();
        await cancellation;
        assert.deepEqual(settled, [child.id, root.id]);
        assert.equal(manager.view.get(child.id)?.status, "error");
        assert.equal(manager.view.get(root.id)?.status, "error");
        acquireWorkspaceMutationLease(rootCwd).close();
        await runTool(runtime, manager.cancel(fillers.map(({ id }) => id)));
      });
    } finally {
      releaseFinalizer();
      rmSync(rootCwd, { recursive: true, force: true });
      for (const cwd of fillerCwds)
        rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test("nested turn-limit closes its Pi scope before settlement", async () => {
  let finalizerStarted!: () => void;
  let releaseFinalizer!: () => void;
  const started = new Promise<void>((resolve) => {
    finalizerStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseFinalizer = resolve;
  });
  const pi = controlledBackend(
    "pi",
    undefined,
    undefined,
    undefined,
    (_task, index) =>
      index === 1
        ? Effect.promise(async () => {
            finalizerStarted();
            await blocked;
          })
        : Effect.void,
  );
  await withManager([pi.backend], async (manager, runtime) => {
    const settled: string[] = [];
    manager.view.setOnSettled(({ id }) => settled.push(id));
    const root = await runTool(
      runtime,
      manager.spawn("pi", {
        ...packageTask("root"),
        todoId: 146,
        todoToken: "prep-146",
      }),
    );
    const child = await runTool(
      runtime,
      manager.spawnNested(root.id, {
        prompt: "one turn",
        title: "limited",
        role: "verifier",
        maxTurns: 1,
      }),
    );
    pi.emitEvent(1, {
      _tag: "AssistantMessage",
      parts: [{ type: "text", text: "allowed" }],
    });
    pi.emitEvent(1, {
      _tag: "AssistantMessage",
      parts: [{ type: "text", text: "overflow" }],
    });
    await started;
    assert.equal(manager.view.get(root.id)?.status, "running");
    assert.equal(manager.view.get(child.id)?.status, "running");
    assert.deepEqual(settled, []);
    assert.deepEqual(currentDelegationState(manager.view.list()), {
      delegations: [{ id: root.id, todo_id: 146, todo_token: "prep-146" }],
    });
    releaseFinalizer();
    await runTool(runtime, manager.waitFor([child.id]));
    assert.equal(
      manager.view.get(child.id)?.errorText,
      "Subagent reached its 1-turn limit.",
    );
    assert.deepEqual(settled, [child.id]);
    assert.equal(manager.view.get(root.id)?.status, "running");
  });
});

test("dispose retains lineage publication and closes descendants before roots", async () => {
  let childFinalizerStarted!: () => void;
  let releaseChild!: () => void;
  const childStarted = new Promise<void>((resolve) => {
    childFinalizerStarted = resolve;
  });
  const childBlocked = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  const order: string[] = [];
  const pi = controlledBackend(
    "pi",
    undefined,
    undefined,
    undefined,
    (_task, index) =>
      Effect.promise(async () => {
        order.push(`${index}:start`);
        if (index === 1) {
          childFinalizerStarted();
          await childBlocked;
        }
        order.push(`${index}:end`);
      }),
  );
  const runtime = createRuntime([pi.backend]);
  const manager = await runtime.runPromise(SubagentManager);
  const root = await runTool(
    runtime,
    manager.spawn("pi", {
      ...packageTask("root"),
      todoId: 146,
      todoToken: "prep-146",
    }),
  );
  const child = await runTool(
    runtime,
    manager.spawnNested(root.id, {
      prompt: "review",
      title: "review",
      role: "reviewer",
    }),
  );
  const publications: string[][] = [];
  const publish = () =>
    publications.push(manager.view.list().map(({ id }) => id));
  publish();
  manager.view.subscribe(publish);
  const disposal = runtime.dispose();
  await childStarted;
  assert.deepEqual(
    manager.view.list().map(({ id }) => id),
    [root.id, child.id],
  );
  assert.deepEqual(currentDelegationState(manager.view.list()), {
    delegations: [{ id: root.id, todo_id: 146, todo_token: "prep-146" }],
  });
  assert.deepEqual(order, ["1:start"]);
  releaseChild();
  await disposal;
  assert.deepEqual(order, ["1:start", "1:end", "0:start", "0:end"]);
  assert.deepEqual(publications, [[root.id, child.id], []]);
  assert.deepEqual(manager.view.list(), []);
});

test("dispose closes root and descendants and correction cannot spawn", async () => {
  const pi = controlledBackend("pi");
  const runtime = createRuntime([pi.backend]);
  const manager = await runtime.runPromise(SubagentManager);
  const root = await runTool(runtime, manager.spawn("pi", packageTask("root")));
  await runTool(
    runtime,
    manager.spawnNested(root.id, {
      prompt: "review",
      title: "review",
      role: "reviewer",
    }),
  );
  await runtime.dispose();
  assert.equal(pi.disposals, 2);

  const correctionBackend = controlledBackend("pi");
  await withManager(
    [correctionBackend.backend],
    async (nextManager, nextRuntime) => {
      const correcting = await runTool(
        nextRuntime,
        nextManager.spawn("pi", packageTask("correcting")),
      );
      correctionBackend.emit(0, {
        _tag: "Completed",
        finalText: '{"status":"done"}',
      });
      await new Promise<void>((resolve) => {
        const stop = nextManager.view.subscribeTo(correcting.id, () => {
          if (!nextManager.view.get(correcting.id)?.handoff?.errors) return;
          stop();
          resolve();
        });
      });
      const before = correctionBackend.tasks.length;
      await expectReject(
        runTool(
          nextRuntime,
          nextManager.spawnNested(correcting.id, {
            prompt: "late review",
            title: "late",
            role: "reviewer",
          }),
        ),
        /correction cannot spawn/,
      );
      assert.equal(correctionBackend.tasks.length, before);
    },
  );
});
