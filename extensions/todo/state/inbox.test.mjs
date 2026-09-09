import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MAX_VERIFICATION_EXCHANGES,
  PUBLIC_TODO_STATES,
  challengeVerificationFinding,
  chooseExecutionOwner,
  publicTodoState,
  propagatePrerequisiteFailure,
  recordVerificationExchange,
  recoverInternalVerificationFailure,
  selectReadyTasks,
} from "./inbox.ts";
import { applyTaskMutation } from "./state-reducer.ts";

const task = (id, status = "pending", extra = {}) => ({
  id,
  subject: `Task ${id}`,
  status,
  ...extra,
});
const ready = (id, extra = {}) =>
  task(id, "pending", {
    ...extra,
    metadata: {
      preparation: { status: "ready" },
      ...(extra.metadata ?? {}),
    },
  });

test("publicTodoState derives all seven values from persisted task fields", () => {
  assert.deepEqual(PUBLIC_TODO_STATES, [
    "preparing",
    "ready",
    "in_progress",
    "waiting",
    "verifying",
    "completed",
    "failed",
  ]);
  assert.equal(publicTodoState(task(1)), "ready");
  assert.equal(
    publicTodoState(
      task(2, "pending", { metadata: { preparation: { status: "running" } } }),
    ),
    "preparing",
  );
  assert.equal(publicTodoState(task(3, "in_progress")), "in_progress");
  assert.equal(
    publicTodoState(
      task(4, "waiting:user", { wait: { kind: "user", questions: ["q"] } }),
    ),
    "waiting",
  );
  assert.equal(
    publicTodoState(task(5, "in_progress", { review: { status: "pending" } })),
    "verifying",
  );
  assert.equal(publicTodoState(task(6, "completed")), "completed");
  assert.equal(
    publicTodoState(task(9, "completed", { review: { status: "pending" } })),
    "verifying",
  );
  assert.equal(
    publicTodoState(
      task(8, "completed", {
        metadata: {
          preparation: { status: "failed" },
          verification: { state: "failed" },
        },
      }),
    ),
    "completed",
  );
  assert.equal(
    publicTodoState(
      task(7, "pending", { metadata: { inbox: { lifecycle: "failed" } } }),
    ),
    "failed",
  );
});

test("ready selection validates order and excludes waits, missing dependencies, and cycles", () => {
  const tasks = [
    ready(1),
    ready(2, { blockedBy: [1] }),
    task(3, "waiting:jobs", {
      wait: {
        kind: "jobs",
        jobIds: ["job"],
        mode: "all",
        deadline: 1,
        settled: {},
      },
    }),
    ready(4, { blockedBy: [99] }),
    ready(5, { blockedBy: [6] }),
    ready(6, { blockedBy: [5] }),
    ready(7, { mergedInto: 1 }),
  ];
  assert.deepEqual(
    selectReadyTasks(tasks, { orderedCandidateIds: [2, 1, 2] }).map(
      ({ id }) => id,
    ),
    [1],
  );
  assert.deepEqual(
    selectReadyTasks(tasks, { orderedCandidateIds: [2, 1] }).map(
      ({ id }) => id,
    ),
    [1],
  );
  assert.deepEqual(
    selectReadyTasks(
      tasks.map((item) =>
        item.id === 1 ? { ...item, status: "completed" } : item,
      ),
      { orderedCandidateIds: [2, 1] },
    ).map(({ id }) => id),
    [2],
  );
});

test("ownership only follows explicit owner or existing classifier/delegation facts", () => {
  assert.equal(
    chooseExecutionOwner({ task: task(1), explicitOwner: "parent" }),
    "parent",
  );
  assert.equal(
    chooseExecutionOwner({
      task: task(2, "pending", {
        metadata: { orchestrator: { requiresOrchestration: true } },
      }),
    }),
    "parent",
  );
  assert.equal(
    chooseExecutionOwner({
      task: task(3, "pending", {
        metadata: { orchestrator: { mode: "sticky" } },
      }),
    }),
    "parent",
  );
  assert.equal(
    chooseExecutionOwner({ task: task(4), explicitOwner: "package-worker" }),
    "package-worker",
  );
  assert.equal(
    chooseExecutionOwner({
      task: task(5, "pending", {
        metadata: { delegation: { status: "running" } },
      }),
    }),
    "package-worker",
  );
  assert.equal(
    chooseExecutionOwner({ task: task(6), explicitOwner: "untrusted-owner" }),
    "parent",
  );
});

test("verification exchanges are bounded, immutable, and fail on the third unresolved exchange", () => {
  const original = task(1, "in_progress");
  const exchanged = [1, 2, 3].reduce(
    (current) =>
      recordVerificationExchange(current, {
        decision: "needs-fix",
        finding: "missing evidence",
        evidence: ["check output"],
        rationale: "verifier finding",
      }),
    original,
  );
  assert.equal(original.metadata, undefined);
  assert.equal(
    exchanged.metadata.verification.exchanges.length,
    MAX_VERIFICATION_EXCHANGES,
  );
  assert.equal(publicTodoState(exchanged), "failed");
  assert.equal(
    recordVerificationExchange(exchanged, {
      decision: "needs-fix",
      finding: "again",
      evidence: ["x"],
      rationale: "again",
    }),
    exchanged,
  );
});

test("approval is terminal on the first exchange or after two corrections", () => {
  const approved = recordVerificationExchange(task(10, "in_progress"), {
    decision: "approved",
    finding: "verified",
    evidence: ["check passed"],
    rationale: "evidence supports completion",
  });
  assert.equal(approved.metadata.verification.state, "approved");
  assert.equal(
    recordVerificationExchange(approved, {
      decision: "needs-fix",
      finding: "late finding",
      evidence: ["late"],
      rationale: "late",
    }),
    approved,
  );

  const twoCorrections = [1, 2].reduce(
    (current) =>
      recordVerificationExchange(current, {
        decision: "needs-fix",
        finding: "needs work",
        evidence: ["check output"],
        rationale: "verifier finding",
      }),
    task(11, "in_progress"),
  );
  const approvedAfterCorrections = recordVerificationExchange(twoCorrections, {
    decision: "approved",
    finding: "fixed",
    evidence: ["new check passed"],
    rationale: "fix verified",
  });
  assert.equal(
    approvedAfterCorrections.metadata.verification.state,
    "approved",
  );
  assert.equal(
    recordVerificationExchange(approvedAfterCorrections, {
      decision: "needs-fix",
      finding: "late finding",
      evidence: ["late"],
      rationale: "late",
    }),
    approvedAfterCorrections,
  );
});

test("finding challenge and internal recovery preserve evidence without a user wait", () => {
  const original = recordVerificationExchange(task(1, "in_progress"), {
    decision: "needs-fix",
    finding: "too broad",
    evidence: ["focused test"],
    rationale: "review",
  });
  const challenged = challengeVerificationFinding(original, {
    decision: "skip",
    evidence: ["prior user request"],
    rationale: "prior user message",
  });
  assert.equal(original.metadata.verification.challenge, undefined);
  assert.equal(
    challenged.metadata.verification.exchanges[0].finding,
    "too broad",
  );
  assert.equal(
    challenged.metadata.verification.challenge.rationale,
    "prior user message",
  );
  assert.equal(
    challenged.metadata.verification.challenge.priorUserMessage,
    undefined,
  );
  const userMessage = {
    id: "message-1",
    content: "User explicitly requested the narrower scope",
  };
  assert.equal(
    challengeVerificationFinding(original, {
      decision: "challenge",
      rationale: "unverified text is not controlling",
      priorUserMessage: userMessage,
    }),
    original,
  );
  const priorMessageChallenge = challengeVerificationFinding(
    original,
    {
      decision: "challenge",
      rationale: "the prior request is controlling",
      priorUserMessage: userMessage,
    },
    new Map([[userMessage.id, userMessage.content]]),
  );
  assert.equal(
    priorMessageChallenge.metadata.verification.challenge.rationale,
    "the prior request is controlling",
  );
  assert.deepEqual(
    priorMessageChallenge.metadata.verification.challenge.priorUserMessage,
    userMessage,
  );
  assert.equal(
    challengeVerificationFinding(original, {
      decision: "",
      evidence: ["support"],
      rationale: "ignored",
    }),
    original,
  );
  assert.equal(
    challengeVerificationFinding(original, {
      decision: "skip",
      evidence: [],
      rationale: "unsupported",
    }),
    original,
  );
  const approvedFinding = recordVerificationExchange(task(3, "in_progress"), {
    decision: "approved",
    finding: "verified",
    evidence: ["check passed"],
    rationale: "review complete",
  });
  assert.equal(
    challengeVerificationFinding(approvedFinding, {
      decision: "challenge",
      evidence: ["late claim"],
      rationale: "too late",
    }),
    approvedFinding,
  );
  const recovered = recoverInternalVerificationFailure(
    task(2, "waiting:user", {
      wait: { kind: "user", questions: ["Retry review?"] },
      review: {
        status: "pending",
        generation: 1,
        token: "review",
        completionRevision: 1,
        requestedAt: 1,
        dispatchedAt: 2,
        reviewer: { id: "reviewer", model: "model" },
      },
    }),
    "reviewer process exited",
  );
  assert.equal(publicTodoState(recovered), "failed");
  assert.equal(recovered.status, "in_progress");
  assert.equal(recovered.wait, undefined);
  assert.equal(recovered.review.dispatchedAt, 2);
  assert.equal(recovered.metadata.verification.state, "failed");
  assert.equal(recovered.metadata.verification.recovery, "manual");
  assert.equal(
    recovered.metadata.verification.failure,
    "reviewer process exited",
  );
  assert.match(
    recovered.metadata.verification.retryPolicy,
    /Automatic completion-review retries exhausted/,
  );
});

test("failure propagation is iterative, non-mutating, and cycle-safe", () => {
  const source = task(1, "pending", {
    metadata: { inbox: { lifecycle: "failed" } },
  });
  const tasks = [source];
  for (let id = 2; id <= 10_001; id++)
    tasks.push(ready(id, { blockedBy: [id - 1] }));
  tasks.push(
    ready(20_000, { blockedBy: [20_001] }),
    ready(20_001, { blockedBy: [20_000] }),
  );
  const next = propagatePrerequisiteFailure(tasks);
  assert.equal(source.metadata.inbox.lifecycle, "failed");
  assert.equal(next[10_000].metadata.inbox.lifecycle, "failed");
  assert.equal(next.at(-1).metadata?.inbox, undefined);
});

test("fresh completion clears stale verification failure and recovers descendants", () => {
  const failed = propagatePrerequisiteFailure([
    task(1, "in_progress", {
      metadata: {
        verification: { state: "failed", failure: "old review" },
        custom: "preserved",
      },
    }),
    ready(2, { blockedBy: [1] }),
  ]);
  assert.equal(publicTodoState(failed[1]), "failed");

  const completed = applyTaskMutation(
    { tasks: failed, nextId: 3, revision: 1 },
    "update",
    { id: 1, status: "completed", result: "fixed", evidence: ["verified"] },
  ).state;
  assert.equal(completed.tasks[0].metadata?.verification, undefined);
  assert.equal(completed.tasks[0].metadata?.custom, "preserved");
  assert.equal(completed.tasks[0].review.status, "pending");
  assert.equal(publicTodoState(completed.tasks[0]), "verifying");
  assert.deepEqual(completed.tasks[1].blockedBy, [1]);
  assert.equal(publicTodoState(completed.tasks[1]), "ready");
  assert.equal(completed.tasks[1].metadata?.inbox, undefined);
});

test("operational failures do not propagate and obsolete prerequisite failures clear", () => {
  const operational = task(1, "pending", {
    metadata: { preparation: { status: "failed", code: "preparation_failed" } },
  });
  const dependent = ready(2, { blockedBy: [1] });
  assert.equal(
    propagatePrerequisiteFailure([operational, dependent])[1].metadata.inbox,
    undefined,
  );

  const recoveredSource = ready(3);
  const staleDependent = ready(4, {
    blockedBy: [3],
    metadata: {
      inbox: {
        lifecycle: "failed",
        reason: "failed prerequisite",
        sourceFailureId: 3,
      },
    },
  });
  assert.equal(
    propagatePrerequisiteFailure([recoveredSource, staleDependent])[1].metadata
      .inbox,
    undefined,
  );

  const inboxOnlyDependent = {
    ...ready(5, { blockedBy: [3] }),
    metadata: {
      inbox: {
        lifecycle: "failed",
        reason: "failed prerequisite",
        sourceFailureId: 3,
      },
    },
  };
  assert.equal(
    Object.hasOwn(
      propagatePrerequisiteFailure([recoveredSource, inboxOnlyDependent])[1],
      "metadata",
    ),
    false,
  );
});
