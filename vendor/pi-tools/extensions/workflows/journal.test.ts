import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createWorkflowJournal,
  recoverInterruptedWorkflow,
  refuseWorkflowResume,
} from "./journal.ts";

test("resume fails closed without replaying JavaScript execution state", () => {
  assert.equal(
    refuseWorkflowResume("wf_test"),
    "Workflow wf_test: execution resume unavailable; JavaScript state cannot be replayed safely. Start a new run.",
  );
});

test("journal seals and historical running artifact recovers terminally", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflow-journal-"));
  try {
    const journal = createWorkflowJournal(dir, "wf_test");
    journal.event("call-start", { call: 1 });
    journal.seal("completed");
    assert.equal(journal.event("late"), false);
    writeFileSync(
      join(dir, "workflow.json"),
      JSON.stringify({ status: "running", agents: [] }),
    );
    assert.equal(recoverInterruptedWorkflow(dir, false), true);
    const recovered = JSON.parse(
      readFileSync(join(dir, "workflow.json"), "utf8"),
    );
    assert.equal(recovered.status, "aborted");
    assert.match(recovered.error, /no execution resume/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
