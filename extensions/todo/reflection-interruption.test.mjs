import assert from "node:assert/strict";
import test from "node:test";
import { interruptsTodoAutomation } from "./index.ts";
import { yieldInProgressTasks } from "./scheduler.ts";
import {
  createTodoSnapshot,
  replayFromBranch,
  TODO_SNAPSHOT_TYPE,
} from "./state/replay.ts";
import { formatContent } from "./tool/response-envelope.ts";

test("pi-like-gabo-reflect input interrupts TODO automation", () => {
  for (const text of [
    "/skill:pi-like-gabo-reflect",
    "$pi-like-gabo-reflect",
    '<skill name="pi-like-gabo-reflect" location="/tmp/SKILL.md">',
  ]) {
    assert.equal(interruptsTodoAutomation(text), true);
  }
  assert.equal(interruptsTodoAutomation("continue TODO #7"), false);
});

test("reflection yields the active TODO without changing other states", () => {
  const state = {
    tasks: [
      { id: 7, subject: "Old work", status: "in_progress" },
      { id: 8, subject: "Queued", status: "pending" },
    ],
    nextId: 9,
    revision: 4,
  };
  const yielded = yieldInProgressTasks(state);
  assert.equal(yielded.tasks[0].status, "pending");
  assert.equal(yielded.tasks[1], state.tasks[1]);
  assert.equal(yielded.revision, 5);

  const snapshot = createTodoSnapshot(yielded);
  const replayed = replayFromBranch({
    sessionManager: {
      getBranch: () => [
        { type: "custom", customType: TODO_SNAPSHOT_TYPE, data: snapshot },
      ],
    },
  });
  assert.equal(replayed.tasks[0].status, "pending");
  assert.equal(replayed.tasks[1].status, "pending");
});

test("completion submission stays visibly under review", () => {
  const state = {
    tasks: [
      {
        id: 7,
        subject: "Verify contracts",
        status: "completed",
        review: { status: "pending" },
      },
    ],
    nextId: 8,
    revision: 1,
  };
  assert.equal(
    formatContent(
      { kind: "update", id: 7, fromStatus: "in_progress", toStatus: "completed" },
      state,
    ),
    "Submitted #7 completion evidence for independent review",
  );
});
