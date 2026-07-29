import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyUsage, formatUsage, turnBudgetBreakdown } from "./model.ts";
import {
  WORKFLOW_PROMPT_GUIDELINES,
  WORKFLOW_TOOL_DESCRIPTION,
} from "./prompt.ts";

test("turn budgets separate usable work from the handoff reserve", () => {
  assert.deepEqual(turnBudgetBreakdown(1), {
    total: 1,
    usable: 0,
    reserve: 1,
  });
  assert.deepEqual(turnBudgetBreakdown(2), {
    total: 2,
    usable: 0,
    reserve: 2,
  });
  assert.deepEqual(turnBudgetBreakdown(3), {
    total: 3,
    usable: 1,
    reserve: 2,
  });
  assert.deepEqual(turnBudgetBreakdown(4), {
    total: 4,
    usable: 2,
    reserve: 2,
  });
  assert.deepEqual(turnBudgetBreakdown(6), {
    total: 6,
    usable: 4,
    reserve: 2,
  });
});

test("usage formatting labels total, work, and handoff turns", () => {
  assert.equal(formatUsage(emptyUsage(), undefined, 1), "0/1 turn");
  assert.equal(
    formatUsage({ ...emptyUsage(), turns: 3 }, undefined, 4),
    "3/4 turns · 2 work + 2 handoff",
  );
  assert.equal(
    formatUsage({ ...emptyUsage(), turns: 8 }, undefined, 4, 1),
    "8 turns used · 4 total/attempt · 2 work + 2 handoff/attempt",
  );
  assert.equal(formatUsage({ ...emptyUsage(), turns: 1 }), "1 turn");
});

test("workflow guidance sizes explicit caps as work plus reserve", () => {
  assert.match(
    WORKFLOW_TOOL_DESCRIPTION,
    /maxTurns: 4.*2 work turns.*2 handoff/s,
  );
  assert.match(
    WORKFLOW_TOOL_DESCRIPTION,
    /`4` work turns require `maxTurns: 6`/,
  );
  assert.ok(
    WORKFLOW_PROMPT_GUIDELINES.some(
      (line) =>
        line.includes("maxTurns: 4") &&
        line.includes("2 tool-capable work turns"),
    ),
  );
  assert.ok(
    WORKFLOW_PROMPT_GUIDELINES.some(
      (line) =>
        line.includes("work turns plus 2") &&
        line.includes("Never increase caps automatically"),
    ),
  );
});
