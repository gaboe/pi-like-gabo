import assert from "node:assert/strict";
import test from "node:test";
import {
  contextBreakdown,
  contextReportOffset,
  contextReportPage,
  formatContextReport,
} from "./context-report.ts";

test("uses Pi message shapes, counts images, schemas, and call arguments", () => {
  const input = {
    usage: { tokens: 900, contextWindow: 2000, percent: 45 },
    systemPrompt: "12345678",
    entries: [
      { type: "message", message: { role: "user", content: "1234" } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "12345678" },
            { type: "thinking", thinking: "1234" },
            {
              type: "image",
              data: "base64-should-not-count",
              mimeType: "image/png",
            },
            { type: "image", data: "also-not-count", mimeType: "image/png" },
            {
              type: "toolCall",
              id: "1",
              name: "read",
              arguments: { path: "1234" },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "12345678" }],
        },
      },
      { type: "compaction", summary: "12345678" },
    ],
    activeTools: [
      {
        name: "read",
        description: "1234",
        parameters: { path: { type: "string" } },
      },
    ],
    contextFiles: [{ path: "AGENTS.md", content: "1234" }],
    skills: [{ name: "skill", description: "1234", filePath: "SKILL.md" }],
  };
  const breakdown = contextBreakdown(input);
  assert.equal(breakdown.user, 1);
  assert.equal(breakdown.toolResults, 2);
  assert.equal(breakdown.images, 2);
  assert.equal(breakdown.toolCallCount, 1);
  assert.equal(breakdown.summaries, 2);
  assert.ok(breakdown.toolCalls > 0);
  assert.ok(breakdown.activeTools > 3);
  const report = formatContextReport(input).join("\n");
  assert.match(report, /Pi hybrid context estimate, not provider-reported/);
  assert.match(report, /chars ÷ 4.*do not sum to Pi estimate/);
  assert.match(report, /included in system prompt/);
  assert.match(
    report,
    /Compaction summaries: 2 estimated tokens \(1 compactions\)/,
  );
});

test("pages report lines and handles narrow widths", () => {
  assert.deepEqual(contextReportPage(["abcd", "efgh"], 1, 0, 1), ["…"]);
  assert.deepEqual(contextReportPage(["abcd"], 0, 0, 1), [""]);
  assert.equal(contextReportOffset(5, 0, 9, 2), 3);
  assert.equal(contextReportOffset(5, 3, -9, 2), 0);
});

test("formats unknown Pi estimate without false precision", () => {
  const report = formatContextReport({
    systemPrompt: "",
    entries: [],
    activeTools: [],
  }).join("\n");
  assert.match(
    report,
    /Pi context estimate: unknown tokens \/ unknown window \(unknown%\)/,
  );
  assert.match(report, /Remaining: unknown tokens/);
});
