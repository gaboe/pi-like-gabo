import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isAllowedOpenAiSubagentModel,
  openAiSubagentModelError,
} from "./src/model-policy.ts";

for (const model of [
  "openai-codex/gpt-5.6-luna",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-sol",
])
  test(`${model} is allowed`, () =>
    assert.equal(isAllowedOpenAiSubagentModel(model), true));
test("TODO completion review uses the allowed canonical Luna model", () => {
  const source = readFileSync(
    new URL("../../../../extensions/todo/state/completion.ts", import.meta.url),
    "utf8",
  );
  const match = /export const COMPLETION_REVIEW_MODEL = "([^"]+)"/.exec(source);
  assert.ok(match);
  assert.equal(match[1], "openai-codex/gpt-5.6-luna");
  assert.equal(isAllowedOpenAiSubagentModel(match[1]), true);
});

test("rejects aliases and other providers", () => {
  for (const model of [
    "openai-codex/gpt-5.3-codex-spark",
    "gpt-5.5-legacy",
    "gpt-5.6-terra",
    "openai/gpt-5.6-terra",
  ])
    assert.equal(isAllowedOpenAiSubagentModel(model), false);
  assert.match(
    openAiSubagentModelError("gpt-5.5-legacy") ?? "",
    /openai-codex\/gpt-5\.6-luna/,
  );
});

test("resolved Pi child models reject every non-tier provider/model", () => {
  for (const model of ["anthropic/claude-sonnet", "openai-codex/gpt-5.6-other"])
    assert.ok(openAiSubagentModelError(model));
});
