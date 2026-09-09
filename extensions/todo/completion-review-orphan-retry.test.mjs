import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerBackgroundSubagentService } from "../../vendor/pi-tools/extensions/shared/background-subagent-protocol.ts";
import { resolveTodoExecutionTarget } from "./enrichment.ts";
import { JobsAdapter } from "./jobs-adapter.ts";
import { TodoScheduler } from "./scheduler.ts";
import { completionReviewRetryDelayMs } from "./state/completion.ts";
import { applyTaskMutation } from "./state/state-reducer.ts";
import { __resetState, commitState, getState } from "./state/store.ts";
import { formatContent } from "./tool/response-envelope.ts";

class Bus {
  handlers = new Map();

  on(channel, handler) {
    const handlers = this.handlers.get(channel) ?? new Set();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => handlers.delete(handler);
  }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("idle scheduler redispatches a verifying review with no active owner", async () => {
  __resetState();
  const reviewRoot = await mkdtemp(join(tmpdir(), "todo-review-orphan-"));
  execFileSync("git", ["init", "-q"], { cwd: reviewRoot });
  const target = resolveTodoExecutionTarget(reviewRoot);
  assert.ok(target);
  const completed = applyTaskMutation(
    {
      tasks: [
        {
          id: 1,
          subject: "Verify research",
          status: "pending",
          metadata: {
            preparation: {
              status: "ready",
              version: 1,
              token: "prepared-review",
              sourceRevision: 1,
              analysisCwd: target.path,
              analysisCwdIdentity: target.identity,
              reviewClassification: {
                version: 1,
                source: "host",
                kind: "research",
                mutatesWorkspace: false,
              },
            },
          },
        },
      ],
      nextId: 2,
      revision: 1,
    },
    "update",
    { id: 1, status: "completed", result: "done", evidence: ["verified"] },
  ).state;
  commitState(completed);

  let calls = 0;
  const unregister = registerBackgroundSubagentService({
    async run(request) {
      calls++;
      request.onSpawn?.(`reviewer-${calls}`);
      if (calls === 1) throw new Error("reviewer stdout maxBuffer exceeded");
      return {
        id: `reviewer-${calls}`,
        status: "done",
        output: '{"decision":"approved","feedback":"verified on retry"}',
      };
    },
  });
  const adapter = new JobsAdapter(new Bus());
  const scheduler = new TodoScheduler(
    { appendEntry() {}, sendMessage() {} },
    adapter,
    () => {},
  );

  try {
    scheduler.activate({
      cwd: reviewRoot,
      isProjectTrusted: () => true,
      modelRegistry: {},
    });
    await waitFor(() => getState().tasks[0].review?.attempts === 1, 5_000);
    const orphan = getState().tasks[0];
    assert.equal(orphan.status, "completed");
    assert.equal(orphan.review.status, "pending");
    assert.equal(orphan.review.dispatchedAt, undefined);
    assert.match(
      formatContent({ kind: "list", includeDeleted: false }, getState()),
      /\[verifying\]/,
    );

    await waitFor(() => calls === 2, completionReviewRetryDelayMs(1) + 15_000);
    await waitFor(
      () => getState().tasks[0].review?.status === "approved",
      10_000,
    );
    assert.equal(calls, 2);
    const approved = getState().tasks[0].review;
    assert.equal(approved.feedback, "verified on retry");
    assert.equal(approved.reviewer.id, "reviewer-2");
  } finally {
    scheduler.dispose();
    adapter.dispose();
    unregister();
    await rm(reviewRoot, { recursive: true, force: true });
  }
});
