import { strict as assert } from "node:assert";
import test from "node:test";
import { registerBackgroundSubagentService } from "../../vendor/pi-tools/extensions/shared/background-subagent-protocol.ts";
import { parseTodoAnalysis, requestTodoAnalysis } from "./enrichment.ts";
import { registerTodoTool } from "./todo.ts";
import { __resetState, commitState, getState } from "./state/store.ts";

const analysis = (status = "ready") => ({
  status,
  subject: "Prepare boundary",
  summary: "Verified preparation facts.",
  scope: [],
  exclusions: [],
  verifiedFacts: [],
  assumptions: [],
  affectedPaths: [],
  sources: [],
  risks: [],
  questions: ["Which region?"],
  steps: [],
  checks: [],
  conflicts: [],
  decisions: [],
  approvals: [],
});

test("tool create does not run preparation or classification", async () => {
  __resetState();
  let tool;
  let analyzed = 0;
  let classified = 0;
  registerTodoTool(
    {
      registerTool(definition) {
        tool = definition;
      },
      appendEntry() {},
    },
    {
      preparation: {
        analyze: async () => {
          analyzed++;
          return analysis();
        },
        classify: async () => {
          classified++;
          return { requiresOrchestration: false, signals: [] };
        },
      },
    },
  );
  await tool.execute(
    "call",
    { action: "create", subject: "Prepare boundary" },
    undefined,
    undefined,
    { cwd: process.cwd(), isProjectTrusted: () => true, modelRegistry: {} },
  );
  const task = getState().tasks[0];
  assert.equal(task.status, "pending");
  assert.equal(task.metadata, undefined);
  assert.equal(analyzed, 0);
  assert.equal(classified, 0);
});

test("tool scope update starts fresh preparation", async () => {
  __resetState();
  let tool;
  const requests = [];
  registerTodoTool(
    {
      registerTool(definition) {
        tool = definition;
      },
      appendEntry() {},
    },
    {
      preparation: {
        analyze: async (_ctx, raw) => {
          requests.push(`analyze:${raw}`);
          return analysis("ready");
        },
        classify: async (_ctx, raw) => {
          requests.push(`classify:${raw}`);
          return { requiresOrchestration: false, signals: [] };
        },
      },
    },
  );
  commitState({
    tasks: [
      {
        id: 1,
        subject: "Verify old scope",
        description: "old scope",
        status: "pending",
        blockedBy: [2],
        metadata: {
          preparation: {
            status: "failed",
            code: "preparation_interrupted",
            version: 1,
            token: "old-token",
          },
        },
      },
      { id: 2, subject: "Pending prerequisite", status: "pending" },
    ],
    nextId: 3,
    revision: 1,
  });
  await tool.execute(
    "call",
    { action: "update", id: 1, description: "fresh scope" },
    undefined,
    undefined,
    { cwd: process.cwd(), isProjectTrusted: () => true, modelRegistry: {} },
  );
  for (let attempt = 0; attempt < 20 && requests.length < 2; attempt++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.ok(requests.some((request) => request === "analyze:fresh scope"));
  assert.ok(requests.some((request) => request === "classify:fresh scope"));
});

test("analyst parser rejects oversized and unknown envelopes", () => {
  assert.equal(
    parseTodoAnalysis(JSON.stringify({ ...analysis(), extra: "no" })),
    undefined,
  );
  assert.equal(
    parseTodoAnalysis(
      JSON.stringify({ ...analysis(), summary: "x".repeat(1_501) }),
    ),
    undefined,
  );
});

test("analyst prompt scrubs credentials and omits session history", async () => {
  let request;
  const { questions, ...modelAnalysis } = analysis();
  const unregister = registerBackgroundSubagentService({
    async run(value) {
      request = value;
      return {
        id: "analysis",
        status: "done",
        output: JSON.stringify({ ...modelAnalysis, openQuestions: questions }),
      };
    },
  });
  try {
    const rawSecret = ["raw", "secret", "12345678"].join("-");
    const historySecret = ["history", "secret", "12345678"].join("-");
    await requestTodoAnalysis(
      {
        cwd: process.cwd(),
        isProjectTrusted: () => true,
        modelRegistry: {},
        sessionManager: {
          buildContextEntries: () => [
            {
              message: {
                role: "user",
                content: `Bearer ${historySecret}`,
              },
            },
          ],
        },
      },
      `Inspect parser. ${["api", "key"].join("_")}=${rawSecret}`,
      { analysisRoot: "current" },
    );
    assert.doesNotMatch(
      request.prompt,
      new RegExp(`${rawSecret}|${historySecret}`),
    );
    assert.match(request.prompt, /\[REDACTED\]/);
  } finally {
    unregister();
  }
});
