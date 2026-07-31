import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import {
  BackendRegistry,
  type SubagentBackend,
  type SubagentSession,
} from "./src/backend.ts";
import type {
  BackendSpawnTask,
  ParentContext,
  SpawnTask,
  SubagentEvent,
} from "./src/domain.ts";
import {
  MAX_RUNNING,
  SubagentManager,
  SubagentManagerLive,
} from "./src/manager.ts";
import { runTool } from "./src/runtime.ts";

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: true,
};
const task = (prompt = "test"): SpawnTask => ({
  prompt,
  title: "Pi fixture",
  cwd: process.cwd(),
  parent,
});

function piFixture(): SubagentBackend {
  return {
    name: "pi",
    capabilities: {
      steering: true,
      modelSelection: true,
      reasoningEffort: true,
    },
    available: Effect.succeed(true),
    spawn: (spawnTask: BackendSpawnTask) =>
      Effect.gen(function* () {
        const events = yield* Queue.make<SubagentEvent>();
        const emit = (event: SubagentEvent) => Queue.offerUnsafe(events, event);
        return {
          meta: Effect.succeed({ backend: "pi", modelLabel: spawnTask.model }),
          events: Stream.fromQueue(events),
          start: Effect.sync(() =>
            setImmediate(() =>
              emit({
                _tag: "RunSettled",
                outcome: { _tag: "Completed", finalText: "ok" },
              }),
            ),
          ),
          send: () => Effect.void,
          interrupt: Effect.void,
        } satisfies SubagentSession;
      }),
  };
}

function runtime() {
  return ManagedRuntime.make(
    SubagentManagerLive.pipe(
      Layer.provide(
        Layer.succeed(BackendRegistry, new Map([["pi", piFixture()]])),
      ),
    ),
  );
}

test("Pi fixture completes and retains Pi backend metadata", async () => {
  const rt = runtime();
  try {
    const manager = await rt.runPromise(SubagentManager);
    const snap = await runTool(
      rt,
      manager.spawn("pi", { ...task(), model: "openai-codex/gpt-5.6-luna" }),
    );
    await runTool(rt, manager.waitFor([snap.id]));
    assert.equal(manager.view.get(snap.id)?.backend, "pi");
  } finally {
    await rt.dispose();
  }
});

test("restarting a settled subagent is visible before agent_start", async () => {
  const rt = runtime();
  try {
    const manager = await rt.runPromise(SubagentManager);
    const snap = await runTool(rt, manager.spawn("pi", task()));
    await runTool(rt, manager.waitFor([snap.id]));
    await runTool(rt, manager.send(snap.id, "continue"));
    assert.equal(manager.view.get(snap.id)?.status, "running");
  } finally {
    await rt.dispose();
  }
});

test("manager keeps MAX_RUNNING at four", () => assert.equal(MAX_RUNNING, 4));
