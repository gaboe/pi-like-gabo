import { strict as assert } from "node:assert";
import { test } from "node:test";
import automationPause, { DoubleEscapePauseDetector } from "./index.ts";
import { requestAutomationPause } from "../../vendor/pi-tools/extensions/shared/automation-pause-protocol.ts";

const esc = "\u001b";

function extensionHarness({ editorText = "", active = true } = {}) {
  let sessionStart;
  let terminalInput;
  let aborts = 0;
  let pauses = 0;
  const notifications = [];
  const ctx = {
    mode: "tui",
    isIdle: () => !active,
    abort: () => {
      aborts++;
      active = false;
    },
    ui: {
      getEditorText: () => editorText,
      onTerminalInput: (handler) => {
        terminalInput = handler;
        return () => {};
      },
      notify: (...args) => notifications.push(args),
    },
  };
  automationPause({
    on(event, handler) {
      if (event === "session_start") sessionStart = handler;
    },
    events: {
      emit(_channel, request) {
        pauses++;
        request.acknowledge("subagents", 1);
      },
    },
  });
  sessionStart({}, ctx);
  return {
    pressEscape: () => terminalInput(esc),
    get aborts() { return aborts; },
    get pauses() { return pauses; },
    notifications,
  };
}

test("first empty-editor Escape explicitly aborts and consumes an active parent", () => {
  const harness = extensionHarness();
  assert.deepEqual(harness.pressEscape(), { consume: true });
  assert.equal(harness.aborts, 1);
  assert.equal(harness.pauses, 0);
});

test("second Escape pauses background automation without aborting twice", () => {
  const harness = extensionHarness();
  harness.pressEscape();
  assert.deepEqual(harness.pressEscape(), { consume: true });
  assert.equal(harness.aborts, 1);
  assert.equal(harness.pauses, 1);
  assert.equal(harness.notifications.length, 1);
});

test("Escape with editor content preserves native input handling", () => {
  const harness = extensionHarness({ editorText: "draft" });
  assert.equal(harness.pressEscape(), undefined);
  assert.equal(harness.aborts, 0);
  assert.equal(harness.pauses, 0);
});

test("double Escape pauses active background automation and consumes the second key", () => {
  const detector = new DoubleEscapePauseDetector();
  let pauses = 0;
  assert.equal(
    detector.handle({
      data: esc,
      now: 1_000,
      editorEmpty: true,
      parentActive: false,
      pause: () => {
        pauses++;
        return { count: 2, sources: ["subagents"] };
      },
    }).consume,
    false,
  );
  const result = detector.handle({
    data: esc,
    now: 1_200,
    editorEmpty: true,
    parentActive: false,
    pause: () => {
      pauses++;
      return { count: 2, sources: ["subagents"] };
    },
  });
  assert.deepEqual(result, { count: 2, sources: ["subagents"], consume: true });
  assert.equal(pauses, 1);
});

test("double Escape preserves Pi's normal action when nothing is active", () => {
  const detector = new DoubleEscapePauseDetector();
  detector.handle({
    data: esc,
    now: 1_000,
    editorEmpty: true,
    parentActive: false,
    pause: () => ({ count: 0, sources: [] }),
  });
  assert.equal(
    detector.handle({
      data: esc,
      now: 1_200,
      editorEmpty: true,
      parentActive: false,
      pause: () => ({ count: 0, sources: [] }),
    }).consume,
    false,
  );
});

test("double Escape remains a pause boundary after the first key aborts the parent", () => {
  const detector = new DoubleEscapePauseDetector();
  detector.handle({
    data: esc,
    now: 1_000,
    editorEmpty: true,
    parentActive: true,
    pause: () => ({ count: 0, sources: [] }),
  });
  assert.deepEqual(
    detector.handle({
      data: esc,
      now: 1_200,
      editorEmpty: true,
      parentActive: false,
      pause: () => ({ count: 0, sources: [] }),
    }),
    { count: 1, sources: ["parent"], consume: true },
  );
});

test("pause protocol aggregates synchronous extension acknowledgements", () => {
  const listeners = [
    (request) => request.acknowledge("todo", 1),
    (request) => request.acknowledge("workflows", 2),
  ];
  assert.deepEqual(
    requestAutomationPause({
      emit(_channel, request) {
        for (const listener of listeners) listener(request);
      },
    }),
    { count: 3, sources: ["todo", "workflows"] },
  );
});
