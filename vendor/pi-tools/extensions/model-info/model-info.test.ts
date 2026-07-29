import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CHILD_COST_ENTRY,
  isChildCostUpdate,
} from "../shared/dashboard-state.ts";
import {
  collectPersistedChildCosts,
  getSessionCost,
  totalChildCost,
} from "./index.ts";
import modelInfo from "./index.ts";

test("session total combines parent assistant and deduplicated persisted child costs", () => {
  const ctx = {
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          message: { role: "assistant", usage: { cost: { total: 1.25 } } },
        },
      ],
    },
  } as unknown as ExtensionContext;
  const costs = collectPersistedChildCosts([
    {
      type: "custom",
      customType: CHILD_COST_ENTRY,
      data: { key: "subagent:sa-1", cost: 0.4, settled: true },
    },
    {
      type: "custom",
      customType: CHILD_COST_ENTRY,
      data: { key: "subagent:sa-1", cost: 0.6, settled: true },
    },
    {
      type: "custom",
      customType: CHILD_COST_ENTRY,
      data: { key: "workflow:wf-1:1", cost: 0.9, settled: true },
    },
  ]);
  assert.equal(getSessionCost(ctx), 1.25);
  assert.equal(totalChildCost(costs), 1.5);
});

test("session replacement ignores a stale settled event context and disposes bus callbacks", () => {
  const handlers = new Map<string, Function>();
  const listeners = new Set<Function>();
  const pi = {
    events: {
      emit: () => {},
      on: (_channel: string, listener: Function) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    on: (event: string, handler: Function) => handlers.set(event, handler),
    getThinkingLevel: () => "off",
  };
  const context = () =>
    ({
      model: undefined,
      getContextUsage: () => null,
      sessionManager: { getBranch: () => [] },
    }) as unknown as ExtensionContext;
  const oldContext = context();
  const newContext = context();
  modelInfo(pi as never);

  handlers.get("session_start")!({}, oldContext);
  (oldContext as unknown as { getContextUsage: () => null }).getContextUsage =
    () => {
      throw new Error(
        "This extension ctx is stale after session replacement or reload.",
      );
    };

  assert.doesNotThrow(() => handlers.get("agent_settled")!({}, oldContext));
  handlers.get("session_shutdown")!({}, newContext);
  assert.equal(listeners.size, 0);
});

test("child cost updates reject malformed and negative values", () => {
  assert.equal(
    isChildCostUpdate({ key: "subagent:sa-1", cost: 0.5, settled: false }),
    true,
  );
  assert.equal(
    isChildCostUpdate({ key: "subagent:sa-1", cost: -1, settled: true }),
    false,
  );
  assert.equal(isChildCostUpdate({ key: "", cost: 1, settled: true }), false);
});
