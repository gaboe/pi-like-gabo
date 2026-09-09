import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import {
  artifactLocation,
  ToolResultArtifacts,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_COUNT,
  MAX_ARTIFACT_TOTAL_BYTES,
} from "./artifacts.ts";

async function temporary(t, prefix = "compact-artifacts-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function assertOwnedUsageWithinCap(root) {
  const names = (await readdir(root)).filter((name) =>
    /^[a-f0-9]{24}\.txt$|^\.compact-tools-[a-f0-9]{24}-[a-f0-9]{16}\.tmp$/.test(
      name,
    ),
  );
  const infos = await Promise.all(names.map((name) => stat(join(root, name))));
  assert.ok(
    names.length <= MAX_ARTIFACT_COUNT,
    `${names.length} owned files exceeds cap`,
  );
  assert.ok(
    infos.reduce((sum, info) => sum + info.size, 0) <= MAX_ARTIFACT_TOTAL_BYTES,
    "owned bytes exceed cap",
  );
}

test("writes exact private recoverable text atomically and dedupes", async (t) => {
  const root = await temporary(t);
  const store = new ToolResultArtifacts(root);
  const text = "first\nsecond\n秘密";
  const artifact = await store.persist("call-1", text);
  assert.ok(artifact);
  assert.equal(await readFile(artifact.path, "utf8"), text);
  assert.equal(
    artifact.sha256,
    createHash("sha256").update(text).digest("hex"),
  );
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(artifact.path)).mode & 0o777, 0o600);
  assert.equal((await store.persist("call-1", text)).path, artifact.path);
});

test("disables unsafe session directories and hashes session IDs into one confined component", async (t) => {
  const root = await temporary(t);
  assert.equal(await artifactLocation("", "session"), undefined);
  assert.equal(await artifactLocation("../session", "session"), undefined);
  const location = await artifactLocation(root, "../session");
  assert.ok(location);
  assert.equal(dirname(location.directory), location.root);
  assert.match(basename(location.directory), /^[a-f0-9]{64}$/);
  assert.ok(location.directory.startsWith(`${location.root}/`));
});

test("cache identity includes the full artifact directory", async (t) => {
  const root = await temporary(t);
  const left = new ToolResultArtifacts(join(root, "left"));
  const right = new ToolResultArtifacts(join(root, "right"));
  const [a, b] = await Promise.all([
    left.persist("same", "text"),
    right.persist("same", "text"),
  ]);
  assert.ok(a && b);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.path, b.path);
});

test("rejects symlink, non-regular, and wrong-content reuse without touching link targets", async (t) => {
  const root = await temporary(t);
  const store = new ToolResultArtifacts(root);
  const artifact = await store.persist("call", "first");
  assert.ok(artifact);

  const victim = join(root, "victim");
  await writeFile(victim, "guarded", { mode: 0o640 });
  await chmod(victim, 0o640);
  await rm(artifact.path);
  await symlink(victim, artifact.path);
  assert.equal(await store.persist("call", "first"), undefined);
  assert.equal(await readFile(victim, "utf8"), "guarded");
  assert.equal((await stat(victim)).mode & 0o777, 0o640);

  await rm(artifact.path);
  await mkdir(artifact.path);
  assert.equal(await store.persist("call", "first"), undefined);
  await rm(artifact.path, { recursive: true });
  await writeFile(artifact.path, "other", { mode: 0o600 });
  assert.equal(await store.persist("call", "first"), undefined);
  assert.equal(await readFile(artifact.path, "utf8"), "other");
});

test("secures exact reused bytes through the opened handle and rejects hardlinks", async (t) => {
  const root = await temporary(t);
  const store = new ToolResultArtifacts(root);
  const artifact = await store.persist("call", "exact bytes");
  assert.ok(artifact);

  await rm(artifact.path);
  await writeFile(artifact.path, "exact bytes", { mode: 0o644 });
  await chmod(artifact.path, 0o644);
  const reused = await store.persist("call", "exact bytes");
  assert.ok(reused);
  assert.equal((await stat(reused.path)).mode & 0o777, 0o600);

  await rm(artifact.path);
  const victim = join(root, "hardlink-victim");
  await writeFile(victim, "exact bytes", { mode: 0o644 });
  await link(victim, artifact.path);
  assert.equal(await store.persist("call", "exact bytes"), undefined);
  assert.equal((await stat(victim)).nlink, 2);
  assert.equal((await stat(victim)).mode & 0o777, 0o644);
});

test("fails open for cap and unsafe/unwritable paths", async (t) => {
  const root = await temporary(t);
  const store = new ToolResultArtifacts(root);
  assert.equal(
    await store.persist("large", "x".repeat(MAX_ARTIFACT_BYTES + 1)),
    undefined,
  );
  const file = join(root, "not-a-directory");
  await writeFile(file, "x");
  assert.equal(
    await new ToolResultArtifacts(file).persist("bad", "text"),
    undefined,
  );
});

test("100 concurrent identical writes converge on one exact artifact", async (t) => {
  const root = await temporary(t);
  const store = new ToolResultArtifacts(root);
  const artifacts = await Promise.all(
    Array.from({ length: 100 }, () => store.persist("same", "concurrent")),
  );
  assert.ok(
    artifacts.every((artifact) => artifact?.path === artifacts[0]?.path),
  );
  assert.equal(
    (await readdir(root)).filter((name) => name.endsWith(".txt")).length,
    1,
  );
  assert.equal(await readFile(artifacts[0].path, "utf8"), "concurrent");
});

test("cleanup reports evictions, clears cache, and permits exact repeat", async (t) => {
  const root = await temporary(t);
  const store = new ToolResultArtifacts(root);
  const first = await store.persist("call-0", "0");
  assert.ok(first);
  for (let i = 1; i <= MAX_ARTIFACT_COUNT; i++)
    assert.ok(await store.persist(`call-${i}`, `${i}`));
  await assert.rejects(lstat(first.path), { code: "ENOENT" });
  const repeated = await store.persist("call-0", "0");
  assert.ok(repeated);
  assert.equal(await readFile(repeated.path, "utf8"), "0");
  const cleanup = await store.cleanup();
  assert.deepEqual(cleanup, { ids: [], paths: [] });
});

test("batch cleanup returns only artifacts that still exist", async (t) => {
  const root = await temporary(t);
  const store = new ToolResultArtifacts(root);
  const artifacts = await store.persistBatch(
    Array.from({ length: MAX_ARTIFACT_COUNT + 1 }, (_, index) => ({
      identity: `call-${index}`,
      text: `${index}`,
    })),
  );
  assert.equal(artifacts.filter(Boolean).length, MAX_ARTIFACT_COUNT);
  for (const artifact of artifacts.filter(Boolean))
    assert.ok((await lstat(artifact.path)).isFile());
});

test("reserves hard caps before writes across oversized concurrent batches", async (t) => {
  const root = await temporary(t);
  let releasePause;
  let reportPaused;
  const pause = new Promise((resolve) => {
    releasePause = resolve;
  });
  const paused = new Promise((resolve) => {
    reportPaused = resolve;
  });
  let shouldPause = true;
  const observe = async () => {
    await assertOwnedUsageWithinCap(root);
    if (shouldPause) {
      shouldPause = false;
      reportPaused();
      await pause;
    }
  };
  const hooks = {
    beforeWrite: () => assertOwnedUsageWithinCap(root),
    beforeRename: observe,
  };
  const items = (prefix) =>
    Array.from({ length: 20 }, (_, index) => ({
      identity: `${prefix}-${index}`,
      text: "x".repeat(MAX_ARTIFACT_BYTES),
    }));
  const first = new ToolResultArtifacts(root, { hooks }).persistBatch(
    items("first"),
  );
  const second = new ToolResultArtifacts(root, { hooks }).persistBatch(
    items("second"),
  );
  await paused;
  await assertOwnedUsageWithinCap(root);
  releasePause();
  const [firstArtifacts, secondArtifacts] = await Promise.all([first, second]);
  assert.equal(firstArtifacts.filter(Boolean).length, MAX_ARTIFACT_COUNT);
  assert.equal(secondArtifacts.filter(Boolean).length, MAX_ARTIFACT_COUNT);
  await assertOwnedUsageWithinCap(root);
});

test("write and rename failures always remove owned temp files", async (t) => {
  for (const failure of ["beforeWrite", "beforeRename"]) {
    const root = await temporary(t, `compact-${failure}-`);
    const store = new ToolResultArtifacts(root, {
      hooks: {
        [failure]: () => {
          throw new Error(failure);
        },
      },
    });
    assert.equal(await store.persist("call", "text"), undefined);
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  }
});

test("cleanup removes only stale extension-owned temp names without recursion", async (t) => {
  const root = await temporary(t);
  const stale = join(
    root,
    `.compact-tools-${"a".repeat(24)}-${"b".repeat(16)}.tmp`,
  );
  const fresh = join(
    root,
    `.compact-tools-${"c".repeat(24)}-${"d".repeat(16)}.tmp`,
  );
  const user = join(root, "user.tmp");
  const nested = join(
    root,
    `.compact-tools-${"e".repeat(24)}-${"f".repeat(16)}.tmp-dir`,
  );
  await Promise.all([
    writeFile(stale, "stale"),
    writeFile(fresh, "fresh"),
    writeFile(user, "user"),
    mkdir(nested),
  ]);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(stale, old, old);
  await new ToolResultArtifacts(root).cleanup();
  await assert.rejects(lstat(stale), { code: "ENOENT" });
  assert.equal(await readFile(fresh, "utf8"), "fresh");
  assert.equal(await readFile(user, "utf8"), "user");
  assert.ok((await lstat(nested)).isDirectory());
});

test("fresh owned temps count toward retention and cleanup reports deleted IDs and paths", async (t) => {
  const root = await temporary(t);
  const ids = Array.from({ length: MAX_ARTIFACT_COUNT }, (_, index) =>
    index.toString(16).padStart(24, "0"),
  );
  await Promise.all(ids.map((id) => writeFile(join(root, `${id}.txt`), id)));
  const fresh = join(
    root,
    `.compact-tools-${"a".repeat(24)}-${"b".repeat(16)}.tmp`,
  );
  await writeFile(fresh, "t".repeat(MAX_ARTIFACT_BYTES));
  const store = new ToolResultArtifacts(root);
  const cleanup = await store.cleanup();
  assert.equal(cleanup.ids.length, 1);
  assert.deepEqual(
    cleanup.paths,
    cleanup.ids.map((id) => join(root, `${id}.txt`)),
  );
  assert.equal((await stat(fresh)).size, MAX_ARTIFACT_BYTES);
  assert.equal((await readdir(root)).length, MAX_ARTIFACT_COUNT);

  const artifacts = await store.persistBatch(
    Array.from({ length: 20 }, (_, index) => ({
      identity: `fresh-temp-${index}`,
      text: "x".repeat(MAX_ARTIFACT_BYTES),
    })),
  );
  assert.equal(artifacts.filter(Boolean).length, MAX_ARTIFACT_COUNT - 1);
  assert.equal((await stat(fresh)).size, MAX_ARTIFACT_BYTES);
  await assertOwnedUsageWithinCap(root);
});

test("rejects a symlinked artifact root and never writes outside session", async (t) => {
  const session = await temporary(t, "compact-session-");
  const outside = await temporary(t, "compact-outside-");
  const location = await artifactLocation(session, "session");
  assert.ok(location);
  await symlink(outside, location.root);
  assert.equal(
    await new ToolResultArtifacts(location.directory, {
      root: location.root,
    }).persist("call", "secret"),
    undefined,
  );
  assert.deepEqual(await readdir(outside), []);
});
