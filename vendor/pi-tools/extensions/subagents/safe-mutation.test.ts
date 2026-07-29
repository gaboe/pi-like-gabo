import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import {
  createSafeMutationContext,
  haveSameFileIdentity,
  isMutationCwdAllowed,
  SAFE_MUTATION_MAX_CONTENT_BYTES,
  safeCreate,
  safeRead,
  safeReplace,
  SafeMutationError,
} from "./src/safe-mutation.ts";

const buildRoot = mkdtempSync(join(tmpdir(), "pi-safe-writer-build-"));
const helper = join(buildRoot, "pi-safe-writer");

before(() => {
  execFileSync(process.execPath, ["scripts/build-native.mjs"], {
    cwd: import.meta.dirname,
    env: {
      ...process.env,
      PI_SAFE_WRITER_BUILD_OUTPUT: helper,
      PI_SAFE_WRITER_TESTING: "1",
    },
    stdio: "inherit",
  });
});

after(() => rmSync(buildRoot, { recursive: true, force: true }));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-safe-writer-root-"));
  const context = createSafeMutationContext(root, helper);
  return {
    root,
    context,
    close() {
      context.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function rejectsCode(operation: Promise<unknown>, code: string) {
  await assert.rejects(
    operation,
    (error) => error instanceof SafeMutationError && error.code === code,
  );
}

async function executeRead(
  context: ReturnType<typeof createSafeMutationContext>,
  path: string,
) {
  const read = context.tools.find((tool) => tool.name === "read")!;
  return read.execute("read-call", { path }, undefined, undefined, {} as never);
}

function runNative(
  root: string,
  args: string[],
  input: Buffer,
  stop?:
    | "writing"
    | "precommit"
    | "prepublish"
    | "postexchange"
    | "postrename"
    | "postcommit"
    | "final-byte-scan"
    | "final-xattr-scan"
    | "reconcile-post-classification"
    | "reconcile-post-fsync"
    | "reconcile-final-byte-scan"
    | "reconcile-final-xattr-scan",
  faults: Record<string, string> = {},
) {
  const rootFd = openSync(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const child = spawn(helper, args, {
    env: {
      ...process.env,
      ...faults,
      ...(stop ? { PI_SAFE_WRITER_TEST_STOP: stop } : {}),
    },
    stdio: ["pipe", "pipe", "pipe", rootFd, "pipe"],
  });
  closeSync(rootFd);
  const stdin = child.stdin;
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  if (!stdin || !childStdout || !childStderr)
    throw new Error("native helper pipes unavailable");
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  childStdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  childStderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  stdin.end(input);
  const result = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: Buffer;
    stderr: Buffer;
  }>((resolve) => {
    child.on("close", (code, signal) =>
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }),
    );
  });
  return { child, marker: child.stdio[4]!, result };
}

function setTestXattr(path: string) {
  const result =
    process.platform === "darwin"
      ? spawnSync("xattr", ["-w", "user.pi_safe_writer_race", "x", path], {
          encoding: "utf8",
        })
      : spawnSync(
          "python3",
          [
            "-c",
            "import os,sys; os.setxattr(sys.argv[1], b'user.pi_safe_writer_race', b'x')",
            path,
          ],
          { encoding: "utf8" },
        );
  assert.equal(
    result.status,
    0,
    result.stderr || result.error?.message || "xattr mutation failed",
  );
}

test("helper compiles and replaces while preserving ownership and mode bits", async () => {
  const f = fixture();
  try {
    const path = join(f.root, "source.ts");
    writeFileSync(path, "old");
    chmodSync(path, 0o6751);
    const beforeStat = lstatSync(path);
    const expected = await safeRead(f.context, "source.ts");
    await safeReplace(f.context, "source.ts", expected, "new");
    const afterStat = lstatSync(path);
    assert.equal(readFileSync(path, "utf8"), "new");
    assert.notEqual(afterStat.ino, beforeStat.ino);
    assert.equal(afterStat.mode & 0o7777, beforeStat.mode & 0o7777);
    assert.equal(afterStat.uid, beforeStat.uid);
    assert.equal(afterStat.gid, beforeStat.gid);
    assert.equal(afterStat.nlink, 1);
    assert.equal(afterStat.size, Buffer.byteLength("new"));
  } finally {
    f.close();
  }
});

test("TypeScript rejects structurally invalid native receipt fingerprints", async () => {
  for (const fingerprint of [
    Buffer.alloc(0),
    (() => {
      const value = Buffer.alloc(136);
      value.write("PISWFP2\0", "ascii");
      value.writeBigUInt64BE(1n, 80);
      return value;
    })(),
  ]) {
    const root = mkdtempSync(join(tmpdir(), "pi-safe-receipt-"));
    const fake = join(root, "fake-helper");
    const receipt = Buffer.alloc(24 + fingerprint.length);
    receipt.write("PISWRC2\0", "ascii");
    receipt.writeBigUInt64BE(1n, 8);
    receipt.writeBigUInt64BE(BigInt(fingerprint.length), 16);
    fingerprint.copy(receipt, 24);
    writeFileSync(
      fake,
      `#!/usr/bin/env node\nprocess.stdout.write(Buffer.from(${JSON.stringify(receipt.toString("base64"))}, "base64"));\n`,
      { mode: 0o755 },
    );
    const context = createSafeMutationContext(root, fake);
    try {
      await rejectsCode(safeCreate(context, "target", "new"), "AMBIGUOUS");
      assert.equal(existsSync(join(root, "target")), false);
    } finally {
      context.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("replacement preserves all target xattrs and rejects a precommit race", async () => {
  for (const stage of ["initial", "precommit"] as const) {
    const f = fixture();
    try {
      writeFileSync(join(f.root, "target"), "old");
      const running = runNative(
        f.root,
        ["replace", "target", "3", "3"],
        Buffer.from("oldnew"),
        stage === "precommit" ? "precommit" : undefined,
        { PI_SAFE_WRITER_TEST_ADD_XATTR: stage },
      );
      if (stage === "precommit") {
        await once(running.marker, "data");
        running.child.kill("SIGCONT");
      }
      const result = await running.result;
      assert.equal(result.code, stage === "initial" ? 0 : 1, stage);
      if (stage === "precommit")
        assert.match(result.stderr.toString(), /SAFE_WRITE:METADATA/, stage);
      assert.equal(
        readFileSync(join(f.root, "target"), "utf8"),
        stage === "initial" ? "new" : "old",
      );
      assert.equal(
        readdirSync(f.root).some((name) => name.startsWith(".pi-safe-write-")),
        false,
      );
    } finally {
      f.close();
    }
  }
});

test("replacement rejects platform file flags before publication", async (t) => {
  const f = fixture();
  try {
    const target = join(f.root, "target");
    writeFileSync(target, "old");
    const configured =
      process.platform === "darwin"
        ? spawnSync("chflags", ["nodump", target], { encoding: "utf8" })
        : process.platform === "linux"
          ? spawnSync("chattr", ["+d", target], { encoding: "utf8" })
          : undefined;
    if (!configured || configured.error || configured.status !== 0)
      return t.skip(
        "filesystem or platform tool does not support a safe nodump flag",
      );
    await rejectsCode(
      safeReplace(f.context, "target", "old", "new"),
      "METADATA",
    );
    assert.equal(readFileSync(target, "utf8"), "old");
  } finally {
    f.close();
  }
});

test("descriptor walk rejects symlinks and swapped targets", async () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), "pi-safe-writer-outside-"));
  try {
    mkdirSync(join(f.root, "real"));
    writeFileSync(join(f.root, "real", "file"), "old");
    writeFileSync(join(outside, "outside"), "secret");
    symlinkSync(join(f.root, "real"), join(f.root, "middle"));
    symlinkSync(join(outside, "outside"), join(f.root, "final"));
    symlinkSync(join(outside, "missing"), join(f.root, "dangling"));
    await rejectsCode(safeCreate(f.context, "middle/new", "x"), "SYMLINK");
    await rejectsCode(safeRead(f.context, "final"), "SYMLINK");
    await rejectsCode(safeCreate(f.context, "dangling", "x"), "SYMLINK");

    const expected = await safeRead(f.context, "real/file");
    unlinkSync(join(f.root, "real", "file"));
    symlinkSync(join(outside, "outside"), join(f.root, "real", "file"));
    await rejectsCode(
      safeReplace(f.context, "real/file", expected, "changed"),
      "SYMLINK",
    );
    assert.equal(readFileSync(join(outside, "outside"), "utf8"), "secret");
  } finally {
    f.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("dangling intermediate symlinks fail closed for create, write, replace, and edit", async () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), "pi-safe-writer-outside-"));
  try {
    writeFileSync(join(outside, "outside"), "secret");
    symlinkSync(join(outside, "missing"), join(f.root, "middle"));
    const tools = Object.fromEntries(
      f.context.tools.map((tool) => [tool.name, tool]),
    );
    await rejectsCode(safeCreate(f.context, "middle/new", "x"), "SYMLINK");
    await rejectsCode(
      safeReplace(f.context, "middle/file", Buffer.from("old"), "x"),
      "SYMLINK",
    );
    await rejectsCode(
      tools.write!.execute(
        "write",
        { path: "middle/new", content: "x" },
        undefined,
        undefined,
        {} as never,
      ),
      "SYMLINK",
    );
    await rejectsCode(
      tools.edit!.execute(
        "edit",
        { path: "middle/file", edits: [{ oldText: "old", newText: "x" }] },
        undefined,
        undefined,
        {} as never,
      ),
      "SYMLINK",
    );
    assert.equal(readFileSync(join(outside, "outside"), "utf8"), "secret");
    assert.equal(existsSync(join(outside, "missing")), false);
  } finally {
    f.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("installed nested read rejects hardlink, FIFO, device, and symlink content", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "file"), "one");
    linkSync(join(f.root, "file"), join(f.root, "alias"));
    const fifo = join(f.root, "pipe");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    symlinkSync(join(f.root, "file"), join(f.root, "link"));
    await rejectsCode(executeRead(f.context, "file"), "HARDLINK");
    await rejectsCode(executeRead(f.context, "pipe"), "TYPE");
    await rejectsCode(executeRead(f.context, "link"), "SYMLINK");

    const devices = createSafeMutationContext("/dev", helper);
    try {
      await rejectsCode(executeRead(devices, "null"), "TYPE");
    } finally {
      devices.close();
    }
  } finally {
    f.close();
  }
});

test("case-varied Git components and helper aliases fail by identity", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, ".git"));
    writeFileSync(join(f.root, ".git", "config"), "x");
    await rejectsCode(safeRead(f.context, ".GiT/config"), "GIT_ADMIN");
    const native = runNative(f.root, ["read", ".GIT/config"], Buffer.alloc(0));
    const nativeResult = await native.result;
    assert.equal(nativeResult.code, 1);
    assert.match(nativeResult.stderr.toString(), /SAFE_WRITE:GIT_ADMIN/);

    const alias = join(f.root, "PI-SAFE-WRITER");
    linkSync(helper, alias);
    assert.equal(haveSameFileIdentity(helper, alias), true);
    await rejectsCode(safeRead(f.context, "PI-SAFE-WRITER"), "HELPER");

    const caseAliasExists = (() => {
      try {
        return haveSameFileIdentity(join(f.root, ".git"), join(f.root, ".GIT"));
      } catch {
        return false;
      }
    })();
    if (caseAliasExists)
      await rejectsCode(safeRead(f.context, ".GIT/config"), "GIT_ADMIN");
  } finally {
    f.close();
  }
});

test("structural bare repositories reject every core.bare form and descendant", () => {
  const forms = [
    "bare",
    "bare = true",
    "bare = yes",
    "bare = on",
    "bare = 1",
    "bare = false",
  ];
  for (const form of forms) {
    const bare = mkdtempSync(join(tmpdir(), "pi-safe-bare-"));
    try {
      mkdirSync(join(bare, "objects"));
      mkdirSync(join(bare, "refs"));
      mkdirSync(join(bare, "worktrees", "topic"), { recursive: true });
      writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(bare, "config"), `[core]\n\t${form}\n`);
      for (const path of [
        bare,
        join(bare, "refs"),
        join(bare, "objects"),
        join(bare, "worktrees", "topic"),
      ])
        assert.equal(isMutationCwdAllowed(path), false, form);
      assert.throws(
        () => createSafeMutationContext(join(bare, "objects"), helper),
        (error) =>
          error instanceof SafeMutationError && error.code === "GIT_ADMIN",
      );
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  }
});

test("nested structural bare Git ancestors are forbidden without false positives", async () => {
  const f = fixture();
  try {
    const bare = join(f.root, "vendor", "repo.git");
    mkdirSync(join(bare, "objects"), { recursive: true });
    mkdirSync(join(bare, "refs", "heads"), { recursive: true });
    writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(bare, "config"), "[core]\n\tbare = true\n");
    writeFileSync(join(bare, "refs", "heads", "main"), "0".repeat(40));
    for (const path of [
      "vendor/repo.git/HEAD",
      "vendor/repo.git/config",
      "vendor/repo.git/refs/heads/main",
      "vendor/repo.git/new/file",
    ])
      await rejectsCode(safeRead(f.context, path), "GIT_ADMIN");

    const ordinary = join(f.root, "ordinary");
    mkdirSync(join(ordinary, "objects"), { recursive: true });
    writeFileSync(join(ordinary, "HEAD"), "meeting notes");
    writeFileSync(join(ordinary, "note"), "safe");
    assert.equal(
      (await safeRead(f.context, "ordinary/note")).toString(),
      "safe",
    );
  } finally {
    f.close();
  }
});

test("nested bare Git missing, irregular, and symlink markers fail closed", async () => {
  for (const marker of ["HEAD", "config", "objects", "refs"] as const) {
    for (const variant of ["missing", "irregular", "symlink"] as const) {
      const f = fixture();
      try {
        const bare = join(f.root, "nested", "repo.git");
        mkdirSync(join(bare, "objects"), { recursive: true });
        mkdirSync(join(bare, "refs"));
        writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");
        writeFileSync(join(bare, "config"), "[core]\n\tbare = true\n");
        rmSync(join(bare, marker), { recursive: true });
        if (variant === "symlink")
          symlinkSync(join(f.root, "missing-marker"), join(bare, marker));
        else if (variant === "irregular") {
          if (marker === "objects" || marker === "refs")
            writeFileSync(join(bare, marker), "malformed");
          else mkdirSync(join(bare, marker));
        }
        await rejectsCode(
          safeRead(f.context, "nested/repo.git/probe"),
          "GIT_ADMIN",
        );
      } finally {
        f.close();
      }
    }
  }
});

test("cooperative replace CAS serializes across helper processes", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "file"), "expected");
    const results = await Promise.allSettled([
      safeReplace(f.context, "file", "expected", "first"),
      safeReplace(f.context, "file", "expected", "second"),
    ]);
    assert.equal(
      results.filter(({ status }) => status === "fulfilled").length,
      1,
    );
    const rejection = results.find(({ status }) => status === "rejected");
    assert.equal(rejection?.status, "rejected");
    if (rejection?.status === "rejected")
      assert.equal(rejection.reason.code, "CAS");
    assert.ok(
      ["first", "second"].includes(readFileSync(join(f.root, "file"), "utf8")),
    );
  } finally {
    f.close();
  }
});

test("atomic publication rejects raced replace and create without clobbering victims", async () => {
  for (const operation of ["replace", "create"] as const) {
    const f = fixture();
    try {
      const target = join(f.root, "target");
      if (operation === "replace") writeFileSync(target, "old");
      const running = runNative(
        f.root,
        operation === "replace"
          ? ["replace", "target", "3", "3"]
          : ["create", "target", "0", "3"],
        operation === "replace" ? Buffer.from("oldnew") : Buffer.from("new"),
        "prepublish",
      );
      await once(running.marker, "data");
      if (operation === "replace") renameSync(target, join(f.root, "original"));
      writeFileSync(target, "victim");
      running.child.kill("SIGCONT");
      const result = await running.result;
      assert.equal(result.code, 1, operation);
      assert.match(result.stderr.toString(), /SAFE_WRITE:(CAS|SYMLINK)/);
      assert.equal(readFileSync(target, "utf8"), "victim");
      if (operation === "replace")
        assert.equal(readFileSync(join(f.root, "original"), "utf8"), "old");
      assert.equal(
        readdirSync(f.root).some((name) => name.startsWith(".pi-safe-write-")),
        false,
      );
    } finally {
      f.close();
    }
  }
});

test("failed rollback preserves exchanged victim in private staging", async () => {
  const f = fixture();
  try {
    const target = join(f.root, "target");
    writeFileSync(target, "old");
    const running = runNative(
      f.root,
      ["replace", "target", "3", "3"],
      Buffer.from("oldnew"),
      "prepublish",
      { PI_SAFE_WRITER_TEST_ROLLBACK_FAIL: "exchange" },
    );
    await once(running.marker, "data");
    renameSync(target, join(f.root, "original"));
    writeFileSync(target, "victim");
    running.child.kill("SIGCONT");
    const result = await running.result;
    assert.equal(result.code, 1);
    assert.match(result.stderr.toString(), /SAFE_WRITE:AMBIGUOUS/);
    assert.equal(readFileSync(target, "utf8"), "new");
    assert.equal(readFileSync(join(f.root, "original"), "utf8"), "old");
    const stage = readdirSync(f.root).find((name) =>
      name.startsWith(".pi-safe-write-"),
    )!;
    assert.equal(readFileSync(join(f.root, stage, "file"), "utf8"), "victim");
    assert.equal(
      readFileSync(join(f.root, stage, "victim-preserved"), "utf8"),
      "preserved\n",
    );
  } finally {
    f.close();
  }
});

test("post-exchange metadata race rolls back without losing old inode", async () => {
  const f = fixture();
  try {
    const target = join(f.root, "target");
    writeFileSync(target, "old", { mode: 0o644 });
    const running = runNative(
      f.root,
      ["replace", "target", "3", "3"],
      Buffer.from("oldnew"),
      "postexchange",
    );
    await once(running.marker, "data");
    const stage = readdirSync(f.root).find((name) =>
      name.startsWith(`.pi-safe-write-${running.child.pid}-`),
    )!;
    chmodSync(join(f.root, stage, "file"), 0o600);
    running.child.kill("SIGCONT");
    const result = await running.result;
    assert.equal(result.code, 1);
    assert.match(result.stderr.toString(), /SAFE_WRITE:CAS/);
    assert.equal(readFileSync(target, "utf8"), "old");
    assert.equal(lstatSync(target).mode & 0o777, 0o600);
  } finally {
    f.close();
  }
});

test(
  "staging stays private during write/precommit and TERM removes it",
  { timeout: 5_000 },
  async () => {
    for (const stop of ["writing", "precommit"] as const) {
      const f = fixture();
      try {
        writeFileSync(join(f.root, "file"), "old");
        chmodSync(join(f.root, "file"), 0o6751);
        const running = runNative(
          f.root,
          ["replace", "file", "3", "3"],
          Buffer.from("oldnew"),
          stop,
        );
        await once(running.marker, "data");
        const stage = readdirSync(f.root).find((name) =>
          name.startsWith(`.pi-safe-write-${running.child.pid}-`),
        );
        assert.match(stage ?? "", /^\.pi-safe-write-[1-9][0-9]*-[0-9]+$/);
        const stagePath = join(f.root, stage!);
        assert.equal(lstatSync(stagePath).mode & 0o7777, 0o700);
        const staged = lstatSync(join(stagePath, "file"));
        assert.equal(staged.size, stop === "writing" ? 0 : 3);
        assert.equal(staged.mode & 0o7777, stop === "writing" ? 0o600 : 0o6751);
        assert.equal(readFileSync(join(f.root, "file"), "utf8"), "old");
        assert.equal(
          readdirSync(f.root).some(
            (name) =>
              name.startsWith(".pi-safe-write-") &&
              !lstatSync(join(f.root, name)).isDirectory(),
          ),
          false,
        );
        running.child.kill("SIGTERM");
        running.child.kill("SIGCONT");
        const result = await running.result;
        assert.equal(result.code, 2);
        assert.equal(readFileSync(join(f.root, "file"), "utf8"), "old");
        assert.equal(
          readdirSync(f.root).some((name) =>
            name.startsWith(".pi-safe-write-"),
          ),
          false,
        );
      } finally {
        f.close();
      }
    }
  },
);

test(
  "precommit staged hardlink or byte tamper fails without publication",
  { timeout: 5_000 },
  async () => {
    for (const attack of ["hardlink", "bytes"] as const) {
      const f = fixture();
      try {
        writeFileSync(join(f.root, "target"), "old");
        const running = runNative(
          f.root,
          ["replace", "target", "3", "3"],
          Buffer.from("oldnew"),
          "precommit",
        );
        await once(running.marker, "data");
        const stage = readdirSync(f.root).find((name) =>
          name.startsWith(`.pi-safe-write-${running.child.pid}-`),
        )!;
        const staged = join(f.root, stage, "file");
        if (attack === "hardlink") linkSync(staged, join(f.root, "retained"));
        else writeFileSync(staged, "bad");
        running.child.kill("SIGCONT");
        const result = await running.result;
        assert.equal(result.code, 1, attack);
        assert.match(
          result.stderr.toString(),
          attack === "hardlink" ? /SAFE_WRITE:HARDLINK/ : /SAFE_WRITE:CAS/,
        );
        assert.equal(readFileSync(join(f.root, "target"), "utf8"), "old");
        assert.equal(
          readdirSync(f.root).some((name) =>
            name.startsWith(".pi-safe-write-"),
          ),
          false,
        );
      } finally {
        f.close();
      }
    }
  },
);

test(
  "post-publication hardlink or byte tamper cannot report success",
  { timeout: 5_000 },
  async () => {
    for (const attack of ["hardlink", "bytes"] as const) {
      const f = fixture();
      try {
        writeFileSync(join(f.root, "target"), "old");
        const running = runNative(
          f.root,
          ["replace", "target", "3", "3"],
          Buffer.from("oldnew"),
          "postrename",
        );
        await once(running.marker, "data");
        if (attack === "hardlink")
          linkSync(join(f.root, "target"), join(f.root, "retained"));
        else writeFileSync(join(f.root, "target"), "bad");
        running.child.kill("SIGCONT");
        const result = await running.result;
        assert.equal(result.code, 1, attack);
        assert.match(result.stderr.toString(), /SAFE_WRITE:AMBIGUOUS/);
      } finally {
        f.close();
      }
    }
  },
);

test("stable publication byte scan rejects same-size in-place writes", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "target"), "old");
    const running = runNative(
      f.root,
      ["replace", "target", "3", "3"],
      Buffer.from("oldnew"),
      "final-byte-scan",
    );
    await once(running.marker, "data");
    writeFileSync(join(f.root, "target"), "bad");
    running.child.kill("SIGCONT");
    const result = await running.result;
    assert.equal(result.code, 1);
    assert.match(result.stderr.toString(), /SAFE_WRITE:AMBIGUOUS/);
  } finally {
    f.close();
  }
});

test("stable publication xattr scan rejects concurrent mutation", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "target"), "old");
    const running = runNative(
      f.root,
      ["replace", "target", "3", "3"],
      Buffer.from("oldold"),
      "final-xattr-scan",
    );
    await once(running.marker, "data");
    setTestXattr(join(f.root, "target"));
    running.child.kill("SIGCONT");
    const result = await running.result;
    assert.equal(result.code, 1);
    assert.match(result.stderr.toString(), /SAFE_WRITE:AMBIGUOUS/);
  } finally {
    f.close();
  }
});

test(
  "macOS inherited ACLs are cleared from private staging and published files",
  { timeout: 5_000 },
  async (t) => {
    if (process.platform !== "darwin") return t.skip("macOS ACL API test");
    const f = fixture();
    const acl =
      "everyone allow read,write,execute,add_file,delete_child,file_inherit,directory_inherit";
    try {
      writeFileSync(join(f.root, "file"), "old");
      const configured = spawnSync("chmod", ["+a", acl, f.root], {
        encoding: "utf8",
      });
      if (configured.status !== 0) {
        if (/not supported|operation unsupported/i.test(configured.stderr))
          return t.skip("filesystem does not support extended ACLs");
        assert.fail(configured.stderr);
      }

      const running = runNative(
        f.root,
        ["replace", "file", "3", "3"],
        Buffer.from("oldnew"),
        "writing",
      );
      await once(running.marker, "data");
      const stage = readdirSync(f.root).find((name) =>
        name.startsWith(`.pi-safe-write-${running.child.pid}-`),
      )!;
      for (const path of [join(f.root, stage), join(f.root, stage, "file")]) {
        const listing = spawnSync("ls", ["-lde", path], { encoding: "utf8" });
        assert.equal(listing.status, 0, listing.stderr);
        assert.doesNotMatch(listing.stdout, /^\s+\d+:/m);
      }
      running.child.kill("SIGTERM");
      running.child.kill("SIGCONT");
      await running.result;

      await safeReplace(f.context, "file", "old", "new");
      const listing = spawnSync("ls", ["-le", join(f.root, "file")], {
        encoding: "utf8",
      });
      assert.equal(listing.status, 0, listing.stderr);
      assert.doesNotMatch(listing.stdout, /^\s+\d+:/m);
    } finally {
      f.close();
    }
  },
);

test("macOS target ACLs are rejected before publication", async (t) => {
  if (process.platform !== "darwin") return t.skip("macOS ACL API test");
  const f = fixture();
  try {
    const target = join(f.root, "target");
    writeFileSync(target, "old");
    const configured = spawnSync(
      "chmod",
      ["+a", "everyone allow read", target],
      {
        encoding: "utf8",
      },
    );
    if (configured.status !== 0) {
      if (/not supported|operation unsupported/i.test(configured.stderr))
        return t.skip("filesystem does not support extended ACLs");
      assert.fail(configured.stderr);
    }
    await rejectsCode(
      safeReplace(f.context, "target", "old", "new"),
      "METADATA",
    );
    assert.equal(readFileSync(target, "utf8"), "old");
  } finally {
    f.close();
  }
});

test("ACL fault hooks fail before publication and retain original bytes", async () => {
  for (const fault of [
    "directory-clear",
    "directory-verify",
    "file-clear",
    "file-verify",
    "final-file-clear",
    "final-file-verify",
  ]) {
    const root = mkdtempSync(join(tmpdir(), "pi-safe-acl-fault-"));
    try {
      writeFileSync(join(root, "target"), "old");
      const running = runNative(
        root,
        ["replace", "target", "3", "3"],
        Buffer.from("oldnew"),
        undefined,
        { PI_SAFE_WRITER_TEST_ACL_FAIL: fault },
      );
      const result = await running.result;
      assert.equal(result.code, 1, fault);
      assert.match(result.stderr.toString(), /SAFE_WRITE:ACL/, fault);
      assert.equal(readFileSync(join(root, "target"), "utf8"), "old", fault);
      assert.equal(
        readdirSync(root).some((name) => name.startsWith(".pi-safe-write-")),
        false,
        fault,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("post-publication cleanup and signal-mask failures report AMBIGUOUS", async () => {
  for (const fault of ["close-stage", "unlink-stage", "signal-mask"]) {
    const root = mkdtempSync(join(tmpdir(), "pi-safe-post-publish-fault-"));
    try {
      writeFileSync(join(root, "target"), "old");
      const running = runNative(
        root,
        ["replace", "target", "3", "3"],
        Buffer.from("oldnew"),
        undefined,
        { PI_SAFE_WRITER_TEST_POST_PUBLISH_FAIL: fault },
      );
      const result = await running.result;
      assert.equal(result.code, 1, fault);
      assert.match(result.stderr.toString(), /SAFE_WRITE:AMBIGUOUS/, fault);
      assert.equal(readFileSync(join(root, "target"), "utf8"), "new", fault);
      assert.equal(
        readdirSync(root).some((name) => name.startsWith(".pi-safe-write-")),
        false,
        fault,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test(
  "TERM before commit aborts; TERM after durable commit reports success",
  { timeout: 3_000 },
  async () => {
    for (const stage of ["precommit", "postcommit"] as const) {
      const f = fixture();
      try {
        writeFileSync(join(f.root, "file"), "old");
        const running = runNative(
          f.root,
          ["replace", "file", "3", "3"],
          Buffer.from("oldnew"),
          stage,
        );
        await once(running.marker, "data");
        running.child.kill("SIGTERM");
        running.child.kill("SIGCONT");
        const result = await running.result;
        assert.equal(result.code, stage === "precommit" ? 2 : 0);
        assert.equal(
          readFileSync(join(f.root, "file"), "utf8"),
          stage === "precommit" ? "old" : "new",
        );
        assert.equal(
          readdirSync(f.root).some((name) =>
            name.startsWith(".pi-safe-write-"),
          ),
          false,
        );
      } finally {
        f.close();
      }
    }
  },
);

test(
  "SIGKILL reconciliation classifies replace/create around commit and removes stale temps",
  { timeout: 5_000 },
  async () => {
    for (const operation of ["replace", "create"] as const) {
      for (const stage of ["precommit", "postrename"] as const) {
        const root = mkdtempSync(join(tmpdir(), "pi-safe-kill-reconcile-"));
        const context = createSafeMutationContext(root, helper, stage);
        const path = join(root, "target");
        try {
          if (operation === "replace") writeFileSync(path, "old");
          const mutation =
            operation === "replace"
              ? safeReplace(context, "target", "old", "new")
              : safeCreate(context, "target", "new");
          if (stage === "precommit") await rejectsCode(mutation, "ABORTED");
          else await mutation;
          assert.equal(
            readFileSync(path, "utf8"),
            stage === "postrename" ? "new" : "old",
          );
        } catch (error) {
          if (
            operation !== "create" ||
            stage !== "precommit" ||
            (error as NodeJS.ErrnoException).code !== "ENOENT"
          )
            throw error;
        } finally {
          assert.equal(
            readdirSync(root).some((name) =>
              name.startsWith(".pi-safe-write-"),
            ),
            false,
          );
          context.close();
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  },
);

test("reconciliation with an empty receipt preserves all staging evidence", async () => {
  const f = fixture();
  try {
    const killedPid = 424_242;
    const stale = `.pi-safe-write-${killedPid}-7`;
    mkdirSync(join(f.root, stale), 0o700);
    writeFileSync(join(f.root, stale, "file"), "staged", { mode: 0o600 });

    const lookalikes = [
      `.pi-safe-write-${killedPid + 1}-7`,
      `.pi-safe-write-${killedPid}-7-0`,
      `.pi-safe-write-${killedPid}-007`,
      `.pi-safe-write-${killedPid}-x`,
      `.pi-safe-write-${killedPid}-8-suffix`,
      ".pi-safe-write-stale",
    ];
    for (const name of lookalikes) {
      mkdirSync(join(f.root, name), 0o700);
      writeFileSync(join(f.root, name, "sentinel"), "legitimate");
    }
    const empty = `.pi-safe-write-${killedPid}-12`;
    mkdirSync(join(f.root, empty), 0o700);
    const inheritedSetgid = `.pi-safe-write-${killedPid}-13`;
    mkdirSync(join(f.root, inheritedSetgid), 0o700);
    chmodSync(join(f.root, inheritedSetgid), 0o2700);
    writeFileSync(join(f.root, inheritedSetgid, "file"), "staged", {
      mode: 0o600,
    });
    const wrongMode = `.pi-safe-write-${killedPid}-8`;
    mkdirSync(join(f.root, wrongMode), 0o755);
    writeFileSync(join(f.root, wrongMode, "file"), "legitimate");
    const extraEntry = `.pi-safe-write-${killedPid}-9`;
    mkdirSync(join(f.root, extraEntry), 0o700);
    writeFileSync(join(f.root, extraEntry, "file"), "legitimate");
    writeFileSync(join(f.root, extraEntry, "extra"), "preserve");
    const wrongType = `.pi-safe-write-${killedPid}-10`;
    writeFileSync(join(f.root, wrongType), "legitimate");
    const symlinkFile = `.pi-safe-write-${killedPid}-11`;
    mkdirSync(join(f.root, symlinkFile), 0o700);
    symlinkSync(join(f.root, "target"), join(f.root, symlinkFile, "file"));
    writeFileSync(join(f.root, "target"), "other");

    const running = runNative(
      f.root,
      ["reconcile-replace", "target", "3", "3", "0", String(killedPid)],
      Buffer.from("oldnew"),
    );
    const result = await running.result;
    assert.equal(result.code, 1);
    assert.match(result.stderr.toString(), /SAFE_WRITE:AMBIGUOUS/);
    assert.equal(readdirSync(f.root).includes(stale), true);
    assert.equal(readdirSync(f.root).includes(empty), true);
    assert.equal(readdirSync(f.root).includes(inheritedSetgid), true);
    for (const name of [
      ...lookalikes,
      wrongMode,
      extraEntry,
      wrongType,
      symlinkFile,
    ])
      assert.equal(readdirSync(f.root).includes(name), true, name);
  } finally {
    f.close();
  }
});

test("cleanup inspection and normalization faults remain ambiguous with stale evidence", async () => {
  for (const fault of ["fstat", "fchmod"]) {
    const root = mkdtempSync(join(tmpdir(), "pi-safe-cleanup-fault-"));
    const killedPid = 424_242;
    const stale = `.pi-safe-write-${killedPid}-7`;
    try {
      mkdirSync(join(root, stale), 0o700);
      writeFileSync(join(root, stale, "file"), "staged", { mode: 0o600 });
      writeFileSync(join(root, "target"), "old");
      const running = runNative(
        root,
        ["reconcile-replace", "target", "3", "3", "0", String(killedPid)],
        Buffer.from("oldnew"),
        undefined,
        { PI_SAFE_WRITER_TEST_CLEANUP_FAIL: fault },
      );
      const result = await running.result;
      assert.equal(result.code, 1, fault);
      assert.match(result.stderr.toString(), /SAFE_WRITE:AMBIGUOUS/, fault);
      assert.equal(existsSync(join(root, stale)), true, fault);
      assert.equal(readFileSync(join(root, stale, "file"), "utf8"), "staged");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("reported post-publication fsync ambiguity is reconciled by safeReplace", async () => {
  for (const reconciliationFails of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "pi-safe-reported-ambiguous-"));
    const context = createSafeMutationContext(
      root,
      helper,
      undefined,
      reconciliationFails,
      true,
    );
    try {
      writeFileSync(join(root, "target"), "old");
      const mutation = safeReplace(context, "target", "old", "new");
      if (reconciliationFails) await rejectsCode(mutation, "AMBIGUOUS");
      else await mutation;
      assert.equal(readFileSync(join(root, "target"), "utf8"), "new");
    } finally {
      context.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test(
  "postrename SIGKILL succeeds only after reconciliation parent sync",
  { timeout: 5_000 },
  async () => {
    for (const failSync of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), "pi-safe-reconcile-sync-"));
      const context = createSafeMutationContext(
        root,
        helper,
        "postrename",
        failSync,
      );
      try {
        writeFileSync(join(root, "target"), "old");
        const mutation = safeReplace(context, "target", "old", "new");
        if (failSync) await rejectsCode(mutation, "AMBIGUOUS");
        else await mutation;
        assert.equal(readFileSync(join(root, "target"), "utf8"), "new");
      } finally {
        context.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
);

test(
  "same-content reconciliation rejects byte, link, and metadata races",
  { timeout: 10_000 },
  async () => {
    for (const barrier of [
      "reconcile-post-classification",
      "reconcile-post-fsync",
    ] as const) {
      for (const attack of ["retained-fd-bytes", "hardlink", "mode"] as const) {
        const root = mkdtempSync(join(tmpdir(), "pi-safe-reconcile-final-"));
        const target = join(root, "target");
        writeFileSync(target, "new");
        try {
          const producer = runNative(
            root,
            ["replace", "target", "3", "3"],
            Buffer.from("newnew"),
            "postrename",
          );
          await once(producer.marker, "data");
          producer.child.kill("SIGKILL");
          const receipt = (await producer.result).stdout;
          assert.ok(receipt.byteLength > 0);

          const retained = openSync(target, constants.O_RDWR);
          try {
            const running = runNative(
              root,
              [
                "reconcile-replace",
                "target",
                "3",
                "3",
                String(receipt.byteLength),
                "424242",
              ],
              Buffer.concat([Buffer.from("newnew"), receipt]),
              barrier,
            );
            await once(running.marker, "data");
            if (attack === "retained-fd-bytes")
              writeSync(retained, Buffer.from("bad"), 0, 3, 0);
            else if (attack === "hardlink")
              linkSync(target, join(root, "retained"));
            else chmodSync(target, 0o600);
            running.child.kill("SIGCONT");
            const result = await running.result;
            assert.equal(result.code, 1, `${barrier}:${attack}`);
            assert.match(
              result.stderr.toString(),
              /SAFE_WRITE:AMBIGUOUS/,
              `${barrier}:${attack}`,
            );
          } finally {
            closeSync(retained);
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  },
);

test("reconciliation final byte and xattr scans reject in-window mutation", async () => {
  for (const [barrier, attack] of [
    ["reconcile-final-byte-scan", "bytes"],
    ["reconcile-final-xattr-scan", "xattr"],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), "pi-safe-reconcile-scan-"));
    const target = join(root, "target");
    writeFileSync(target, "new");
    try {
      const producer = runNative(
        root,
        ["replace", "target", "3", "3"],
        Buffer.from("newnew"),
        "postrename",
      );
      await once(producer.marker, "data");
      producer.child.kill("SIGKILL");
      const receipt = (await producer.result).stdout;
      const running = runNative(
        root,
        [
          "reconcile-replace",
          "target",
          "3",
          "3",
          String(receipt.byteLength),
          "424242",
        ],
        Buffer.concat([Buffer.from("newnew"), receipt]),
        barrier,
      );
      await once(running.marker, "data");
      if (attack === "bytes") writeFileSync(target, "bad");
      else setTestXattr(target);
      running.child.kill("SIGCONT");
      const result = await running.result;
      assert.equal(result.code, 1, barrier);
      assert.match(result.stderr.toString(), /SAFE_WRITE:AMBIGUOUS/, barrier);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("reconciliation requires a strict positive PID", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "target"), "old");
    for (const pid of ["0", "01", "+1", "-1", "1x"]) {
      const running = runNative(
        f.root,
        ["reconcile-replace", "target", "3", "3", "0", pid],
        Buffer.from("oldnew"),
      );
      const result = await running.result;
      assert.equal(result.code, 1);
      assert.match(result.stderr.toString(), /SAFE_WRITE:PROTOCOL/);
    }
    const missing = runNative(
      f.root,
      ["reconcile-replace", "target", "3", "3", "0"],
      Buffer.from("oldnew"),
    );
    const result = await missing.result;
    assert.equal(result.code, 1);
    assert.match(result.stderr.toString(), /SAFE_WRITE:PROTOCOL/);
  } finally {
    f.close();
  }
});

test("new writes are durable no-clobber and aborted or unavailable helpers fail closed", async () => {
  const f = fixture();
  try {
    await safeCreate(f.context, "one/two/three/new.txt", "first");
    await rejectsCode(
      safeCreate(f.context, "one/two/three/new.txt", "second"),
      "CAS",
    );
    const controller = new AbortController();
    controller.abort();
    await rejectsCode(
      safeReplace(
        f.context,
        "one/two/three/new.txt",
        "first",
        "aborted",
        controller.signal,
      ),
      "ABORTED",
    );
    assert.equal(
      readFileSync(join(f.root, "one/two/three/new.txt"), "utf8"),
      "first",
    );

    const unavailable = createSafeMutationContext(
      f.root,
      join(f.root, "missing-helper"),
    );
    try {
      assert.equal(unavailable.available, false);
      await rejectsCode(
        executeRead(unavailable, "one/two/three/new.txt"),
        "UNAVAILABLE",
      );
      await rejectsCode(
        safeCreate(unavailable, "unavailable", "x"),
        "UNAVAILABLE",
      );
    } finally {
      unavailable.close();
    }
  } finally {
    f.close();
  }
});

test("native source has explicit supported-platform ACL compile guards", () => {
  const source = readFileSync(
    join(import.meta.dirname, "native", "safe-writer.c"),
    "utf8",
  );
  assert.match(source, /defined\(__linux__\)/);
  assert.match(source, /defined\(__APPLE__\)/);
  assert.match(
    source,
    /#error "safe-writer supports only Linux and macOS ACL APIs"/,
  );
  assert.match(source, /fremovexattr\(fd, names\[index\]\)/);
  assert.match(source, /static int copy_xattrs\(int source, int destination\)/);
  assert.match(source, /flistxattr\(fd, buffer, size\)/);
  assert.match(source, /flistxattr\(fd, buffer, size, 0\)/);
  assert.match(source, /fgetxattr/);
  assert.match(source, /fsetxattr/);
  assert.match(source, /FS_IOC_GETFLAGS/);
  assert.match(source, /FS_EXTENT_FL \| FS_INDEX_FL/);
  assert.match(source, /status\.st_flags/);
  assert.match(source, /SYS_renameat2/);
  assert.match(source, /RENAME_EXCHANGE/);
  assert.match(source, /RENAME_NOREPLACE/);
  assert.match(source, /renameatx_np/);
  assert.match(source, /RENAME_SWAP/);
  assert.match(source, /RENAME_EXCL/);
  assert.match(source, /capture_fingerprint/);
  assert.match(source, /st_ctim/);
  assert.match(source, /st_ctimespec/);
  assert.match(source, /st_mtim/);
  assert.match(source, /st_mtimespec/);
  assert.match(source, /st_gen/);
  assert.match(source, /reconcile-final-byte-scan/);
  assert.match(source, /reconcile-final-xattr-scan/);
  assert.match(source, /system\.posix_acl_access/);
  assert.match(source, /system\.posix_acl_default/);
  assert.match(source, /acl_get_fd_np\(fd, ACL_TYPE_EXTENDED\)/);
  assert.match(source, /acl_set_fd_np\(fd, empty, ACL_TYPE_EXTENDED\)/);
});

test("protocol bounds inputs and exposes only native-backed file tools", async () => {
  const f = fixture();
  try {
    await rejectsCode(
      safeCreate(
        f.context,
        "large",
        Buffer.alloc(SAFE_MUTATION_MAX_CONTENT_BYTES + 1),
      ),
      "BOUNDS",
    );
    await rejectsCode(safeCreate(f.context, "x".repeat(4_097), "x"), "BOUNDS");
    assert.deepEqual(
      f.context.tools.map(({ name }) => name),
      ["read", "edit", "write"],
    );

    writeFileSync(join(f.root, "edit.txt"), "alpha beta");
    const edit = f.context.tools.find((tool) => tool.name === "edit")!;
    await edit.execute(
      "edit-call",
      { path: "edit.txt", edits: [{ oldText: "beta", newText: "gamma" }] },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(readFileSync(join(f.root, "edit.txt"), "utf8"), "alpha gamma");
    const write = f.context.tools.find((tool) => tool.name === "write")!;
    await write.execute(
      "write-call",
      { path: "full/new.txt", content: "complete" },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(
      readFileSync(join(f.root, "full/new.txt"), "utf8"),
      "complete",
    );
  } finally {
    f.close();
  }
});

test("worktree and ancestor Git administration paths fail closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-safe-worktree-root-"));
  try {
    mkdirSync(join(root, "admin", "worktrees", "topic"), { recursive: true });
    writeFileSync(join(root, "admin", "config"), "secret");
    writeFileSync(join(root, ".git"), "gitdir: admin\n");
    assert.equal(isMutationCwdAllowed(root), true);
    const context = createSafeMutationContext(root, helper);
    try {
      await rejectsCode(safeRead(context, "admin/config"), "GIT_ADMIN");
    } finally {
      context.close();
    }
    assert.equal(isMutationCwdAllowed(join(root, "admin")), false);
    assert.equal(
      isMutationCwdAllowed(join(root, "admin", "worktrees", "topic")),
      false,
    );

    writeFileSync(join(root, ".git"), "malformed\n");
    assert.equal(isMutationCwdAllowed(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
