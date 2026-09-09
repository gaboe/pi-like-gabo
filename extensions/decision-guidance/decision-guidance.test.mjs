import assert from "node:assert/strict";
import test from "node:test";
import decisionGuidance, { DECISION_GUIDANCE } from "./index.ts";

test("adds evidence-rich code and review decision guidance to every agent turn", () => {
  let handler;
  decisionGuidance({
    on(event, callback) {
      if (event === "before_agent_start") handler = callback;
    },
  });

  const result = handler({ systemPrompt: "base prompt" });
  assert.equal(result.systemPrompt, `base prompt\n\n${DECISION_GUIDANCE}`);

  const orderedFields = [
    "Source/link.",
    "Full verbatim user request or review comment.",
    "Current code snippet, labeled file:line, with sufficient surrounding lines for context.",
    "Supporting evidence.",
    "Recommendation.",
    "Draft reply.",
  ];
  let previous = -1;
  for (const field of orderedFields) {
    const position = result.systemPrompt.indexOf(field);
    assert.ok(position > previous, `${field} must follow prior packet fields`);
    previous = position;
  }

  assert.match(result.systemPrompt, /Write prose by default/);
  assert.match(
    result.systemPrompt,
    /only when user explicitly asks for options/,
  );
  assert.match(
    result.systemPrompt,
    /evidence is missing, label it unavailable/,
  );
  assert.match(
    result.systemPrompt,
    /never fabricate evidence, sources, comments, or code/,
  );
  assert.match(
    result.systemPrompt,
    /decisions with no relevant code, omit this packet/,
  );
  assert.match(
    result.systemPrompt,
    /use grep instead of rg and find instead of fd/,
  );
  assert.match(
    result.systemPrompt,
    /only valid nested names are read, grep, find, ls, and bash/,
  );
  assert.match(result.systemPrompt, /standalone content search on rg/);
  assert.match(result.systemPrompt, /standalone file discovery on fd/);
});
