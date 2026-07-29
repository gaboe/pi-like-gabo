import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcileDashboardSelection,
  type DashboardSelection,
} from "./src/ui/takeover.ts";
import { createTranscriptLineCache } from "./src/ui/transcript.ts";

test("transcript cache keeps history through token revisions and reflows by width", () => {
  const cache = createTranscriptLineCache();
  const theme = { fg: (_color: string, text: string) => text } as any;
  const snap = {
    revision: 1,
    cwd: process.cwd(),
    transcript: [{ kind: "assistant", parts: [{ type: "text", text: "one" }] }],
    liveTools: [],
    queued: [],
  } as any;

  const first = cache.get(snap, 80, theme);
  assert.strictEqual(cache.get({ ...snap, revision: 2 }, 80, theme), first);
  const streaming = cache.get(
    { ...snap, revision: 3, liveAssistant: { text: "two", thinking: "" } },
    80,
    theme,
  );
  assert.deepEqual(streaming, ["one", "", "two"]);
  assert.notStrictEqual(cache.get(snap, 40, theme), first);
});

test("dashboard selection follows its subagent id and falls back by row", () => {
  const selection: DashboardSelection = { id: "sa-7", index: 6 };

  reconcileDashboardSelection(selection, [
    { id: "sa-new" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `sa-${index + 1}` })),
  ]);
  assert.deepEqual(selection, { id: "sa-7", index: 7 });

  reconcileDashboardSelection(selection, [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `sa-${index + 1}` })),
    { id: "sa-8" },
    { id: "sa-9" },
  ]);
  assert.deepEqual(selection, { id: "sa-9", index: 7 });

  reconcileDashboardSelection(selection, [{ id: "sa-1" }, { id: "sa-2" }]);
  assert.deepEqual(selection, { id: "sa-2", index: 1 });

  reconcileDashboardSelection(selection, []);
  assert.deepEqual(selection, { id: undefined, index: 0 });
});
