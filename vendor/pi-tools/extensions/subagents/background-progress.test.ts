import assert from "node:assert/strict";
import test from "node:test";
import {
  backgroundProgressStage,
  backgroundProgressSubject,
  shouldReportBackgroundProgress,
} from "./index.ts";
import type { SubagentSnapshot } from "./src/domain.ts";

function snapshot(patch: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    id: "sa-1",
    backend: "pi",
    title: "prepare",
    prompt: "prepare",
    cwd: "/repo",
    status: "running",
    createdAt: 0,
    maxTurns: 24,
    meta: { backend: "pi" },
    usage: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "",
    turns: 0,
    ...patch,
  };
}

test("background progress reports meaningful stages with a one-minute heartbeat", () => {
  assert.equal(backgroundProgressStage(snapshot()), "starting analyst");
  assert.equal(
    backgroundProgressStage(
      snapshot({ liveTools: [{ toolId: "1", name: "read" }] }),
    ),
    "inspecting repository",
  );
  assert.equal(
    backgroundProgressStage(
      snapshot({ liveTools: [{ toolId: "1", name: "web_search" }] }),
    ),
    "researching sources",
  );
  assert.equal(
    backgroundProgressStage(
      snapshot({ liveAssistant: { text: "draft", thinking: "" } }),
    ),
    "synthesizing findings",
  );
  assert.equal(
    backgroundProgressSubject(
      snapshot({
        liveAssistant: {
          text: "TITLE: Fix repeated regex compilation",
          thinking: "",
        },
      }),
    ),
    undefined,
  );
  assert.equal(
    backgroundProgressSubject(
      snapshot({
        transcript: [
          {
            kind: "assistant",
            parts: [
              { type: "text", text: "TITLE: Fix repeated regex compilation" },
            ],
          },
        ],
      }),
    ),
    "Fix repeated regex compilation",
  );

  assert.equal(
    shouldReportBackgroundProgress(
      "starting analyst",
      1_000,
      "starting analyst",
      60_999,
    ),
    false,
  );
  assert.equal(
    shouldReportBackgroundProgress(
      "starting analyst",
      1_000,
      "starting analyst",
      61_000,
    ),
    true,
  );
  assert.equal(
    shouldReportBackgroundProgress(
      "starting analyst",
      1_000,
      "inspecting repository",
      2_000,
    ),
    true,
  );
  assert.equal(
    shouldReportBackgroundProgress(
      "starting analyst",
      1_000,
      "starting analyst",
      2_000,
      true,
    ),
    true,
  );
});
