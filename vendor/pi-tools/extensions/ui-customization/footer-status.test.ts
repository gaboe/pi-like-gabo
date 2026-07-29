import assert from "node:assert/strict";
import test from "node:test";
import { arrangeFooterStatuses } from "./index.ts";

test("caveman and ponytail follow usage while other statuses retain rows", () => {
  const layout = arrangeFooterStatuses(
    "62%/372k · $452.92 · 16 tok/s",
    new Map([
      ["subagents", "subagents: 2 running"],
      ["ponytail", "🐴 ponytail: 🌿 LITE"],
      ["caveman", "⠠⠄ caveman level: LITE"],
      ["jobs", "jobs: 1 running\njob detail"],
    ]),
  );

  assert.equal(
    layout.usage,
    "62%/372k · $452.92 · 16 tok/s · ⠠⠄ caveman level: LITE · 🐴 ponytail: 🌿 LITE",
  );
  assert.deepEqual(layout.remaining, [
    "jobs: 1 running",
    "job detail",
    "subagents: 2 running",
  ]);
});

test("missing mode statuses leave usage unchanged", () => {
  assert.deepEqual(arrangeFooterStatuses("usage", new Map()), {
    usage: "usage",
    remaining: [],
  });
});
