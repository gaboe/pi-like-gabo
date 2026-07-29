import assert from "node:assert/strict";
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
test("rejects Spark, aliases, and other providers", () => {
  for (const model of [
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
