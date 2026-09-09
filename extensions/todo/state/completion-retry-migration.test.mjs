import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import {
  isCompletionReviewDispatchable,
  isTaskArchivable,
  nextCompletionReviewRetryAt,
} from "./completion.ts";
import { applyTaskMutation } from "./state-reducer.ts";
import { replayFromBranch } from "./replay.ts";

const legacyTask = (extra = {}) => ({
  id: 1,
  subject: "legacy completion",
  status: "completed",
  result: "done",
  evidence: ["verified"],
  ...extra,
});

const digestFor = (task) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        task.subject,
        task.description ?? null,
        task.result ?? null,
        task.evidence ?? null,
        null,
      ]),
    )
    .digest("hex");

const replay = (task) =>
  replayFromBranch({
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          message: {
            role: "toolResult",
            toolName: "todo",
            details: { tasks: [task], nextId: 2, revision: 1 },
          },
        },
      ],
    },
  });

describe("completion retry and legacy migration", () => {
  it("does not schedule owner-blocked failed reviews", () => {
    const state = applyTaskMutation(
      {
        tasks: [legacyTask({ status: "in_progress" })],
        nextId: 2,
        revision: 1,
      },
      "update",
      { id: 1, status: "completed", result: "done", evidence: ["verified"] },
      100,
      () => "review-token",
    ).state;
    const task = {
      ...state.tasks[0],
      metadata: { preparation: { status: "running" } },
      review: { ...state.tasks[0].review, failedAt: 0, attempts: 1 },
    };
    assert.equal(isCompletionReviewDispatchable(task, 100_000), false);
    assert.equal(nextCompletionReviewRetryAt([task]), undefined);
    const available = { ...task, metadata: undefined };
    assert.equal(nextCompletionReviewRetryAt([available]), 30_000);
    assert.equal(
      nextCompletionReviewRetryAt([available], new Set([1])),
      undefined,
    );
  });

  it("migrates valid legacy completion to durable pending review with digest", () => {
    const task = legacyTask({
      metadata: {
        preparation: { status: "running", activeWorkerIds: ["worker"] },
      },
    });
    const migrated = replay(task).tasks[0];
    assert.equal(migrated.status, "completed");
    assert.equal(migrated.review.status, "pending");
    assert.equal(migrated.review.token, "legacy-completion-1");
    assert.equal(migrated.review.inputDigest, digestFor(task));
    assert.equal(isCompletionReviewDispatchable(migrated), false);
    assert.equal(isTaskArchivable(migrated), false);
    assert.equal(
      isCompletionReviewDispatchable({ ...migrated, metadata: undefined }),
      true,
    );
  });

  it("keeps ambiguous delegation IDs blocked but ignores terminal audit IDs", () => {
    for (const field of ["subagentId", "subagentIds", "workerIds"]) {
      for (const status of [undefined, "settled", "cancelled"]) {
        const delegation = {
          ...(status === undefined ? {} : { status }),
          [field]: field === "subagentId" ? "legacy-worker" : ["legacy-worker"],
        };
        const migrated = replay(legacyTask({ metadata: { delegation } }))
          .tasks[0];
        const blocked = status === undefined;

        assert.equal(migrated.status, "completed");
        assert.equal(migrated.review.status, "pending");
        assert.equal(isCompletionReviewDispatchable(migrated), !blocked);
        assert.equal(
          nextCompletionReviewRetryAt([
            {
              ...migrated,
              review: { ...migrated.review, failedAt: 0, attempts: 1 },
            },
          ]),
          blocked ? undefined : 30_000,
        );
        assert.equal(isTaskArchivable(migrated), false);
        assert.equal(
          isTaskArchivable({
            ...migrated,
            review: { ...migrated.review, status: "approved" },
          }),
          !blocked,
        );
      }
    }
  });
});
