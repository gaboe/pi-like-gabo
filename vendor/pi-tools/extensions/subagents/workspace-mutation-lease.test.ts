import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { afterEach } from "node:test";
import {
  defineTool,
  type AgentSession,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import registerSubagents, {
  createParentUserBashGuard,
  createParentWorkspaceMutationGuard,
} from "./index.ts";
import {
  createLiveToolGate,
  createPiWorkspaceMutationGuard,
} from "./src/backends/pi.ts";
import { resolveWorkspaceMutationPath } from "../shared/resolve-to-cwd.ts";
import {
  acquireWorkspaceMutationLease,
  assertWorkspaceMutationLease,
  beginGlobalShellExecution,
  beginWorkspaceToolExecution,
  registerManagedWorkspaceWorker,
  registerUnconstrainedWorkspaceWorker,
  resetWorkspaceMutationRegistryForTests,
} from "../shared/workspace-mutation-lease.ts";

afterEach(resetWorkspaceMutationRegistryForTests);

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "pi-workspace-lease-"));
  mkdirSync(join(root, "packages", "one"), { recursive: true });
  symlinkSync(root, join(root, "alias"));
  return root;
}

function pathAliasCases(root: string, homeRoot: string, fileRoot: string) {
  const roots = {
    package: join(root, "pkg"),
    home: homeRoot,
    file: fileRoot,
    unicode: join(root, "unicode space"),
  };
  for (const target of Object.values(roots))
    mkdirSync(target, { recursive: true });
  return [
    { label: "@ alias", input: "@pkg/file.txt", root: roots.package },
    {
      label: "home alias",
      input: `~/${basename(homeRoot)}/file.txt`,
      root: roots.home,
    },
    {
      label: "file URL",
      input: pathToFileURL(join(fileRoot, "file.txt")).href,
      root: roots.file,
    },
    {
      label: "Unicode-space alias",
      input: "unicode\u00a0space/file.txt",
      root: roots.unicode,
    },
  ];
}

function mutationTools(onCall: () => void) {
  const write = defineTool({
    name: "write",
    label: "write",
    description: "test write",
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    async execute() {
      onCall();
      return {
        content: [{ type: "text" as const, text: "ok" }],
        details: {},
      };
    },
  });
  const edit = defineTool({ ...write, name: "edit", label: "edit" });
  return { write, edit };
}

test("shared resolver conforms to Pi 0.80.6 resolveToCwd semantics", () => {
  const cwd = join(tmpdir(), "resolver cwd");
  assert.equal(
    resolveWorkspaceMutationPath("pkg/file", cwd),
    resolve(cwd, "pkg/file"),
  );
  assert.equal(
    resolveWorkspaceMutationPath("@pkg/file", cwd),
    resolve(cwd, "pkg/file"),
  );
  assert.equal(
    resolveWorkspaceMutationPath("@@pkg/file", cwd),
    resolve(cwd, "@pkg/file"),
  );
  for (const space of "\u00a0\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000")
    assert.equal(
      resolveWorkspaceMutationPath(`unicode${space}space/file`, cwd),
      resolve(cwd, "unicode space/file"),
    );
  assert.equal(resolveWorkspaceMutationPath("~", cwd), homedir());
  assert.equal(
    resolveWorkspaceMutationPath("~/pkg/file", cwd),
    join(homedir(), "pkg/file"),
  );
  const absolute = resolve(tmpdir(), "absolute-file");
  assert.equal(resolveWorkspaceMutationPath(absolute, cwd), absolute);
  assert.equal(
    resolveWorkspaceMutationPath(pathToFileURL(absolute).href, cwd),
    absolute,
  );
  assert.equal(
    resolveWorkspaceMutationPath("file", "~"),
    join(homedir(), "file"),
  );
  assert.equal(
    resolveWorkspaceMutationPath("file", pathToFileURL(cwd).href),
    join(cwd, "file"),
  );
  if (process.platform === "win32")
    assert.equal(
      resolveWorkspaceMutationPath("~\\pkg\\file", cwd),
      join(homedir(), "pkg\\file"),
    );
  else
    assert.equal(
      resolveWorkspaceMutationPath("~\\pkg\\file", cwd),
      resolve(cwd, "~\\pkg\\file"),
    );
  assert.throws(
    () => resolveWorkspaceMutationPath(undefined, cwd),
    /must be a string/,
  );
  assert.throws(() => resolveWorkspaceMutationPath("file://%", cwd));
});

test("canonical same, ancestor, descendant, and symlink roots overlap", () => {
  const root = workspace();
  try {
    const parent = registerManagedWorkspaceWorker(root);
    const lease = acquireWorkspaceMutationLease(join(root, "packages"), parent);
    assert.throws(
      () => registerManagedWorkspaceWorker(join(root, "packages", "one")),
      /active exclusive lease/,
    );
    assert.throws(
      () => registerManagedWorkspaceWorker(join(root, "alias", "packages")),
      /active exclusive lease/,
    );
    assert.throws(() => acquireWorkspaceMutationLease(root), /active lease/);
    lease.close();
    lease.close();
    parent.close();
    registerManagedWorkspaceWorker(join(root, "packages", "one")).close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lease rejects active tools and process-global shell or unconstrained-worker risk", () => {
  const root = workspace();
  try {
    const tool = beginWorkspaceToolExecution(root);
    assert.throws(
      () => acquireWorkspaceMutationLease(root),
      /tool is executing/,
    );
    tool.close();

    const shell = beginGlobalShellExecution();
    assert.throws(
      () => acquireWorkspaceMutationLease(join(root, "packages")),
      /shell is executing/,
    );
    shell.close();
    assert.throws(
      () => acquireWorkspaceMutationLease(root),
      /observed shell execution may have retained descendants/,
    );

    resetWorkspaceMutationRegistryForTests();
    const worker = registerUnconstrainedWorkspaceWorker();
    assert.throws(
      () => acquireWorkspaceMutationLease(root),
      /unconstrained worker is live/,
    );
    worker.close();
    assert.throws(
      () => acquireWorkspaceMutationLease(root),
      /observed unconstrained worker may have retained descendants/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("separate module graphs share registry state and owner validity", async () => {
  const root = workspace();
  try {
    const specifier =
      "../shared/workspace-mutation-lease.ts?separate-module-graph";
    const other = await import(specifier);
    const lease = acquireWorkspaceMutationLease(root);
    assert.doesNotThrow(() =>
      other.assertWorkspaceMutationLease(lease.owner, root),
    );
    assert.throws(
      () => other.beginGlobalShellExecution(),
      /active exclusive lease/,
    );
    lease.close();
    const shell = other.beginGlobalShellExecution();
    assert.throws(
      () => acquireWorkspaceMutationLease(root),
      /shell is executing/,
    );
    shell.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner token expires on release and cannot authorize later mutation", () => {
  const root = workspace();
  try {
    const lease = acquireWorkspaceMutationLease(root);
    assert.doesNotThrow(() => assertWorkspaceMutationLease(lease.owner, root));
    lease.close();
    assert.throws(
      () => assertWorkspaceMutationLease(lease.owner, root),
      /invalid or expired/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registered extension blocks parent write/edit aliases before dispatch and releases lifecycle activity", async () => {
  const root = workspace();
  const fileRoot = workspace();
  const homeRoot = mkdtempSync(join(homedir(), "pi-workspace-lease-home-"));
  try {
    const handlers = new Map<string, (event: any, ctx?: any) => any>();
    const pi = {
      events: { emit() {}, on() {} },
      on(name: string, handler: (event: any, ctx?: any) => any) {
        handlers.set(name, handler);
      },
      registerTool() {},
      registerMessageRenderer() {},
      registerCommand() {},
      getThinkingLevel() {},
      sendMessage() {},
    };
    registerSubagents(pi as never);
    const sessionStart = handlers.get("session_start")!;
    const toolCall = handlers.get("tool_call")!;
    const toolEnd = handlers.get("tool_execution_end")!;
    sessionStart({}, { cwd: root, hasUI: false, isIdle: () => false });

    let bodyCalls = 0;
    const dispatch = (toolName: string, path: string, toolCallId: string) => {
      const result = toolCall({
        toolName,
        path: undefined,
        input: { path },
        toolCallId,
      });
      if (!result?.block) bodyCalls++;
      return result;
    };
    for (const alias of pathAliasCases(root, homeRoot, fileRoot)) {
      const blockedBaseline = bodyCalls;
      const fixer = registerManagedWorkspaceWorker(alias.root);
      const lease = acquireWorkspaceMutationLease(alias.root, fixer);
      for (const toolName of ["write", "edit"]) {
        const toolCallId = `${alias.label}-${toolName}`;
        const result = dispatch(toolName, alias.input, toolCallId);
        assert.deepEqual(result?.block, true, `${alias.label} ${toolName}`);
        assert.match(result?.reason ?? "", /active exclusive lease/);
        toolEnd({ toolCallId });
      }
      assert.equal(bodyCalls, blockedBaseline, alias.label);
      lease.close();
      fixer.close();
      const activity = dispatch(
        "write",
        alias.input,
        `${alias.label}-released`,
      );
      assert.equal(activity, undefined);
      assert.throws(
        () => acquireWorkspaceMutationLease(alias.root),
        /tool is executing/,
      );
      toolEnd({ toolCallId: `${alias.label}-released` });
      acquireWorkspaceMutationLease(alias.root).close();
    }
    assert.equal(bodyCalls, 4);
    await handlers.get("session_shutdown")!({});
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fileRoot, { recursive: true, force: true });
    rmSync(homeRoot, { recursive: true, force: true });
  }
});

test("parent guard derives write/edit targets and treats bash process-globally", () => {
  const root = workspace();
  const outside = workspace();
  try {
    const guard = createParentWorkspaceMutationGuard(root);
    const outsideLease = acquireWorkspaceMutationLease(outside);
    for (const name of ["write", "edit"])
      assert.match(
        guard.start(name, name, { path: join(outside, "absolute.txt") }) ?? "",
        /active exclusive lease/,
      );
    assert.match(guard.start("bash", "bash") ?? "", /active exclusive lease/);
    outsideLease.close();

    assert.equal(
      guard.start("write", "write", { path: join(outside, "absolute.txt") }),
      undefined,
    );
    assert.throws(
      () => acquireWorkspaceMutationLease(outside),
      /tool is executing/,
    );
    guard.end("write");
    assert.equal(guard.start("bash", "bash"), undefined);
    guard.end("bash");
    assert.throws(
      () => acquireWorkspaceMutationLease(outside),
      /observed shell execution may have retained descendants/,
    );
    guard.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("parent write and edit guards resolve Pi path aliases before blocking", () => {
  const root = workspace();
  const fileRoot = workspace();
  const homeRoot = mkdtempSync(join(homedir(), "pi-workspace-lease-home-"));
  try {
    const guard = createParentWorkspaceMutationGuard(root);
    let bodyCalls = 0;
    for (const alias of pathAliasCases(root, homeRoot, fileRoot)) {
      const lease = acquireWorkspaceMutationLease(alias.root);
      for (const name of ["write", "edit"]) {
        const reason = guard.start(`${alias.label}-${name}`, name, {
          path: alias.input,
        });
        if (!reason) {
          bodyCalls++;
          guard.end(`${alias.label}-${name}`);
        }
        assert.match(reason ?? "", /active exclusive lease/, alias.label);
      }
      lease.close();
    }
    for (const path of [undefined, 42, "file://%"] as const) {
      for (const name of ["write", "edit"]) {
        const reason = guard.start(`invalid-${String(path)}-${name}`, name, {
          path,
        });
        if (!reason) bodyCalls++;
        assert.ok(reason, `${name} must reject ${String(path)}`);
      }
    }
    assert.equal(bodyCalls, 0);
    guard.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fileRoot, { recursive: true, force: true });
    rmSync(homeRoot, { recursive: true, force: true });
  }
});

test("Pi write and edit guards resolve Pi path aliases before body", async () => {
  const root = workspace();
  const fileRoot = workspace();
  const homeRoot = mkdtempSync(join(homedir(), "pi-workspace-lease-home-"));
  try {
    let bodyCalls = 0;
    const tools = mutationTools(() => bodyCalls++);
    const session = {
      getToolDefinition: (name: string) => tools[name as keyof typeof tools],
    } as Pick<AgentSession, "getToolDefinition"> as AgentSession;
    createPiWorkspaceMutationGuard(root).apply(session);

    for (const alias of pathAliasCases(root, homeRoot, fileRoot)) {
      const lease = acquireWorkspaceMutationLease(alias.root);
      for (const [name, tool] of Object.entries(tools))
        await assert.rejects(
          tool.execute(
            `${alias.label}-${name}`,
            { path: alias.input },
            undefined,
            undefined,
            {} as never,
          ),
          /active exclusive lease/,
          alias.label,
        );
      lease.close();
    }
    for (const path of [undefined, 42, "file://%"] as const)
      for (const [name, tool] of Object.entries(tools))
        await assert.rejects(
          tool.execute(
            `invalid-${String(path)}-${name}`,
            { path },
            undefined,
            undefined,
            {} as never,
          ),
        );
    assert.equal(bodyCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fileRoot, { recursive: true, force: true });
    rmSync(homeRoot, { recursive: true, force: true });
  }
});

test("Pi tool guard checks canonical params.path before body and confines owner", async () => {
  const root = workspace();
  const outside = workspace();
  try {
    let calls = 0;
    const tools = mutationTools(() => calls++);
    const { write } = tools;
    const session = {
      getToolDefinition: (name: string) => tools[name as keyof typeof tools],
    } as Pick<AgentSession, "getToolDefinition"> as AgentSession;
    const lease = acquireWorkspaceMutationLease(root);

    createPiWorkspaceMutationGuard(root).apply(session);
    for (const [name, tool] of Object.entries(tools))
      await assert.rejects(
        tool.execute(
          name,
          { path: "inside.txt" },
          undefined,
          undefined,
          {} as never,
        ),
        /active exclusive lease/,
      );
    assert.equal(calls, 0);
    lease.close();

    const outsideLease = acquireWorkspaceMutationLease(outside);
    for (const [name, tool] of Object.entries(tools))
      await assert.rejects(
        tool.execute(
          `cross-cwd-${name}`,
          { path: join(outside, "absolute.txt") },
          undefined,
          undefined,
          {} as never,
        ),
        /active exclusive lease/,
      );
    assert.equal(calls, 0);
    outsideLease.close();

    const ownedLease = acquireWorkspaceMutationLease(root);
    const ownedWrite = defineTool({
      ...write,
      execute: async () => {
        calls++;
        return {
          content: [{ type: "text" as const, text: "ok" }],
          details: {},
        };
      },
    });
    const ownedSession = {
      getAllTools: () => [{ name: "write" }],
      getToolDefinition: (name: string) =>
        name === "write" ? ownedWrite : undefined,
    } as Pick<
      AgentSession,
      "getAllTools" | "getToolDefinition"
    > as AgentSession;
    createPiWorkspaceMutationGuard(root, ownedLease.owner).apply(ownedSession);
    let revoked = false;
    createLiveToolGate(
      () => (revoked ? "terminal TODO" : undefined),
      "Package Worker authority revoked",
    ).apply(ownedSession);
    await assert.rejects(
      ownedWrite.execute(
        "owner-escape",
        { path: join(outside, "absolute.txt") },
        undefined,
        undefined,
        {} as never,
      ),
      /invalid or expired/,
    );
    revoked = true;
    await assert.rejects(
      ownedWrite.execute(
        "revoked-owner",
        { path: "owned.txt" },
        undefined,
        undefined,
        {} as never,
      ),
      /Package Worker authority revoked: terminal TODO/,
    );
    assert.equal(calls, 0);
    revoked = false;
    await ownedWrite.execute(
      "owned",
      { path: "owned.txt" },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(calls, 1);
    ownedLease.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("user_bash reserves before exec and blocks leases during the event gap", async () => {
  const root = workspace();
  try {
    let bodyCalls = 0;
    const guard = createParentUserBashGuard({
      async exec() {
        bodyCalls++;
        return { exitCode: 0 };
      },
    });
    const reserved = guard.begin();
    assert.ok("operations" in reserved);
    assert.throws(
      () => acquireWorkspaceMutationLease(root),
      /shell is executing/,
    );
    const operations = reserved.operations;
    assert.ok(operations);
    await operations.exec("true", root, { onData() {} });
    assert.equal(bodyCalls, 1);
    assert.throws(
      () => acquireWorkspaceMutationLease(root),
      /observed shell execution may have retained descendants/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("user_bash returns a full blocked result without executing the body", () => {
  const root = workspace();
  try {
    let bodyCalls = 0;
    const guard = createParentUserBashGuard({
      async exec() {
        bodyCalls++;
        return { exitCode: 0 };
      },
    });
    const lease = acquireWorkspaceMutationLease(root);
    assert.deepEqual(guard.begin(), {
      result: {
        output:
          "Shell execution blocked by an active workspace mutation lease.",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    });
    assert.equal(bodyCalls, 0);
    lease.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("user_bash closes active reservations after success, error, and cancellation", async () => {
  const root = workspace();
  try {
    for (const outcome of ["completed", "failed", "cancelled"] as const) {
      resetWorkspaceMutationRegistryForTests();
      const controller = new AbortController();
      if (outcome === "cancelled") controller.abort();
      const guard = createParentUserBashGuard({
        async exec(_command, _cwd, options) {
          assert.equal(options.signal?.aborted, outcome === "cancelled");
          if (outcome === "failed") throw new Error("expected failure");
          if (outcome === "cancelled") throw new Error("aborted");
          return { exitCode: 0 };
        },
      });
      const reserved = guard.begin();
      const operations = reserved.operations;
      assert.ok(operations);
      const execution = operations.exec(outcome, root, {
        onData() {},
        signal: controller.signal,
      });
      if (outcome === "completed") await execution;
      else
        await assert.rejects(
          execution,
          outcome === "failed" ? /expected/ : /aborted/,
        );
      assert.throws(
        () => acquireWorkspaceMutationLease(root),
        /observed shell execution may have retained descendants/,
        outcome,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session shutdown closes a never-executed user_bash reservation", () => {
  const root = workspace();
  try {
    let bodyCalls = 0;
    const guard = createParentUserBashGuard({
      async exec() {
        bodyCalls++;
        return { exitCode: 0 };
      },
    });
    const reserved = guard.begin();
    assert.ok("operations" in reserved);
    assert.throws(
      () => acquireWorkspaceMutationLease(root),
      /shell is executing/,
    );
    guard.close();
    assert.equal(bodyCalls, 0);
    assert.throws(
      () => acquireWorkspaceMutationLease(root),
      /observed shell execution may have retained descendants/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
