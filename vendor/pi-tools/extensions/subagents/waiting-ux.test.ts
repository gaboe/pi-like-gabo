import assert from "node:assert/strict";
import test from "node:test";
import { deferredInteractiveWaitResult } from "./index.ts";
import { formatActivityStatus } from "./src/format.ts";
import {
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_WAIT_TOOL_DESCRIPTION,
} from "./src/prompt.ts";

const theme = {
  fg(_color: string, text: string) {
    return text;
  },
};

test("only TUI waits defer running subagents and terminate the parent turn", () => {
  const statuses = new Map([
    ["sa-1", "running"],
    ["sa-2", "done"],
  ]);
  const statusOf = (id: string) => statuses.get(id);
  const deferred = deferredInteractiveWaitResult(
    "tui",
    ["sa-1", "sa-2"],
    statusOf,
  );
  assert.deepEqual(deferred?.details, {
    pending: ["sa-1"],
    deferred: true,
  });
  assert.equal(deferred?.terminate, true);
  assert.equal(
    deferredInteractiveWaitResult("tui", ["sa-2"], statusOf),
    undefined,
  );
  for (const mode of ["rpc", "json", "print", undefined]) {
    assert.equal(
      deferredInteractiveWaitResult(mode, ["sa-1"], statusOf),
      undefined,
      String(mode),
    );
  }
});

test("idle status and model guidance expose nonblocking subagent waiting", () => {
  assert.match(
    formatActivityStatus(theme as never, {
      running: 2,
      done: 0,
      failed: 0,
      waiting: true,
    }),
    /waiting for 2 subagents/,
  );
  assert.match(
    formatActivityStatus(theme as never, {
      running: 2,
      done: 0,
      failed: 0,
      waiting: false,
    }),
    /2 running/,
  );
  assert.match(SUBAGENT_WAIT_TOOL_DESCRIPTION, /deferred instead of blocking/);
  assert.match(SUBAGENT_SPAWN_PROMPT_GUIDELINES.join("\n"), /end the turn/);
});
