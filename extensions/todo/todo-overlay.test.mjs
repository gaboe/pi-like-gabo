import assert from "node:assert/strict";
import test from "node:test";
import { replaceState, getState } from "./state/store.ts";
import {
  CANCELLATION_CAPACITY_ERROR,
  CANCELLATION_QUARANTINE_ERROR,
} from "./state/state.ts";
import { TodoOverlay } from "./todo-overlay.ts";
import { DEFAULT_PROMPT_GUIDELINES } from "./todo.ts";
import {
  completionReviewFooterStatus,
  formatCommandTaskLine,
  formatOverlayTaskLine,
  renderTodoCall,
  renderTodoResult,
} from "./view/format.ts";

const theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
  strikethrough: (text) => text,
};

test("TODO guidance requires full-plan decomposition and safe parallel execution", () => {
  assert.ok(
    DEFAULT_PROMPT_GUIDELINES.some(
      (line) =>
        line.includes("whole known execution plan into separate TODOs") &&
        line.includes("current execution scope, not a roadmap") &&
        line.includes("delete superseded pending TODOs"),
    ),
  );
  assert.ok(
    DEFAULT_PROMPT_GUIDELINES.some(
      (line) =>
        line.includes("start every safe independent unit") &&
        line.includes("Same feature, PR, or stack is not itself a conflict"),
    ),
  );
  assert.ok(
    DEFAULT_PROMPT_GUIDELINES.some((line) =>
      line.includes("preparation is not a per-TODO permission gate"),
    ),
  );
});

test("completion review footer distinguishes queued and dispatched reviewers", () => {
  const review = (id, dispatchedAt) => ({
    id,
    subject: `Task ${id}`,
    status: "completed",
    review: {
      status: "pending",
      generation: 1,
      token: `review-${id}`,
      completionRevision: id,
      requestedAt: 1,
      ...(dispatchedAt === undefined ? {} : { dispatchedAt }),
      reviewer: { id: "reviewer", model: "luna" },
    },
  });
  assert.equal(
    completionReviewFooterStatus([review(1)]),
    "completion review queued: #1",
  );
  assert.equal(
    completionReviewFooterStatus([
      review(1, 1),
      review(2, 1),
      review(3, 1),
      review(4, 1),
    ]),
    "completion review: #1, #2, #3 +1",
  );
});

test("TODO preparation renders as active work without changing driver status", () => {
  const task = {
    id: 7,
    subject: "Prepare task details",
    status: "pending",
    metadata: {
      preparation: {
        status: "running",
        progress: "inspecting repository",
      },
    },
  };
  assert.equal(
    formatOverlayTaskLine(task, theme, true),
    "◐ #7 Prepare task details (preparing: inspecting repository)",
  );
  assert.equal(
    formatCommandTaskLine(task, "○"),
    "  ◐ #7 Prepare task details (preparing: inspecting repository)",
  );
});

test("TODO rows surface cancellation retry and re-arm state", () => {
  for (const [metadata, expected] of [
    [
      {
        delegation: {
          status: "cancelling",
          subagentIds: ["hidden"],
          cancellationAttempts: 0,
        },
      },
      "cancelling workers",
    ],
    [
      {
        delegation: {
          status: "cancelling",
          cancellationAttempts: 1,
          cancellationError: "temporary",
        },
      },
      "cancellation failed · retry pending",
    ],
    [
      {
        delegation: {
          status: "cancelling",
          cancellationAttempts: 3,
          cancellationError: "permanent",
        },
      },
      "cancellation exhausted · re-arm required",
    ],
  ]) {
    const task = {
      id: 7,
      subject: "Cancel worker",
      status: "in_progress",
      metadata,
    };
    assert.match(
      formatOverlayTaskLine(task, theme, true),
      new RegExp(expected.replace(/[·]/g, "\\·")),
    );
    assert.match(
      formatCommandTaskLine(task, "◐"),
      new RegExp(expected.replace(/[·]/g, "\\·")),
    );
  }
});

test("TODO rows surface preparation cancellation exhaustion without identities", () => {
  const task = { id: 8, subject: "Cancel preparation", status: "completed" };
  for (const [attempts, error, expected] of [
    [0, undefined, "cancelling preparation"],
    [1, "private failure", "preparation cancellation failed · retry pending"],
    [
      3,
      "private failure",
      "preparation cancellation exhausted · re-arm required",
    ],
  ]) {
    const intent = {
      kind: "preparation",
      taskId: 8,
      token: "hidden-token",
      workerGeneration: 1,
      ids: ["hidden-worker"],
      generation: 1,
      attempts,
      ...(error ? { error } : {}),
    };
    assert.match(
      formatOverlayTaskLine(task, theme, true, [intent]),
      new RegExp(expected),
    );
    assert.match(
      formatCommandTaskLine(task, "●", [intent]),
      new RegExp(expected),
    );
  }
  assert.doesNotMatch(
    formatOverlayTaskLine(task, theme, true, [
      {
        kind: "preparation",
        taskId: 8,
        token: "hidden-token",
        workerGeneration: 1,
        ids: ["hidden-worker"],
        generation: 1,
        attempts: 3,
        error: "private failure",
      },
    ]),
    /hidden-token|hidden-worker|private failure/,
  );
});

test("TODO overlay renders overflow-only cancellation recovery", () => {
  let widget;
  const overlay = new TodoOverlay();
  overlay.setUICtx({
    setWidget(_key, content) {
      widget = content;
    },
  });
  replaceState({
    tasks: [{ id: 9, subject: "overflow cancellation", status: "pending" }],
    nextId: 10,
    revision: 1,
    cancellationOverflow: [
      {
        kind: "preparation",
        taskId: 9,
        token: "hidden-token",
        workerGeneration: 1,
        ids: ["hidden-worker"],
        generation: 1,
        attempts: 1,
        error: "private failure",
      },
    ],
  });
  overlay.update();
  assert.match(
    widget({ requestRender() {} }, theme)
      .render(120)
      .join("\n"),
    /preparation cancellation failed · retry pending/,
  );
  overlay.dispose();
});

test("TODO overlay and command formatting render quarantine-only cancellation recovery", () => {
  let widget;
  const overlay = new TodoOverlay();
  overlay.setUICtx({
    setWidget(_key, content) {
      widget = content;
    },
  });
  const task = {
    id: 10,
    subject: "quarantine cancellation",
    status: "pending",
  };
  const intent = {
    kind: "preparation",
    taskId: 10,
    token: "hidden-token",
    workerGeneration: 1,
    ids: ["hidden-worker"],
    generation: 1,
    attempts: 3,
    error: "private failure",
  };
  replaceState({
    tasks: [task],
    nextId: 11,
    revision: 1,
    cancellationQuarantine: [intent],
    cancellationCapacityError: CANCELLATION_QUARANTINE_ERROR,
  });
  overlay.update();
  assert.match(
    widget({ requestRender() {} }, theme)
      .render(120)
      .join("\n"),
    /preparation cancellation exhausted · re-arm required/,
  );
  assert.match(
    formatCommandTaskLine(task, "●", [intent]),
    /preparation cancellation exhausted · re-arm required/,
  );
  assert.match(
    widget({ requestRender() {} }, theme)
      .render(120)
      .join("\n"),
    /cancellation recovery quarantined/,
  );
  overlay.dispose();
});

test("TODO overlay renders identity-free capacity warning with no visible tasks", () => {
  let widget;
  const overlay = new TodoOverlay();
  overlay.setUICtx({
    setWidget(_key, content) {
      widget = content;
    },
  });
  replaceState({
    tasks: [],
    nextId: 1,
    revision: 1,
    cancellationCapacityError: CANCELLATION_CAPACITY_ERROR,
  });
  overlay.update();
  const rendered = widget({ requestRender() {} }, theme)
    .render(120)
    .join("\n");
  assert.match(rendered, /cancellation recovery capacity full/);
  assert.doesNotMatch(rendered, /private capacity detail|worker|token/);

  replaceState({ tasks: [], nextId: 1, revision: 2 });
  overlay.update();
  assert.equal(widget, undefined);
  overlay.dispose();
});

test("TODO overlay budgets the capacity warning with a full task layout", () => {
  let widget;
  const overlay = new TodoOverlay();
  overlay.setUICtx({
    setWidget(_key, content) {
      widget = content;
    },
  });
  replaceState({
    tasks: Array.from({ length: 24 }, (_, id) => ({
      id: id + 1,
      subject: `task ${id + 1}`,
      status: "pending",
    })),
    nextId: 25,
    revision: 1,
    cancellationCapacityError: CANCELLATION_CAPACITY_ERROR,
  });
  overlay.update();
  const lines = widget({ requestRender() {} }, theme).render(120);
  assert.ok(lines.length <= 13);
  assert.ok(lines.filter((line) => line).length <= 12);
  assert.match(lines.join("\n"), /cancellation recovery capacity full/);
  overlay.dispose();
});

test("TODO hygiene hides completed tasks while retaining audit state", () => {
  let widget;
  const ui = {
    setWidget(_key, content) {
      widget = content;
    },
  };
  const overlay = new TodoOverlay();
  overlay.setUICtx(ui);
  replaceState({
    tasks: [
      {
        id: 1,
        subject: "done",
        status: "completed",
        result: "done",
        evidence: ["verified"],
        review: {
          status: "approved",
          generation: 1,
          token: "approved-review-1",
          completionRevision: 1,
          requestedAt: 1,
          reviewedAt: 2,
          reviewer: { id: "reviewer", model: "model" },
        },
      },
    ],
    nextId: 2,
    revision: 1,
  });
  overlay.hideAllCompletedTasks();
  assert.equal(widget, undefined);
  assert.equal(getState().tasks[0].status, "completed");

  replaceState({
    tasks: [
      {
        id: 1,
        subject: "done",
        status: "completed",
        result: "done",
        evidence: ["verified"],
        review: {
          status: "approved",
          generation: 1,
          token: "approved-review-1",
          completionRevision: 1,
          requestedAt: 1,
          reviewedAt: 2,
          reviewer: { id: "reviewer", model: "model" },
        },
      },
      { id: 2, subject: "next", status: "pending" },
    ],
    nextId: 3,
    revision: 2,
  });
  overlay.update();
  assert.equal(typeof widget, "function");
  const component = widget({ requestRender() {} }, theme);
  const lines = component.render(120);
  assert.match(lines.join("\n"), /Todos \(0\/1\)/);
  assert.match(lines.join("\n"), /next/);
  assert.doesNotMatch(lines.join("\n"), /done/);
  overlay.dispose();
});

test("TODO overlay keeps completion visible until independent review approves it", () => {
  let widget;
  const overlay = new TodoOverlay();
  overlay.setUICtx({
    setWidget(_key, content) {
      widget = content;
    },
  });
  replaceState({
    tasks: [
      {
        id: 1,
        subject: "await review",
        status: "completed",
        result: "done",
        evidence: ["verified"],
        review: {
          status: "pending",
          generation: 1,
          token: "review-token",
          completionRevision: 1,
          requestedAt: 1,
          reviewer: { id: "reviewer", model: "model" },
        },
      },
    ],
    nextId: 2,
    revision: 1,
  });
  overlay.hideAllCompletedTasks();
  assert.equal(typeof widget, "function");
  const component = widget({ requestRender() {} }, theme);
  assert.match(
    component.render(120).join("\n"),
    /◐ await review \(reviewing completion\)/,
  );
  overlay.dispose();
});

test("TODO overlay keeps rejected review state visible after reopening", () => {
  const task = {
    id: 8,
    subject: "fix review flow",
    status: "pending",
    review: { status: "rejected" },
  };
  assert.equal(
    formatOverlayTaskLine(task, theme, true),
    "◐ #8 fix review flow (completion review rejected)",
  );
  assert.equal(
    formatCommandTaskLine(task, "○"),
    "  ✗ #8 fix review flow (completion review rejected)",
  );
});

test("TODO overlay labels operational review exhaustion as failed", () => {
  const task = {
    id: 8,
    subject: "fix review service",
    status: "in_progress",
    metadata: { verification: { state: "failed" } },
    review: { status: "rejected" },
  };
  assert.equal(
    formatOverlayTaskLine(task, theme, true),
    "◐ #8 fix review service (completion review failed)",
  );
  assert.equal(
    formatCommandTaskLine(task, "○"),
    "  ✗ #8 fix review service (completion review failed)",
  );
});

test("TODO overlay shows queued automatic continuation", () => {
  let widget;
  const overlay = new TodoOverlay(() => true);
  overlay.setUICtx({
    setWidget(_key, content) {
      widget = content;
    },
  });
  replaceState({
    tasks: [{ id: 1, subject: "continue work", status: "in_progress" }],
    nextId: 2,
    revision: 1,
  });
  overlay.update();
  const component = widget({ requestRender() {} }, theme);
  assert.match(component.render(120).join("\n"), /Resuming TODO…/);
  overlay.dispose();
});

test("TODO rendering explains dependency updates instead of echoing pending", () => {
  const task = {
    id: 28,
    subject: "Verify review-triage bot coverage",
    status: "pending",
    blockedBy: [27],
  };
  const state = { tasks: [task], nextId: 29, revision: 1 };
  const call = renderTodoCall(
    { action: "update", id: 28, removeBlockedBy: [27] },
    theme,
    state,
  )
    .render(120)
    .join("\n");
  assert.match(call, /Verify review-triage bot coverage/);
  assert.match(call, /− blocker #27/);
  const result = renderTodoResult(
    {
      details: {
        action: "update",
        params: { id: 28, removeBlockedBy: [27] },
        tasks: [{ ...task, blockedBy: undefined }],
        nextId: 29,
      },
    },
    theme,
  )
    .render(120)
    .join("\n")
    .trimEnd();
  assert.equal(result, "✓ removed blocker #27");
});

test("TODO waiting display shows only remaining jobs and partial progress", () => {
  const task = {
    id: 27,
    subject: "Validate AGENTS.md content",
    status: "waiting:jobs",
    wait: {
      kind: "jobs",
      jobIds: ["job-be", "job-fe"],
      mode: "all",
      deadline: Date.now() + 1_000,
      settled: { "job-be": { id: "job-be", status: "succeeded" } },
    },
  };
  const overlayLine = formatOverlayTaskLine(task, theme, true);
  assert.match(overlayLine, /^▶/);
  assert.match(overlayLine, /\(running · all: job-fe · 1\/2 settled\)/);
  assert.match(
    formatCommandTaskLine(task, "▶"),
    /\(running · all: job-fe · 1\/2 settled\)/,
  );
});
