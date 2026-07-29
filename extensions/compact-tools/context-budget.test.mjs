import assert from "node:assert/strict";
import test from "node:test";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import compactTools from "./index.ts";
import { boundToolResultContext, MAX_TOOL_RESULT_TEXT_CHARS } from "./context-budget.ts";
import { buildToolResult } from "../todo/tool/response-envelope.ts";
import { createTodoSnapshot } from "../todo/state/replay.ts";

test("registers context budgeting independently of compact display state", () => {
  let context;
  compactTools({
    on(name, handler) {
      if (name === "context") context = handler;
    },
    registerCommand() {},
    registerEntryRenderer() {},
    appendEntry() {},
  });
  const source = { role: "toolResult", content: [{ type: "text", text: "x".repeat(20_000) }] };
  assert.ok(context({ messages: [source] }).messages[0].content[0].text.length <= MAX_TOOL_RESULT_TEXT_CHARS);
});

const providerChars = (content) => {
  const text = content.filter((block) => block.type === "text");
  return text.reduce((size, block) => size + block.text.length, 0) + Math.max(0, text.length - 1);
};
const omitted = (content) => Number(content.find((block) => block.type === "text" && /chars omitted/.test(block.text)).text.match(/\[(\d+) chars omitted/)[1]);

test("counts Pi 0.82.1 OpenAI text separators and exact source omission", () => {
  const source = { role: "toolResult", content: [{ type: "text", text: "x".repeat(8192) }, { type: "text", text: "y".repeat(8192) }] };
  assert.equal(convertToLlm([source])[0].content.filter((block) => block.type === "text").map((block) => block.text).join("\n").length, 16_385);
  const bounded = boundToolResultContext(source);
  assert.equal(providerChars(bounded.content), MAX_TOOL_RESULT_TEXT_CHARS);
  assert.equal(omitted(bounded.content), 105);
  assert.equal(omitted(bounded.content), 16_384 - bounded.content.filter((block) => block.type === "text" && !/chars omitted/.test(block.text)).reduce((size, block) => size + block.text.length, 0));
  assert.deepEqual(boundToolResultContext(bounded), bounded);

  const separatorsOnly = {
    role: "toolResult",
    content: Array.from({ length: 16_386 }, () => ({ type: "text", text: "" })),
  };
  const emptyBounded = boundToolResultContext(separatorsOnly);
  assert.equal(providerChars(emptyBounded.content), 0);
  assert.deepEqual(boundToolResultContext(emptyBounded), emptyBounded);

  const sparse = {
    role: "toolResult",
    content: [...separatorsOnly.content.slice(0, -1), { type: "text", text: "x" }],
  };
  const sparseBounded = boundToolResultContext(sparse);
  assert.equal(providerChars(sparseBounded.content), 1);
  assert.equal(sparseBounded.content[0].text, "x");

  const fragmented = {
    role: "toolResult",
    content: Array.from({ length: 16_386 }, () => ({ type: "text", text: "x" })),
  };
  const fragmentedBounded = boundToolResultContext(fragmented);
  assert.ok(providerChars(fragmentedBounded.content) <= MAX_TOOL_RESULT_TEXT_CHARS);
  assert.equal(
    omitted(fragmentedBounded.content),
    16_386 - fragmentedBounded.content.filter((block) => block.type === "text" && !/chars omitted/.test(block.text)).reduce((size, block) => size + block.text.length, 0),
  );

  const twoLarge = { role: "toolResult", content: [{ type: "text", text: "a".repeat(10_000) }, { type: "text", text: "b".repeat(10_000) }] };
  const sliced = boundToolResultContext(twoLarge);
  assert.equal(providerChars(sliced.content), MAX_TOOL_RESULT_TEXT_CHARS);
  assert.equal(omitted(sliced.content), 3722);
  assert.equal(omitted(sliced.content), 20_000 - sliced.content.filter((block) => block.type === "text" && !/chars omitted/.test(block.text)).reduce((size, block) => size + block.text.length, 0));
});

test("preserves interleaved block order, source, and success/error caps", () => {
  const source = { role: "toolResult", content: [{ type: "text", text: `head${"a".repeat(20_000)}` }, { type: "image", data: "one", mimeType: "image/png" }, { type: "text", text: `${"b".repeat(20_000)}tail` }, { type: "image", data: "two", mimeType: "image/png" }] };
  const before = JSON.stringify(source);
  const bounded = boundToolResultContext(source);
  assert.equal(JSON.stringify(source), before);
  assert.ok(providerChars(bounded.content) <= MAX_TOOL_RESULT_TEXT_CHARS);
  assert.deepEqual(bounded.content.filter((block) => block.type === "image"), source.content.filter((block) => block.type === "image"));
  assert.match(bounded.content.filter((block) => block.type === "text")[0].text, /^head/);
  assert.match(bounded.content.filter((block) => block.type === "text").at(-1).text, /tail$/);
  const error = boundToolResultContext({ ...source, isError: true });
  assert.ok(providerChars(error.content) <= MAX_TOOL_RESULT_TEXT_CHARS);
  assert.ok(error.content.filter((block) => block.type === "text").at(-1).text.length >= bounded.content.filter((block) => block.type === "text").at(-1).text.length);
});

test("versioned snapshots own replay while tool details do not repeat state", () => {
  const state = {
    tasks: Array.from({ length: 80 }, (_, index) => ({
      id: index + 1,
      subject: `Task ${index + 1}`,
      status: "pending",
      description: "x".repeat(2_000),
    })),
    nextId: 81,
    revision: 1,
  };
  const result = buildToolResult("list", {
    action: "list",
    description: "y".repeat(100_000),
    metadata: { huge: "z".repeat(100_000) },
  }, state, {
    kind: "list",
    includeDeleted: false,
  });
  const snapshot = createTodoSnapshot(state);
  const oldDetailsBytes = Buffer.byteLength(
    JSON.stringify({ action: "list", params: { action: "list" }, tasks: state.tasks, nextId: state.nextId }),
  );
  const newDetailsBytes = Buffer.byteLength(JSON.stringify(result.details));
  assert.ok(newDetailsBytes < 100);
  assert.equal(JSON.stringify(result.details).includes("y".repeat(100)), false);
  assert.equal(JSON.stringify(result.details).includes("z".repeat(100)), false);
  assert.ok(oldDetailsBytes > 100_000);
  assert.equal("tasks" in result.details, false);
  assert.equal("nextId" in result.details, false);
  assert.deepEqual(result.details.params, {});
  assert.equal("id" in (result.details.task ?? {}), false);
  assert.equal(snapshot.tasks.length, 80);
  const session = SessionManager.inMemory();
  session.appendCustomEntry("rpiv-todo:snapshot", snapshot);
  assert.deepEqual(session.buildSessionContext().messages, []);
  const llm = convertToLlm([
    { role: "toolResult", toolCallId: "call-1", toolName: "todo", content: result.content, details: result.details },
  ]);
  assert.equal(llm[0].details, result.details);
});
