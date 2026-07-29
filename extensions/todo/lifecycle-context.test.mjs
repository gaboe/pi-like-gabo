import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  bindChildSessionExtensions,
  excludeSessionOwnedChildExtensions,
  shutdownAndDisposeChildSession,
} from "../../vendor/pi-tools/extensions/shared/child-session.ts";
import {
  acquirePackageAssignmentLease,
  packageAssignmentError,
  registerPackageAssignmentGate,
} from "../../vendor/pi-tools/extensions/shared/assignment-gate-protocol.ts";
import todoExtension from "./index.ts";
import { TodoScheduler } from "./scheduler.ts";
import { __resetState } from "./todo.ts";

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

function extensionHarness() {
  const lifecycle = new Map();
  const pi = {
    events: new Bus(),
    on(name, handler) {
      const handlers = lifecycle.get(name) ?? [];
      handlers.push(handler);
      lifecycle.set(name, handlers);
    },
    registerTool() {},
    registerCommand() {},
    appendEntry() {},
    sendMessage() {},
  };
  todoExtension(pi);
  return {
    start: () =>
      lifecycle.get("session_start")[0](
        {},
        {
          mode: "print",
          hasUI: false,
          sessionManager: { getBranch: () => [] },
        },
      ),
    shutdown: () => lifecycle.get("session_shutdown")[0](),
  };
}

test("assignment gate belongs only to active TODO session", async () => {
  __resetState();
  const unregisterSentinel = registerPackageAssignmentGate(
    () => "sentinel gate",
  );
  const extension = extensionHarness();
  assert.equal(
    packageAssignmentError({ todoId: 1, todoToken: "token" }),
    "sentinel gate",
  );

  await extension.start();
  assert.notEqual(
    packageAssignmentError({ todoId: 1, todoToken: "token" }),
    "sentinel gate",
  );
  await extension.shutdown();
  assert.equal(
    packageAssignmentError({ todoId: 1, todoToken: "token" }),
    "package_handoff assignment gate unavailable.",
  );
  unregisterSentinel();
});

test("session reload refreshes gate and shutdown removes only its own registration", async () => {
  __resetState();
  const oldSession = extensionHarness();
  const newSession = extensionHarness();
  await oldSession.start();
  await oldSession.shutdown();
  assert.equal(
    packageAssignmentError({ todoId: 1, todoToken: "token" }),
    "package_handoff assignment gate unavailable.",
  );

  await newSession.start();
  assert.notEqual(
    packageAssignmentError({ todoId: 1, todoToken: "token" }),
    "package_handoff assignment gate unavailable.",
  );
  const unregisterNewer = registerPackageAssignmentGate(
    () => "newer canonical gate",
  );
  await newSession.shutdown();
  assert.equal(
    packageAssignmentError({ todoId: 1, todoToken: "token" }),
    "newer canonical gate",
  );
  unregisterNewer();
});

test("shutdown generation prevents a late session start from replacing the active gate", async () => {
  __resetState();
  const originalDisable = TodoScheduler.prototype.disableOrchestrator;
  let releaseDisable;
  const blockedDisable = new Promise((resolve) => {
    releaseDisable = resolve;
  });
  TodoScheduler.prototype.disableOrchestrator = async function () {
    await blockedDisable;
  };

  const stale = extensionHarness();
  const staleStart = stale.start();
  await Promise.resolve();
  await stale.shutdown();
  TodoScheduler.prototype.disableOrchestrator = originalDisable;

  const unregister = registerPackageAssignmentGate(() => undefined);
  const lease = acquirePackageAssignmentLease({
    todoId: 1,
    todoToken: "token",
  });
  assert.notEqual(typeof lease, "string");
  if (typeof lease === "string") throw new Error(lease);
  try {
    releaseDisable();
    await staleStart;
    assert.equal(lease.validate(), undefined);
  } finally {
    lease.close();
    unregister();
    TodoScheduler.prototype.disableOrchestrator = originalDisable;
  }
});

test("filtered child loading and binding keep acquired parent gate generation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "todo-child-gate-"));
  const unregister = registerPackageAssignmentGate(() => undefined);
  const request = { todoId: 1, todoToken: "token" };
  const lease = acquirePackageAssignmentLease(request);
  assert.notEqual(typeof lease, "string");
  if (typeof lease === "string") throw new Error(lease);

  let session;
  try {
    const settingsManager = SettingsManager.inMemory(undefined, {
      projectTrusted: false,
    });
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: path.join(directory, "agent"),
      settingsManager,
      noExtensions: true,
      extensionFactories: [todoExtension],
      extensionsOverride: excludeSessionOwnedChildExtensions,
    });
    await loader.reload();
    assert.equal(loader.getExtensions().extensions.length, 0);
    assert.equal(lease.validate(), undefined);

    ({ session } = await createAgentSession({
      cwd: directory,
      agentDir: path.join(directory, "agent"),
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(directory),
    }));
    await bindChildSessionExtensions(session);
    assert.equal(lease.validate(), undefined);
  } finally {
    lease.close();
    unregister();
    if (session) await shutdownAndDisposeChildSession(session);
    await rm(directory, { recursive: true, force: true });
  }
});

test("agent_settled ignores a stale replaced-session context", async () => {
  __resetState();
  const lifecycle = new Map();
  const pi = {
    events: new Bus(),
    on(name, handler) {
      const handlers = lifecycle.get(name) ?? [];
      handlers.push(handler);
      lifecycle.set(name, handlers);
    },
    registerTool() {},
    registerCommand() {},
    appendEntry() {},
    sendMessage() {},
  };
  todoExtension(pi);
  const replaced = { hasUI: false, sessionManager: { getBranch: () => [] } };
  const current = { hasUI: false, sessionManager: { getBranch: () => [] } };
  const stale = new Proxy(
    {},
    {
      get() {
        throw new Error("stale-context proxy accessed");
      },
    },
  );
  try {
    await lifecycle.get("session_start")[0]({}, replaced);
    await lifecycle.get("session_start")[0]({}, current);
    await lifecycle.get("agent_settled")[0]({}, stale);
  } finally {
    await lifecycle.get("session_shutdown")[0]();
  }
  assert.ok(true);
});
