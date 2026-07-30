import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { getCompactToolRenderer } from "../../vendor/pi-tools/extensions/shared/compact-tool-renderer-protocol.ts";

const originalUpdateDisplay = ToolExecutionComponent.prototype.updateDisplay;
const originalRender = ToolExecutionComponent.prototype.render;
const priorRenderer = getCompactToolRenderer();
const { default: compactTools } = await import(`./index.ts?lifecycle=${Date.now()}`);

test("restores renderer globals when the extension runtime shuts down", () => {
  let shutdown;
  compactTools({
    on(name, handler) {
      if (name === "session_shutdown") shutdown = handler;
    },
    registerCommand() {},
    registerEntryRenderer() {},
    appendEntry() {},
  });

  assert.notEqual(ToolExecutionComponent.prototype.updateDisplay, originalUpdateDisplay);
  assert.notEqual(ToolExecutionComponent.prototype.render, originalRender);
  assert.notEqual(getCompactToolRenderer(), priorRenderer);

  shutdown({}, {});

  assert.equal(ToolExecutionComponent.prototype.updateDisplay, originalUpdateDisplay);
  assert.equal(ToolExecutionComponent.prototype.render, originalRender);
  assert.equal(getCompactToolRenderer(), priorRenderer);
});
