import assert from "node:assert/strict";
import {
  linkSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defineTool, type AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  applyReadConfinement,
  createSynchronousTurnGate,
  isFindingFixerBashCommand,
  isFindingFixerPathAllowed,
  isIdleWaitCommand,
  isPathInsideRoot,
  isReadOnlyBashCommand,
} from "./src/backends/pi.ts";
import { withSubagentTurnBudget } from "./src/turn-budget.ts";
import {
  DEFAULT_SUBAGENT_TURNS,
  normalizeNestedWorkerTurns,
  normalizeSubagentTurns,
} from "./src/domain.ts";

test("read-only bash policy allows only bounded non-content listing", () => {
  assert.equal(isReadOnlyBashCommand("rg -n refresh"), false);
  assert.equal(isReadOnlyBashCommand("rg refresh -n"), false);
  assert.equal(isReadOnlyBashCommand("rg --files --hidden"), true);
  assert.equal(isReadOnlyBashCommand("find src -type f"), true);
  assert.equal(isReadOnlyBashCommand("rtk rg --files"), true);
  assert.equal(isReadOnlyBashCommand("rtk find . -maxdepth 2 -type f"), true);
});

test("read-only bash policy rejects mutation, composition, and path escapes", () => {
  assert.equal(isReadOnlyBashCommand("rm -rf src"), false);
  assert.equal(isReadOnlyBashCommand("rtk rm -rf src"), false);
  assert.equal(isReadOnlyBashCommand("find src -delete"), false);
  assert.equal(isReadOnlyBashCommand("find -files0-from paths"), false);
  assert.equal(isReadOnlyBashCommand("find -files0-from=paths"), false);
  assert.equal(isReadOnlyBashCommand("rg token > out"), false);
  assert.equal(isReadOnlyBashCommand("git status"), false);
  assert.equal(isReadOnlyBashCommand("git diff"), false);
  assert.equal(isReadOnlyBashCommand("git status && npm test"), false);
  assert.equal(isReadOnlyBashCommand("head -1 ~/.ssh/config"), false);
  assert.equal(isReadOnlyBashCommand("rg token ../other"), false);
  assert.equal(isReadOnlyBashCommand("rg token src/auth.ts"), false);
  assert.equal(isReadOnlyBashCommand("rg --glob *.ts token"), false);
  assert.equal(isReadOnlyBashCommand("rg token leak"), false);
  assert.equal(isReadOnlyBashCommand("find -L leak -type f"), false);
  assert.equal(isReadOnlyBashCommand("rg -L token"), false);
  assert.equal(isReadOnlyBashCommand("rg -nL token"), false);
  assert.equal(isReadOnlyBashCommand("rg --follow token"), false);
  assert.equal(isReadOnlyBashCommand("find . -de''lete"), false);
  assert.equal(isReadOnlyBashCommand("find . -de\\lete"), false);
  assert.equal(isReadOnlyBashCommand("find . -de*"), false);
  assert.equal(isReadOnlyBashCommand("git diff --output=out"), false);
  assert.equal(isReadOnlyBashCommand("git diff --output out"), false);
  assert.equal(isReadOnlyBashCommand("rg token | head"), false);
});

test("finding-fixer shell permits listing but not content search", () => {
  for (const command of ["rg --files", "find src -type f"])
    assert.equal(isFindingFixerBashCommand(command), true, command);
  assert.equal(isFindingFixerBashCommand("rg -n finding"), false);
  for (const command of [
    "git diff",
    "npm test",
    "npm run check",
    "bun test",
    "bun run check",
    "npx tsc --noEmit",
    "curl https://production.example/deploy",
    "rm -rf src",
  ])
    assert.equal(isFindingFixerBashCommand(command), false, command);
});

test("finding-fixer paths reject Git administration data and every symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-fixer-root-"));
  const worktree = mkdtempSync(join(tmpdir(), "pi-fixer-worktree-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-fixer-outside-"));
  try {
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, ".git", "config"), "config");
    writeFileSync(join(root, "source.ts"), "ok");
    symlinkSync(join(root, ".git", "config"), join(root, "config-link"));
    symlinkSync(join(root, "src"), join(root, "src-link"));
    symlinkSync(
      join(outside, "nonexistent.ts"),
      join(root, "dangling-outside"),
    );
    linkSync(join(root, ".git", "config"), join(root, "config-hard-link"));
    assert.equal(isFindingFixerPathAllowed(root, "source.ts"), true);
    assert.equal(isFindingFixerPathAllowed(root, "new/nonexistent.ts"), true);
    assert.equal(isFindingFixerPathAllowed(root, ".git/config"), false);
    assert.equal(isFindingFixerPathAllowed(root, "config-link"), false);
    assert.equal(isFindingFixerPathAllowed(root, "src-link/new.ts"), false);
    assert.equal(isFindingFixerPathAllowed(root, "dangling-outside"), false);
    assert.equal(isFindingFixerPathAllowed(root, "config-hard-link"), false);

    mkdirSync(join(worktree, "admin"));
    writeFileSync(join(worktree, "admin", "config"), "config");
    writeFileSync(join(worktree, ".git"), "gitdir: admin\n");
    symlinkSync(
      join(worktree, "admin", "config"),
      join(worktree, "worktree-config-link"),
    );
    assert.equal(
      isFindingFixerPathAllowed(worktree, "worktree-config-link"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("synchronous Pi turn gate rejects overflow tools before their body", async () => {
  let mutations = 0;
  const tool = defineTool({
    name: "mutate",
    label: "mutate",
    description: "test mutation",
    parameters: Type.Object({}),
    async execute() {
      mutations++;
      return {
        content: [{ type: "text" as const, text: "mutated" }],
        details: {},
      };
    },
  });
  const session = {
    getAllTools: () => [
      {
        name: "mutate",
        description: "test mutation",
        parameters: tool.parameters,
      },
    ],
    getToolDefinition: (name: string) => (name === "mutate" ? tool : undefined),
  } as Pick<AgentSession, "getAllTools" | "getToolDefinition"> as AgentSession;
  const gate = createSynchronousTurnGate();
  gate.apply(session);
  assert.equal(
    gate.claim(() => true),
    true,
  );
  await tool.execute("accepted", {}, undefined, undefined, {} as never);
  assert.equal(
    gate.claim(() => false),
    false,
  );
  await assert.rejects(
    tool.execute("overflow", {}, undefined, undefined, {} as never),
    /rejected this overflow tool before execution/,
  );
  assert.equal(mutations, 1);
});

test("subagents reject bare sleep loops without blocking legitimate commands", () => {
  for (const command of [
    "sleep 180",
    "rtk sleep 30",
    "rtk sh -c 'sleep 180'",
    'bash -c "sleep 1m"',
  ]) {
    assert.equal(isIdleWaitCommand(command), true, command);
  }
  for (const command of [
    "codex exec review",
    "rtk codex exec review",
    "for i in 1 2; do check && exit; sleep 1; done",
    "cargo test",
  ]) {
    assert.equal(isIdleWaitCommand(command), false, command);
  }
});

test("subagents receive their bounded turn budget before starting", () => {
  assert.equal(DEFAULT_SUBAGENT_TURNS, 24);
  assert.equal(normalizeSubagentTurns(2), 4);
  assert.equal(normalizeSubagentTurns(100), 48);
  assert.equal(normalizeNestedWorkerTurns(1), 1);
  assert.equal(normalizeNestedWorkerTurns(2), 2);
  assert.equal(normalizeNestedWorkerTurns(3), 3);
  assert.equal(normalizeNestedWorkerTurns(100), 8);
  const prompt = withSubagentTurnBudget("Review this diff.", 24);
  assert.match(prompt, /24 assistant turns total/);
  assert.match(prompt, /verification by turn 22/);
  assert.match(prompt, /final two turns/);
  assert.match(prompt, /budget_request \{additional_turns, reason\}/);
  assert.match(prompt, /only the orchestrator may approve one extension/);
  assert.doesNotMatch(prompt, /Do not launch other agents/);
  assert.match(prompt, /Do not wait by polling or sleeping/);
});

test("read policy allows missing in-root paths but rejects outside and symlink escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-read-root-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-read-outside-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "inside.ts"), "");
    writeFileSync(join(root, "..existing"), "");
    writeFileSync(join(outside, "secret"), "no");
    symlinkSync(join(outside, "secret"), join(root, "src", "escape"));
    symlinkSync(outside, join(root, "outside-dir"));
    symlinkSync(join(outside, "missing"), join(root, "dangling"));

    assert.equal(isPathInsideRoot(root, "src/inside.ts", true), true);
    assert.equal(isPathInsideRoot(root, "..existing", true), true);
    assert.equal(isPathInsideRoot(root, "AGENTS.md", true), true);
    assert.equal(isPathInsideRoot(root, join(root, "AGENTS.md"), true), true);
    assert.equal(isPathInsideRoot(root, "src/nested/missing.ts", true), true);
    assert.equal(isPathInsideRoot(root, join(outside, "missing"), true), false);
    assert.equal(isPathInsideRoot(root, "../missing.ts", true), false);
    assert.equal(isPathInsideRoot(root, "src/escape", true), false);
    assert.equal(isPathInsideRoot(root, "outside-dir/missing.ts", true), false);
    assert.equal(isPathInsideRoot(root, "dangling", true), false);
    assert.equal(isPathInsideRoot(root, "dangling/child.ts", true), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("read confinement passes an allowed missing path through to normal read errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-read-root-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-read-outside-"));
  const missing = Object.assign(new Error("ENOENT: no such file"), {
    code: "ENOENT",
  });
  let calls = 0;
  const read = defineTool({
    name: "read",
    label: "read",
    description: "test read",
    parameters: Type.Object({ path: Type.String() }),
    async execute() {
      calls++;
      throw missing;
    },
  });
  const session = {
    getToolDefinition: (name: string) => (name === "read" ? read : undefined),
  } as Pick<AgentSession, "getToolDefinition"> as AgentSession;
  try {
    applyReadConfinement(session, root);
    await assert.rejects(
      read.execute(
        "missing",
        { path: "AGENTS.md" },
        undefined,
        undefined,
        {} as never,
      ),
      (error) => error === missing,
    );
    await assert.rejects(
      read.execute(
        "outside",
        { path: join(outside, "missing") },
        undefined,
        undefined,
        {} as never,
      ),
      /rejected a read outside its package root/,
    );
    assert.equal(calls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test(
  "read policy accepts missing paths through macOS /tmp aliases",
  { skip: process.platform !== "darwin" },
  () => {
    const root = mkdtempSync("/tmp/pi-read-root-");
    try {
      const canonicalRoot = realpathSync(root);
      assert.equal(isPathInsideRoot(root, "AGENTS.md", true), true);
      assert.equal(
        isPathInsideRoot(root, join(canonicalRoot, "AGENTS.md"), true),
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
