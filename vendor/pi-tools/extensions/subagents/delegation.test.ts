import assert from "node:assert/strict";
import test from "node:test";
import {
  currentDelegationState,
  MAX_TODO_TOKEN_LENGTH,
  validatePackageOwnership,
} from "../shared/subagent-wait-protocol.ts";
import {
  acquirePackageAssignmentLease,
  acquirePackageAssignmentLeaseAsync,
  registerPackageAssignmentGate,
} from "../shared/assignment-gate-protocol.ts";
import { spawnPackageAssignment } from "./index.ts";

test("package ownership requires the complete contract, id, and token trio", () => {
  assert.equal(
    validatePackageOwnership(undefined, undefined, undefined),
    undefined,
  );
  for (const [contract, id, token] of [
    [undefined, 1, undefined],
    [undefined, undefined, "prep-1"],
    [undefined, 1, "prep-1"],
  ]) {
    assert.match(
      validatePackageOwnership(contract, id, token) ?? "",
      /require output_contract package_handoff/,
    );
  }
  for (const [id, token, error] of [
    [undefined, undefined, /positive todo_id/],
    [1, undefined, /nonblank todo_token/],
    [undefined, "prep-1", /positive todo_id/],
    [0, "prep-1", /positive todo_id/],
  ]) {
    assert.match(
      validatePackageOwnership("package_handoff", id, token) ?? "",
      error as RegExp,
    );
  }
  assert.match(
    validatePackageOwnership("package_handoff", 1, "  ") ?? "",
    /nonblank todo_token/,
  );
  assert.match(
    validatePackageOwnership(
      "package_handoff",
      1,
      "x".repeat(MAX_TODO_TOKEN_LENGTH + 1),
    ) ?? "",
    /at most 256/,
  );
  assert.equal(
    validatePackageOwnership("package_handoff", 1, "prep-1"),
    undefined,
  );
});

test("package spawn revalidates at manager and spawn latches", async () => {
  let allowed = true;
  const unregister = registerPackageAssignmentGate(() =>
    allowed ? undefined : "assignment stale",
  );
  try {
    let spawnCalls = 0;
    await assert.rejects(
      spawnPackageAssignment(
        { todoId: 1, todoToken: "prep-1" },
        {
          async getManager() {
            allowed = false;
            return {};
          },
          async spawn() {
            spawnCalls++;
            return { id: "sa-never" };
          },
          async cancel() {},
        },
      ),
      /assignment stale/,
    );
    assert.equal(spawnCalls, 0);

    allowed = true;
    const sequence: string[] = [];
    await assert.rejects(
      spawnPackageAssignment(
        { todoId: 1, todoToken: "prep-1" },
        {
          async getManager() {
            sequence.push("manager");
            return {};
          },
          async spawn() {
            sequence.push("spawn");
            allowed = false;
            return { id: "sa-created" };
          },
          async cancel(_manager, id) {
            sequence.push(`cancel:${id}`);
          },
          onPending() {
            sequence.push("pending");
          },
          onRejected() {
            sequence.push("rejected");
          },
          onRelease() {
            sequence.push("release");
          },
        },
      ),
      /assignment stale/,
    );
    assert.deepEqual(sequence, [
      "pending",
      "manager",
      "spawn",
      "rejected",
      "cancel:sa-created",
      "release",
    ]);
  } finally {
    unregister();
  }
});

test("synchronous package assignment acquisition remains exclusive", () => {
  const unregister = registerPackageAssignmentGate(() => undefined);
  try {
    const request = { todoId: 1, todoToken: "prep-1" };
    const first = acquirePackageAssignmentLease(request);
    assert.equal(typeof first, "object");
    assert.match(
      String(acquirePackageAssignmentLease(request)),
      /already spawning/,
    );
    if (typeof first !== "string") first.close();
    const next = acquirePackageAssignmentLease(request);
    assert.equal(typeof next, "object");
    if (typeof next !== "string") next.close();
  } finally {
    unregister();
  }
});

test("async package assignment acquisition wakes three waiters FIFO", async () => {
  const unregister = registerPackageAssignmentGate(() => undefined);
  try {
    const request = { todoId: 1, todoToken: "prep-1" };
    const holder = await acquirePackageAssignmentLeaseAsync(request);
    assert.notEqual(typeof holder, "string");
    if (typeof holder === "string") throw new Error(holder);

    const order: number[] = [];
    const waiters = [1, 2, 3].map(async (number) => {
      const lease = await acquirePackageAssignmentLeaseAsync(request);
      assert.notEqual(typeof lease, "string");
      if (typeof lease === "string") throw new Error(lease);
      order.push(number);
      lease.close();
    });
    holder.close();
    await Promise.all(waiters);
    assert.deepEqual(order, [1, 2, 3]);
  } finally {
    unregister();
  }
});

test("aborting the middle package assignment waiter preserves FIFO", async () => {
  const unregister = registerPackageAssignmentGate(() => undefined);
  try {
    const request = { todoId: 1, todoToken: "prep-1" };
    const holder = await acquirePackageAssignmentLeaseAsync(request);
    assert.notEqual(typeof holder, "string");
    if (typeof holder === "string") throw new Error(holder);

    const order: number[] = [];
    const first = acquirePackageAssignmentLeaseAsync(request).then((lease) => {
      assert.notEqual(typeof lease, "string");
      if (typeof lease === "string") throw new Error(lease);
      order.push(1);
      lease.close();
    });
    const controller = new AbortController();
    const middle = acquirePackageAssignmentLeaseAsync(
      request,
      controller.signal,
    );
    const last = acquirePackageAssignmentLeaseAsync(request).then((lease) => {
      assert.notEqual(typeof lease, "string");
      if (typeof lease === "string") throw new Error(lease);
      order.push(3);
      lease.close();
    });

    controller.abort();
    assert.match(String(await middle), /aborted/);
    holder.close();
    await Promise.all([first, last]);
    assert.deepEqual(order, [1, 3]);
  } finally {
    unregister();
  }
});

test("gate generation change invalidates holder and queued waiters", async () => {
  const unregisterOld = registerPackageAssignmentGate(() => undefined);
  const request = { todoId: 1, todoToken: "prep-1" };
  const holder = await acquirePackageAssignmentLeaseAsync(request);
  assert.notEqual(typeof holder, "string");
  if (typeof holder === "string") throw new Error(holder);
  const waiter = acquirePackageAssignmentLeaseAsync(request);

  const unregisterNew = registerPackageAssignmentGate(
    () => "package_handoff assignment gate is off.",
  );
  try {
    assert.match(String(await waiter), /assignment gate is off/);
    assert.match(holder.validate() ?? "", /gate changed during spawn/);
  } finally {
    holder.close();
    unregisterOld();
    unregisterNew();
  }
});

test("failed first spawn releases the next queued package assignment", async () => {
  const authorized: string[] = [];
  const unregister = registerPackageAssignmentGate(
    () => undefined,
    ({ subagentId }) => authorized.push(subagentId),
  );
  let spawnStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    spawnStarted = resolve;
  });
  let failSpawn!: (error: Error) => void;
  const failedSpawn = new Promise<never>((_resolve, reject) => {
    failSpawn = reject;
  });
  try {
    const request = { todoId: 1, todoToken: "prep-1" };
    const first = spawnPackageAssignment(request, {
      async getManager() {
        return {};
      },
      async spawn() {
        spawnStarted();
        return failedSpawn;
      },
      async cancel() {},
    });
    await started;
    const second = spawnPackageAssignment(request, {
      async getManager() {
        return {};
      },
      async spawn() {
        return { id: "sa-next" };
      },
      async cancel() {},
    });

    failSpawn(new Error("first backend spawn failed"));
    await assert.rejects(first, /first backend spawn failed/);
    assert.equal((await second).id, "sa-next");
    assert.deepEqual(authorized, ["sa-next"]);
  } finally {
    unregister();
  }
});

test("batched disjoint package workers queue only their spawn handshakes", async () => {
  const authorized: string[] = [];
  const running = new Set<string>();
  const unregister = registerPackageAssignmentGate(
    () => undefined,
    ({ subagentId }) => authorized.push(subagentId),
  );
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  let releaseFirst!: () => void;
  const holdFirst = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  try {
    const request = { todoId: 1, todoToken: "prep-1" };
    const first = spawnPackageAssignment(request, {
      async getManager() {
        return {};
      },
      async spawn() {
        running.add("sa-first");
        firstStarted();
        await holdFirst;
        return { id: "sa-first" };
      },
      async cancel() {},
    });
    await started;
    const second = spawnPackageAssignment(request, {
      async getManager() {
        return {};
      },
      async spawn() {
        assert.deepEqual([...running], ["sa-first"]);
        running.add("sa-second");
        return { id: "sa-second" };
      },
      async cancel() {},
    });

    releaseFirst();
    assert.deepEqual(
      (await Promise.all([first, second])).map(({ id }) => id),
      ["sa-first", "sa-second"],
    );
    assert.deepEqual([...running], ["sa-first", "sa-second"]);
    assert.deepEqual(authorized, ["sa-first", "sa-second"]);
  } finally {
    unregister();
  }
});

test("package spawn authorizes one current gate generation", async () => {
  const authorized: string[] = [];
  const unregister = registerPackageAssignmentGate(
    () => undefined,
    ({ subagentId }) => authorized.push(subagentId),
  );
  try {
    const snapshot = await spawnPackageAssignment(
      { todoId: 1, todoToken: "prep-1" },
      {
        async getManager() {
          return {};
        },
        async spawn() {
          return { id: "sa-1" };
        },
        async cancel() {},
      },
    );
    assert.equal(snapshot.id, "sa-1");
    assert.deepEqual(authorized, ["sa-1"]);
  } finally {
    unregister();
  }
});

test("abort while manager or prepare is blocked cannot authorize or start a worker", async () => {
  const unregister = registerPackageAssignmentGate(() => undefined);
  try {
    for (const phase of ["manager", "prepare"] as const) {
      const controller = new AbortController();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached!: () => void;
      const waiting = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const tracked: Array<{ id: string; status: string }> = [];
      let starts = 0;
      let authorizations = 0;
      const unregisterAuthorizer = registerPackageAssignmentGate(
        () => undefined,
        () => authorizations++,
      );
      const spawning = spawnPackageAssignment(
        { todoId: 20, todoToken: `prep-${phase}` },
        {
          async getManager() {
            if (phase === "manager") {
              reached();
              await blocked;
            }
            return {};
          },
          async spawn() {
            const candidate = { id: `sa-${phase}`, status: "pending" };
            tracked.push(candidate);
            if (phase === "prepare") {
              reached();
              await blocked;
            }
            return candidate;
          },
          async start() {
            starts++;
          },
          async reject(_manager, id) {
            tracked.find((candidate) => candidate.id === id)!.status =
              "rejected";
          },
          async cancel() {},
        },
        controller.signal,
      );
      await waiting;
      controller.abort();
      release();
      await assert.rejects(spawning, /aborted/);
      assert.equal(authorizations, 0);
      assert.equal(starts, 0);
      assert.ok(
        tracked.length === 0 ||
          tracked.every(({ status }) => status === "rejected"),
      );
      unregisterAuthorizer();
    }
  } finally {
    unregister();
  }
});

test("failed cancellation leaves rejected unauthorized candidate tracked", async () => {
  let allowed = true;
  const authorized: string[] = [];
  const tracked = [{ id: "sa-rejected", status: "pending" }];
  const unregister = registerPackageAssignmentGate(
    () => (allowed ? undefined : "assignment stale"),
    ({ subagentId }) => authorized.push(subagentId),
  );
  let starts = 0;
  try {
    await assert.rejects(
      spawnPackageAssignment(
        { todoId: 21, todoToken: "prep-21" },
        {
          async getManager() {
            return {};
          },
          async spawn() {
            allowed = false;
            return tracked[0];
          },
          async start() {
            starts++;
          },
          async reject() {
            tracked[0].status = "rejected";
          },
          async cancel() {
            throw new Error("cooperative cancellation failed");
          },
        },
      ),
      /assignment stale/,
    );
    assert.deepEqual(tracked, [{ id: "sa-rejected", status: "rejected" }]);
    assert.deepEqual(authorized, []);
    assert.equal(starts, 0);
  } finally {
    unregister();
  }
});

test("observer failures cannot leak lease or fail an accepted started worker", async () => {
  const authorized: string[] = [];
  const unregister = registerPackageAssignmentGate(
    () => undefined,
    ({ subagentId }) => authorized.push(subagentId),
  );
  try {
    let started = false;
    const first = await spawnPackageAssignment(
      { todoId: 22, todoToken: "prep-22" },
      {
        async getManager() {
          return {};
        },
        async spawn() {
          return { id: "sa-observer" };
        },
        async start() {
          started = true;
        },
        async cancel() {},
        onPending() {
          throw new Error("pending observer failed");
        },
        onAccepted() {
          throw new Error("accepted observer failed");
        },
      },
    );
    assert.equal(first.id, "sa-observer");
    assert.equal(started, true);
    const next = await acquirePackageAssignmentLeaseAsync({
      todoId: 22,
      todoToken: "prep-22",
    });
    assert.notEqual(typeof next, "string");
    if (typeof next !== "string") next.close();
    assert.deepEqual(authorized, ["sa-observer"]);
  } finally {
    unregister();
  }
});

test("prepare and start failures each release the FIFO next waiter", async () => {
  const unregister = registerPackageAssignmentGate(() => undefined);
  try {
    for (const phase of ["prepare", "start"] as const) {
      const request = { todoId: 23, todoToken: `prep-${phase}` };
      let reached!: () => void;
      const waiting = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let fail!: (error: Error) => void;
      const blocked = new Promise<void>((_resolve, reject) => {
        fail = reject;
      });
      const first = spawnPackageAssignment(request, {
        async getManager() {
          return {};
        },
        async spawn() {
          reached();
          if (phase === "prepare") await blocked;
          return { id: `sa-first-${phase}` };
        },
        async start() {
          if (phase === "start") await blocked;
        },
        async cancel() {},
      });
      await waiting;
      const order: string[] = [];
      const second = spawnPackageAssignment(request, {
        async getManager() {
          return {};
        },
        async spawn() {
          order.push("next");
          return { id: `sa-next-${phase}` };
        },
        async cancel() {},
      });
      fail(new Error(`${phase} failed`));
      await assert.rejects(first, new RegExp(`${phase} failed`));
      assert.equal((await second).id, `sa-next-${phase}`);
      assert.deepEqual(order, ["next"]);
    }
  } finally {
    unregister();
  }
});

test("delegation publication keeps alpha while beta handshake is pending", () => {
  const owned = {
    id: "sa-owned",
    status: "running",
    outputContract: "package_handoff",
    todoId: 7,
    todoToken: "prep-7",
  };
  assert.deepEqual(
    currentDelegationState([
      owned,
      { ...owned, id: "sa-beta", pendingStart: true },
      { id: "sa-scout", status: "running" },
      {
        id: "sa-ordinary-with-pair",
        status: "running",
        todoId: 7,
        todoToken: "prep-7",
      },
      {
        id: "sa-partial-package",
        status: "running",
        outputContract: "package_handoff",
        todoId: 7,
      },
      {
        id: "sa-immediate",
        status: "done",
        outputContract: "package_handoff",
        todoId: 8,
        todoToken: "prep-8",
      },
    ]),
    {
      delegations: [{ id: "sa-owned", todo_id: 7, todo_token: "prep-7" }],
    },
  );
  assert.deepEqual(currentDelegationState([{ ...owned, status: "done" }]), {
    delegations: [],
  });
  assert.deepEqual(currentDelegationState([{ ...owned, status: "running" }]), {
    delegations: [{ id: "sa-owned", todo_id: 7, todo_token: "prep-7" }],
  });
});
