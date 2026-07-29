import assert from "node:assert/strict";
import test from "node:test";
import { parseTurnBudgetRequest } from "./src/turn-budget.ts";

test("parses an exact partial budget request", () => {
  assert.deepEqual(
    parseTurnBudgetRequest(
      JSON.stringify({
        status: "partial",
        budget_request: {
          additional_turns: 6,
          reason: "Focused verification remains.",
        },
        remaining_work: ["run test", "report evidence"],
      }),
    ),
    {
      additionalTurns: 6,
      reason: "Focused verification remains.",
      remainingWork: ["run test", "report evidence"],
    },
  );
});

test("rejects automatic, unbounded, or incomplete budget requests", () => {
  for (const value of [
    {
      status: "done",
      budget_request: { additional_turns: 4, reason: "x" },
      remaining_work: ["x"],
    },
    {
      status: "partial",
      budget_request: { additional_turns: 49, reason: "x" },
      remaining_work: ["x"],
    },
    {
      status: "partial",
      budget_request: { additional_turns: 4, reason: "" },
      remaining_work: ["x"],
    },
    {
      status: "partial",
      budget_request: { additional_turns: 4, reason: "x" },
      remaining_work: [],
    },
  ])
    assert.equal(parseTurnBudgetRequest(JSON.stringify(value)), undefined);
});
