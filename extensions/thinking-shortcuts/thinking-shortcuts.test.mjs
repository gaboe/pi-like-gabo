import assert from "node:assert/strict";
import test from "node:test";
import { adjacentThinkingLevel } from "./index.ts";

test("thinking shortcuts move in both directions without wrapping", () => {
  const levels = ["off", "low", "high"];
  assert.equal(adjacentThinkingLevel(levels, "low", 1), "high");
  assert.equal(adjacentThinkingLevel(levels, "low", -1), "off");
  assert.equal(adjacentThinkingLevel(levels, "high", 1), "high");
  assert.equal(adjacentThinkingLevel(levels, "off", -1), "off");
});

test("thinking shortcuts recover from a level unsupported by the current model", () => {
  assert.equal(adjacentThinkingLevel(["off", "high"], "medium", 1), "high");
  assert.equal(adjacentThinkingLevel(["off", "high"], "medium", -1), "off");
});
