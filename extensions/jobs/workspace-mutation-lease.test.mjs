import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { JobManager } from "./manager.ts";
import { JobStore } from "./store.ts";
import {
  acquireWorkspaceMutationLease,
  resetWorkspaceMutationRegistryForTests,
} from "../../vendor/pi-tools/extensions/shared/workspace-mutation-lease.ts";

afterEach(resetWorkspaceMutationRegistryForTests);

async function fixture(commands, onLifecycle = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-jobs-workspace-lease-"));
  const manager = new JobManager(new JobStore(root), commands, {
    onLifecycle,
    async approveNetwork() {
      return false;
    },
  });
  await manager.initialize("workspace-lease", root);
  return {
    root,
    manager,
    async close() {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function definition(root) {
  return {
    kind: "command",
    title: "lease fixture",
    command: "fixture",
    cwd: root,
    restartPolicy: "never",
    conditions: [],
  };
}

test("active lease rejects command jobs before backend start", async () => {
  let starts = 0;
  const f = await fixture({
    async start() {
      starts++;
      throw new Error("backend must not start");
    },
    async stop() {},
  });
  try {
    const lease = acquireWorkspaceMutationLease(f.root);
    await assert.rejects(
      f.manager.start(definition(f.root)),
      /active exclusive lease/,
    );
    assert.equal(starts, 0);
    lease.close();
  } finally {
    await f.close();
  }
});

test("active command job blocks leases and stop releases active bookkeeping", async () => {
  let stops = 0;
  const f = await fixture({
    async start() {
      return {
        id: "bt-active",
        async stop() {
          stops++;
        },
        dispose() {},
      };
    },
    async stop() {},
  });
  try {
    const job = await f.manager.start(definition(f.root));
    assert.throws(
      () => acquireWorkspaceMutationLease(f.root),
      /shell is executing/,
    );
    await f.manager.stop(job.id);
    assert.equal(stops, 1);
    assert.throws(
      () => acquireWorkspaceMutationLease(f.root),
      /observed shell execution may have retained descendants/,
    );
  } finally {
    await f.close();
  }
});

test("failed command backend start taints and releases active bookkeeping", async () => {
  const f = await fixture({
    async start() {
      throw new Error("expected spawn failure");
    },
    async stop() {},
  });
  try {
    await assert.rejects(
      f.manager.start(definition(f.root)),
      /expected spawn failure/,
    );
    assert.throws(
      () => acquireWorkspaceMutationLease(f.root),
      /observed shell execution may have retained descendants/,
    );
  } finally {
    await f.close();
  }
});

test("command settlement and disposal release active bookkeeping", async () => {
  let settle;
  let completedResolve;
  const completed = new Promise((resolve) => {
    completedResolve = resolve;
  });
  const f = await fixture(
    {
      async start(_options, _onOutput, onSettlement) {
        settle = onSettlement;
        return { id: "bt-settle", async stop() {}, dispose() {} };
      },
      async stop() {},
    },
    (event) => {
      if (event.type === "completed") completedResolve();
    },
  );
  try {
    await f.manager.start(definition(f.root));
    assert.throws(
      () => acquireWorkspaceMutationLease(f.root),
      /shell is executing/,
    );
    settle({ status: "done", exitCode: 0 });
    await completed;
    assert.throws(
      () => acquireWorkspaceMutationLease(f.root),
      /observed shell execution may have retained descendants/,
    );

    resetWorkspaceMutationRegistryForTests();
    await f.manager.start(definition(f.root));
    await f.manager.dispose();
    assert.throws(
      () => acquireWorkspaceMutationLease(f.root),
      /observed shell execution may have retained descendants/,
    );
  } finally {
    await f.close();
  }
});
