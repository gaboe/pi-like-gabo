import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { runAgent } from "./runner.ts";
import {
  acquireWorkspaceMutationLease,
  resetWorkspaceMutationRegistryForTests,
} from "../shared/workspace-mutation-lease.ts";

afterEach(resetWorkspaceMutationRegistryForTests);

function options(
  sessionFactory: Parameters<typeof runAgent>[0]["sessionFactory"],
) {
  return {
    prompt: "fixture",
    cwd: process.cwd(),
    loader: {} as never,
    settingsManager: {} as never,
    modelRegistry: {} as never,
    sessionFactory,
  };
}

function pendingSession() {
  let rejectPrompt: ((error: Error) => void) | undefined;
  let startedResolve: (() => void) | undefined;
  let disposals = 0;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const session = {
    model: undefined,
    messages: [],
    getAllTools: () => [],
    getToolDefinition: () => undefined,
    async bindExtensions() {},
    subscribe: () => () => {},
    async steer() {},
    prompt() {
      startedResolve?.();
      return new Promise<void>((_resolve, reject) => {
        rejectPrompt = reject;
      });
    },
    async abort() {
      rejectPrompt?.(new Error("aborted"));
    },
    getContextUsage: () => undefined,
    extensionRunner: {
      hasHandlers: () => false,
      async emit() {},
    },
    dispose() {
      disposals++;
    },
  } as unknown as AgentSession;
  return { session, started, disposals: () => disposals };
}

test("active lease blocks workflow child session factory", async () => {
  let calls = 0;
  const lease = acquireWorkspaceMutationLease(process.cwd());
  const outcome = await runAgent(
    options(async () => {
      calls++;
      throw new Error("must not create session");
    }),
  );
  assert.equal(calls, 0);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /active exclusive lease/);
  lease.close();
});

test("failed workflow child creation taints and releases worker bookkeeping", async () => {
  let calls = 0;
  const outcome = await runAgent(
    options(async () => {
      calls++;
      throw new Error("expected child failure");
    }),
  );
  assert.equal(calls, 1);
  assert.match(outcome.error ?? "", /expected child failure/);
  assert.throws(
    () => acquireWorkspaceMutationLease(process.cwd()),
    /observed unconstrained worker may have retained descendants/,
  );
});

test("active workflow child blocks leases and cancellation releases bookkeeping", async () => {
  const fake = pendingSession();
  const controller = new AbortController();
  const execution = runAgent({
    ...options(async () => ({ session: fake.session })),
    signal: controller.signal,
  });
  await fake.started;
  assert.throws(
    () => acquireWorkspaceMutationLease(process.cwd()),
    /unconstrained worker is live/,
  );
  controller.abort(new Error("cancel fixture"));
  const outcome = await execution;
  assert.equal(outcome.aborted, true);
  assert.equal(fake.disposals(), 1);
  assert.throws(
    () => acquireWorkspaceMutationLease(process.cwd()),
    /observed unconstrained worker may have retained descendants/,
  );
});
