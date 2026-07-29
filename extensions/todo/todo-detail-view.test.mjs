import assert from "node:assert/strict";
import test from "node:test";
import {
  TodoDetailView,
  showTodoDetailView,
} from "./todo-detail-view.ts";
import { __resetState, commitState } from "./state/store.ts";

const theme = new Proxy({}, {
  get: (_target, key) =>
    key === "bold"
      ? (text) => text
      : key === "fg"
        ? (_color, text) => text
        : undefined,
});

const preparedTask = {
  id: 7,
  subject: "Fix scheduler",
  description: "Raw user request",
  status: "pending",
  metadata: {
    preparation: {
      status: "ready",
      summary: "Prepared analysis",
      analysisCwd: "/repo/plugin",
      affectedPaths: ["extensions/todo/todo.ts"],
      steps: ["Add overlay"],
      questions: ["Keep raw input?"],
      risks: ["Stale state"],
    },
  },
};

test("detail view renders raw request and prepared analysis", () => {
  let result;
  const view = new TodoDetailView(
    { requestRender() {}, terminal: { rows: 24 } },
    theme,
    () => [preparedTask],
    (value) => {
      result = value;
    },
  );
  const firstPage = view.render(90);
  const output = firstPage.join("\n");
  assert.ok(firstPage.length <= 24);
  assert.match(output, /#7 Fix scheduler/);
  assert.match(output, /Raw user request/);
  assert.match(output, /enter\/e edit via prompt/);

  view.handleInput("\x1b[6~");
  const secondPage = view.render(90).join("\n");
  assert.match(secondPage, /Prepared analysis/);
  assert.match(secondPage, /extensions\/todo\/todo\.ts/);
  view.handleInput("e");
  assert.deepEqual(result, { action: "edit", id: 7 });
});

test("navigation stays bounded and stale deleted tasks cannot be edited", () => {
  let tasks = [preparedTask, { ...preparedTask, id: 8, subject: "Second" }];
  const results = [];
  const view = new TodoDetailView(
    { requestRender() {}, terminal: { rows: 24 } },
    theme,
    () => tasks,
    (value) => results.push(value),
  );
  view.handleInput("\x1b[B");
  view.handleInput("\x1b[B");
  assert.match(view.render(70).join("\n"), /#8 Second/);

  tasks = tasks.map((task) => ({ ...task, status: "deleted" }));
  view.handleInput("e");
  assert.deepEqual(results, []);
  assert.match(view.render(70).join("\n"), /No visible TODOs/);

  view.handleInput("a");
  assert.deepEqual(results, [{ action: "add" }]);
});

test("edit action closes the full view and seeds the main editor prompt", async () => {
  __resetState();
  commitState({ tasks: [preparedTask], nextId: 8, revision: 1 });
  let editorText = "";
  await showTodoDetailView({
    ui: {
      async custom(factory, options) {
        assert.equal(options, undefined);
        factory(
          { requestRender() {}, terminal: { rows: 24 } },
          theme,
          {},
          () => {},
        );
        return { action: "edit", id: 7 };
      },
      setEditorText(value) {
        editorText = value;
      },
    },
  });
  assert.match(editorText, /Update TODO #7/);
  assert.match(editorText, /Raw user request/);
});
