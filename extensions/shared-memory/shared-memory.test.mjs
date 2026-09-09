import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import sharedMemory, {
  MAX_MEMORY_LINES,
  encodeClaudeProjectPath,
  loadMemory,
  resolveSharedMemoryFile,
} from "./index.ts";

describe("shared Pi and Claude memory", () => {
  it("uses Claude's encoded Nexus memory for root, descendants, and stax worktrees", () => {
    const home = mkdtempSync(join(tmpdir(), "shared-memory-"));
    const nexus = join(home, "bp", "nexus");
    mkdirSync(nexus, { recursive: true });
    const expected = join(
      home,
      ".claude",
      "projects",
      encodeClaudeProjectPath(nexus),
      "memory",
      "MEMORY.md",
    );

    assert.equal(
      resolveSharedMemoryFile(join(nexus, "nexus-be"), home),
      expected,
    );
    assert.equal(
      resolveSharedMemoryFile(
        join(home, ".stax", "worktrees", "nexus-be", "fix"),
        home,
      ),
      expected,
    );
  });

  it("bounds injected memory and requests compaction past the line limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "shared-memory-lines-"));
    const file = join(dir, "MEMORY.md");
    writeFileSync(
      file,
      Array.from(
        { length: MAX_MEMORY_LINES + 1 },
        (_, i) => `- memory ${i}`,
      ).join("\n"),
    );

    const memory = loadMemory(file);
    assert.equal(memory.lines, MAX_MEMORY_LINES + 1);
    assert.equal(memory.content.split("\n").length, MAX_MEMORY_LINES);
    assert.equal(memory.truncated, true);
  });

  it("keeps one stable memory snapshot for the whole session", () => {
    const previousHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "shared-memory-session-"));
    const cwd = join(home, "project");
    const file = join(
      home,
      ".claude",
      "projects",
      encodeClaudeProjectPath(cwd),
      "memory",
      "MEMORY.md",
    );
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "# Memory Index\n\n- old value\n");
    process.env.HOME = home;

    try {
      const handlers = new Map();
      sharedMemory({
        on: (event, handler) => handlers.set(event, handler),
        registerCommand: () => {},
      });
      const ctx = { cwd };
      handlers.get("session_start")({}, ctx);
      writeFileSync(file, "# Memory Index\n\n- new value\n");

      const result = handlers.get("before_agent_start")(
        { systemPrompt: "base" },
        ctx,
      );
      assert.match(result.systemPrompt, /old value/);
      assert.doesNotMatch(result.systemPrompt, /new value/);
    } finally {
      process.env.HOME = previousHome;
    }
  });
});
