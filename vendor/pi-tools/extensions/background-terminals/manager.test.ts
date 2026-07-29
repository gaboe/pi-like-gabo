/**
 * End-to-end tests: manager behavior through a real ManagedRuntime with real
 * child processes, exactly as the tool handlers drive it. Commands use
 * `node -e` one-liners for portability (node exists on any machine running
 * pi). Tests are event-driven (kill()/nextChange/settle hooks), not
 * timing-based.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import test, { afterEach } from "node:test";
import { Effect } from "effect";
import {
  backgroundTerminalService,
  provideBackgroundTerminalService,
  type BackgroundTerminalService,
} from "./src/api.ts";
import type { TerminalSnapshot } from "./src/domain.ts";
import {
  MAX_RUNNING,
  MAX_TRACKED,
  TerminalManager,
  type TerminalManagerShape,
} from "./src/manager.ts";
import { createTerminalRuntime, runTool } from "./src/runtime.ts";
import {
  acquireWorkspaceMutationLease,
  resetWorkspaceMutationRegistryForTests,
} from "../shared/workspace-mutation-lease.ts";

afterEach(resetWorkspaceMutationRegistryForTests);

const cwd = process.cwd();

/** Quote a `node -e` script for sh -c. */
function nodeCmd(script: string) {
  return `node -e '${script}'`;
}

async function withManager(
  run: (
    manager: TerminalManagerShape,
    runtime: ReturnType<typeof createTerminalRuntime>,
  ) => Promise<void>,
) {
  const runtime = createTerminalRuntime();
  try {
    const manager = await runtime.runPromise(TerminalManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

/** Resolve when the given terminal settles (via the manager's settle hook). */
function settlement(manager: TerminalManagerShape, id: string) {
  return new Promise<{ snap: TerminalSnapshot; consumed: boolean }>(
    (resolve) => {
      const existing = manager.view.get(id);
      if (existing && existing.status !== "running") {
        resolve({ snap: existing, consumed: false });
        return;
      }
      const unsub = manager.view.subscribeTo(id, () => {
        const snap = manager.view.get(id);
        if (snap && snap.status !== "running") {
          unsub();
          resolve({ snap, consumed: false });
        }
      });
    },
  );
}

function processGone(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function pollUntil(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

test("background terminals block leases while active and remain fail-closed after exit", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd("setInterval(() => {}, 1000)"),
        title: "lease-active",
        cwd,
      }),
    );
    assert.throws(
      () => acquireWorkspaceMutationLease(cwd),
      /shell is executing/,
    );
    await runTool(runtime, manager.kill([snap.id]));
    assert.throws(
      () => acquireWorkspaceMutationLease(cwd),
      /observed shell execution may have retained descendants/,
    );
  });
});

test("natural terminal exit releases active shell bookkeeping", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.start({ command: "true", title: "natural-exit", cwd }),
    );
    await settlement(manager, snap.id);
    assert.throws(
      () => acquireWorkspaceMutationLease(cwd),
      /observed shell execution may have retained descendants/,
    );
  });
});

test("active lease rejects bg_start before process registration", async () => {
  await withManager(async (manager, runtime) => {
    const lease = acquireWorkspaceMutationLease(cwd);
    await assert.rejects(
      runTool(
        runtime,
        manager.start({ command: "true", title: "blocked", cwd }),
      ),
      /active exclusive lease/,
    );
    assert.equal(manager.view.size(), 0);
    lease.close();
  });
});

test("failed background spawn taints but releases active shell bookkeeping", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.start({
        command: "true",
        title: "spawn-failure",
        cwd: "/definitely/not/a/real/dir-workspace-lease",
      }),
    );
    await settlement(manager, snap.id);
    assert.throws(
      () => acquireWorkspaceMutationLease(cwd),
      /observed shell execution may have retained descendants/,
    );
  });
});

test("runtime disposal releases active background shell bookkeeping", async () => {
  const runtime = createTerminalRuntime();
  const manager = await runtime.runPromise(TerminalManager);
  await runTool(
    runtime,
    manager.start({
      command: nodeCmd("setInterval(() => {}, 1000)"),
      title: "dispose-lease",
      cwd,
    }),
  );
  assert.throws(() => acquireWorkspaceMutationLease(cwd), /shell is executing/);
  await runtime.dispose();
  assert.throws(
    () => acquireWorkspaceMutationLease(cwd),
    /observed shell execution may have retained descendants/,
  );
});

test("settlement listeners multicast and unsubscribe independently", async () => {
  await withManager(async (manager, runtime) => {
    const first: string[] = [];
    const second: string[] = [];
    manager.view.subscribeSettled((snap) => first.push(snap.id));
    const unsubscribe = manager.view.subscribeSettled((snap) =>
      second.push(snap.id),
    );

    const one = await runTool(
      runtime,
      manager.start({ command: "true", title: "one", cwd }),
    );
    await settlement(manager, one.id);
    unsubscribe();
    const two = await runTool(
      runtime,
      manager.start({ command: "true", title: "two", cwd }),
    );
    await settlement(manager, two.id);

    assert.deepEqual(first, [one.id, two.id]);
    assert.deepEqual(second, [one.id]);
  });
});

test("raw output listeners multicast and unsubscribe independently", async () => {
  await withManager(async (manager, runtime) => {
    const first: string[] = [];
    const second: string[] = [];
    manager.view.subscribeOutput(({ chunk }) => first.push(chunk));
    const unsubscribe = manager.view.subscribeOutput(({ chunk }) =>
      second.push(chunk),
    );

    const one = await runTool(
      runtime,
      manager.start({ command: "printf first", title: "one", cwd }),
    );
    await settlement(manager, one.id);
    unsubscribe();
    const two = await runTool(
      runtime,
      manager.start({ command: "printf second", title: "two", cwd }),
    );
    await settlement(manager, two.id);

    assert.equal(first.join(""), "firstsecond");
    assert.equal(second.join(""), "first");
  });
});

test("broad listeners skip output chunks while detail and raw listeners receive them", async () => {
  await withManager(async (manager, runtime) => {
    let broad = 0;
    let detail = 0;
    const output: string[] = [];
    manager.view.subscribe(() => broad++);
    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd('setTimeout(() => process.stdout.write("chunk"), 10)'),
        title: "notification-split",
        cwd,
      }),
    );
    manager.view.subscribeTo(snap.id, () => detail++);
    manager.view.subscribeOutput(({ chunk }) => output.push(chunk));
    await settlement(manager, snap.id);

    assert.equal(broad, 3, "start bookkeeping and settlement only");
    assert.equal(detail, 1, "settlement flushes pending output immediately");
    assert.equal(output.join(""), "chunk");
  });
});

test("detail output notifications coalesce during streaming", async () => {
  await withManager(async (manager, runtime) => {
    let detail = 0;
    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd(
          'let i=0; const t=setInterval(() => { process.stdout.write("x"); if (++i === 20) clearInterval(t) }, 5)',
        ),
        title: "coalesced-output",
        cwd,
      }),
    );
    manager.view.subscribeTo(snap.id, () => detail++);
    await settlement(manager, snap.id);
    assert.ok(detail >= 2, "stream and settlement notify");
    assert.ok(detail <= 4, `expected coalesced notifications, got ${detail}`);
  });
});

test("a backpressured start sink receives stdout losslessly", async () => {
  await withManager(async (manager, runtime) => {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        setImmediate(() => {
          chunks.push(Buffer.from(chunk));
          callback();
        });
      },
    });
    const expected = "0123456789abcdef".repeat(32_768);
    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd(
          `process.stdout.write("0123456789abcdef".repeat(32768))`,
        ),
        title: "backpressure",
        cwd,
        stdoutSink: sink,
      }),
    );
    const { snap: done } = await settlement(manager, snap.id);

    assert.equal(Buffer.concat(chunks).toString(), expected);
    assert.equal(done.stdout.totalBytes, Buffer.byteLength(expected));
  });
});

test("a sink error detaches it and cannot deadlock settlement", async () => {
  await withManager(async (manager, runtime) => {
    const sink = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        callback(new Error("sink failed"));
      },
    });
    const bytes = 512 * 1024;
    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd(`process.stdout.write("x".repeat(${bytes}))`),
        title: "broken-sink",
        cwd,
        stdoutSink: sink,
      }),
    );
    const { snap: done } = await settlement(manager, snap.id);

    assert.equal(done.status, "done");
    assert.equal(done.stdout.totalBytes, bytes);
  });
});

test("the module service rendezvous publishes, unsubscribes, and aborts", async () => {
  const seen: BackgroundTerminalService[] = [];
  const unsubscribe = backgroundTerminalService.subscribe((service) =>
    seen.push(service),
  );
  const ready = backgroundTerminalService.ready();
  const unused = async () => {
    throw new Error("unused");
  };
  const lifetime = provideBackgroundTerminalService({
    start: unused,
    status: unused,
    list: unused,
    kill: unused,
    subscribeSettled: () => () => {},
    subscribeOutput: () => () => {},
  });

  assert.equal(await ready, lifetime.service);
  assert.deepEqual(seen, [lifetime.service]);
  assert.equal(lifetime.service.signal.aborted, false);
  unsubscribe();
  lifetime.shutdown();
  assert.equal(lifetime.service.signal.aborted, true);

  const replacement = provideBackgroundTerminalService({
    start: unused,
    status: unused,
    list: unused,
    kill: unused,
    subscribeSettled: () => () => {},
    subscribeOutput: () => () => {},
  });
  assert.equal(await backgroundTerminalService.ready(), replacement.service);
  assert.equal(seen.length, 1);
  replacement.shutdown();
});

test("happy path: stdout and stderr captured separately, settles done, hook fires once unconsumed", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; status: string; consumed: boolean }> =
      [];
    manager.view.subscribeSettled((snap, consumed) =>
      settled.push({ id: snap.id, status: snap.status, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd(
          'process.stdout.write("out-line\\n"); process.stderr.write("err-line\\n");',
        ),
        title: "happy",
        cwd,
      }),
    );
    assert.equal(snap.status, "running");
    assert.ok(snap.pid);
    assert.equal(snap.command.includes("out-line"), true);

    const { snap: done } = await settlement(manager, snap.id);
    assert.equal(done.status, "done");
    assert.equal(done.exitCode, 0);
    assert.equal(done.signal, undefined);
    assert.equal(done.stdout.text, "out-line\n");
    assert.equal(done.stderr.text, "err-line\n");
    assert.ok(done.settledAt);
    assert.deepEqual(settled, [
      { id: snap.id, status: "done", consumed: false },
    ]);

    // Spill files hold the full capture.
    if (done.stdout.spillPath) {
      assert.equal(
        fs.readFileSync(done.stdout.spillPath, "utf8"),
        "out-line\n",
      );
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(done.stdout.spillPath).mode & 0o777, 0o600);
        assert.equal(
          fs.statSync(path.dirname(done.stdout.spillPath)).mode & 0o777,
          0o700,
        );
      }
    }
    if (done.stderr.spillPath) {
      assert.equal(
        fs.readFileSync(done.stderr.spillPath, "utf8"),
        "err-line\n",
      );
    }
  });
});

test("non-zero exit settles as failed with the exit code", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd("process.exit(3)"),
        title: "fails",
        cwd,
      }),
    );
    const { snap: failed } = await settlement(manager, snap.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.exitCode, 3);
  });
});

test("kill settles a never-exiting process as killed and resolves after settle; repeat kill is a no-op", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd("setInterval(() => {}, 1000)"),
        title: "immortal",
        cwd,
      }),
    );
    assert.equal(snap.status, "running");

    const report = await runTool(runtime, manager.kill([snap.id]));
    assert.equal(report.length, 1);
    assert.equal(report[0].id, snap.id);
    assert.equal(report[0].title, "immortal");
    assert.equal(report[0].status, "killed");
    assert.equal(report[0].killed, true);
    assert.equal(report[0].wasRunning, true);
    assert.match(report[0].exit, /^SIG/);
    const after = manager.view.get(snap.id);
    assert.equal(after?.status, "killed");
    assert.ok(after?.signal);

    const second = await runTool(runtime, manager.kill([snap.id]));
    assert.equal(second[0].killed, false);
    assert.equal(second[0].wasRunning, false);
    assert.equal(second[0].status, "killed");
  });
});

test(
  "a SIGTERM-resistant child is escalated to SIGKILL within the teardown bound",
  { skip: process.platform === "win32" },
  async () => {
    await withManager(async (manager, runtime) => {
      const snap = await runTool(
        runtime,
        manager.start({
          command: `exec ${nodeCmd(
            'process.on("SIGTERM", () => process.stdout.write("term\\n")); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);',
          )}`,
          title: "term-resistant",
          cwd,
        }),
      );
      assert.ok(
        await pollUntil(() =>
          (manager.view.get(snap.id)?.stdout.text ?? "").includes("ready"),
        ),
        "child installed its SIGTERM handler",
      );

      const startedAt = Date.now();
      const [result] = await runTool(runtime, manager.kill([snap.id]));
      const elapsed = Date.now() - startedAt;

      assert.equal(result.status, "killed");
      assert.equal(manager.view.get(snap.id)?.signal, "SIGKILL");
      assert.match(manager.view.get(snap.id)?.stdout.text ?? "", /term/);
      assert.ok(elapsed >= 1_500, `SIGKILL was not immediate (${elapsed}ms)`);
      assert.ok(
        elapsed < 4_500,
        `termination exceeded its bound (${elapsed}ms)`,
      );
    });
  },
);

test("concurrent overlapping multi-id kills observe each settlement exactly once", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.subscribeSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );
    const [first, second] = await runTool(
      runtime,
      Effect.forEach(
        ["first", "second"],
        (title) =>
          manager.start({
            command: nodeCmd("setInterval(() => {}, 1000)"),
            title,
            cwd,
          }),
        { concurrency: "unbounded" },
      ),
    );

    const reports = await runTool(
      runtime,
      Effect.all(
        [
          manager.kill([first.id, second.id, first.id]),
          manager.kill([second.id, first.id]),
        ],
        { concurrency: "unbounded" },
      ),
    );

    assert.deepEqual(
      reports.map((report) => report.map((entry) => entry.id)),
      [
        [first.id, second.id],
        [second.id, first.id],
      ],
    );
    assert.ok(reports.flat().every((entry) => entry.status === "killed"));
    assert.deepEqual(
      settled.sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: first.id, consumed: true },
        { id: second.id, consumed: true },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});

test(
  "kill terminates the whole process tree (grandchildren die)",
  { skip: process.platform === "win32" },
  async () => {
    await withManager(async (manager, runtime) => {
      const sentinelDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "bt-tree-test-"),
      );
      const sentinel = path.join(sentinelDir, "heartbeat");
      const snap = await runTool(
        runtime,
        manager.start({
          // sh spawns node in the background and prints the grandchild pid,
          // then waits forever so the group stays alive.
          command: `node -e 'const fs = require("node:fs"); const file = ${JSON.stringify(sentinel)}; let n = 0; fs.writeFileSync(file, String(n)); setInterval(() => fs.writeFileSync(file, String(++n)), 25)' & echo "child:$!"; wait`,
          title: "tree",
          cwd,
        }),
      );

      // Wait for the grandchild pid line.
      assert.ok(
        await pollUntil(() =>
          (manager.view.get(snap.id)?.stdout.text ?? "").includes("child:"),
        ),
        "grandchild pid was printed",
      );
      const text = manager.view.get(snap.id)?.stdout.text ?? "";
      const match = /child:(\d+)/.exec(text);
      assert.ok(match, "parsed grandchild pid");
      const grandchild = Number(match[1]);
      assert.equal(processGone(grandchild), false);
      assert.ok(
        await pollUntil(() => fs.existsSync(sentinel)),
        "heartbeat exists",
      );
      const heartbeatBefore = fs.readFileSync(sentinel, "utf8");
      assert.ok(
        await pollUntil(
          () => fs.readFileSync(sentinel, "utf8") !== heartbeatBefore,
        ),
        "heartbeat belongs to the live grandchild",
      );

      await runTool(runtime, manager.kill([snap.id]));
      assert.ok(
        await pollUntil(() => processGone(grandchild)),
        "grandchild process is gone after group kill",
      );
      const stoppedAt = fs.readFileSync(sentinel, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(
        fs.readFileSync(sentinel, "utf8"),
        stoppedAt,
        "the unique grandchild heartbeat stopped",
      );
      fs.rmSync(sentinelDir, { recursive: true, force: true });
    });
  },
);

test(
  "a shell exit with inherited pipes open settles naturally and reaps descendants",
  { skip: process.platform === "win32" },
  async () => {
    await withManager(async (manager, runtime) => {
      const snap = await runTool(
        runtime,
        manager.start({
          command: `node -e "setInterval(()=>{},1e3)" & echo "child:$!"; exit 0`,
          title: "exited-shell",
          cwd,
        }),
      );
      assert.ok(
        await pollUntil(() =>
          (manager.view.get(snap.id)?.stdout.text ?? "").includes("child:"),
        ),
        "descendant pid was printed",
      );
      const match = /child:(\d+)/.exec(
        manager.view.get(snap.id)?.stdout.text ?? "",
      );
      assert.ok(match);
      const grandchild = Number(match[1]);
      assert.ok(snap.pid);
      assert.ok(await pollUntil(() => processGone(snap.pid!)), "shell exited");
      assert.equal(manager.view.get(snap.id)?.status, "running");

      assert.ok(
        await pollUntil(
          () => manager.view.get(snap.id)?.status !== "running",
          7_000,
        ),
        "entry settled after the bounded post-exit grace",
      );
      assert.equal(manager.view.get(snap.id)?.status, "done");
      assert.equal(manager.view.get(snap.id)?.exitCode, 0);
      assert.ok(
        await pollUntil(() => processGone(grandchild)),
        "surviving process-group descendant was reaped",
      );
    });
  },
);

test(
  "kill preserves a natural exit observed before the signal point",
  { skip: process.platform === "win32" },
  async () => {
    await withManager(async (manager, runtime) => {
      const snap = await runTool(
        runtime,
        manager.start({
          command: `node -e "setInterval(()=>{},1e3)" & echo "child:$!"; exit 0`,
          title: "natural-race",
          cwd,
        }),
      );
      assert.ok(
        await pollUntil(() =>
          (manager.view.get(snap.id)?.stdout.text ?? "").includes("child:"),
        ),
      );
      const match = /child:(\d+)/.exec(
        manager.view.get(snap.id)?.stdout.text ?? "",
      );
      assert.ok(match);
      const grandchild = Number(match[1]);
      assert.ok(snap.pid);
      assert.ok(await pollUntil(() => processGone(snap.pid!)));
      assert.equal(manager.view.get(snap.id)?.status, "running");

      const [result] = await runTool(runtime, manager.kill([snap.id]));
      assert.equal(result.wasRunning, true);
      assert.equal(result.killed, false);
      assert.equal(result.status, "done");
      assert.equal(result.exit, "exit 0");
      assert.ok(await pollUntil(() => processGone(grandchild)));
    });
  },
);

test("concurrency cap rejects an extra start; a failed spawn releases its slot", async () => {
  await withManager(async (manager, runtime) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        Array.from({ length: MAX_RUNNING }, (_, n) => n),
        (n) =>
          manager.start({
            command: nodeCmd("setInterval(() => {}, 1000)"),
            title: `filler-${n}`,
            cwd,
          }),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(spawns.length, MAX_RUNNING);
    await assert.rejects(
      runTool(runtime, manager.start({ command: "true", title: "extra", cwd })),
      new RegExp(`Max ${MAX_RUNNING} background terminals`),
    );

    // Free one slot; a bogus binary settles as failed near-instantly (the
    // 'error'/'exit' path), leaving the slot free again.
    await runTool(runtime, manager.kill([spawns[0].id]));
    const bogus = await runTool(
      runtime,
      manager.start({
        command: "definitely-not-a-real-binary-12345",
        title: "bogus",
        cwd,
      }),
    );
    const { snap: settled } = await settlement(manager, bogus.id);
    assert.equal(settled.status, "failed");
    // The settled bogus entry does not occupy a running slot.
    const again = await runTool(
      runtime,
      manager.start({
        command: nodeCmd("setInterval(() => {}, 1000)"),
        title: "refill",
        cwd,
      }),
    );
    assert.equal(again.status, "running");
  });
});

test("a settle during an in-flight kill reports consumed: true", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.subscribeSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );
    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd("setInterval(() => {}, 1000)"),
        title: "consumed",
        cwd,
      }),
    );
    await runTool(runtime, manager.kill([snap.id]));
    assert.deepEqual(settled, [{ id: snap.id, consumed: true }]);
  });
});

test("UI requestKill settles as killed and is NOT consumed", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; status: string; consumed: boolean }> =
      [];
    manager.view.subscribeSettled((snap, consumed) =>
      settled.push({ id: snap.id, status: snap.status, consumed }),
    );
    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd("setInterval(() => {}, 1000)"),
        title: "ui-kill",
        cwd,
      }),
    );
    manager.view.requestKill(snap.id);
    const { snap: after } = await settlement(manager, snap.id);
    assert.equal(after.status, "killed");
    assert.deepEqual(settled, [
      { id: snap.id, status: "killed", consumed: false },
    ]);
  });
});

test("runtime.dispose kills running processes; no settle hook fires after dispose", async () => {
  const runtime = createTerminalRuntime();
  const manager = await runtime.runPromise(TerminalManager);
  const settled: string[] = [];
  manager.view.subscribeSettled((snap) => settled.push(snap.id));

  const snap = await runTool(
    runtime,
    manager.start({
      command: nodeCmd("setInterval(() => {}, 1000)"),
      title: "disposed",
      cwd,
    }),
  );
  const pid = snap.pid;
  assert.ok(pid);

  await runtime.dispose();
  assert.ok(await pollUntil(() => processGone(pid)), "process killed");
  // The disposed guard suppressed the hook.
  assert.deepEqual(settled, []);
  // start after dispose is rejected (by the runtime itself, or by the
  // manager's disposed guard if the effect still runs).
  await assert.rejects(
    runTool(runtime, manager.start({ command: "true", title: "late", cwd })),
    /shutting down|disposed/,
  );
});

test("pruning drops the oldest settled entries past MAX_TRACKED, never running ones", async () => {
  await withManager(async (manager, runtime) => {
    const keeper = await runTool(
      runtime,
      manager.start({
        command: nodeCmd("setInterval(() => {}, 1000)"),
        title: "keeper",
        cwd,
      }),
    );

    const settledIds: string[] = [];
    for (let i = 0; i < MAX_TRACKED + 4; i++) {
      const snap = await runTool(
        runtime,
        manager.start({ command: "true", title: `quick-${i}`, cwd }),
      );
      settledIds.push(snap.id);
      await settlement(manager, snap.id);
    }

    const remaining = manager.view.list().map((snap) => snap.id);
    assert.equal(remaining.length <= MAX_TRACKED, true);
    // The running entry survived pruning.
    assert.equal(remaining.includes(keeper.id), true);
    // The earliest settled entries were pruned first.
    assert.equal(remaining.includes(settledIds[0]), false);
    // The latest settled entries survive.
    assert.equal(remaining.includes(settledIds[settledIds.length - 1]), true);

    const [historical] = await runTool(runtime, manager.kill([settledIds[0]]));
    assert.equal(historical.title, "quick-0");
    assert.equal(historical.status, "done");
    assert.equal(historical.wasRunning, false);
    assert.equal(historical.killed, false);
  });
});

test("runtime disposal removes the private spill directory", async () => {
  const runtime = createTerminalRuntime();
  const manager = await runtime.runPromise(TerminalManager);
  const snap = await runTool(
    runtime,
    manager.start({ command: "node --version", title: "cleanup", cwd }),
  );
  const { snap: done } = await settlement(manager, snap.id);
  assert.ok(done.stdout.spillPath);
  const spillDir = path.dirname(done.stdout.spillPath);
  assert.equal(fs.existsSync(spillDir), true);

  await runtime.dispose();

  assert.equal(fs.existsSync(spillDir), false);
});

test("an unknown command settles failed with the platform shell's non-zero exit", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.start({
        command: "definitely-not-a-real-binary-12345",
        title: "bogus",
        cwd,
      }),
    );
    const { snap: failed } = await settlement(manager, snap.id);
    assert.equal(failed.status, "failed");
    // The platform shell reports a non-zero exit and explains the failure.
    assert.notEqual(failed.exitCode, 0);
    assert.ok(failed.stderr.text.length > 0, "stderr explains the failure");
  });
});

test("a process 'error' event settles failed with errorText and no bogus exit code", async () => {
  await withManager(async (manager, runtime) => {
    // spawn() with a nonexistent cwd emits ENOENT via the 'error' event
    // (the tool layer validates cwd; the manager must still be correct).
    const snap = await runTool(
      runtime,
      manager.start({
        command: "true",
        title: "bad-cwd",
        cwd: "/definitely/not/a/real/dir-12345",
      }),
    );
    const { snap: failed } = await settlement(manager, snap.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.errorText ?? "", /ENOENT/);
    // Node's 'close' after a spawn 'error' reports the errno (e.g. -2) as
    // its code; that must not leak into exitCode.
    assert.equal(failed.exitCode, undefined);
    assert.equal(failed.signal, undefined);
  });
});

test("the spill file holds the complete capture when the settle hook fires, beyond the in-memory cap", async () => {
  await withManager(async (manager, runtime) => {
    const chunk = 1 << 16; // 64 KiB per write
    const writes = 48; // 3 MiB total > 2 MiB RETAINED_PER_STREAM
    const totalBytes = chunk * writes;

    let spillSizeAtSettle = -1;
    const settledOnce = new Promise<TerminalSnapshot>((resolve) => {
      manager.view.subscribeSettled((snap) => {
        // Measured inside the hook: the full capture must already be on disk
        // when the completion follow-up (which cites this path) is queued.
        if (snap.stdout.spillPath) {
          spillSizeAtSettle = fs.statSync(snap.stdout.spillPath).size;
        }
        resolve(snap);
      });
    });

    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd(
          `const s = "x".repeat(${chunk}); for (let i = 0; i < ${writes}; i++) process.stdout.write(s);`,
        ),
        title: "firehose",
        cwd,
      }),
    );
    const done = await settledOnce;
    assert.equal(done.id, snap.id);
    assert.equal(done.status, "done");
    assert.equal(done.stdout.totalBytes, totalBytes);
    // In-memory retention is bounded; the head was dropped.
    assert.ok(done.stdout.truncatedBytes > 0, "head was truncated in memory");
    assert.ok(
      Buffer.byteLength(done.stdout.text) <= 2 * 1024 * 1024,
      "retained text within the cap",
    );
    if (done.stdout.spillPath) {
      assert.equal(
        spillSizeAtSettle,
        totalBytes,
        "spill file was fully flushed before the settle hook",
      );
    }
  });
});

test("aborting the kill wait does not cancel the termination", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.start({
        command:
          process.platform === "win32"
            ? nodeCmd("setInterval(() => {}, 1000)")
            : `exec ${nodeCmd(
                'process.on("SIGTERM", () => process.stdout.write("term\\n")); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);',
              )}`,
        title: "abort-race",
        cwd,
      }),
    );
    const pid = snap.pid;
    assert.ok(pid);
    if (process.platform !== "win32") {
      assert.ok(
        await pollUntil(() =>
          (manager.view.get(snap.id)?.stdout.text ?? "").includes("ready"),
        ),
        "child installed its SIGTERM handler",
      );
    }

    // Abort the tool call immediately: the kill wait is interrupted, but the
    // SIGTERM→SIGKILL teardown must continue detached in the background.
    const controller = new AbortController();
    const killPromise = runTool(runtime, manager.kill([snap.id]), {
      signal: controller.signal,
      interruptMessage: "aborted",
    });
    controller.abort();
    await assert.rejects(killPromise, /aborted/);

    const { snap: after } = await settlement(manager, snap.id);
    assert.equal(after.status, "killed");
    if (process.platform !== "win32") assert.equal(after.signal, "SIGKILL");
    assert.ok(await pollUntil(() => processGone(pid)), "process is gone");
  });
});

test("status returns the snapshot and rejects unknown ids with the known list", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.start({ command: "true", title: "status", cwd }),
    );
    const seen = await runTool(runtime, manager.status(snap.id));
    assert.equal(seen.id, snap.id);
    await assert.rejects(
      runTool(runtime, manager.status("bt-999")),
      /Unknown terminal id "bt-999"\. Known: bt-1\./,
    );
  });
});
