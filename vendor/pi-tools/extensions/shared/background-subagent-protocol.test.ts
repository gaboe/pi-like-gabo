import assert from "node:assert/strict";
import test from "node:test";
import {
  getBackgroundSubagentService,
  registerBackgroundSubagentService,
  type BackgroundSubagentService,
} from "./background-subagent-protocol.ts";

const service = (id: string): BackgroundSubagentService => ({
  async run() {
    return { id, status: "done", output: id };
  },
});

test("nested child services restore the parent rendezvous", () => {
  const parent = service("parent");
  const child = service("child");
  const unregisterParent = registerBackgroundSubagentService(parent);
  const unregisterChild = registerBackgroundSubagentService(child);
  assert.equal(getBackgroundSubagentService(), child);
  unregisterChild();
  assert.equal(getBackgroundSubagentService(), parent);
  unregisterParent();
});
