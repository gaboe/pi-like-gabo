import assert from "node:assert/strict";
import { test } from "node:test";
import { extractMeta, prepareWorkflowScript } from "./meta.ts";

test("metadata is decoded statically and removed from executable source", () => {
  const source = `export const meta = {
    name: "audit",
    description: "safe",
    phases: [{ title: "Scan", detail: "files" }],
  };
  return { ok: true };`;
  const prepared = prepareWorkflowScript(source);
  assert.deepEqual(prepared.meta, {
    name: "audit",
    description: "safe",
    phases: [{ title: "Scan", detail: "files" }],
  });
  assert.doesNotMatch(prepared.source, /name:\s*"audit"/);
  assert.equal(prepared.source.split("\n").length, source.split("\n").length);
});

test("export-like text in strings, comments, regexes, and templates is untouched", () => {
  const source = `
    const string = "export default notSyntax";
    const template = \`export const meta = \${string}\`;
    const regex = /export\\s+default/;
    // export const fake = 1
    return { string, template, matches: regex.test(string) };
  `;
  const prepared = prepareWorkflowScript(source);
  assert.equal(prepared.source, source);
  assert.deepEqual(prepared.meta, { phases: [] });
});

test("unavailable sandbox globals fail during preflight with actionable errors", () => {
  assert.throws(
    () =>
      prepareWorkflowScript("const path = process.env.TMPDIR; return path;"),
    /does not expose `process`; pass data through workflow args or use a literal/,
  );
  assert.throws(
    () =>
      prepareWorkflowScript(
        "return globalThis['fetch']('https:\/\/example.com');",
      ),
    /does not expose `fetch`/,
  );
  assert.throws(
    () => prepareWorkflowScript("return import('./other.js');"),
    /cannot use dynamic imports/,
  );
  assert.doesNotThrow(() =>
    prepareWorkflowScript(
      "return { processType: typeof process, process: 'label' };",
    ),
  );
});

test("executable and unsupported metadata fail closed", () => {
  assert.throws(
    () =>
      prepareWorkflowScript(
        `export const meta = { name: (() => "executed")(), phases: [] }; return 1;`,
      ),
    /only static literals/,
  );
  assert.throws(
    () => prepareWorkflowScript(`export default 1; return 1;`),
    /may only export/,
  );
  assert.deepEqual(
    extractMeta(`export const meta = { name: process.exit(), phases: [] }`),
    { phases: [] },
  );
});
