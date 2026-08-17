import assert from "node:assert/strict";
import test from "node:test";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import compactTools from "./index.ts";
import {
  boundToolResultContext,
  boundToolResultHistory,
  MAX_TOOL_HISTORY_TEXT_CHARS,
  MAX_TOOL_RESULT_TEXT_CHARS,
  MAX_NON_TEXT_BLOCKS_PER_RESULT,
  modeledProviderChars,
  providerText,
} from "./context-budget.ts";
import { buildToolResult } from "../todo/tool/response-envelope.ts";
import { createTodoSnapshot } from "../todo/state/replay.ts";

test("registers context budgeting independently of compact display state", async () => {
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
  const result = await context({ messages: [source] }, {
    sessionManager: { getSessionId: () => "test", getSessionDir: () => "/tmp" },
  });
  assert.ok(result.messages[0].content[0].text.length <= MAX_TOOL_RESULT_TEXT_CHARS);
});

test("automatically compacts after an agent ends above threshold and rearms below it", async () => {
  const agentEnd = [];
  let sessionStart;
  let tokens = 244_801;
  let compactions = 0;
  const warnings = [];
  let compactOptions;
  compactTools({
    on(name, handler) {
      if (name === "agent_end") agentEnd.push(handler);
      if (name === "session_start") sessionStart = handler;
    },
    registerCommand() {},
    registerEntryRenderer() {},
    appendEntry() {},
  });
  const ctx = {
    getContextUsage: () => ({ tokens, contextWindow: 272_000 }),
    compact: (options) => {
      compactions++;
      compactOptions = options;
    },
    hasUI: true,
    ui: { notify: (message) => warnings.push(message) },
  };

  agentEnd[0]({}, ctx);
  agentEnd[0]({}, ctx);
  assert.equal(compactions, 1);
  compactOptions.onError(new Error("failed"));
  agentEnd[0]({}, ctx);
  assert.equal(compactions, 2);
  compactOptions.onError(new Error("Nothing to compact (session too small)"));
  agentEnd[0]({}, ctx);
  assert.equal(compactions, 2);
  assert.deepEqual(warnings, ["Automatic context compaction failed: failed"]);
  tokens = 80_000;
  agentEnd[0]({}, ctx);
  tokens = 100_001;
  agentEnd[0]({}, ctx);
  assert.equal(compactions, 3);
  await sessionStart({}, {
    ...ctx,
    cwd: "/tmp",
    ui: { theme: {} },
    sessionManager: { getBranch: () => [] },
  });
  agentEnd[0]({}, ctx);
  assert.equal(compactions, 4);
});

test("uses a 70% model-relative threshold", () => {
  const agentEnd = [];
  let compactions = 0;
  compactTools({
    on(name, handler) {
      if (name === "agent_end") agentEnd.push(handler);
    },
    registerCommand() {},
    registerEntryRenderer() {},
    appendEntry() {},
  });
  agentEnd[0]({}, {
    getContextUsage: () => ({ tokens: 42_001, contextWindow: 60_000 }),
    compact: () => { compactions++; },
  });
  assert.equal(compactions, 1);
});

const historyToolChars = (messages) => messages
  .filter((message) => message.role === "toolResult")
  .reduce((total, message) => total + providerChars(message.content), 0);

test("bounds aggregate tool history while preserving recent results and transcript source", () => {
  const nonTool = { role: "user", content: [{ type: "text", text: "keep me" }] };
  const messages = [nonTool, ...Array.from({ length: 40 }, (_, index) => ({
    role: "toolResult",
    toolCallId: `call-${index}`,
    toolName: "read",
    isError: index === 0,
    details: { index },
    content: [
      { type: "image", data: `image-${index}`, mimeType: "image/png" },
      { type: "text", text: `${index}:${"x".repeat(20_000)}` },
    ],
  }))];
  const before = structuredClone(messages);
  const bounded = boundToolResultHistory(messages);

  assert.deepEqual(messages, before);
  assert.ok(historyToolChars(bounded) <= MAX_TOOL_HISTORY_TEXT_CHARS);
  assert.equal(bounded.length, messages.length);
  assert.equal(bounded[0], nonTool);
  assert.deepEqual(
    bounded.map(({ toolCallId, toolName, isError, details }) => ({ toolCallId, toolName, isError, details })),
    messages.map(({ toolCallId, toolName, isError, details }) => ({ toolCallId, toolName, isError, details })),
  );
  const boundedImages = bounded.flatMap((message) => message.content ?? []).filter((block) => block.type === "image");
  const sourceImages = messages.flatMap((message) => message.content ?? []).filter((block) => block.type === "image");
  assert.deepEqual(boundedImages, sourceImages.slice(-boundedImages.length));
  assert.match(bounded[1].content.find((block) => block.type === "text").text, /omitted|…/);
  assert.match(bounded.at(-1).content.find((block) => block.type === "text").text, /^39:/);
  assert.deepEqual(boundToolResultHistory(bounded), bounded);
});

const providerChars = modeledProviderChars;

test("accounts for OpenAI placeholders when exhausting aggregate history", () => {
  const messages = [
    ...Array.from({ length: 5_000 }, (_, index) => ({
      role: "toolResult",
      toolCallId: `empty-${index}`,
      content: [{ type: "text", text: "" }],
    })),
    ...Array.from({ length: 1_000 }, (_, index) => ({
      role: "toolResult",
      toolCallId: `text-${index}`,
      content: [{ type: "text", text: "x".repeat(100) }],
    })),
  ];
  const bounded = boundToolResultHistory(messages);

  assert.ok(historyToolChars(bounded) <= MAX_TOOL_HISTORY_TEXT_CHARS);
  assert.ok(bounded.some((message) => message.content[0].text === "…"));
});
const omitted = (content) => Number(content.find((block) => block.type === "text" && /chars omitted/.test(block.text)).text.match(/\[(\d+) chars omitted/)[1]);

test("counts Pi 0.82.1 OpenAI text separators and exact source omission", () => {
  const source = { role: "toolResult", content: [{ type: "text", text: "x".repeat(8192) }, { type: "text", text: "y".repeat(8192) }] };
  assert.equal(convertToLlm([source])[0].content.filter((block) => block.type === "text").map((block) => block.text).join("\n").length, 16_385);
  const bounded = boundToolResultContext(source);
  assert.equal(providerChars(bounded.content), MAX_TOOL_RESULT_TEXT_CHARS);
  assert.equal(omitted(bounded.content), 105);
  assert.equal(omitted(bounded.content), providerText(source.content).length - bounded.content.filter((block) => block.type === "text" && !/chars omitted/.test(block.text)).reduce((size, block) => size + block.text.length, 0));
  assert.deepEqual(boundToolResultContext(bounded), bounded);

  const separatorsOnly = {
    role: "toolResult",
    content: Array.from({ length: 16_386 }, () => ({ type: "text", text: "" })),
  };
  const emptyBounded = boundToolResultContext(separatorsOnly);
  assert.ok(providerChars(emptyBounded.content) <= MAX_TOOL_RESULT_TEXT_CHARS);
  assert.equal(omitted(emptyBounded.content), providerText(separatorsOnly.content).length - emptyBounded.content.filter((block) => block.type === "text" && !/chars omitted/.test(block.text)).reduce((size, block) => size + block.text.length, 0));
  assert.deepEqual(boundToolResultContext(emptyBounded), emptyBounded);

  const sparse = {
    role: "toolResult",
    content: [...separatorsOnly.content.slice(0, -1), { type: "text", text: "x" }],
  };
  const sparseBounded = boundToolResultContext(sparse);
  assert.ok(providerChars(sparseBounded.content) <= MAX_TOOL_RESULT_TEXT_CHARS);
  assert.equal(omitted(sparseBounded.content), providerText(sparse.content).length - sparseBounded.content.filter((block) => block.type === "text" && !/chars omitted/.test(block.text)).reduce((size, block) => size + block.text.length, 0));

  const fragmented = {
    role: "toolResult",
    content: Array.from({ length: 16_386 }, () => ({ type: "text", text: "x" })),
  };
  const fragmentedBounded = boundToolResultContext(fragmented);
  assert.ok(providerChars(fragmentedBounded.content) <= MAX_TOOL_RESULT_TEXT_CHARS);
  assert.equal(
    omitted(fragmentedBounded.content),
    providerText(fragmented.content).length - fragmentedBounded.content.filter((block) => block.type === "text" && !/chars omitted/.test(block.text)).reduce((size, block) => size + block.text.length, 0),
  );

  const twoLarge = { role: "toolResult", content: [{ type: "text", text: "a".repeat(10_000) }, { type: "text", text: "b".repeat(10_000) }] };
  const sliced = boundToolResultContext(twoLarge);
  assert.equal(providerChars(sliced.content), MAX_TOOL_RESULT_TEXT_CHARS);
  assert.equal(omitted(sliced.content), 3722);
  assert.equal(omitted(sliced.content), providerText(twoLarge.content).length - sliced.content.filter((block) => block.type === "text" && !/chars omitted/.test(block.text)).reduce((size, block) => size + block.text.length, 0));
});

test("reports exact original provider character ranges for 20,002 characters", () => {
  const source = { role: "toolResult", content: [{ type: "text", text: "x".repeat(20_002) }] };
  let individual;
  const bounded = boundToolResultContext(source, (_message, info) => {
    individual = info;
    return `\n\n[${info.omitted} chars omitted from LLM context]\n\n`;
  });
  assert.equal(individual.total, 20_002);
  assert.equal(individual.omitted, individual.end - individual.start + 1);
  assert.equal(providerChars(bounded.content), MAX_TOOL_RESULT_TEXT_CHARS);

  const seen = [];
  boundToolResultHistory([
    source,
    ...Array.from({ length: 5 }, (_, index) => ({ role: "toolResult", content: [{ type: "text", text: `${index}${"z".repeat(20_001)}` }] })),
  ], (_message, info, index) => {
    seen.push({ index, ...info });
    return `[chars=${info.start}-${info.end} omitted=${info.omitted} total=${info.total}]`;
  });
  assert.ok(seen.some((info) => info.index === 0 && info.start === 1 && info.end === 20_002 && info.omitted === 20_002 && info.total === 20_002));
});

test("caps 4,000 image-only blocks and preserves latest bounded images", () => {
  const source = {
    role: "toolResult",
    content: Array.from({ length: 4_000 }, (_, index) => ({ type: "image", data: `${index}`, mimeType: "image/png" })),
  };
  const bounded = boundToolResultHistory([source])[0];
  const images = bounded.content.filter((block) => block.type === "image");
  assert.equal(images.length, MAX_NON_TEXT_BLOCKS_PER_RESULT);
  assert.deepEqual(images.map((image) => image.data), Array.from({ length: MAX_NON_TEXT_BLOCKS_PER_RESULT }, (_, index) => `${4_000 - MAX_NON_TEXT_BLOCKS_PER_RESULT + index}`));
  assert.match(bounded.content.find((block) => block.type === "text").text, /3984 image\/binary blocks omitted/);
  assert.ok(providerChars(bounded.content) <= MAX_TOOL_RESULT_TEXT_CHARS);
  assert.ok(historyToolChars([bounded]) <= MAX_TOOL_HISTORY_TEXT_CHARS);

  const repeated = { type: "image", data: "same", mimeType: "image/png" };
  const seventeen = boundToolResultContext({ role: "toolResult", content: Array(17).fill(repeated) });
  assert.equal(seventeen.content.filter((block) => block.type === "image").length, MAX_NON_TEXT_BLOCKS_PER_RESULT);
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

test("empty in-memory session disables persistence and keeps normal truncation", async () => {
  const { lstat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  let context;
  compactTools({ on(name, handler) { if (name === "context") context = handler; }, registerCommand() {}, registerEntryRenderer() {}, appendEntry() {} });
  const session = SessionManager.inMemory();
  const cwdArtifacts = join(process.cwd(), ".compact-tool-artifacts");
  const existed = await lstat(cwdArtifacts).then(() => true, () => false);
  const result = await context({ messages: [{ role: "toolResult", toolCallId: "call", content: [{ type: "text", text: "x".repeat(20_002) }] }] }, { sessionManager: session });
  const marker = result.messages[0].content.find((block) => block.type === "text" && /chars omitted/.test(block.text)).text;
  assert.doesNotMatch(marker, /Recovery id=/);
  assert.equal(await lstat(cwdArtifacts).then(() => true, () => false), existed);
});

test("duplicate tool-call IDs bind recovery to message index and exact content", async (t) => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { realpath } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "compact-duplicate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let context;
  compactTools({ on(name, handler) { if (name === "context") context = handler; }, registerCommand() {}, registerEntryRenderer() {}, appendEntry() {} });
  const texts = [`a${"x".repeat(20_001)}`, `b${"y".repeat(20_001)}`];
  const messages = texts.map((text) => ({ role: "toolResult", toolCallId: "duplicate", content: [{ type: "text", text }] }));
  const result = await context({ messages }, { sessionManager: { getSessionId: () => "../session", getSessionDir: () => root } });
  const paths = result.messages.map((message) => message.content.find((block) => block.type === "text" && block.text.includes("Recovery id=")).text.match(/path=(\S+)/)[1]);
  assert.notEqual(paths[0], paths[1]);
  assert.deepEqual(await Promise.all(paths.map((path) => readFile(path, "utf8"))), texts);
  const canonicalRoot = await realpath(root);
  assert.ok(paths.every((path) => path.startsWith(`${canonicalRoot}/.compact-tool-artifacts/`) && !path.includes("../session")));
});

test("batch retention emits only exact artifacts still present at handoff", async (t) => {
  const { lstat, mkdtemp, readFile, readdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const root = await mkdtemp(join(tmpdir(), "compact-handoff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let context;
  compactTools({ on(name, handler) { if (name === "context") context = handler; }, registerCommand() {}, registerEntryRenderer() {}, appendEntry() {} });
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: "toolResult",
    toolCallId: `call-${index}`,
    content: [{ type: "text", text: `${index}:${String(index).repeat(20_002)}` }],
  }));
  const result = await context({ messages }, { sessionManager: { getSessionId: () => "handoff", getSessionDir: () => root } });
  const markers = result.messages.flatMap((message) => message.content ?? []).filter((block) => block.type === "text" && block.text.includes("Recovery id="));
  assert.ok(markers.length > 0 && markers.length <= 16);
  for (const marker of markers) {
    const path = marker.text.match(/path=(\S+)/)[1];
    const data = await readFile(path);
    const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    assert.match(marker.text, new RegExp(`sha256=${createHash("sha256").update(data).digest("hex")}`));
    assert.match(marker.text, new RegExp(`utf8Bytes=${data.length}`));
  }
  const directory = join(await import("node:fs/promises").then(({ realpath }) => realpath(root)), ".compact-tool-artifacts", createHash("sha256").update("handoff").digest("hex"));
  const files = await readdir(directory);
  assert.ok(files.filter((name) => name.endsWith(".txt")).length <= 16);
  assert.deepEqual(files.filter((name) => name.endsWith(".tmp")), []);
});

test("recovery markers preserve UTF-8 multiblock output and reuse aggregate artifacts", async (t) => {
  const { mkdtemp, readFile, readdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const root = await mkdtemp(join(tmpdir(), "compact-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let context;
  compactTools({ on(name, handler) { if (name === "context") context = handler; }, registerCommand() {}, registerEntryRenderer() {}, appendEntry() {} });
  const multiText = `α\n${"x".repeat(10_000)}\nβ\n${"y".repeat(10_000)}`;
  const messages = [
    { role: "toolResult", toolCallId: "utf8-call", content: [{ type: "text", text: `α\n${"x".repeat(10_000)}` }, { type: "image", data: "not-persisted" }, { type: "text", text: `β\n${"y".repeat(10_000)}` }] },
    ...Array.from({ length: 5 }, (_, index) => ({ role: "toolResult", toolCallId: `aggregate-${index}`, content: [{ type: "text", text: `${index}:${"z".repeat(14_000)}` }] })),
  ];
  const ctx = { sessionManager: { getSessionId: () => "session-test", getSessionDir: () => root } };
  const first = await context({ messages }, ctx);
  const marker = first.messages.flatMap((message) => message.content ?? []).find((block) => block.type === "text" && block.text.includes("Recovery id="))?.text;
  assert.ok(marker);
  const path = marker.match(/path=(\S+)/)[1];
  const stored = await readFile(path, "utf8");
  assert.ok([multiText, ...messages.slice(1).map((message) => message.content[0].text)].includes(stored));
  assert.match(marker, new RegExp(`sha256=${createHash("sha256").update(stored).digest("hex")}`));
  assert.match(marker, new RegExp(`utf8Bytes=${Buffer.byteLength(stored)}`));
  assert.match(marker, /lines=1-\d+ chars=\d+-\d+ omitted=\d+ chars total=\d+/);
  assert.deepEqual(messages[0].content.filter((block) => block.type === "image"), [{ type: "image", data: "not-persisted" }]);
  const artifactDirectory = join(root, ".compact-tool-artifacts", createHash("sha256").update("session-test").digest("hex"));
  const filesBefore = await readdir(artifactDirectory);
  await context({ messages }, ctx);
  assert.deepEqual(await readdir(artifactDirectory), filesBefore);
});
