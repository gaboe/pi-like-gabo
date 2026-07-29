import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  handoffRawEvidence,
  MAX_HANDOFF_RAW_BYTES,
  MAX_HANDOFF_STRING_LENGTH,
  packageHandoffCorrection,
  parsePackageHandoff,
} from "./src/handoff.ts";

const cwd = process.cwd();
const handoff = (status: "done" | "partial" | "blocked" | "failed") =>
  JSON.stringify({
    status,
    acceptance: [
      {
        criterion: "tests pass",
        passed: status === "done",
        evidence: ["npm test"],
      },
    ],
    changed_paths: ["src/a.ts"],
    checks: [{ name: "test", result: "passed" }],
    review: "reviewed",
    remaining_work: [],
    risks: [],
  });

test("accepts every package handoff status", () => {
  for (const status of ["done", "partial", "blocked", "failed"] as const)
    assert.equal(parsePackageHandoff(handoff(status), cwd).valid, true);
});

test("done requires passed criteria", () => {
  const result = parsePackageHandoff(
    handoff("done").replace('"passed":true', '"passed":false'),
    cwd,
  );
  assert.equal(result.valid, false);
  if (!result.valid)
    assert.deepEqual(result.errors, [
      "done requires every acceptance criterion to pass.",
    ]);
});

test("every status requires evidence for every acceptance criterion", () => {
  for (const status of ["done", "partial", "blocked", "failed"] as const) {
    const input = JSON.parse(handoff(status));
    input.acceptance[0].evidence = [];
    const result = parsePackageHandoff(JSON.stringify(input), cwd);
    assert.equal(result.valid, false, status);
    if (!result.valid) {
      assert.deepEqual(result.errors, [
        "Every acceptance criterion requires non-empty evidence.",
      ]);
      assert.equal(
        packageHandoffCorrection(result.errors),
        "Mechanical Handoff Gate rejected final output:\n- Every acceptance criterion requires non-empty evidence.\n\nReturn one corrected JSON Package Handoff only. Required fields: status, acceptance [{criterion, passed, evidence}], changed_paths, checks [{name, result}], review, remaining_work, risks. Optional budget_request is {additional_turns, reason} and requires partial status plus non-empty remaining_work. This is your reserved correction opportunity.",
      );
    }
  }
});

test("rejects malformed handoffs with exact local errors", () => {
  assert.deepEqual(parsePackageHandoff("nope", cwd), {
    valid: false,
    errors: ["Final handoff must be a JSON object."],
  });
});

test("normalizes lexical changed paths and allows nonexistent files", () => {
  const input = JSON.parse(handoff("done"));
  input.changed_paths = [
    "src/../src/deleted.ts",
    resolve(cwd, "new/nonexistent.ts"),
  ];
  const result = parsePackageHandoff(JSON.stringify(input), cwd);
  assert.equal(result.valid, true);
  if (result.valid)
    assert.deepEqual(result.handoff.changed_paths, [
      "src/deleted.ts",
      "new/nonexistent.ts",
    ]);
});

test("rejects outside, blank, duplicate, and oversized values", () => {
  const input = JSON.parse(handoff("partial"));
  input.changed_paths = ["../outside.ts", "src/a.ts", "src/../src/a.ts"];
  input.remaining_work = [" ", "same", "same"];
  input.review = "x".repeat(MAX_HANDOFF_STRING_LENGTH + 1);
  const result = parsePackageHandoff(JSON.stringify(input), cwd);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(
      result.errors.includes("changed_paths[0] must resolve inside task.cwd."),
    );
    assert.ok(
      result.errors.includes("changed_paths must not contain duplicates."),
    );
    assert.ok(
      result.errors.includes("remaining_work[0] must be a non-empty string."),
    );
    assert.ok(
      result.errors.includes("remaining_work must not contain duplicates."),
    );
    assert.ok(
      result.errors.includes(
        `review must be at most ${MAX_HANDOFF_STRING_LENGTH} characters.`,
      ),
    );
  }
});

test("rejects oversized raw output and retains bounded hash evidence", () => {
  const raw = "é".repeat(MAX_HANDOFF_RAW_BYTES);
  const result = parsePackageHandoff(raw, cwd);
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.errors[0] ?? "", /received 131072/);
  const evidence = handoffRawEvidence(raw);
  assert.ok(Buffer.byteLength(evidence) < MAX_HANDOFF_RAW_BYTES);
  assert.match(evidence, /sha256:[0-9a-f]{64}/);
  assert.match(evidence, /131072 bytes/);
});
