import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SUBAGENT_SEND_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
} from "./src/prompt.ts";
import {
  WORKFLOW_PROMPT_GUIDELINES,
  WORKFLOW_TOOL_DESCRIPTION,
} from "../workflows/prompt.ts";

for (const [name, guidance] of [
  ["subagents", SUBAGENT_SPAWN_PROMPT_GUIDELINES],
  ["workflows", WORKFLOW_PROMPT_GUIDELINES],
] as const) {
  test(`${name} uses lean explicit model and effort routing`, () => {
    const text = guidance.join("\n");
    assert.match(text, /model and (?:reasoning_)?effort independently/);
    assert.match(text, /Luna for focused scouts\/verifiers, broad exploration, and precisely scoped low-risk implementation/);
    assert.match(text, /Luna effort low for mechanical work, medium for multi-step reasoning, or high only when bounded work is genuinely difficult/);
    assert.match(text, /Terra low for ambiguous root causes, domain decisions, or broad\/coupled multi-file implementation/);
    assert.match(text, /Sol low for routine review/);
    assert.match(text, /Sol medium for planning or complex synthesis/);
    assert.match(text, /xhigh only for genuinely difficult problems/);
    assert.match(text, /never choose max automatically/);
  });
}

test("workflow tool description matches effort-aware Luna routing", () => {
  const text = WORKFLOW_TOOL_DESCRIPTION;
  assert.match(text, /Route bounded low-risk read-only work or precisely scoped implementation/);
  assert.match(text, /Choose effort independently by reasoning depth/);
  assert.match(text, /a failed check stays at the same tier unless it exposes missing reasoning or scope ambiguity/);
  assert.doesNotMatch(text, /at most 4 tool-capable work turns/);
  assert.doesNotMatch(text, /touch at most 3 files/);
});

test("subagent routing distinguishes tiers from exact Pi model hints", () => {
  const text = SUBAGENT_SPAWN_PROMPT_GUIDELINES.join("\n");
  assert.match(text, /routing tiers, not valid Pi model hints/);
  assert.match(text, /openai-codex\/gpt-5\.6-terra/);
  assert.match(text, /exact model tiers/);
  assert.match(text, /gpt-5\.6-luna/);
  assert.match(text, /exact model tiers/);
  assert.match(text, /8-12 for narrow mechanical scouts/);
  assert.match(text, /24-32 for focused implementation/);
  assert.match(text, /two final turns reserved/);
  assert.match(text, /never the shorthand luna, terra, or sol/);
});

test("subagent routing keeps semantic corrections on the owning worker", () => {
  const text = [
    ...SUBAGENT_SPAWN_PROMPT_GUIDELINES,
    ...SUBAGENT_SEND_PROMPT_GUIDELINES,
  ].join("\n");
  assert.match(text, /subagent_send/);
  assert.match(text, /same Package Worker/);
  assert.match(text, /do not spawn a replacement/);
  assert.match(text, /implement the package in the parent/);
  assert.match(text, /budget_request \{additional_turns, reason\}/);
  assert.match(text, /exact request at most once/);
  assert.match(text, /Never extend automatically/);
});

test("subagent routing permits queued same-TODO package handshakes", () => {
  const text = SUBAGENT_SPAWN_PROMPT_GUIDELINES.join("\n");
  assert.match(text, /Batch safe same-TODO Package Worker spawns/);
  assert.match(text, /handshakes queue in FIFO order/);
  assert.match(text, /authorized workers run concurrently/);
  assert.match(text, /Never downgrade a rejected package to parent writes/);
});

test("spawn schema is strict and legacy external selectors fail closed", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(source, /additionalProperties: false/);
  assert.match(source, /Legacy external selector/);
});
