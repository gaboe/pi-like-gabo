import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTodoReorder,
  createTodoReorderSnapshot,
  parseTodoReorder,
} from "./reorder.ts";

const task = (id, status = "pending", blockedBy) => ({
  id,
  subject: `task ${id}`,
  status,
  blockedBy,
});

test("reorder starts with three open tasks and moves pending tasks only", () => {
  const state = {
    tasks: [task(1, "in_progress"), task(2), task(3)],
    nextId: 4,
    revision: 7,
  };
  const snapshot = createTodoReorderSnapshot(state);
  assert.deepEqual(snapshot, { revision: 7, candidateIds: [2, 3] });
  const reordered = applyTodoReorder(state, snapshot, [3, 2]);
  assert.deepEqual(
    reordered.tasks.map(({ id }) => id),
    [1, 3, 2],
  );
  assert.equal(reordered.revision, 8);
  assert.equal(
    createTodoReorderSnapshot({ ...state, tasks: state.tasks.slice(0, 2) }),
    undefined,
  );
});

test("reorder rejects stale, incomplete, duplicate, and dependency-breaking proposals", () => {
  const state = {
    tasks: [task(1, "in_progress"), task(2), task(3, "pending", [2])],
    nextId: 4,
    revision: 4,
  };
  const snapshot = createTodoReorderSnapshot(state);
  assert.ok(snapshot);
  assert.equal(
    applyTodoReorder({ ...state, revision: 5 }, snapshot, [2, 3]).revision,
    5,
  );
  assert.equal(applyTodoReorder(state, snapshot, [3, 2]), state);
  assert.equal(applyTodoReorder(state, snapshot, [2]), state);
  assert.equal(applyTodoReorder(state, snapshot, [2, 2]), state);
});

test("Luna output must be an exact candidate permutation", () => {
  assert.deepEqual(parseTodoReorder('{"order":[3,2]}', [2, 3]), [3, 2]);
  assert.equal(parseTodoReorder('{"order":[3,3]}', [2, 3]), undefined);
  assert.equal(parseTodoReorder('{"order":[3,2,4]}', [2, 3]), undefined);
  assert.equal(parseTodoReorder("not json", [2, 3]), undefined);
});
