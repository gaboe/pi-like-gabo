import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  COMPLETION_REVIEW_MODEL,
  isCompletionReviewDispatchable,
  isObsoleteCompletionReviewerFailure,
  resolveCompletionReviewModel,
} from "./completion.ts";
import { publicTodoState } from "./inbox.ts";
import { isPersistableTaskState } from "./replay.ts";
import {
  applyTaskMutation,
  claimCompletionReview,
  failCompletionReview,
  settleCompletionReview,
} from "./state-reducer.ts";
import { recoverRejectedCompletionReviews } from "./waits.ts";

function completedState() {
  return applyTaskMutation(
    {
      tasks: [{ id: 1, subject: "review me", status: "in_progress" }],
      nextId: 2,
      revision: 1,
    },
    "update",
    { id: 1, status: "completed", result: "done", evidence: ["test"] },
    1,
    () => "token",
  ).state;
}

function exhaust(feedback) {
  let state = completedState();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const review = state.tasks[0].review;
    const identity = {
      taskId: 1,
      generation: review.generation,
      token: review.token,
      completionRevision: review.completionRevision,
    };
    state = failCompletionReview(
      claimCompletionReview(state, identity, attempt * 10),
      identity,
      feedback,
      attempt * 10 + 1,
    );
  }
  return state;
}

describe("completion operational exhaustion", () => {
  it("falls back when a regressed reviewer selector is unsupported", () => {
    assert.equal(
      resolveCompletionReviewModel("openai-codex/gpt-5.3-codex-spark"),
      COMPLETION_REVIEW_MODEL,
    );
    assert.equal(
      resolveCompletionReviewModel("openai-codex/gpt-5.6-sol"),
      "openai-codex/gpt-5.6-sol",
    );
  });

  for (const failure of [
    "reviewer process crashed",
    "reviewer returned malformed decision JSON",
    "snapshot changed during final validation",
  ]) {
    it(`persists ${failure} as failed without a modal or automatic replay`, () => {
      const state = exhaust(failure);
      const task = state.tasks[0];
      assert.equal(task.status, "in_progress");
      assert.equal(publicTodoState(task), "failed");
      assert.equal(task.wait, undefined);
      assert.equal(task.review.status, "rejected");
      assert.equal(task.review.attempts, 3);
      assert.match(task.review.feedback, new RegExp(failure));
      assert.match(
        task.review.feedback,
        /Automatic completion-review retries exhausted/,
      );
      assert.equal(
        isCompletionReviewDispatchable(task, Number.MAX_SAFE_INTEGER),
        false,
      );
      assert.equal(recoverRejectedCompletionReviews(state), state);
    });
  }

  it("retries the smallest persisted unsupported-model failure after reload", () => {
    const failed = {
      tasks: [
        {
          id: 1,
          subject: "review me",
          status: "in_progress",
          result: "done",
          evidence: ["test"],
          metadata: { verification: { state: "failed" } },
          review: {
            status: "rejected",
            generation: 4,
            token: "review-token",
            completionRevision: 2,
            requestedAt: 1,
            failedAt: 2,
            attempts: 3,
            reviewer: {
              id: "background-subagent",
              model: "openai-codex/gpt-5.3-codex-spark",
            },
            feedback:
              "Codex error: old model is not supported with this account",
          },
        },
        {
          id: 2,
          subject: "blocked dependent",
          status: "pending",
          blockedBy: [1],
          metadata: {
            inbox: {
              lifecycle: "failed",
              reason: "failed prerequisite",
              sourceFailureId: 1,
            },
          },
        },
      ],
      nextId: 3,
      revision: 4,
    };
    assert.equal(isObsoleteCompletionReviewerFailure(failed.tasks[0]), true);

    const recovered = recoverRejectedCompletionReviews(failed);
    const task = recovered.tasks[0];
    assert.equal(task.status, "completed");
    assert.equal(task.review.status, "pending");
    assert.equal(task.review.attempts, 0);
    assert.equal(task.review.reviewer.model, COMPLETION_REVIEW_MODEL);
    assert.equal(task.review.feedback, undefined);
    assert.equal(task.metadata?.verification, undefined);
    assert.equal(isCompletionReviewDispatchable(task), true);
    assert.equal(recovered.tasks[1].metadata, undefined);
    assert.equal(isPersistableTaskState(recovered), true);
  });

  it("requires explicit changed-evidence recompletion to recover", () => {
    const exhausted = exhaust("reviewer process crashed");
    assert.match(
      applyTaskMutation(exhausted, "update", {
        id: 1,
        status: "completed",
        result: "done",
        evidence: ["test"],
      }).op.message,
      /unchanged since review rejection/,
    );
    const recovered = applyTaskMutation(exhausted, "update", {
      id: 1,
      status: "completed",
      result: "done",
      evidence: ["test", "remediated"],
    });
    assert.equal(recovered.op.kind, "update");
    assert.equal(recovered.state.tasks[0].metadata?.verification, undefined);
    assert.equal(recovered.state.tasks[0].review.status, "pending");
    assert.equal(publicTodoState(recovered.state.tasks[0]), "verifying");
  });

  it("keeps semantic rejection out of operational failure state", () => {
    const state = completedState();
    const review = state.tasks[0].review;
    const rejected = settleCompletionReview(
      claimCompletionReview(state, {
        taskId: 1,
        generation: review.generation,
        token: review.token,
        completionRevision: review.completionRevision,
      }),
      {
        taskId: 1,
        generation: review.generation,
        token: review.token,
        completionRevision: review.completionRevision,
      },
      { decision: "rejected", feedback: "missing test" },
    );
    assert.equal(rejected.tasks[0].review.status, "rejected");
    assert.equal(rejected.tasks[0].metadata?.verification?.state, "active");
    assert.notEqual(publicTodoState(rejected.tasks[0]), "failed");
  });
});
