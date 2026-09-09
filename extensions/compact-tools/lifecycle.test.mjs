import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import compactTools from "./index.ts";
import {
  getCompactToolRenderer,
  setCompactToolRenderer,
} from "../../vendor/pi-tools/extensions/shared/compact-tool-renderer-protocol.ts";

const originalUpdateDisplay = ToolExecutionComponent.prototype.updateDisplay;
const originalRender = ToolExecutionComponent.prototype.render;
const priorRenderer = getCompactToolRenderer();

const extensionApi = (onShutdown) => ({
  on(name, handler) {
    if (name === "session_shutdown") onShutdown(handler);
  },
  registerCommand() {},
  registerEntryRenderer() {},
  appendEntry() {},
});

test("restores renderer globals when the extension runtime shuts down", () => {
  let shutdown;
  compactTools(
    extensionApi((handler) => {
      shutdown = handler;
    }),
  );
  assert.notEqual(
    ToolExecutionComponent.prototype.updateDisplay,
    originalUpdateDisplay,
  );
  shutdown({}, {});
  assert.equal(
    ToolExecutionComponent.prototype.updateDisplay,
    originalUpdateDisplay,
  );
  assert.equal(ToolExecutionComponent.prototype.render, originalRender);
  assert.equal(getCompactToolRenderer(), priorRenderer);
});

test("does not tear down a newer compact-tools runtime", () => {
  const prior = getCompactToolRenderer();
  const externalRenderer = {
    version: 1,
    enabled: () => true,
    render: () => [],
  };
  setCompactToolRenderer(externalRenderer);
  let shutdownA;
  let shutdownB;
  compactTools(
    extensionApi((handler) => {
      shutdownA = handler;
    }),
  );
  compactTools(
    extensionApi((handler) => {
      shutdownB = handler;
    }),
  );
  const rendererB = getCompactToolRenderer();
  shutdownA({}, {});
  assert.equal(getCompactToolRenderer(), rendererB);
  assert.notEqual(
    ToolExecutionComponent.prototype.updateDisplay,
    originalUpdateDisplay,
  );
  shutdownB({}, {});
  assert.equal(getCompactToolRenderer(), externalRenderer);
  assert.equal(
    ToolExecutionComponent.prototype.updateDisplay,
    originalUpdateDisplay,
  );
  assert.equal(ToolExecutionComponent.prototype.render, originalRender);
  setCompactToolRenderer(prior);
});

test("restores a still-live older compact-tools runtime", () => {
  const prior = getCompactToolRenderer();
  const externalRenderer = {
    version: 1,
    enabled: () => true,
    render: () => [],
  };
  setCompactToolRenderer(externalRenderer);
  let shutdownA;
  let shutdownB;
  compactTools(
    extensionApi((handler) => {
      shutdownA = handler;
    }),
  );
  const rendererA = getCompactToolRenderer();
  const updateA = ToolExecutionComponent.prototype.updateDisplay;
  compactTools(
    extensionApi((handler) => {
      shutdownB = handler;
    }),
  );
  shutdownB({}, {});
  assert.equal(getCompactToolRenderer(), rendererA);
  assert.equal(ToolExecutionComponent.prototype.updateDisplay, updateA);
  shutdownA({}, {});
  assert.equal(getCompactToolRenderer(), externalRenderer);
  assert.equal(
    ToolExecutionComponent.prototype.updateDisplay,
    originalUpdateDisplay,
  );
  setCompactToolRenderer(prior);
});
