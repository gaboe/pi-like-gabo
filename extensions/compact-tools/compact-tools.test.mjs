import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import {
  categoryFor,
  commandDisplay,
  commandTarget,
  compactPath,
  customTarget,
  displayTarget,
  errorPreview,
  resultSummary,
} from "./format.ts";
import {
  compactionThresholds,
  boundBatchOutput,
  normalizeBatchCalls,
  registerToolBatch,
  TOOL_BATCH_PARAMETERS,
} from "./index.ts";

const cwd = "/tmp/worktrees/feature";

test("compacts before summarization approaches the model context limit", () => {
  assert.deepEqual(compactionThresholds(272_000), {
    compactAt: 100_000,
    rearmAt: 80_000,
  });
  assert.deepEqual(compactionThresholds(undefined), {
    compactAt: 100_000,
    rearmAt: 80_000,
  });
});

test("tool_batch schema accepts and normalizes rg/fd compatibility aliases", () => {
  const schemas = TOOL_BATCH_PARAMETERS.properties.calls.items.oneOf;
  assert.equal(schemas.length, 42);
  assert.equal(TOOL_BATCH_PARAMETERS.properties.concurrency.type, "integer");
  const nestedSchema = (tool, selector, mode) =>
    schemas.find(
      (schema) =>
        schema.properties?.[selector]?.enum?.[0] === tool &&
        Object.hasOwn(schema.properties, mode),
    );
  const readArgs = nestedSchema("read", "tool", "args");
  assert.equal(readArgs.additionalProperties, false);
  assert.deepEqual(Object.keys(readArgs.properties.args.properties), [
    "path",
    "offset",
    "limit",
  ]);
  assert.deepEqual(readArgs.properties.args.required, ["path"]);
  assert.equal(
    Object.hasOwn(readArgs.properties.args.properties, "command"),
    false,
  );
  assert.equal(
    nestedSchema("fd", "name", "arguments").properties.arguments.properties.glob
      .type,
    "boolean",
  );
  assert.equal(
    nestedSchema("rg", "tool", "args").properties.args.properties.context
      .maximum,
    20,
  );
  assert.deepEqual(
    normalizeBatchCalls([
      {
        tool: "rg",
        args: { pattern: "needle", path: "src", fixed_strings: true },
      },
      { tool: "fd", args: { pattern: "test", path: "src", limit: 20 } },
    ]),
    [
      { tool: "grep", args: { pattern: "needle", path: "src", literal: true } },
      {
        tool: "fd",
        args: { pattern: "test", path: "src", limit: 20 },
      },
    ],
  );
  assert.deepEqual(
    normalizeBatchCalls([{ tool: "fd", args: { glob: true } }]),
    [{ tool: "fd", args: { glob: true } }],
  );
  assert.deepEqual(
    normalizeBatchCalls([
      { tool: "fd", args: { pattern: "needle", extension: ".ts" } },
      {
        tool: "fd",
        args: { pattern: "*.test.*", glob: true, extension: "ts" },
      },
      { tool: "fd", args: { extension: "ts" } },
    ]),
    [
      { tool: "fd", args: { pattern: "needle", extension: ".ts" } },
      {
        tool: "fd",
        args: { pattern: "*.test.*", glob: true, extension: "ts" },
      },
      { tool: "fd", args: { extension: "ts" } },
    ],
  );
  assert.throws(
    () =>
      normalizeBatchCalls([
        { tool: "rg", name: "fd", args: { pattern: "test" } },
      ]),
    /exactly one/,
  );
});

test("tool_batch bounds aggregate output by bytes and lines", () => {
  const bounded = boundBatchOutput(
    Array.from(
      { length: 8 },
      (_, index) =>
        `## ${index + 1}. read\n${"x".repeat(8_000)}\n${"line\n".repeat(400)}`,
    ).join("\n\n"),
  );
  assert.ok(Buffer.byteLength(bounded, "utf8") <= 50_000);
  assert.ok(bounded.split("\n").length <= 2_000);
  assert.match(bounded, /tool_batch output truncated/);
});

test("tool_batch truncation preserves UTF-8 and the byte ceiling", () => {
  const bounded = boundBatchOutput("🙂".repeat(30_000));
  assert.ok(Buffer.byteLength(bounded, "utf8") <= 50_000);
  assert.doesNotMatch(bounded, /�/);
  assert.match(bounded, /tool_batch output truncated/);
});

test("tool_batch rejects missing, duplicate, conflicting, and invalid selectors", async () => {
  for (const call of [
    { args: { pattern: "needle" } },
    { tool: "rg", name: "rg" },
    { tool: "rg", name: "fd" },
    { tool: "rg", args: { pattern: "a" }, arguments: { pattern: "b" } },
    { tool: "edit", args: { path: "src/a.ts" } },
    { tool: "read", path: "README.md", bogus: 1 },
    { tool: "read", args: { path: "README.md", bogus: 1 } },
    { tool: "read", args: null },
    { tool: "read", arguments: null },
    { tool: "read", args: undefined },
    { tool: "read", path: "README.md", args: { path: "other.md" } },
    { tool: "grep", args: { pattern: "x", ignoreCase: "yes" } },
    { tool: "bash", args: { command: "echo ok", timeout: Number.NaN } },
    { tool: "fd", args: { extension: 42 } },
  ]) {
    assert.throws(() => normalizeBatchCalls([call]), /tool_batch call 1/);
  }
  assert.throws(
    () => normalizeBatchCalls("not calls"),
    /calls must be an array/,
  );
  assert.throws(() => normalizeBatchCalls([]), /at least one call/);
  assert.throws(
    () =>
      normalizeBatchCalls(
        Array.from({ length: 9 }, () => ({ tool: "ls", args: {} })),
      ),
    /must not contain more than 8 calls/,
  );

  let definition;
  registerToolBatch(
    {
      registerTool(tool) {
        definition = tool;
      },
    },
    cwd,
  );
  await assert.rejects(
    definition.execute("invalid", { calls: [{ args: {} }] }, undefined),
    /tool_batch call 1/,
  );
  await assert.rejects(
    definition.execute(
      "invalid-concurrency",
      { calls: [{ tool: "ls", args: {} }], concurrency: Number.NaN },
      undefined,
    ),
    /concurrency must be an integer from 1 to 8/,
  );
});

test("tool_batch registration leaves standalone rg/fd definitions untouched", () => {
  const standaloneRg = { name: "rg", execute: Symbol("rg") };
  const standaloneFd = { name: "fd", execute: Symbol("fd") };
  const registry = new Map([
    ["rg", standaloneRg],
    ["fd", standaloneFd],
  ]);
  registerToolBatch(
    {
      registerTool(tool) {
        registry.set(tool.name, tool);
      },
    },
    cwd,
  );
  assert.equal(registry.get("rg"), standaloneRg);
  assert.equal(registry.get("fd"), standaloneFd);
  assert.equal(registry.get("tool_batch").name, "tool_batch");
  assert.deepEqual([...registry.keys()], ["rg", "fd", "tool_batch"]);
});

test("tool_batch executes rg/fd aliases through grep/find", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-batch-aliases-"));
  await writeFile(join(directory, "sample.test.ts"), "const needle = true;\n");
  let definition;
  registerToolBatch(
    {
      registerTool(tool) {
        definition = tool;
      },
    },
    directory,
  );
  const result = await definition.execute(
    "call",
    {
      calls: [
        { tool: "rg", args: { pattern: "needle", path: directory } },
        { tool: "fd", args: { pattern: "test", path: directory } },
      ],
    },
    undefined,
  );
  const text = result.content[0].text;
  assert.match(text, /1\. grep/);
  assert.match(text, /sample\.test\.ts/);
  assert.match(text, /2\. fd/);
});

test("fd alias applies pattern, glob, extension, and no-match filters together", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-batch-fd-filters-"));
  await writeFile(join(directory, "needle.ts"), "ok\n");
  await writeFile(join(directory, "needle.js"), "wrong extension\n");
  await writeFile(join(directory, "other.test.ts"), "glob match\n");
  let definition;
  registerToolBatch(
    {
      registerTool(tool) {
        definition = tool;
      },
    },
    directory,
  );
  const result = await definition.execute(
    "fd-filters",
    {
      calls: [
        {
          tool: "fd",
          args: { pattern: "needle", extension: "ts", path: directory },
        },
        {
          tool: "fd",
          args: {
            pattern: "*.test.*",
            glob: true,
            extension: "ts",
            path: directory,
          },
        },
        { tool: "fd", args: { extension: "missing", path: directory } },
      ],
    },
    undefined,
  );
  const text = result.content[0].text;
  assert.match(text, /1\. fd[\s\S]*needle\.ts/);
  assert.doesNotMatch(text, /1\. fd[\s\S]*needle\.js/);
  assert.match(text, /2\. fd[\s\S]*other\.test\.ts/);
  assert.match(text, /3\. fd[\s\S]*No files found matching pattern/);
});

test("tool_batch stops claiming calls after abort", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-batch-abort-"));
  const marker = join(directory, "must-not-run");
  let definition;
  registerToolBatch(
    {
      registerTool(tool) {
        definition = tool;
      },
    },
    directory,
  );
  const controller = new AbortController();
  const batch = definition.execute(
    "abort",
    {
      calls: [
        { tool: "bash", args: { command: "sleep 0.2" } },
        { tool: "bash", args: { command: `touch ${marker}` } },
      ],
      concurrency: 1,
    },
    controller.signal,
  );
  await delay(20);
  controller.abort(new Error("cancelled"));
  await assert.rejects(batch, /cancelled|aborted/);
  await assert.rejects(access(marker));
});

test("tool_batch rejects caller abort observed during final inner calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-batch-final-abort-"));
  let definition;
  registerToolBatch(
    {
      registerTool(tool) {
        definition = tool;
      },
    },
    directory,
  );
  const controller = new AbortController();
  const batch = definition.execute(
    "final-abort",
    {
      calls: [{ tool: "bash", args: { command: "sleep 0.05" } }],
      concurrency: 1,
    },
    controller.signal,
  );
  setTimeout(() => controller.abort(new Error("final cancellation")), 10);
  await assert.rejects(batch, /final cancellation|aborted|cancelled/i);
});

test("tool_batch aborts running siblings after an inner timeout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-batch-inner-abort-"));
  const marker = join(directory, "sibling-must-not-finish");
  let definition;
  registerToolBatch(
    {
      registerTool(tool) {
        definition = tool;
      },
    },
    directory,
  );
  const startedAt = Date.now();
  await assert.rejects(
    definition.execute(
      "inner-abort",
      {
        calls: [
          { tool: "bash", args: { command: "sleep 0.2", timeout: 0.01 } },
          { tool: "bash", args: { command: `sleep 0.2; touch ${marker}` } },
        ],
        concurrency: 2,
      },
      undefined,
    ),
    /timed out|aborted/i,
  );
  assert.ok(Date.now() - startedAt >= 10);
  await assert.rejects(access(marker));
});

test("categorizes general tools without taking edit rendering", () => {
  assert.equal(categoryFor("read"), "read");
  assert.equal(categoryFor("grep"), "search");
  assert.equal(categoryFor("web_search"), "search");
  assert.equal(categoryFor("bash"), "command");
  assert.equal(categoryFor("workflow"), "other");
  assert.equal(categoryFor("edit"), undefined);
  assert.equal(categoryFor("write"), undefined);
});

test("removes workspace prefixes from paths and commands", () => {
  assert.equal(
    compactPath(`${cwd}/extensions/jobs/manager.ts`, cwd),
    "extensions/jobs/manager.ts",
  );
  assert.equal(
    displayTarget(
      "read",
      "read",
      { path: `${cwd}/extensions/jobs/manager.ts` },
      cwd,
    ),
    "extensions/jobs/manager.ts",
  );
  assert.deepEqual(
    commandDisplay({ command: `cd ${cwd} && bun run check` }, cwd),
    {
      command: "bun run check",
      location: ".",
    },
  );
  assert.equal(
    commandTarget({ command: `cd ${cwd} && bun run check` }, cwd),
    ". · bun run check",
  );
});

test("keeps external paths intact", () => {
  assert.equal(compactPath("/var/log/system.log", cwd), "/var/log/system.log");
});

test("summarizes results without exposing full output", () => {
  const result = {
    content: [{ type: "text", text: "a.ts:1\na.ts:2\nb.ts:8\n" }],
  };
  assert.equal(resultSummary("search", result), "3 results");
  assert.equal(
    resultSummary("command", {
      content: [{ type: "text", text: "82 pass\n0 fail" }],
    }),
    "82 tests passed",
  );
  assert.equal(
    resultSummary("other", {
      content: [{ type: "text", text: "Updated task #4\nlarge payload" }],
    }),
    "Updated task #4",
  );
});

test("shows concise custom-tool intent and bounded errors", () => {
  assert.equal(
    customTarget("todo", { action: "update", id: 4 }),
    "Todo update",
  );
  assert.equal(customTarget("workflow", { name: "review" }), "Workflow review");
  assert.deepEqual(
    errorPreview({
      content: [{ type: "text", text: "first\nsecond\nthird\nfourth" }],
    }),
    ["second", "third", "fourth"],
  );
});
