import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  applyJobState,
  isTaskActionable,
  migrateLegacyPreparedApprovals,
  recoverInterruptedPreparations,
} from "./state/waits.ts";
import {
  applyTaskMutation,
  settleCompletionReview,
} from "./state/state-reducer.ts";
import { getState, replaceState } from "./state/store.ts";
import {
  classifyOrchestration,
  ORCHESTRATOR_GUIDANCE,
} from "./orchestrator.ts";
import { formatContent } from "./tool/response-envelope.ts";

const base = (tasks) => ({ tasks, nextId: tasks.length + 1, revision: 1 });
const task = (id, status = "pending", extra = {}) => ({
  id,
  subject: `Task ${id}`,
  status,
  ...extra,
});

test("/todo add appends only and edits remain explicit state mutations", () => {
  const before = base([task(1)]);
  const added = applyTaskMutation(before, "create", {
    subject: "Task 2",
  }).state;
  assert.deepEqual(
    added.tasks.map(({ id, subject }) => [id, subject]),
    [
      [1, "Task 1"],
      [2, "Task 2"],
    ],
  );
  assert.equal(
    applyTaskMutation(added, "update", { id: 1, subject: "Edited" }).state
      .tasks[0].subject,
    "Edited",
  );
  assert.equal(
    applyTaskMutation(added, "update", { id: 1, status: "deleted" }).op.kind,
    "error",
  );
  assert.equal(
    applyTaskMutation(
      base([task(1, "deleted", { result: "done", evidence: ["verified"] })]),
      "update",
      { id: 1, subject: "rewrite audit" },
    ).op.kind,
    "error",
  );
  for (const key of ["inbox", "verification"]) {
    assert.equal(
      applyTaskMutation(added, "update", {
        id: 1,
        metadata: { [key]: { state: "forged" } },
      }).op.kind,
      "error",
    );
  }
});

test("preparation candidate questions do not create a user wait and only ready work is actionable", () => {
  const prepared = base([
    task(1, "pending", {
      metadata: {
        preparation: {
          status: "awaiting_approval",
          approvalQuestion: "Approve prepared plan?",
        },
      },
      wait: { kind: "user", questions: ["Approve prepared plan?"] },
    }),
  ]);
  const migrated = migrateLegacyPreparedApprovals(prepared);
  assert.equal(migrated.tasks[0].status, "pending");
  assert.equal(migrated.tasks[0].wait, undefined);
  assert.equal(migrated.tasks[0].metadata.preparation.status, "ready");
  assert.equal(isTaskActionable(migrated.tasks[0], migrated.tasks), true);
});

test("matching job events wake only their waiter while independent siblings continue", () => {
  const waiting = base([
    task(1, "waiting:jobs", {
      wait: {
        kind: "jobs",
        jobIds: ["job-a"],
        mode: "all",
        deadline: 99,
        settled: {},
        waitToken: "wait-a",
        registeredAt: 1,
        generation: 1,
        incarnations: { "job-a": "job-a-incarnation" },
      },
    }),
    task(2, "waiting:jobs", {
      wait: {
        kind: "jobs",
        jobIds: ["job-b"],
        mode: "all",
        deadline: 99,
        settled: {},
        waitToken: "wait-b",
        registeredAt: 1,
        generation: 1,
        incarnations: { "job-b": "job-b-incarnation" },
      },
    }),
  ]);
  const next = applyJobState(
    waiting,
    {
      id: "job-a",
      status: "succeeded",
      waitToken: "wait-a",
      waitRegisteredAt: 1,
      waitGeneration: 1,
      waitIncarnation: "job-a-incarnation",
    },
    10,
  );
  assert.equal(next.tasks[0].status, "pending");
  assert.equal(next.tasks[1].status, "waiting:jobs");
});

test("reload recovery requeues interrupted preparation without accepting it as complete", () => {
  const state = base([
    task(1, "pending", {
      metadata: {
        preparation: { status: "running", token: "old", version: 1 },
        delegation: { status: "running", subagentId: "worker" },
      },
    }),
  ]);
  const recovered = recoverInterruptedPreparations(state);
  assert.equal(recovered.tasks[0].status, "pending");
  assert.equal(recovered.tasks[0].metadata.preparation.status, "failed");
  assert.equal(recovered.tasks[0].metadata.preparation.token, "old");
  assert.equal(recovered.tasks[0].metadata.preparation.version, 2);
});

test("orchestration guidance preserves parent/worker choice and maximal package ownership", () => {
  const classified = classifyOrchestration(
    "Delegate independent work with a durable handoff",
  );
  assert.equal(classified.requiresOrchestration, true);
  assert.match(ORCHESTRATOR_GUIDANCE, /maximal package/);
  assert.match(ORCHESTRATOR_GUIDANCE, /Parent owns approvals/);
});

test("core creation assigns a current-life token and leaves preparation queued", () => {
  const result = applyTaskMutation(
    base([]),
    "create",
    { subject: "Prepare asynchronously" },
    1,
    () => "core-incarnation",
  );
  assert.equal(result.state.tasks[0].status, "pending");
  assert.deepEqual(result.state.tasks[0].metadata.preparation, {
    status: "queued",
    version: 1,
    token: "core-incarnation",
    sourceRevision: 2,
  });
  assert.equal(result.state.tasks[0].wait, undefined);
});

test("approved public lifecycle is exactly seven states", async () => {
  const { PUBLIC_TODO_STATES } = await import("./state/inbox.ts");
  assert.deepEqual(PUBLIC_TODO_STATES, [
    "preparing",
    "ready",
    "in_progress",
    "waiting",
    "verifying",
    "completed",
    "failed",
  ]);
});

test("idle queue claims ready work and may reprioritize multiple ready tasks", async () => {
  const { selectReadyTasks } = await import("./state/inbox.ts");
  const tasks = [
    task(1, "pending", { metadata: { preparation: { status: "ready" } } }),
    task(2, "pending", { metadata: { preparation: { status: "ready" } } }),
    task(3, "waiting:jobs", {
      wait: {
        kind: "jobs",
        jobIds: ["job"],
        mode: "all",
        deadline: 99,
        settled: {},
      },
    }),
  ];
  assert.deepEqual(
    selectReadyTasks(tasks, { orderedCandidateIds: [2, 1] }).map(
      (item) => item.id,
    ),
    [2, 1],
  );
});

test("execution owner follows context and explicit parent/worker instructions", async () => {
  const { chooseExecutionOwner } = await import("./state/inbox.ts");
  assert.equal(
    chooseExecutionOwner({
      task: task(1, "pending", {
        metadata: { orchestrator: { requiresOrchestration: true } },
      }),
      explicitOwner: "package-worker",
    }),
    "package-worker",
  );
  assert.equal(
    chooseExecutionOwner({ task: task(2), explicitOwner: "parent" }),
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
    chooseExecutionOwner({
      task: task(4, "pending", {
        metadata: { orchestrator: { requiresOrchestration: true } },
      }),
    }),
    "parent",
  );
});

test("duplicate source items persist with merged identity and shared verification", async () => {
  const { mergeDuplicateItems } = await import("./state/inbox.ts");
  const source = [1, 2, 3].map((id) =>
    task(id, "pending", {
      subject: "Deliver shared duplicate outcome",
      description: "Update the same scheduler scope and verification contract.",
    }),
  );
  const result = mergeDuplicateItems(source, 1, 2, {
    result: "done",
    evidence: ["check passed"],
  });
  assert.equal(result.executionOwnerId, 1);
  assert.equal(result.items.find((item) => item.id === 2).mergedInto, 1);
  assert.deepEqual(
    result.items.slice(0, 2).map((item) => item.evidence),
    [["check passed"], ["check passed"]],
  );
  assert.equal(result.items[2].result, undefined);
  assert.equal(result.items[2].evidence, undefined);
  assert.equal(source[1].mergedInto, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);

  assert.equal(
    applyTaskMutation(base(source), "merge", { id: 1, duplicateId: 1 }).op.kind,
    "error",
  );
  assert.equal(
    applyTaskMutation(
      base([
        task(1, "pending", { subject: "Update scheduler retries" }),
        task(2, "pending", { subject: "Document telemetry protocol" }),
      ]),
      "merge",
      { id: 1, duplicateId: 2 },
    ).op.kind,
    "error",
  );
  assert.equal(
    applyTaskMutation(
      base([
        task(1, "pending", {
          subject: "Shared generic request",
          description: "Change scheduler retry behavior.",
        }),
        task(2, "pending", {
          subject: "Shared generic request",
          description: "Document telemetry retention.",
        }),
      ]),
      "merge",
      { id: 1, duplicateId: 2 },
    ).op.kind,
    "error",
  );
  const linked = applyTaskMutation(base(source), "merge", {
    id: 1,
    duplicateId: 2,
  });
  assert.equal(linked.op.kind, "merge");
  assert.equal(linked.state.tasks[1].mergedInto, 1);
  assert.deepEqual(linked.state.tasks[1].metadata.inbox.mergeDecision, {
    executionOwnerId: 1,
    duplicateId: 2,
    basis: "same-subject",
    sharedSubjectTerms: ["deliver", "duplicate", "outcome", "shared"],
    sharedScopeTerms: [
      "contract",
      "same",
      "scheduler",
      "scope",
      "verification",
    ],
    sharedPaths: [],
  });
  assert.match(
    formatContent({ kind: "list", includeDeleted: true }, linked.state),
    /#2 Deliver shared duplicate outcome.*merged into #1/,
  );
  assert.match(
    formatContent({ kind: "get", task: linked.state.tasks[1] }, linked.state),
    /merged into: #1/,
  );
  assert.equal(
    isTaskActionable(linked.state.tasks[1], linked.state.tasks),
    false,
  );
  const completedOwner = applyTaskMutation(base(source.slice(0, 2)), "update", {
    id: 1,
    status: "completed",
    result: "shared result",
    evidence: ["shared evidence"],
  }).state;
  const pendingMerge = applyTaskMutation(completedOwner, "merge", {
    id: 1,
    duplicateId: 2,
  }).state;
  const pendingReview = pendingMerge.tasks[0].review;
  const settledMerge = settleCompletionReview(
    pendingMerge,
    {
      taskId: 1,
      generation: pendingReview.generation,
      token: pendingReview.token,
      completionRevision: pendingReview.completionRevision,
    },
    {
      decision: "approved",
      feedback: "approved shared work",
      reviewerId: "reviewer",
      model: "model",
    },
  );
  assert.deepEqual(
    settledMerge.tasks.slice(0, 2).map((item) => ({
      status: item.status,
      result: item.result,
      evidence: item.evidence,
      review: item.review.status,
    })),
    [
      {
        status: "completed",
        result: "shared result",
        evidence: ["shared evidence"],
        review: "approved",
      },
      {
        status: "completed",
        result: "shared result",
        evidence: ["shared evidence"],
        review: "approved",
      },
    ],
  );
  assert.equal(
    applyTaskMutation(linked.state, "update", {
      id: 2,
      status: "completed",
      result: "duplicate result",
      evidence: ["duplicate check"],
    }).op.kind,
    "error",
  );
  const completed = applyTaskMutation(linked.state, "update", {
    id: 1,
    status: "completed",
    result: "implemented once",
    evidence: ["focused check passed"],
  }).state;
  const review = completed.tasks[0].review;
  const { claimCompletionReview } = await import("./state/state-reducer.ts");
  const identity = {
    taskId: 1,
    generation: review.generation,
    token: review.token,
    completionRevision: review.completionRevision,
  };
  const approved = settleCompletionReview(
    claimCompletionReview(completed, identity),
    identity,
    {
      decision: "approved",
      feedback: "shared evidence verified",
      reviewerId: "reviewer",
      model: "openai-codex/gpt-5.6-luna",
    },
  );
  assert.equal(approved.tasks[1].status, "completed");
  assert.equal(approved.tasks[1].review.status, "approved");
  assert.equal(approved.tasks[1].result, "implemented once");
  assert.deepEqual(approved.tasks[1].evidence, ["focused check passed"]);
  assert.equal(approved.tasks[2].result, undefined);
  assert.equal(
    applyTaskMutation(approved, "update", {
      id: 1,
      result: "changed after approval",
      evidence: ["new evidence"],
    }).op.kind,
    "error",
  );

  const unresolvedLinked = {
    ...approved,
    tasks: approved.tasks.map((item) =>
      item.id === 3 ? { ...item, mergedInto: 1 } : item,
    ),
  };
  assert.equal(
    applyTaskMutation(unresolvedLinked, "delete", { id: 1 }).op.kind,
    "error",
  );

  const immediatelySettled = applyTaskMutation(approved, "merge", {
    id: 1,
    duplicateId: 3,
  }).state;
  assert.equal(immediatelySettled.tasks[2].mergedInto, 1);
  assert.equal(immediatelySettled.tasks[2].status, "completed");
  assert.equal(immediatelySettled.tasks[2].review.status, "approved");
  assert.equal(immediatelySettled.tasks[2].result, "implemented once");

  const activeDuplicate = task(4, "pending", {
    metadata: {
      preparation: { status: "running", activeWorkerIds: ["prep-4"] },
    },
  });
  assert.equal(
    applyTaskMutation(
      { ...approved, tasks: [...approved.tasks, activeDuplicate], nextId: 5 },
      "merge",
      { id: 1, duplicateId: 4 },
    ).op.kind,
    "error",
  );

  const { isPersistableTaskState } = await import("./state/replay.ts");
  const graph = {
    tasks: [task(1), task(2, "pending", { mergedInto: 1 })],
    nextId: 3,
    revision: 1,
  };
  assert.equal(isPersistableTaskState(graph), true);
  assert.equal(
    isPersistableTaskState({
      ...graph,
      tasks: [task(1, "pending", { mergedInto: 1 })],
    }),
    false,
  );
  assert.equal(
    isPersistableTaskState({
      ...graph,
      tasks: [task(2, "pending", { mergedInto: 99 })],
    }),
    false,
  );
  assert.equal(
    isPersistableTaskState({
      ...graph,
      tasks: [
        task(1),
        task(2, "pending", { mergedInto: 1 }),
        task(3, "pending", { mergedInto: 2 }),
      ],
      nextId: 4,
    }),
    false,
  );
});

test("scheduler eligibility and TODO projections use canonical inbox labels", async () => {
  const { publicTodoState } = await import("./state/inbox.ts");
  const { isTaskActionable } = await import("./state/waits.ts");
  const preparing = task(1, "pending", {
    metadata: { preparation: { status: "running" } },
  });
  const ready = task(2, "pending", {
    metadata: { preparation: { status: "ready" } },
  });
  const failedPreparation = task(3, "pending", {
    metadata: { preparation: { status: "failed", code: "preparation_failed" } },
  });
  assert.equal(publicTodoState(preparing), "preparing");
  assert.equal(publicTodoState(ready), "ready");
  assert.equal(publicTodoState(failedPreparation), "failed");
  const interrupted = task(5, "in_progress", {
    metadata: {
      preparation: { status: "ready" },
      delegation: { status: "interrupted" },
    },
  });
  assert.equal(isTaskActionable(interrupted, [interrupted]), false);
  const genericFailure = task(4, "pending", {
    metadata: { preparation: { status: "failed", code: "target_invalid" } },
  });
  assert.equal(publicTodoState(genericFailure), "failed");
  assert.equal(isTaskActionable(genericFailure, [genericFailure]), false);
  assert.equal(
    isTaskActionable(preparing, [preparing, ready, failedPreparation]),
    false,
  );
  assert.equal(
    isTaskActionable(ready, [preparing, ready, failedPreparation]),
    true,
  );
  assert.equal(
    isTaskActionable(failedPreparation, [preparing, ready, failedPreparation]),
    true,
  );
  const { actionableContinuation } = await import("./scheduler.ts");
  assert.match(
    actionableContinuation({
      tasks: [failedPreparation],
      nextId: 4,
      revision: 1,
    }),
    /Do not continue implementation from guessed facts/,
  );
  const text = formatContent(
    { kind: "list", includeDeleted: false },
    { tasks: [preparing, ready, failedPreparation], nextId: 4, revision: 1 },
  );
  assert.match(text, /\[preparing\] #1/);
  assert.match(text, /\[ready\] #2/);
  assert.match(text, /\[failed\] #3/);
});

test("third unresolved executor/verifier exchange fails the item and leaves siblings independent", async () => {
  const { publicTodoState, recordVerificationExchange } =
    await import("./state/inbox.ts");
  const result = [1, 2, 3].reduce(
    (state) =>
      recordVerificationExchange(state, {
        decision: "needs-fix",
        finding: "missing evidence",
        evidence: ["check output"],
        rationale: "verifier finding",
      }),
    task(1, "in_progress"),
  );
  assert.equal(publicTodoState(result), "failed");
  assert.equal(result.metadata.verification.exchanges.length, 3);
});

test("parent challenge preserves finding, evidence, and rationale", async () => {
  const { challengeVerificationFinding } = await import("./state/inbox.ts");
  const result = challengeVerificationFinding(
    task(1, "in_progress", {
      metadata: {
        verification: {
          exchanges: [
            {
              decision: "needs-fix",
              finding: "too broad",
              evidence: ["focused test"],
              rationale: "review",
            },
          ],
        },
      },
    }),
    {
      decision: "skip",
      evidence: ["user explicitly requested this scope"],
      rationale: "prior user message",
    },
  );
  assert.equal(result.metadata.verification.exchanges[0].finding, "too broad");
  assert.deepEqual(result.metadata.verification.exchanges[0].evidence, [
    "focused test",
  ]);
  assert.equal(
    result.metadata.verification.challenge.rationale,
    "prior user message",
  );
  assert.equal(
    result.metadata.verification.challenge.priorUserMessage,
    undefined,
  );
});

test("failed prerequisites transitively fail dependents while independent branches remain queued", async () => {
  const { propagatePrerequisiteFailure, publicTodoState } =
    await import("./state/inbox.ts");
  const ready = (id, blockedBy) =>
    task(id, "pending", {
      ...(blockedBy ? { blockedBy } : {}),
      metadata: { preparation: { status: "ready" } },
    });
  const result = propagatePrerequisiteFailure([
    task(1, "pending", { metadata: { inbox: { lifecycle: "failed" } } }),
    ready(2, [1]),
    ready(3, [2]),
    ready(4),
  ]);
  assert.deepEqual(
    result
      .filter((item) => publicTodoState(item) === "failed")
      .map((item) => item.id),
    [1, 2, 3],
  );
  assert.equal(
    result.find((item) => item.id === 2).metadata.inbox.sourceFailureId,
    1,
  );
  assert.equal(
    result.find((item) => item.id === 3).metadata.inbox.sourceFailureId,
    1,
  );
  assert.match(
    formatContent(
      { kind: "get", task: result.find((item) => item.id === 3) },
      base(result),
    ),
    /failure: failed prerequisite #1/,
  );
  const { isPersistableTaskState } = await import("./state/replay.ts");
  assert.equal(isPersistableTaskState(base(result)), true);
  const withSource = (sourceFailureId) =>
    result.map((item) =>
      item.id === 3
        ? {
            ...item,
            metadata: {
              ...item.metadata,
              inbox: { ...item.metadata.inbox, sourceFailureId },
            },
          }
        : item,
    );
  assert.equal(isPersistableTaskState(base(withSource(99))), false);
  assert.equal(isPersistableTaskState(base(withSource(4))), false);
  const first = propagatePrerequisiteFailure([
    task(1),
    ready(2, [1, 5]),
    ready(3, [2]),
    task(5, "pending", { metadata: { inbox: { lifecycle: "failed" } } }),
  ]);
  assert.equal(
    first.find((item) => item.id === 2).metadata.inbox.sourceFailureId,
    5,
  );
  const second = propagatePrerequisiteFailure(
    first.map((item) =>
      item.id === 1
        ? { ...item, metadata: { inbox: { lifecycle: "failed" } } }
        : item,
    ),
  );
  assert.equal(
    second.find((item) => item.id === 2).metadata.inbox.sourceFailureId,
    5,
  );
  assert.equal(
    second.find((item) => item.id === 3).metadata.inbox.sourceFailureId,
    5,
  );
  assert.equal(publicTodoState(result.find((item) => item.id === 4)), "ready");
});

test("completion review drives verification, challenge, and automatic failure recovery", async () => {
  const {
    claimCompletionReview,
    failCompletionReview,
    settleCompletionReview,
  } = await import("./state/state-reducer.ts");
  const { publicTodoState } = await import("./state/inbox.ts");
  const { isCompletionReviewDispatchable } =
    await import("./state/completion.ts");
  const { recoverRejectedCompletionReviews } = await import("./state/waits.ts");
  const completed = applyTaskMutation(base([task(1)]), "update", {
    id: 1,
    status: "completed",
    result: "implemented",
    evidence: ["focused check passed"],
  }).state;
  const reviewIdentity = (state) => ({
    taskId: 1,
    generation: state.tasks[0].review.generation,
    token: state.tasks[0].review.token,
    completionRevision: state.tasks[0].review.completionRevision,
  });
  const identity = reviewIdentity(completed);
  const rejected = settleCompletionReview(
    claimCompletionReview(completed, identity),
    identity,
    {
      decision: "rejected",
      feedback: "missing target proof",
      reviewerId: "reviewer",
      model: "openai-codex/gpt-5.6-luna",
    },
  );
  assert.equal(
    rejected.tasks[0].metadata.verification.exchanges.at(-1).decision,
    "needs-fix",
  );
  const challenged = applyTaskMutation(rejected, "challenge", {
    id: 1,
    decision: "challenge",
    challengeEvidence: ["target proof is already in the completion evidence"],
    rationale: "the finding conflicts with the persisted evidence",
  });
  assert.equal(challenged.op.kind, "challenge");
  assert.equal(
    applyTaskMutation(challenged.state, "update", {
      id: 1,
      status: "completed",
      result: "implemented",
      evidence: ["focused check passed"],
    }).op.kind,
    "update",
  );

  let failed = completed;
  for (let attempt = 0; attempt < 3; attempt++) {
    const currentIdentity = reviewIdentity(failed);
    failed = failCompletionReview(
      claimCompletionReview(failed, currentIdentity),
      currentIdentity,
      "reviewer process exited",
      attempt + 1,
    );
  }
  assert.equal(publicTodoState(failed.tasks[0]), "failed");
  assert.equal(failed.tasks[0].status, "in_progress");
  assert.equal(failed.tasks[0].review.status, "rejected");
  assert.equal(failed.tasks[0].review.attempts, 3);
  assert.equal(failed.tasks[0].metadata.verification.state, "failed");
  assert.equal(failed.tasks[0].metadata.verification.recovery, "manual");
  assert.equal(failed.tasks[0].wait, undefined);
  assert.equal(
    isCompletionReviewDispatchable(failed.tasks[0], Number.MAX_SAFE_INTEGER),
    false,
  );
  assert.equal(recoverRejectedCompletionReviews(failed), failed);
  assert.match(
    failed.tasks[0].review.feedback,
    /Automatic completion-review retries exhausted/,
  );
});

test("completion review fails closed when its audit exchange cannot persist", async () => {
  const { claimCompletionReview, settleCompletionReview } =
    await import("./state/state-reducer.ts");
  const metadata = Object.fromEntries(
    Array.from({ length: 64 }, (_, index) => [`key-${index}`, index]),
  );
  const state = {
    tasks: [
      task(1, "completed", {
        result: "implemented",
        evidence: ["check passed"],
        metadata,
        review: {
          status: "pending",
          generation: 1,
          token: "review-token",
          completionRevision: 1,
          requestedAt: 1,
          reviewer: { id: "reviewer", model: "model" },
        },
      }),
    ],
    nextId: 2,
    revision: 1,
  };
  const identity = {
    taskId: 1,
    generation: 1,
    token: "review-token",
    completionRevision: 1,
  };
  const settled = settleCompletionReview(
    claimCompletionReview(state, identity),
    identity,
    {
      decision: "approved",
      feedback: "looks correct",
      reviewerId: "reviewer",
      model: "model",
    },
  );
  assert.equal(settled.tasks[0].review.status, "pending");
  assert.match(settled.tasks[0].review.feedback, /audit exchange/);
});

test("production mutation and replay propagate prerequisite failure", async () => {
  const { publicTodoState } = await import("./state/inbox.ts");
  const failed = task(1, "pending", {
    metadata: { inbox: { lifecycle: "failed" } },
  });
  const dependent = task(2, "pending", { blockedBy: [1] });
  const independent = task(3);
  const state = {
    tasks: [failed, dependent, independent],
    nextId: 4,
    revision: 1,
  };
  const mutated = applyTaskMutation(state, "update", {
    id: 3,
    activeForm: "continuing independent work",
  }).state;
  assert.equal(publicTodoState(mutated.tasks[1]), "failed");

  const { createTodoSnapshot, replayFromBranch, TODO_SNAPSHOT_TYPE } =
    await import("./state/replay.ts");
  const replayed = replayFromBranch({
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: TODO_SNAPSHOT_TYPE,
          data: createTodoSnapshot(state),
        },
      ],
    },
  });
  assert.equal(publicTodoState(replayed.tasks[1]), "failed");
  assert.equal(replayed.revision, 2);

  const { isPersistableTaskState, pruneTodoStateForPersistence } =
    await import("./state/replay.ts");
  const incomplete = {
    tasks: [task(4, "completed")],
    nextId: 5,
    revision: 3,
  };
  assert.equal(isPersistableTaskState(incomplete), true);
  assert.equal(
    pruneTodoStateForPersistence(incomplete).tasks[0].status,
    "pending",
  );
  const historical = createTodoSnapshot({
    tasks: [
      task(4, "completed", {
        result: "legacy result",
        evidence: ["legacy evidence"],
      }),
    ],
    nextId: 5,
    revision: 3,
  });
  delete historical.tasks[0].result;
  delete historical.tasks[0].evidence;
  const recovered = replayFromBranch({
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: TODO_SNAPSHOT_TYPE,
          data: historical,
        },
      ],
    },
  });
  assert.equal(recovered.tasks[0].status, "pending");
  assert.equal(recovered.tasks[0].review, undefined);
});

test("archiving requires canonical completion evidence", async () => {
  const { isTaskArchivable } = await import("./state/completion.ts");
  assert.equal(
    isTaskArchivable(task(1, "completed", { review: { status: "approved" } })),
    false,
  );
  assert.equal(
    isTaskArchivable(
      task(1, "completed", {
        result: "done",
        evidence: ["check passed"],
      }),
    ),
    false,
  );
  assert.equal(
    isTaskArchivable(
      task(1, "completed", {
        result: "done",
        evidence: ["check passed"],
        review: { status: "approved" },
        metadata: { inbox: { lifecycle: "failed" } },
      }),
    ),
    false,
  );
  assert.equal(
    isTaskArchivable(
      task(2, "completed", {
        result: "done",
        evidence: ["check passed"],
        review: { status: "approved" },
        metadata: {
          preparation: {
            status: "running",
            activeWorkerIds: ["preparation-worker"],
          },
        },
      }),
    ),
    false,
  );
  const completed = task(3, "completed", {
    result: "done",
    evidence: ["check passed"],
    review: { status: "approved" },
    metadata: { preparation: { status: "cancelled", activeWorkerIds: [] } },
  });
  assert.equal(
    isTaskArchivable(completed, { hasCancellationIntent: true }),
    false,
  );
  assert.equal(
    applyTaskMutation(
      {
        tasks: [completed],
        nextId: 4,
        revision: 1,
        cancellationIntents: [
          {
            kind: "preparation",
            taskId: 3,
            token: "preparation-token",
            ids: ["preparation-worker"],
            generation: 1,
            attempts: 0,
          },
        ],
      },
      "clear",
      {},
    ).op.kind,
    "error",
  );
});

test("internal verification failure recovers automatically without Retry/Revise", async () => {
  const { publicTodoState, recoverInternalVerificationFailure } =
    await import("./state/inbox.ts");
  const result = recoverInternalVerificationFailure(
    task(1, "waiting:user", {
      wait: { kind: "user", questions: ["Retry review?"] },
      review: {
        status: "pending",
        generation: 1,
        token: "review-1",
        completionRevision: 1,
        requestedAt: 1,
        reviewer: { id: "reviewer", model: "model" },
      },
    }),
    "reviewer process exited",
  );
  assert.equal(publicTodoState(result), "failed");
  assert.equal(result.status, "in_progress");
  assert.equal(result.wait, undefined);
  assert.equal(result.metadata.verification.state, "failed");
  assert.equal(result.metadata.verification.recovery, "manual");
  assert.equal(result.metadata.verification.prompt, undefined);
  assert.match(
    result.metadata.verification.retryPolicy,
    /Automatic completion-review retries exhausted/,
  );
});

test("the in-place refactor exposes one authoritative TODO store", async () => {
  const { authoritativeTodoStore } = await import("./state/inbox.ts");
  assert.equal(authoritativeTodoStore.getState, getState);
  assert.equal(authoritativeTodoStore.replaceState, replaceState);
});
