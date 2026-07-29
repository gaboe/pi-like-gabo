import { spawn } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  createReadToolDefinition,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  assertWorkspaceMutationLease,
  type WorkspaceMutationOwner,
} from "../../shared/workspace-mutation-lease.ts";

export const SAFE_MUTATION_MAX_PATH_BYTES = 4_096;
export const SAFE_MUTATION_MAX_CONTENT_BYTES = 4 * 1_024 * 1_024;
export const SAFE_MUTATION_MAX_EDITS = 128;
const MAX_ERROR_BYTES = 8_192;
const NATIVE_FINGERPRINT_MAX_BYTES = 1_024 * 1_024;
const NATIVE_FINGERPRINT_HEADER_BYTES = 136;
const NATIVE_RECEIPT_MAX_BYTES = 2 * NATIVE_FINGERPRINT_MAX_BYTES + 48;
const NATIVE_FINGERPRINT_MAGIC = Buffer.from("PISWFP2\0", "ascii");
const NATIVE_RECEIPT_MAGIC = Buffer.from("PISWRC2\0", "ascii");

export class SafeMutationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

function isInside(root: string, target: string) {
  const fromRoot = relative(root, target);
  return (
    fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
  );
}

function readRegularMarker(path: string) {
  const status = lstatSync(path);
  if (!status.isFile() || status.nlink !== 1 || status.size > 64 * 1_024)
    return undefined;
  return readFileSync(path, "utf8");
}

function canonicalizeExistingPrefix(path: string) {
  const suffix: string[] = [];
  let existing = path;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return undefined;
    suffix.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...suffix);
}

export function haveSameFileIdentity(first: string, second: string) {
  try {
    const firstStatus = statSync(realpathSync(first), { bigint: true });
    const secondStatus = statSync(realpathSync(second), { bigint: true });
    return (
      firstStatus.dev === secondStatus.dev &&
      firstStatus.ino === secondStatus.ino
    );
  } catch {
    return false;
  }
}

function gitAdminRoots(repositoryRoot: string) {
  const dotGit = resolve(repositoryRoot, ".git");
  if (!existsSync(dotGit)) return [];
  try {
    let gitDir: string;
    const dotGitStatus = lstatSync(dotGit);
    if (dotGitStatus.isSymbolicLink()) return [realpathSync(dotGit)];
    if (dotGitStatus.isDirectory()) gitDir = realpathSync(dotGit);
    else if (dotGitStatus.isFile()) {
      const marker = readRegularMarker(dotGit);
      const match = marker && /^gitdir:\s*(.+)\s*$/m.exec(marker);
      if (!match) return undefined;
      gitDir = realpathSync(resolve(repositoryRoot, match[1]));
    } else return undefined;

    const roots = [gitDir];
    const commonFile = resolve(gitDir, "commondir");
    if (existsSync(commonFile)) {
      const commonDir = readRegularMarker(commonFile)?.trim();
      if (!commonDir) return undefined;
      roots.push(realpathSync(resolve(gitDir, commonDir)));
    }
    return roots;
  } catch {
    return undefined;
  }
}

function isBareGitRoot(path: string) {
  return (
    ["HEAD", "objects", "refs", "config"].filter((marker) => {
      try {
        lstatSync(resolve(path, marker));
        return true;
      } catch (error) {
        return !["ENOENT", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        );
      }
    }).length >= 3
  );
}

function hasBareGitAncestor(root: string, target: string) {
  let ancestor = target;
  for (;;) {
    if (isBareGitRoot(ancestor)) return true;
    if (ancestor === root) return false;
    const parent = dirname(ancestor);
    if (parent === ancestor || !isInside(root, parent)) return false;
    ancestor = parent;
  }
}

export function isMutationCwdAllowed(cwd: string) {
  try {
    const canonicalCwd = realpathSync(cwd);
    if (canonicalCwd.split(sep).some((part) => part.toLowerCase() === ".git"))
      return false;
    let ancestor = canonicalCwd;
    for (;;) {
      if (isBareGitRoot(ancestor)) return false;
      const adminRoots = gitAdminRoots(ancestor);
      if (
        !adminRoots ||
        adminRoots.some((adminRoot) => isInside(adminRoot, canonicalCwd))
      )
        return false;
      const parent = dirname(ancestor);
      if (parent === ancestor) return true;
      ancestor = parent;
    }
  } catch {
    return false;
  }
}

export function resolveSafeWriterBinary(explicit?: string) {
  const candidate =
    explicit ??
    process.env.PI_SAFE_WRITER ??
    fileURLToPath(new URL("../native/bin/pi-safe-writer", import.meta.url));
  try {
    const canonical = realpathSync(candidate);
    if (!statSync(canonical).isFile()) return undefined;
    accessSync(canonical, constants.X_OK);
    return canonical;
  } catch {
    return undefined;
  }
}

function relativeToolPath(
  context: Pick<SafeMutationContext, "root" | "binary">,
  input: string,
) {
  const { root } = context;
  const normalized = input.startsWith("@") ? input.slice(1) : input;
  if (
    !normalized ||
    normalized.includes("\0") ||
    Buffer.byteLength(normalized) > SAFE_MUTATION_MAX_PATH_BYTES
  )
    throw new SafeMutationError(
      "Path is empty or exceeds protocol bounds.",
      "BOUNDS",
    );
  const absolute = resolve(root, normalized);
  if (!isInside(root, absolute) || absolute === root)
    throw new SafeMutationError(
      "Path must resolve inside package root.",
      "PATH",
    );
  const adminRoots = gitAdminRoots(root);
  const canonicalTarget = canonicalizeExistingPrefix(absolute);
  if (
    !adminRoots ||
    !canonicalTarget ||
    hasBareGitAncestor(root, canonicalTarget) ||
    adminRoots.some(
      (adminRoot) =>
        isInside(adminRoot, canonicalTarget) ||
        (existsSync(absolute) && haveSameFileIdentity(adminRoot, absolute)),
    )
  )
    throw new SafeMutationError(
      "Git administration paths are forbidden.",
      "GIT_ADMIN",
    );
  if (
    context.binary &&
    existsSync(absolute) &&
    haveSameFileIdentity(context.binary, absolute)
  )
    throw new SafeMutationError(
      "The active native helper is immutable.",
      "HELPER",
    );
  const path = relative(root, absolute);
  if (
    path
      .split(sep)
      .some((part) => part.toLowerCase() === ".git" || part === "..")
  )
    throw new SafeMutationError(
      "Git administration and traversal paths are forbidden.",
      "GIT_ADMIN",
    );
  if (Buffer.byteLength(path) > SAFE_MUTATION_MAX_PATH_BYTES)
    throw new SafeMutationError("Path exceeds protocol bounds.", "BOUNDS");
  return path.split(sep).join("/");
}

function boundedBuffer(value: string | Buffer) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (buffer.byteLength > SAFE_MUTATION_MAX_CONTENT_BYTES)
    throw new SafeMutationError(
      "Content exceeds safe mutation limit.",
      "BOUNDS",
    );
  return buffer;
}

interface HelperResult {
  readonly stdout: Buffer;
}

export interface SafeMutationContext {
  readonly root: string;
  readonly binary?: string;
  readonly available: boolean;
  readonly mutationLeaseOwner?: WorkspaceMutationOwner;
  readonly tools: ReadonlyArray<ToolDefinition>;
  close(): void;
}

function helperError(stderr: Buffer, fallback: string) {
  const text = stderr.toString("utf8").trim();
  const match = /^SAFE_WRITE:([^:\n]+)(?::(.*))?$/s.exec(text);
  return new SafeMutationError(match?.[2] || fallback, match?.[1] || "HELPER");
}

interface Reconciliation {
  readonly args: string[];
  readonly input: Buffer;
}

function isNativeFingerprintFramed(fingerprint: Buffer) {
  if (
    fingerprint.length < NATIVE_FINGERPRINT_HEADER_BYTES ||
    fingerprint.length > NATIVE_FINGERPRINT_MAX_BYTES ||
    !fingerprint.subarray(0, 8).equals(NATIVE_FINGERPRINT_MAGIC) ||
    fingerprint.readBigUInt64BE(96) >= 1_000_000_000n ||
    fingerprint.readBigUInt64BE(112) >= 1_000_000_000n ||
    fingerprint.readBigUInt64BE(120) > 1n
  )
    return false;
  let offset = NATIVE_FINGERPRINT_HEADER_BYTES;
  const count = fingerprint.readBigUInt64BE(80);
  for (let index = 0n; index < count; index++) {
    if (fingerprint.length - offset < 16) return false;
    const nameLength = fingerprint.readBigUInt64BE(offset);
    const valueLength = fingerprint.readBigUInt64BE(offset + 8);
    offset += 16;
    const remaining = BigInt(fingerprint.length - offset);
    if (
      nameLength === 0n ||
      nameLength > remaining ||
      valueLength > remaining - nameLength
    )
      return false;
    const nameBytes = Number(nameLength);
    if (fingerprint.subarray(offset, offset + nameBytes).includes(0))
      return false;
    offset += nameBytes + Number(valueLength);
  }
  return offset === fingerprint.length;
}

function parseNativeReceipt(receipt: Buffer) {
  if (!receipt.length || receipt.length > NATIVE_RECEIPT_MAX_BYTES)
    throw new SafeMutationError(
      "Native publication receipt is empty or exceeds protocol bounds.",
      "AMBIGUOUS",
    );
  let offset = 0;
  let staged = false;
  let published = false;
  while (offset < receipt.length) {
    if (
      receipt.length - offset < 24 ||
      !receipt.subarray(offset, offset + 8).equals(NATIVE_RECEIPT_MAGIC)
    )
      throw new SafeMutationError(
        "Native publication receipt is truncated or invalid.",
        "AMBIGUOUS",
      );
    const phase = receipt.readBigUInt64BE(offset + 8);
    const length = receipt.readBigUInt64BE(offset + 16);
    offset += 24;
    if (
      length > BigInt(NATIVE_FINGERPRINT_MAX_BYTES) ||
      length > BigInt(receipt.length - offset)
    )
      throw new SafeMutationError(
        "Native fingerprint length exceeds receipt bounds.",
        "AMBIGUOUS",
      );
    const fingerprint = receipt.subarray(offset, offset + Number(length));
    if (!isNativeFingerprintFramed(fingerprint))
      throw new SafeMutationError(
        "Native fingerprint framing is invalid.",
        "AMBIGUOUS",
      );
    if (phase === 0n && !staged && !published) staged = true;
    else if (phase === 1n && !published) published = true;
    else
      throw new SafeMutationError(
        "Native publication receipt phases are invalid.",
        "AMBIGUOUS",
      );
    offset += fingerprint.length;
  }
  return { staged, published };
}

async function reconcileUnexpectedExit(
  context: Pick<SafeMutationContext, "binary"> & {
    rootFd: number;
    testKillAt?: "precommit" | "postrename";
    testReconciliationFsyncFailure?: boolean;
    testMutationFsyncFailure?: boolean;
  },
  reconciliation: Reconciliation,
  helperPid: number | undefined,
  receipt: Buffer,
) {
  try {
    parseNativeReceipt(receipt);
    if (!helperPid || !Number.isSafeInteger(helperPid))
      throw new Error("terminated helper PID is unavailable");
    const result = await invokeHelper(
      context,
      [...reconciliation.args, String(receipt.byteLength), String(helperPid)],
      Buffer.concat([reconciliation.input, receipt]),
    );
    const classification = result.stdout.toString("utf8").trim();
    if (classification === "SUCCESS") return result;
    if (classification === "ABORTED")
      throw new SafeMutationError("Mutation aborted.", "ABORTED");
    throw new SafeMutationError(
      "Mutation outcome is ambiguous after helper termination.",
      "AMBIGUOUS",
    );
  } catch (error) {
    if (
      error instanceof SafeMutationError &&
      (error.code === "ABORTED" || error.code === "AMBIGUOUS")
    )
      throw error;
    throw new SafeMutationError(
      `Mutation outcome is ambiguous because reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
      "AMBIGUOUS",
    );
  }
}

function invokeHelper(
  context: Pick<SafeMutationContext, "binary"> & {
    rootFd: number;
    testKillAt?: "precommit" | "postrename";
    testReconciliationFsyncFailure?: boolean;
    testMutationFsyncFailure?: boolean;
  },
  args: string[],
  input: Buffer,
  signal?: AbortSignal,
  reconciliation?: Reconciliation,
) {
  if (!context.binary)
    return Promise.reject(
      new SafeMutationError(
        "Native safe-writer is unavailable; finding-fixer is read-only. Run npm run build:native in extensions/subagents.",
        "UNAVAILABLE",
      ),
    );
  if (signal?.aborted)
    return Promise.reject(
      new SafeMutationError("Mutation aborted before execution.", "ABORTED"),
    );

  const binary = context.binary;
  return new Promise<HelperResult>((resolvePromise, rejectPromise) => {
    const child = spawn(binary, args, {
      ...(context.testKillAt ||
      context.testReconciliationFsyncFailure ||
      context.testMutationFsyncFailure
        ? {
            env: {
              ...process.env,
              ...(context.testKillAt
                ? { PI_SAFE_WRITER_TEST_STOP: context.testKillAt }
                : {}),
              ...(context.testReconciliationFsyncFailure
                ? { PI_SAFE_WRITER_TEST_RECONCILE_FSYNC_FAIL: "1" }
                : {}),
              ...(context.testMutationFsyncFailure
                ? { PI_SAFE_WRITER_TEST_MUTATION_FSYNC_FAIL: "1" }
                : {}),
            },
          }
        : {}),
      stdio: context.testKillAt
        ? ["pipe", "pipe", "pipe", context.rootFd, "pipe"]
        : ["pipe", "pipe", "pipe", context.rootFd],
    });
    const { stdin, stdout: childStdout, stderr: childStderr } = child;
    if (!stdin || !childStdout || !childStderr) {
      child.kill("SIGKILL");
      rejectPromise(
        new SafeMutationError("Helper pipes are unavailable.", "HELPER"),
      );
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    if (context.testKillAt)
      child.stdio[4]?.once("data", () => child.kill("SIGKILL"));
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failed: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      killTimer.unref();
    };
    signal?.addEventListener("abort", abort, { once: true });

    childStdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > SAFE_MUTATION_MAX_CONTENT_BYTES) {
        failed = new SafeMutationError(
          "Helper output exceeds protocol bounds.",
          "BOUNDS",
        );
        child.kill("SIGKILL");
      } else stdout.push(chunk);
    });
    childStderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= MAX_ERROR_BYTES) stderr.push(chunk);
      else {
        failed = new SafeMutationError(
          "Helper error exceeds protocol bounds.",
          "BOUNDS",
        );
        child.kill("SIGKILL");
      }
    });
    child.on("error", (error) => {
      failed = error;
    });
    child.on("close", (code, terminatedBy) => {
      signal?.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
      const errorOutput = Buffer.concat(stderr);
      const reportedFailure = /^SAFE_WRITE:/s.test(
        errorOutput.toString("utf8").trim(),
      );
      const exitError = helperError(
        errorOutput,
        `safe-writer exited ${code ?? terminatedBy}`,
      );
      const output = Buffer.concat(stdout);
      if (code === 0) {
        if (reconciliation) {
          try {
            if (!parseNativeReceipt(output).published)
              throw new SafeMutationError(
                "Native helper exited without a post-publication receipt.",
                "AMBIGUOUS",
              );
          } catch {
            void reconcileUnexpectedExit(
              context,
              reconciliation,
              child.pid,
              output,
            ).then(resolvePromise, rejectPromise);
            return;
          }
        }
        resolvePromise({ stdout: output });
      } else if (
        reconciliation &&
        (failed || !reportedFailure || exitError.code === "AMBIGUOUS")
      ) {
        void reconcileUnexpectedExit(
          context,
          reconciliation,
          child.pid,
          output,
        ).then(resolvePromise, rejectPromise);
      } else if (failed) rejectPromise(failed);
      else if (signal?.aborted)
        rejectPromise(new SafeMutationError("Mutation aborted.", "ABORTED"));
      else rejectPromise(exitError);
    });
    stdin.on("error", () => {});
    stdin.end(input);
  });
}

interface InternalContext extends SafeMutationContext {
  readonly rootFd: number;
  readonly testKillAt?: "precommit" | "postrename";
  readonly testReconciliationFsyncFailure?: boolean;
  readonly testMutationFsyncFailure?: boolean;
}

export async function safeRead(
  context: SafeMutationContext,
  path: string,
  signal?: AbortSignal,
) {
  const internal = context as InternalContext;
  return (
    await invokeHelper(
      internal,
      ["read", relativeToolPath(context, path)],
      Buffer.alloc(0),
      signal,
    )
  ).stdout;
}

export async function safeReplace(
  context: SafeMutationContext,
  path: string,
  expected: string | Buffer,
  content: string | Buffer,
  signal?: AbortSignal,
) {
  if (context.mutationLeaseOwner)
    assertWorkspaceMutationLease(context.mutationLeaseOwner, context.root);
  const expectedBytes = boundedBuffer(expected);
  const contentBytes = boundedBuffer(content);
  const relativePath = relativeToolPath(context, path);
  const input = Buffer.concat([expectedBytes, contentBytes]);
  await invokeHelper(
    context as InternalContext,
    [
      "replace",
      relativePath,
      String(expectedBytes.byteLength),
      String(contentBytes.byteLength),
    ],
    input,
    signal,
    {
      args: [
        "reconcile-replace",
        relativePath,
        String(expectedBytes.byteLength),
        String(contentBytes.byteLength),
      ],
      input,
    },
  );
}

export async function safeCreate(
  context: SafeMutationContext,
  path: string,
  content: string | Buffer,
  signal?: AbortSignal,
) {
  if (context.mutationLeaseOwner)
    assertWorkspaceMutationLease(context.mutationLeaseOwner, context.root);
  const contentBytes = boundedBuffer(content);
  const relativePath = relativeToolPath(context, path);
  await invokeHelper(
    context as InternalContext,
    ["create", relativePath, "0", String(contentBytes.byteLength)],
    contentBytes,
    signal,
    {
      args: [
        "reconcile-create",
        relativePath,
        "0",
        String(contentBytes.byteLength),
      ],
      input: contentBytes,
    },
  );
}

function exactReplacement(
  current: string,
  edits: ReadonlyArray<{ oldText: string; newText: string }>,
) {
  if (!edits.length || edits.length > SAFE_MUTATION_MAX_EDITS)
    throw new SafeMutationError(
      `Edit requires 1-${SAFE_MUTATION_MAX_EDITS} replacements.`,
      "BOUNDS",
    );
  const ranges = edits.map((edit) => {
    if (!edit.oldText)
      throw new SafeMutationError("oldText must not be empty.", "EDIT");
    const start = current.indexOf(edit.oldText);
    if (start < 0)
      throw new SafeMutationError("oldText was not found.", "EDIT");
    if (current.indexOf(edit.oldText, start + edit.oldText.length) >= 0)
      throw new SafeMutationError("oldText must match exactly once.", "EDIT");
    return { ...edit, start, end: start + edit.oldText.length };
  });
  ranges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index++)
    if (ranges[index]!.start < ranges[index - 1]!.end)
      throw new SafeMutationError("Edit replacements overlap.", "EDIT");
  let output = current;
  for (const edit of ranges.reverse())
    output = `${output.slice(0, edit.start)}${edit.newText}${output.slice(edit.end)}`;
  boundedBuffer(output);
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isReplacement(
  value: unknown,
): value is { oldText: string; newText: string } {
  return (
    isRecord(value) &&
    typeof value.oldText === "string" &&
    typeof value.newText === "string"
  );
}

function prepareEditArguments(args: unknown) {
  if (!isRecord(args) || typeof args.path !== "string")
    return { path: "", edits: [] };
  const edits =
    Array.isArray(args.edits) && args.edits.every(isReplacement)
      ? [...args.edits]
      : [];
  if (typeof args.oldText === "string" && typeof args.newText === "string")
    edits.push({ oldText: args.oldText, newText: args.newText });
  return { path: args.path, edits };
}

function mutationTools(context: SafeMutationContext) {
  const read = defineTool(
    createReadToolDefinition(context.root, {
      operations: {
        access: async () => {},
        readFile: (path) => safeRead(context, path),
      },
    }),
  );
  const edit = defineTool({
    name: "edit",
    label: "Safe Edit",
    description:
      "Safely edit one package file using unique, non-overlapping exact replacements. Native descriptor-relative CAS rejects symlinks, hard links, Git admin paths, non-regular files, and races. Maximum 4 MiB.",
    parameters: Type.Object({
      path: Type.String({
        minLength: 1,
        maxLength: SAFE_MUTATION_MAX_PATH_BYTES,
      }),
      edits: Type.Array(
        Type.Object({ oldText: Type.String(), newText: Type.String() }),
        { minItems: 1, maxItems: SAFE_MUTATION_MAX_EDITS },
      ),
    }),
    prepareArguments: prepareEditArguments,
    async execute(_id, params, signal) {
      const expected = await safeRead(context, params.path, signal);
      const current = expected.toString("utf8");
      if (!Buffer.from(current).equals(expected))
        throw new SafeMutationError(
          "Exact edit only supports UTF-8 text files.",
          "TYPE",
        );
      const next = exactReplacement(current, params.edits);
      await safeReplace(context, params.path, expected, next, signal);
      return {
        content: [{ type: "text" as const, text: `Updated ${params.path}` }],
        details: {},
      };
    },
  });

  const write = defineTool({
    name: "write",
    label: "Safe Write",
    description:
      "Safely write complete UTF-8 file content inside package root. Existing files use native descriptor-relative CAS and atomic replacement; new files use atomic no-clobber creation. Maximum 4 MiB.",
    parameters: Type.Object({
      path: Type.String({
        minLength: 1,
        maxLength: SAFE_MUTATION_MAX_PATH_BYTES,
      }),
      content: Type.String({ maxLength: SAFE_MUTATION_MAX_CONTENT_BYTES }),
    }),
    async execute(_id, params, signal) {
      boundedBuffer(params.content);
      try {
        const expected = await safeRead(context, params.path, signal);
        await safeReplace(
          context,
          params.path,
          expected,
          params.content,
          signal,
        );
      } catch (error) {
        if (!(error instanceof SafeMutationError) || error.code !== "NOT_FOUND")
          throw error;
        await safeCreate(context, params.path, params.content, signal);
      }
      return {
        content: [{ type: "text" as const, text: `Wrote ${params.path}` }],
        details: {},
      };
    },
  });
  return [read, edit, write];
}

export function createSafeMutationContext(
  root: string,
  explicitBinary?: string,
  testKillAt?: "precommit" | "postrename",
  testReconciliationFsyncFailure?: boolean,
  testMutationFsyncFailure?: boolean,
  mutationLeaseOwner?: WorkspaceMutationOwner,
): SafeMutationContext {
  const canonicalRoot = realpathSync(root);
  if (!isMutationCwdAllowed(canonicalRoot))
    throw new SafeMutationError(
      "Mutation cwd is inside Git administration data.",
      "GIT_ADMIN",
    );
  const rootFd = openSync(
    canonicalRoot,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const binary = resolveSafeWriterBinary(explicitBinary);
  let closed = false;
  const context: InternalContext = {
    root: canonicalRoot,
    rootFd,
    binary,
    testKillAt,
    testReconciliationFsyncFailure,
    testMutationFsyncFailure,
    available: binary !== undefined,
    mutationLeaseOwner,
    tools: [],
    close() {
      if (closed) return;
      closed = true;
      closeSync(rootFd);
    },
  };
  (context as { tools: ReadonlyArray<ToolDefinition> }).tools =
    mutationTools(context);
  return context;
}
