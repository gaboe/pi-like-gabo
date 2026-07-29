import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import test from "node:test";
import firecrawlTools from "./index.ts";

test("registration needs neither Firecrawl nor credentials", () => {
  const tools: { name: string; execute: Function }[] = [];
  firecrawlTools({
    registerTool: (tool: { name: string; execute: Function }) =>
      tools.push(tool),
  } as never);

  assert.deepEqual(
    tools.map(({ name }) => name),
    ["search", "crawl", "scrape"],
  );
  assert.equal(
    readFileSync(new URL("./index.ts", import.meta.url), "utf8").includes(
      'from "firecrawl"',
    ),
    false,
  );
});

test("first execution loads operations and validates credentials", () => {
  const script = `import tools from "./index.ts"; const registered = []; tools({ registerTool: tool => registered.push(tool) }); try { await registered[0].execute("id", { query: "test" }); } catch (error) { if (error.message.includes("Missing FIRECRAWL_API_KEY")) process.exit(0); } process.exit(1);`;
  execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: import.meta.dirname,
    env: {
      ...process.env,
      FIRECRAWL_API_KEY: undefined,
      HOME: mkdtempSync(`${tmpdir()}/firecrawl-test-`),
    },
  });
});
