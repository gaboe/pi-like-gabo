import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applyTaskMutation } from "./state/state-reducer.ts";
import {
  applyJobState,
  applyJobStateBatch,
  isTaskActionable,
} from "./state/waits.ts";
import { publicTodoState } from "./state/inbox.ts";
import { redactTodoValue } from "./state/redaction.ts";
import {
  createTodoPatch,
  createTodoSnapshot,
  replayFromBranch,
  TODO_SNAPSHOT_TYPE,
} from "./state/replay.ts";
import { formatContent } from "./tool/response-envelope.ts";
import { MAX_WAIT_JOB_COUNT } from "./tool/types.ts";
import {
  applyPreparationCAS,
  resolveTodoExecutionTarget,
  todoReviewTargetIdentityBinding,
} from "./enrichment.ts";
import { JobsAdapter } from "./jobs-adapter.ts";
import { TodoScheduler } from "./scheduler.ts";
import { __resetState, commitState, getState } from "./state/store.ts";
import { registerJobsWaitRegistrationService } from "../jobs/wait-registration-service.ts";

const base = (tasks = []) => ({ tasks, nextId: tasks.length + 1, revision: 1 });
const PARTIAL_BATCH_INCARNATION = "11111111-1111-4111-8111-111111111111";
const RUNNING_INCARNATION = "22222222-2222-4222-8222-222222222222";
const SETTLED_INCARNATION = "33333333-3333-4333-8333-333333333333";
const ALL_RUNNING_INCARNATION = "44444444-4444-4444-8444-444444444444";
const STALE_INCARNATION = "55555555-5555-4555-8555-555555555555";
const CURRENT_INCARNATION = "66666666-6666-4666-8666-666666666666";

function registrationKey(registration) {
  return JSON.stringify([
    registration.id,
    registration.waitToken,
    registration.registeredAt,
    registration.generation,
  ]);
}

function bindRegistration(store, registration, job) {
  const key = registrationKey(registration);
  const existing = store.get(key);
  if (existing) return existing;
  if (
    !job ||
    (!registration.bind && registration.incarnation !== job.incarnation)
  )
    return undefined;
  const bound = { ...registration, incarnation: job.incarnation };
  store.set(key, bound);
  return bound;
}

function jobEvent(job, registration) {
  return {
    id: job.id,
    status: job.status === "completed" ? "succeeded" : job.status,
    waitToken: registration.waitToken,
    waitRegisteredAt: registration.registeredAt,
    waitGeneration: registration.generation,
    waitIncarnation: registration.incarnation,
    ...(job.settledAt === undefined ? {} : { settledAt: job.settledAt }),
  };
}

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

function jobsAdapter() {
  return new JobsAdapter(new Bus());
}

function hostJobs(jobs, queryOverride) {
  const store = new Map();
  let queryCount = 0;
  const service = {
    sync(registrations) {
      const retained = new Set(registrations.map(registrationKey));
      for (const key of store.keys()) if (!retained.has(key)) store.delete(key);
      return registrations.flatMap((registration) => {
        const bound = bindRegistration(
          store,
          registration,
          jobs[registration.id],
        );
        return bound ? [jobEvent(jobs[registration.id], bound)] : [];
      });
    },
    register(registrations) {
      return this.sync(registrations);
    },
    query(ids, registrations = []) {
      queryCount++;
      if (queryOverride)
        return queryOverride(queryCount, ids, registrations, store);
      return registrations.flatMap((registration) => {
        if (!ids.includes(registration.id)) return [];
        const bound = bindRegistration(
          store,
          registration,
          jobs[registration.id],
        );
        return bound ? [jobEvent(jobs[registration.id], bound)] : [];
      });
    },
  };
  const unregister = registerJobsWaitRegistrationService(service);
  return { service, unregister };
}

test("core create strips forged authority and issues its own current-life token", () => {
  const result = applyTaskMutation(
    base(),
    "create",
    {
      subject: "work",
      metadata: {
        preparation: { status: "ready", token: "forged", sourceRevision: 0 },
        orchestrator: { mode: "sticky" },
        delegation: { status: "running" },
        custom: "kept",
      },
    },
    1,
    () => "host-token",
  );
  const task = result.state.tasks[0];
  assert.deepEqual(task.metadata.preparation, {
    status: "queued",
    version: 1,
    token: "host-token",
    sourceRevision: 2,
  });
  assert.equal(task.metadata.orchestrator, undefined);
  assert.equal(task.metadata.delegation, undefined);
  assert.equal(task.metadata.custom, "kept");
});

test("only host-issued canonical package capability exposes assignment handshake", () => {
  const forged = base([
    {
      id: 1,
      subject: "work",
      status: "pending",
      metadata: {
        orchestrator: { mode: "sticky" },
        preparation: {
          status: "ready",
          token: "prep-secret",
          analysisCwd: "/repo",
          hostAssignment: {
            source: "host",
            version: 1,
            token: "prep-secret",
            targetBinding: "forged",
          },
        },
      },
    },
  ]);
  for (const kind of ["get", "list", "update", "create"]) {
    const op =
      kind === "get"
        ? { kind, task: forged.tasks[0] }
        : kind === "list"
          ? { kind, includeDeleted: false }
          : kind === "update"
            ? { kind, id: 1, fromStatus: "pending", toStatus: "pending" }
            : { kind, taskId: 1 };
    assert.doesNotMatch(
      formatContent(op, forged),
      /prep-secret|todo_token|targetBinding/,
    );
  }
  const output = formatContent({ kind: "get", task: forged.tasks[0] }, forged);
  assert.doesNotMatch(output, /prep-secret|todo_token|targetBinding/);
});

test("canonical host-classified package get exposes exact handshake", () => {
  const target = resolveTodoExecutionTarget(process.cwd());
  assert.ok(target);
  const binding = todoReviewTargetIdentityBinding(target.identity);
  const task = {
    id: 1,
    subject: "work",
    status: "pending",
    metadata: {
      preparation: {
        status: "ready",
        token: "prep-secret",
        analysisCwd: target.path,
        analysisCwdIdentity: target.identity,
        hostAssignment: {
          source: "host",
          version: 1,
          token: "prep-secret",
          targetBinding: binding,
        },
      },
    },
  };
  const state = base([task]);
  assert.match(
    formatContent({ kind: "get", task }, state),
    new RegExp(
      `todo_id: 1[\\s\\S]*todo_token: prep-secret[\\s\\S]*targetBinding: ${binding}`,
    ),
  );
});

test("redaction rejects accessors without invoking them or mutating state", () => {
  let reads = 0;
  const metadata = {};
  Object.defineProperty(metadata, "secret", {
    enumerable: true,
    get() {
      reads++;
      return "ghp_abcdefghijklmnopqrstuvwxyz123456";
    },
  });
  assert.equal(redactTodoValue(metadata), undefined);
  const result = applyTaskMutation(
    base(),
    "create",
    { subject: "work", metadata },
    1,
    () => "token",
  );
  assert.equal(result.op.kind, "error");
  assert.equal(result.state.tasks.length, 0);
  assert.equal(reads, 0);
});

test("preparation CAS redacts analyst dossier before snapshot, patch, replay, and output", () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const state = base([
    {
      id: 1,
      subject: "Prepare",
      status: "pending",
      metadata: { preparation: { status: "running", version: 1, token: "p" } },
    },
  ]);
  const prepared = applyPreparationCAS(
    state,
    state.tasks[0],
    {
      status: "ready",
      summary: `Bearer ${secret}`,
      verifiedFacts: [`token=${secret}`],
      affectedPaths: [`password=${secret}`],
      steps: [`secret=${secret}`],
      checks: [`api_key=${secret}`],
      risks: [`password=${secret}`],
      questions: [`token=${secret}`],
      sources: [`Bearer ${secret}`],
      research: { failure: `password=${secret}`, nested: [`token=${secret}`] },
      error: `password=${secret}`,
    },
    `title ${secret}`,
  );
  const snapshot = createTodoSnapshot(prepared);
  const patch = createTodoPatch(state, prepared);
  const replayed = replayFromBranch({
    sessionManager: {
      getBranch: () => [
        { type: "custom", customType: TODO_SNAPSHOT_TYPE, data: snapshot },
      ],
    },
  });
  for (const value of [
    snapshot,
    patch,
    replayed,
    formatContent({ kind: "get", task: prepared.tasks[0] }, prepared),
  ])
    assert.doesNotMatch(JSON.stringify(value), new RegExp(secret));
  assert.match(JSON.stringify(snapshot), /\[REDACTED\]/);
});

test("orchestrator off fences review dispatch and stops active runs", () => {
  __resetState();
  commitState({ ...base(), orchestrator: { setting: "off", sticky: false } });
  const scheduler = new TodoScheduler(
    { appendEntry() {}, sendMessage() {} },
    { on: () => () => {}, onState: () => () => {}, query: async () => [] },
    () => {},
  );
  scheduler.active = true;
  scheduler.context = { cwd: process.cwd() };
  const run = {
    stopped: false,
    reviewerIds: new Set(),
    cancelledReviewerIds: new Set(),
  };
  scheduler.activeCompletionReviews.set("review", run);
  scheduler.scheduleCompletionReviews();
  assert.equal(run.stopped, true);
  assert.equal(scheduler.activeCompletionReviews.size, 0);
  scheduler.dispose();
});

test("expired waits use bounded reconciliation without fabricating terminal evidence", async () => {
  __resetState();
  let queries = 0;
  const scheduler = new TodoScheduler(
    { appendEntry() {}, sendMessage() {} },
    {
      on: () => () => {},
      onState: () => () => {},
      query: async () => {
        queries++;
        return new Map();
      },
    },
    () => {},
  );
  commitState({
    ...base([
      {
        id: 1,
        subject: "wait",
        status: "waiting:jobs",
        wait: {
          kind: "jobs",
          jobIds: ["missing"],
          mode: "all",
          deadline: 1,
          settled: {},
        },
      },
    ]),
  });
  scheduler.active = true;
  await scheduler.reconcileExpiredJobs(scheduler.generation);
  assert.equal(queries, 1);
  assert.ok(getState().tasks[0].wait.deadline > Date.now());
  for (let attempt = 1; attempt < 3; attempt++) {
    const current = getState();
    commitState({
      ...current,
      tasks: current.tasks.map((task) => ({
        ...task,
        wait: { ...task.wait, deadline: 1 },
      })),
    });
    await scheduler.reconcileExpiredJobs(scheduler.generation);
  }
  assert.equal(queries, 3);
  assert.notEqual(getState().tasks[0].status, "waiting:jobs");
  assert.equal(publicTodoState(getState().tasks[0]), "failed");
  assert.equal(isTaskActionable(getState().tasks[0], getState().tasks), false);
  assert.equal(getState().tasks[0].wait, undefined);
  assert.deepEqual(getState().tasks[0].waitEvidence, undefined);
  assert.deepEqual(getState().tasks[0].metadata.jobWaitDiagnostic, {
    reason: "job reconciliation exhausted: partial/unavailable",
    unresolvedJobIds: [],
    missingJobIds: ["missing"],
    attempts: 3,
  });
  scheduler.armDeadline();
  assert.equal(scheduler.timer, undefined);
  await scheduler.reconcileExpiredJobs(scheduler.generation);
  assert.equal(queries, 3);
  scheduler.dispose();
});

test("scheduler requires exact current host assignment capability", () => {
  const target = resolveTodoExecutionTarget(process.cwd());
  assert.ok(target);
  const binding = todoReviewTargetIdentityBinding(target.identity);
  const prepared = (hostAssignment) => ({
    id: 1,
    subject: "work",
    status: "pending",
    metadata: {
      orchestrator: { mode: "sticky" },
      preparation: {
        status: "ready",
        token: "current",
        approval: "granted",
        approvalRequired: false,
        analysisCwd: target.path,
        analysisCwdIdentity: target.identity,
        ...(hostAssignment ? { hostAssignment } : {}),
      },
    },
  });
  const scheduler = new TodoScheduler(
    { appendEntry() {}, sendMessage() {} },
    { on: () => () => {}, onState: () => () => {}, query: async () => [] },
    () => {},
  );
  scheduler.active = true;
  for (const capability of [
    undefined,
    { source: "caller", version: 1, token: "current", targetBinding: binding },
    { source: "host", version: 1, token: "old", targetBinding: binding },
    {
      source: "host",
      version: 1,
      token: "current",
      targetBinding: "old-binding",
    },
  ]) {
    commitState({
      ...base([prepared(capability)]),
      orchestrator: { setting: "auto" },
    });
    assert.match(
      scheduler.packageAssignmentError(
        1,
        "current",
        "auto",
        target.path,
        binding,
      ) ?? "",
      /host-issued/,
    );
  }
  const capability = {
    source: "host",
    version: 1,
    token: "current",
    targetBinding: binding,
  };
  commitState({
    ...base([prepared(capability)]),
    orchestrator: { setting: "auto" },
  });
  assert.equal(
    scheduler.packageAssignmentError(
      1,
      "current",
      "auto",
      target.path,
      binding,
    ),
    undefined,
  );
  scheduler.authorizePackageAssignment(
    1,
    "current",
    "worker",
    target.path,
    binding,
  );
  assert.equal(getState().tasks[0].metadata.delegation.status, "running");
  // Revalidation before publication sees a capability removed after initial admission.
  commitState({
    ...base([prepared(undefined)]),
    orchestrator: { setting: "auto" },
  });
  assert.throws(
    () =>
      scheduler.authorizePackageAssignment(
        1,
        "current",
        "worker-2",
        target.path,
        binding,
      ),
    /host-issued/,
  );
  scheduler.dispose();
});

test("orchestrator off durable transition fences late review settlement", () => {
  __resetState();
  const scheduler = new TodoScheduler(
    { appendEntry() {}, sendMessage() {} },
    { on: () => () => {}, onState: () => () => {}, query: async () => [] },
    () => {},
  );
  scheduler.active = true;
  scheduler.context = { cwd: process.cwd() };
  const run = {
    stopped: false,
    reviewerIds: new Set(["reviewer"]),
    cancelledReviewerIds: new Set(),
  };
  scheduler.activeCompletionReviews.set("review", run);
  const plan = scheduler.prepareOrchestratorOff();
  commitState(plan.state);
  scheduler.dispatchOrchestratorOff(plan);
  assert.equal(run.stopped, true);
  assert.equal(scheduler.activeCompletionReviews.size, 0);
  assert.equal(
    scheduler.commitReviewState({
      ...getState(),
      revision: getState().revision + 1,
    }),
    false,
  );
  scheduler.dispose();
});

test("unavailable expired job queries consume bounded durable budget and replay", async () => {
  __resetState();
  let queries = 0;
  const scheduler = new TodoScheduler(
    { appendEntry() {}, sendMessage() {} },
    {
      on: () => () => {},
      onState: () => () => {},
      query: async () => {
        queries++;
        return undefined;
      },
    },
    () => {},
  );
  scheduler.active = true;
  for (let attempt = 1; attempt <= 3; attempt++) {
    commitState({
      ...base([
        {
          id: 1,
          subject: "wait",
          status: "waiting:jobs",
          wait: {
            kind: "jobs",
            jobIds: ["missing"],
            mode: "all",
            deadline: 1,
            settled: {},
            reconciliationAttempts: attempt - 1,
          },
        },
      ]),
    });
    await scheduler.reconcileExpiredJobs(scheduler.generation);
    if (attempt < 3) {
      assert.equal(getState().tasks[0].wait.reconciliationAttempts, attempt);
      assert.equal(
        getState().tasks[0].wait.reconciliationError,
        "query_unavailable",
      );
    }
  }
  assert.notEqual(getState().tasks[0].status, "waiting:jobs");
  assert.equal(publicTodoState(getState().tasks[0]), "failed");
  assert.equal(isTaskActionable(getState().tasks[0], getState().tasks), false);
  assert.equal(getState().tasks[0].wait, undefined);
  assert.deepEqual(getState().tasks[0].metadata.jobWaitDiagnostic, {
    reason: "job reconciliation exhausted: partial/unavailable",
    unresolvedJobIds: [],
    missingJobIds: ["missing"],
    attempts: 3,
  });
  scheduler.armDeadline();
  assert.equal(scheduler.timer, undefined);
  assert.equal(queries, 3);
  scheduler.handleJobState({ id: "missing", status: "succeeded" });
  assert.equal(publicTodoState(getState().tasks[0]), "failed");
  assert.notEqual(getState().tasks[0].status, "waiting:jobs");
  const replayed = replayFromBranch({
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: TODO_SNAPSHOT_TYPE,
          data: createTodoSnapshot(getState()),
        },
      ],
    },
  });
  assert.equal(replayed.tasks[0].wait, undefined);
  assert.equal(publicTodoState(replayed.tasks[0]), "failed");
  assert.equal(isTaskActionable(replayed.tasks[0], replayed.tasks), false);
  scheduler.dispose();
});

test("partial unavailable reconciliation marks only waiters from unavailable batches", async () => {
  __resetState();
  const ids = Array.from(
    { length: MAX_WAIT_JOB_COUNT + 1 },
    (_, index) => `job-${index + 1}`,
  );
  const queries = [];
  const jobs = {
    "job-1": {
      id: "job-1",
      status: "completed",
      incarnation: PARTIAL_BATCH_INCARNATION,
    },
  };
  const { service, unregister } = hostJobs(
    jobs,
    (count, batch, registrations, store) => {
      queries.push(batch);
      if (count > 1) return undefined;
      const registration = registrations.find((item) => item.id === "job-1");
      if (!registration) return [];
      const bound = bindRegistration(store, registration, jobs["job-1"]);
      return bound ? [jobEvent(jobs["job-1"], bound)] : [];
    },
  );
  const sync = service.sync.bind(service);
  service.sync = (registrations) => {
    sync(registrations);
    return [];
  };
  const adapter = jobsAdapter();
  const scheduler = new TodoScheduler(
    { appendEntry() {}, sendMessage() {} },
    adapter,
    () => {},
  );
  commitState({
    ...base(
      ids.map((jobId, index) => ({
        id: index + 1,
        subject: jobId,
        status: "waiting:jobs",
        wait: {
          kind: "jobs",
          jobIds: [jobId],
          mode: "all",
          deadline: 1,
          settled: {},
          waitToken: "batch-incarnation",
          registeredAt: 1,
          generation: 1,
          ...(jobId === "job-1"
            ? { incarnations: { [jobId]: PARTIAL_BATCH_INCARNATION } }
            : {}),
        },
      })),
    ),
  });
  scheduler.active = true;
  await scheduler.reconcileExpiredJobs(scheduler.generation);
  assert.equal(queries.length, 2);
  assert.equal(queries[0].length, MAX_WAIT_JOB_COUNT);
  assert.equal(queries[0][0], "job-1");
  assert.deepEqual(queries[1], [`job-${MAX_WAIT_JOB_COUNT + 1}`]);
  assert.notEqual(getState().tasks[0].status, "waiting:jobs");
  assert.deepEqual(
    getState().tasks[0].waitEvidence?.map(({ id, status }) => ({ id, status })),
    [{ id: "job-1", status: "succeeded" }],
  );
  assert.equal(
    getState().tasks[1].wait.reconciliationError,
    "query_unavailable",
  );
  assert.equal(
    getState().tasks.at(-1).wait.reconciliationError,
    "query_unavailable",
  );
  for (let attempt = 1; attempt < 3; attempt++) {
    const current = getState();
    commitState({
      ...current,
      tasks: current.tasks.map((task) =>
        task.id === MAX_WAIT_JOB_COUNT + 1
          ? { ...task, wait: { ...task.wait, deadline: 1 } }
          : task,
      ),
    });
    await scheduler.reconcileExpiredJobs(scheduler.generation);
  }
  assert.equal(publicTodoState(getState().tasks.at(-1)), "failed");
  assert.equal(
    isTaskActionable(getState().tasks.at(-1), getState().tasks),
    false,
  );
  assert.equal(getState().tasks.at(-1).wait, undefined);
  assert.deepEqual(getState().tasks.at(-1).metadata.jobWaitDiagnostic, {
    reason: "job reconciliation exhausted: partial/unavailable",
    unresolvedJobIds: [],
    missingJobIds: [`job-${MAX_WAIT_JOB_COUNT + 1}`],
    attempts: 3,
  });
  scheduler.dispose();
  adapter.dispose();
  unregister();
});

test("exhausted reconciliation records running versus unavailable IDs and replays evidence", async () => {
  __resetState();
  const { unregister } = hostJobs({
    running: {
      id: "running",
      status: "running",
      incarnation: RUNNING_INCARNATION,
    },
    settled: {
      id: "settled",
      status: "completed",
      settledAt: 10,
      incarnation: SETTLED_INCARNATION,
    },
  });
  const adapter = jobsAdapter();
  const scheduler = new TodoScheduler(
    { appendEntry() {}, sendMessage() {} },
    adapter,
    () => {},
  );
  commitState({
    ...base([
      {
        id: 1,
        subject: "wait",
        status: "waiting:jobs",
        wait: {
          kind: "jobs",
          jobIds: ["running", "settled", "missing"],
          mode: "all",
          deadline: 1,
          settled: {
            settled: { id: "settled", status: "succeeded", settledAt: 10 },
          },
          waitToken: "incarnation",
          registeredAt: 1,
          generation: 1,
          incarnations: {
            running: RUNNING_INCARNATION,
            settled: SETTLED_INCARNATION,
          },
        },
      },
    ]),
  });
  scheduler.active = true;
  for (let attempt = 0; attempt < 3; attempt++) {
    await scheduler.reconcileExpiredJobs(scheduler.generation);
    if (attempt < 2)
      commitState({
        ...getState(),
        tasks: getState().tasks.map((task) => ({
          ...task,
          wait: { ...task.wait, deadline: 1 },
        })),
      });
  }
  assert.deepEqual(getState().tasks[0].metadata.jobWaitDiagnostic, {
    reason: "job reconciliation exhausted: partial/unavailable",
    unresolvedJobIds: ["running"],
    missingJobIds: ["missing"],
    attempts: 3,
  });
  assert.deepEqual(getState().tasks[0].waitEvidence, [
    { id: "settled", status: "succeeded", settledAt: 10 },
  ]);
  const replayed = replayFromBranch({
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: TODO_SNAPSHOT_TYPE,
          data: createTodoSnapshot(getState()),
        },
      ],
    },
  });
  assert.deepEqual(
    replayed.tasks[0].metadata.jobWaitDiagnostic,
    getState().tasks[0].metadata.jobWaitDiagnostic,
  );
  assert.deepEqual(
    replayed.tasks[0].waitEvidence,
    getState().tasks[0].waitEvidence,
  );
  scheduler.dispose();
  adapter.dispose();
  unregister();
});

test("all-running exhausted reconciliation has no unavailable IDs", async () => {
  __resetState();
  const { unregister } = hostJobs({
    running: {
      id: "running",
      status: "running",
      incarnation: ALL_RUNNING_INCARNATION,
    },
  });
  const adapter = jobsAdapter();
  const scheduler = new TodoScheduler(
    { appendEntry() {}, sendMessage() {} },
    adapter,
    () => {},
  );
  commitState({
    ...base([
      {
        id: 1,
        subject: "wait",
        status: "waiting:jobs",
        wait: {
          kind: "jobs",
          jobIds: ["running"],
          mode: "all",
          deadline: 1,
          settled: {},
          waitToken: "incarnation",
          registeredAt: 1,
          generation: 1,
          incarnations: { running: ALL_RUNNING_INCARNATION },
        },
      },
    ]),
  });
  scheduler.active = true;
  for (let attempt = 0; attempt < 3; attempt++) {
    await scheduler.reconcileExpiredJobs(scheduler.generation);
    if (attempt < 2)
      commitState({
        ...getState(),
        tasks: getState().tasks.map((task) => ({
          ...task,
          wait: { ...task.wait, deadline: 1 },
        })),
      });
  }
  assert.deepEqual(getState().tasks[0].metadata.jobWaitDiagnostic, {
    reason: "job reconciliation exhausted: partial/unavailable",
    unresolvedJobIds: ["running"],
    missingJobIds: [],
    attempts: 3,
  });
  scheduler.dispose();
  adapter.dispose();
  unregister();
});

test("sticky mode treats cancelling delegation and active cancellation ledger as busy", () => {
  __resetState();
  const scheduler = new TodoScheduler(
    { appendEntry() {}, sendMessage() {} },
    { on: () => () => {}, onState: () => () => {}, query: async () => [] },
    () => {},
  );
  const task = (delegation, mode = "sticky") => ({
    id: 1,
    subject: "owned",
    status: "in_progress",
    metadata: {
      orchestrator: { mode },
      preparation: { token: "token" },
      delegation: {
        todoId: 1,
        todoToken: "token",
        subagentId: "worker",
        ...delegation,
      },
    },
  });
  commitState({
    ...base([
      task({
        status: "cancelling",
        cancellationIds: ["worker"],
        cancellationGeneration: 1,
      }),
    ]),
    orchestrator: { setting: "auto", sticky: true },
  });
  scheduler.clearStickyIfSettled();
  assert.equal(getState().orchestrator.sticky, true);
  commitState({
    ...getState(),
    tasks: [
      task({
        status: "cancelled",
        cancellationIds: ["worker"],
        cancellationGeneration: 1,
      }),
    ],
    cancellationIntents: [
      {
        kind: "delegation",
        taskId: 1,
        token: "token",
        ids: ["worker"],
        generation: 1,
        attempts: 0,
      },
    ],
  });
  scheduler.clearStickyIfSettled();
  assert.equal(getState().orchestrator.sticky, true);
  const settledState = {
    ...getState(),
    tasks: [
      task(
        {
          status: "cancelled",
          cancellationIds: ["worker"],
          cancellationGeneration: 1,
        },
        "direct",
      ),
    ],
  };
  delete settledState.cancellationIntents;
  commitState(settledState);
  scheduler.clearStickyIfSettled();
  assert.equal(getState().orchestrator.sticky, false);
  scheduler.dispose();
});

test("job wait incarnation fences stale reused-ID events and queries", async () => {
  const wait = {
    kind: "jobs",
    jobIds: ["reused"],
    mode: "any",
    deadline: 10_000,
    settled: {},
    waitToken: "current-incarnation",
    registeredAt: 2_000,
    generation: 2,
    incarnations: { reused: CURRENT_INCARNATION },
  };
  const waiting = {
    ...base([{ id: 1, subject: "wait", status: "waiting:jobs", wait }]),
    revision: 2,
  };
  const stale = applyJobState(
    waiting,
    {
      id: "reused",
      status: "succeeded",
      waitToken: "old-incarnation",
      waitRegisteredAt: 1_000,
      waitGeneration: 1,
      waitIncarnation: STALE_INCARNATION,
      settledAt: 1_000,
    },
    3_000,
  );
  assert.equal(stale, waiting);
  assert.equal(
    applyJobState(
      waiting,
      {
        id: "reused",
        status: "succeeded",
        waitToken: "current-incarnation",
        waitRegisteredAt: 2_000,
        waitGeneration: 2,
        waitIncarnation: CURRENT_INCARNATION,
        settledAt: 2_000,
      },
      3_000,
    ).tasks[0].status,
    "pending",
  );

  __resetState();
  let query = 0;
  const jobs = {
    reused: {
      id: "reused",
      status: "completed",
      settledAt: 2_000,
      incarnation: CURRENT_INCARNATION,
    },
  };
  const { unregister } = hostJobs(jobs, (count) => {
    query++;
    return count === 1 ? [] : undefined;
  });
  const persisted = [];
  const adapter = jobsAdapter();
  const scheduler = new TodoScheduler(
    {
      appendEntry(_type, data) {
        persisted.push(data);
      },
      sendMessage() {},
    },
    adapter,
    () => {},
  );
  scheduler.active = true;
  const replayed = replayFromBranch({
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: TODO_SNAPSHOT_TYPE,
          data: createTodoSnapshot(base()),
        },
        {
          type: "custom",
          customType: TODO_SNAPSHOT_TYPE,
          data: createTodoPatch(base(), waiting),
        },
      ],
    },
  });
  assert.deepEqual(replayed.tasks[0].wait, wait);
  commitState(replayed);
  await scheduler.reconcileJobs(scheduler.generation);
  assert.equal(getState().tasks[0].status, "pending");
  assert.equal(query, 0);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].upsertedTasks[0].status, "pending");
  assert.equal(getState().tasks[0].waitEvidence[0].id, "reused");
  assert.equal(getState().tasks[0].waitEvidence[0].status, "succeeded");
  assert.ok(getState().tasks[0].waitEvidence[0].settledAt >= 2_000);
  scheduler.dispose();
  adapter.dispose();
  unregister();
});

test("persistence redacts secrets from snapshots, patches, and replay", () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const result = applyTaskMutation(
    base(),
    "create",
    {
      subject: `subject ${secret}`,
      description: `Bearer ${secret}`,
      metadata: { note: `password=${secret}` },
    },
    1,
    () => "host-token",
  );
  const completed = applyTaskMutation(result.state, "update", {
    id: 1,
    status: "completed",
    result: `sk-abcdefghijklmnopqrstuv`,
    evidence: [`token=${secret}`],
  });
  const snapshot = createTodoSnapshot(completed.state);
  const patch = createTodoPatch(result.state, completed.state);
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(patch), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(snapshot), /sk-abcdefghijklmnopqrstuv/);
  const replayed = replayFromBranch({
    sessionManager: {
      getBranch: () => [
        { type: "custom", customType: TODO_SNAPSHOT_TYPE, data: snapshot },
      ],
    },
  });
  assert.doesNotMatch(JSON.stringify(replayed), new RegExp(secret));
});

test("job registration batch rejects stale incarnations without partial mutation", () => {
  const waiting = base([
    {
      id: 1,
      subject: "first",
      status: "waiting:jobs",
      wait: {
        kind: "jobs",
        jobIds: ["a"],
        mode: "all",
        deadline: 10_000,
        settled: {},
        waitToken: "batch",
        registeredAt: 1,
        generation: 1,
      },
    },
    {
      id: 2,
      subject: "second",
      status: "waiting:jobs",
      wait: {
        kind: "jobs",
        jobIds: ["b"],
        mode: "all",
        deadline: 10_000,
        settled: {},
        waitToken: "batch",
        registeredAt: 1,
        generation: 1,
        incarnations: { b: CURRENT_INCARNATION },
      },
    },
  ]);
  const result = applyJobStateBatch(waiting, [
    {
      id: "a",
      status: "succeeded",
      waitToken: "batch",
      waitRegisteredAt: 1,
      waitGeneration: 1,
      waitIncarnation: PARTIAL_BATCH_INCARNATION,
    },
    {
      id: "b",
      status: "succeeded",
      waitToken: "batch",
      waitRegisteredAt: 1,
      waitGeneration: 1,
      waitIncarnation: STALE_INCARNATION,
    },
  ]);
  assert.equal(result, waiting);
});

test("running-only registration batch binds any-mode wait without waking", () => {
  const waiting = base([
    {
      id: 1,
      subject: "wait",
      status: "waiting:jobs",
      wait: {
        kind: "jobs",
        jobIds: ["a", "b"],
        mode: "any",
        deadline: 10_000,
        settled: {},
        waitToken: "running-any",
        registeredAt: 1,
        generation: 1,
      },
    },
  ]);
  const result = applyJobStateBatch(
    waiting,
    ["a", "b"].map((id) => ({
      id,
      status: "running",
      waitToken: "running-any",
      waitRegisteredAt: 1,
      waitGeneration: 1,
      waitIncarnation: `${id}-incarnation`,
    })),
  );
  assert.equal(result.tasks[0].status, "waiting:jobs");
  assert.deepEqual(result.tasks[0].wait.settled, {});
  assert.deepEqual(result.tasks[0].wait.incarnations, {
    a: "a-incarnation",
    b: "b-incarnation",
  });
  assert.equal(result.tasks[0].waitEvidence, undefined);
});

test("job registration batch binds 65,536 descriptors in one revision", () => {
  const taskCount = 1_024;
  const jobsPerTask = 64;
  const state = base(
    Array.from({ length: taskCount }, (_, taskIndex) => ({
      id: taskIndex + 1,
      subject: `wait-${taskIndex}`,
      status: "waiting:jobs",
      wait: {
        kind: "jobs",
        jobIds: Array.from(
          { length: jobsPerTask },
          (_, jobIndex) => `job-${taskIndex}-${jobIndex}`,
        ),
        mode: "all",
        deadline: 10_000,
        settled: {},
        waitToken: "scale",
        registeredAt: 1,
        generation: 1,
      },
    })),
  );
  const replies = state.tasks.flatMap((task) =>
    task.wait.jobIds.map((id) => ({
      id,
      status: "running",
      waitToken: "scale",
      waitRegisteredAt: 1,
      waitGeneration: 1,
      waitIncarnation: `${id}-incarnation`,
    })),
  );
  const started = performance.now();
  const result = applyJobStateBatch(state, replies, 2);
  assert.ok(performance.now() - started < 10_000);
  assert.equal(result.revision, state.revision + 1);
  assert.equal(
    result.tasks[0].wait.incarnations["job-0-0"],
    "job-0-0-incarnation",
  );
  assert.equal(
    result.tasks.at(-1).wait.incarnations[
      `job-${taskCount - 1}-${jobsPerTask - 1}`
    ],
    `job-${taskCount - 1}-${jobsPerTask - 1}-incarnation`,
  );
});

test("job registration acknowledgements fail closed and settle terminal batches atomically", () => {
  const waiting = (ids) => ({
    ...base([
      {
        id: 1,
        subject: "wait",
        status: "waiting:jobs",
        wait: {
          kind: "jobs",
          jobIds: ids,
          mode: "all",
          deadline: Date.now() + 60_000,
          settled: {},
          waitToken: "ack",
          registeredAt: 1,
          generation: 1,
        },
      },
    ]),
  });
  for (const replies of [
    [],
    [{ id: "a", status: "succeeded" }],
    [
      {
        id: "a",
        status: "running",
        waitToken: "ack",
        waitRegisteredAt: 1,
        waitGeneration: 1,
        waitIncarnation: CURRENT_INCARNATION,
      },
      {
        id: "a",
        status: "running",
        waitToken: "ack",
        waitRegisteredAt: 1,
        waitGeneration: 1,
        waitIncarnation: CURRENT_INCARNATION,
      },
    ],
  ]) {
    __resetState();
    const unregister = registerJobsWaitRegistrationService({
      register: () => replies,
      sync: () => replies,
      query: () => [],
    });
    const persisted = [];
    const adapter = jobsAdapter();
    const scheduler = new TodoScheduler(
      {
        appendEntry(_type, data) {
          persisted.push(data);
        },
        sendMessage() {},
      },
      adapter,
      () => {},
    );
    commitState(waiting(["a", "b"]));
    const before = getState();
    scheduler.stateChanged(false);
    assert.equal(getState(), before);
    assert.equal(persisted.length, 0);
    scheduler.dispose();
    adapter.dispose();
    unregister();
  }

  __resetState();
  const { unregister } = hostJobs({
    a: {
      id: "a",
      status: "completed",
      settledAt: 2,
      incarnation: CURRENT_INCARNATION,
    },
    b: {
      id: "b",
      status: "failed",
      settledAt: 3,
      incarnation: SETTLED_INCARNATION,
    },
  });
  const persisted = [];
  let changes = 0;
  const adapter = jobsAdapter();
  const scheduler = new TodoScheduler(
    {
      appendEntry(_type, data) {
        persisted.push(data);
      },
      sendMessage() {},
    },
    adapter,
    () => changes++,
  );
  commitState(waiting(["a", "b"]));
  scheduler.stateChanged(false);
  assert.equal(getState().tasks[0].status, "pending");
  assert.deepEqual(
    getState().tasks[0].waitEvidence.map(({ id, status }) => ({ id, status })),
    [
      { id: "a", status: "succeeded" },
      { id: "b", status: "failed" },
    ],
  );
  assert.equal(getState().revision, 2);
  assert.equal(persisted.length, 1);
  assert.equal(changes, 1);
  scheduler.dispose();
  adapter.dispose();
  unregister();
});
