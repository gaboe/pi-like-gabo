import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export const MAX_ARTIFACT_BYTES = 512 * 1024;
export const MAX_ARTIFACT_COUNT = 16;
export const MAX_ARTIFACT_TOTAL_BYTES = 8 * 1024 * 1024;
const STALE_TEMP_MS = 60 * 60 * 1000;
const ARTIFACT_NAME = /^([a-f0-9]{24})\.txt$/;
const TEMP_NAME = /^\.compact-tools-[a-f0-9]{24}-[a-f0-9]{16}\.tmp$/;
const directoryLocks = new Map<string, Promise<void>>();

type OwnedEntry = {
  name: string;
  path: string;
  bytes: number;
  mtime: number;
  artifact: string | undefined;
};
type BatchEntry = {
  indexes: number[];
  identity: string;
  data: Buffer;
  artifact: Artifact;
};

async function withDirectoryLock<T>(
  directory: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = directoryLocks.get(directory) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  directoryLocks.set(directory, queued);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (directoryLocks.get(directory) === queued)
      directoryLocks.delete(directory);
  }
}

export type Artifact = {
  id: string;
  path: string;
  sha256: string;
  bytes: number;
};
export type ArtifactLocation = { root: string; directory: string };
export type ArtifactCleanup = { ids: string[]; paths: string[] };
export type ArtifactHooks = {
  beforeWrite?: (path: string) => void | Promise<void>;
  beforeRename?: (from: string, to: string) => void | Promise<void>;
};

export async function artifactLocation(
  sessionDir: string,
  sessionId: string,
): Promise<ArtifactLocation | undefined> {
  if (!sessionDir || !isAbsolute(sessionDir)) return undefined;
  try {
    const sessionRoot = await realpath(sessionDir);
    const root = resolve(sessionRoot, ".compact-tool-artifacts");
    const component = createHash("sha256").update(sessionId).digest("hex");
    const directory = resolve(root, component);
    if (dirname(directory) !== root || !directory.startsWith(`${root}${sep}`))
      return undefined;
    return { root, directory };
  } catch {
    return undefined;
  }
}

export class ToolResultArtifacts {
  private readonly byKey = new Map<string, Artifact>();
  private readonly inFlight = new Map<string, Promise<Artifact | undefined>>();
  private readonly root: string;
  private readonly hooks: ArtifactHooks;

  constructor(
    readonly directory: string,
    options: { root?: string; hooks?: ArtifactHooks } = {},
  ) {
    this.directory = resolve(directory);
    this.root = resolve(options.root ?? directory);
    this.hooks = options.hooks ?? {};
  }

  async persist(identity: string, text: string): Promise<Artifact | undefined> {
    return (await this.persistBatch([{ identity, text }]))[0];
  }

  async persistBatch(
    items: readonly { identity: string; text: string }[],
  ): Promise<(Artifact | undefined)[]> {
    try {
      return await withDirectoryLock(this.directory, async () => {
        await this.ensureDirectory();
        await this.cleanup();
        const results: (Artifact | undefined)[] = items.map(() => undefined);
        const unique = new Map<string, BatchEntry>();
        for (const [index, { identity, text }] of items.entries()) {
          const data = Buffer.from(text, "utf8");
          if (!data.length || data.length > MAX_ARTIFACT_BYTES) continue;
          const sha256 = createHash("sha256").update(data).digest("hex");
          const key = `${this.directory}\0${identity}\0${sha256}`;
          const existing = unique.get(key);
          if (existing) {
            existing.indexes.push(index);
            continue;
          }
          const id = createHash("sha256")
            .update(key)
            .digest("hex")
            .slice(0, 24);
          unique.set(key, {
            indexes: [index],
            identity,
            data,
            artifact: {
              id,
              path: join(this.directory, `${id}.txt`),
              sha256,
              bytes: data.length,
            },
          });
        }

        const reusable = new Map<string, Artifact>();
        const candidates: BatchEntry[] = [];
        for (const [key, entry] of unique) {
          try {
            await lstat(entry.artifact.path);
            if (!(await this.verify(entry.artifact))) continue;
            this.byKey.set(key, entry.artifact);
            reusable.set(key, entry.artifact);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
              candidates.push(entry);
          }
        }

        const retained = await this.ownedEntries();
        const reusablePaths = new Set(
          [...reusable.values()].map(({ path }) => path),
        );
        const fixed = retained.filter(
          (entry) => !entry.artifact || reusablePaths.has(entry.path),
        );
        const fixedBytes = fixed.reduce((sum, entry) => sum + entry.bytes, 0);
        let reservedCount = 0;
        let reservedBytes = 0;
        const selected: BatchEntry[] = [];
        for (const candidate of candidates) {
          if (fixed.length + reservedCount + 1 > MAX_ARTIFACT_COUNT) continue;
          if (
            fixedBytes + reservedBytes + candidate.data.length >
            MAX_ARTIFACT_TOTAL_BYTES
          )
            continue;
          selected.push(candidate);
          reservedCount++;
          reservedBytes += candidate.data.length;
        }
        await this.makeRoom([...reusablePaths], reservedCount, reservedBytes);

        for (const [key, artifact] of reusable) {
          for (const index of unique.get(key)!.indexes)
            results[index] = artifact;
        }
        for (const entry of selected) {
          const artifact = await this.persistOne(
            entry.identity,
            entry.data.toString("utf8"),
          );
          if (artifact)
            for (const index of entry.indexes) results[index] = artifact;
        }
        return await Promise.all(
          results.map(async (artifact) =>
            artifact && (await this.verify(artifact)) ? artifact : undefined,
          ),
        );
      });
    } catch {
      return items.map(() => undefined);
    }
  }

  private async persistOne(
    identity: string,
    text: string,
  ): Promise<Artifact | undefined> {
    const data = Buffer.from(text, "utf8");
    if (!data.length || data.length > MAX_ARTIFACT_BYTES) return undefined;
    const sha256 = createHash("sha256").update(data).digest("hex");
    const key = `${this.directory}\0${identity}\0${sha256}`;
    const active = this.inFlight.get(key);
    if (active) return active;
    const promise = this.writeOrReuse(key, data, sha256);
    this.inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async writeOrReuse(
    key: string,
    data: Buffer,
    sha256: string,
  ): Promise<Artifact | undefined> {
    const known = this.byKey.get(key);
    if (known) {
      if (await this.verify(known)) return known;
      this.byKey.delete(key);
    }
    const id = createHash("sha256").update(key).digest("hex").slice(0, 24);
    const path = join(this.directory, `${id}.txt`);
    const artifact = { id, path, sha256, bytes: data.length };
    try {
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        !(await this.verify(artifact))
      )
        return undefined;
      this.byKey.set(key, artifact);
      return artifact;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }

    const temp = join(
      this.directory,
      `.compact-tools-${id}-${randomBytes(8).toString("hex")}.tmp`,
    );
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(
        temp,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      await file.chmod(0o600);
      await this.hooks.beforeWrite?.(temp);
      await file.writeFile(data);
      await file.sync();
      await file.close();
      file = undefined;
      try {
        const existing = await lstat(path);
        if (
          !existing.isFile() ||
          existing.isSymbolicLink() ||
          !(await this.verify(artifact))
        )
          return undefined;
        this.byKey.set(key, artifact);
        return artifact;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          return undefined;
      }
      await this.hooks.beforeRename?.(temp, path);
      await rename(temp, path);
      if (!(await this.verify(artifact))) return undefined;
      this.byKey.set(key, artifact);
      return artifact;
    } catch {
      return undefined;
    } finally {
      await file?.close().catch(() => undefined);
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  private async verify(artifact: Artifact): Promise<boolean> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(
        artifact.path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const opened = await file.stat();
      if (!this.safeFile(opened, artifact.bytes)) return false;
      const data = await file.readFile();
      if (
        data.length !== artifact.bytes ||
        createHash("sha256").update(data).digest("hex") !== artifact.sha256
      )
        return false;
      await file.chmod(0o600);
      const secured = await file.stat();
      return (
        this.safeFile(secured, artifact.bytes) &&
        (secured.mode & 0o777) === 0o600
      );
    } catch {
      return false;
    } finally {
      await file?.close().catch(() => undefined);
    }
  }

  private safeFile(
    info: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
    bytes: number,
  ): boolean {
    if (!info.isFile() || info.size !== bytes) return false;
    if (
      typeof process.getuid === "function" &&
      typeof info.uid === "number" &&
      info.uid !== process.getuid()
    )
      return false;
    if (typeof info.nlink === "number" && info.nlink !== 1) return false;
    return true;
  }

  private async ensureDirectory() {
    if (this.directory !== this.root && dirname(this.directory) !== this.root)
      throw new Error("artifact directory escapes root");
    if (this.directory === this.root) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
    } else {
      await mkdir(this.root, { mode: 0o700 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
      await this.secureDirectory(this.root);
      await mkdir(this.directory, { mode: 0o700 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
    }
    await this.secureDirectory(this.directory);
  }

  private async secureDirectory(path: string) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("artifact directory is unsafe");
    const directory = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.chmod(0o700);
    } finally {
      await directory.close();
    }
  }

  async cleanup(
    preferredPaths: readonly string[] = [],
  ): Promise<ArtifactCleanup> {
    return this.makeRoom(preferredPaths, 0, 0);
  }

  private async ownedEntries(): Promise<OwnedEntry[]> {
    const entries = await Promise.all(
      (await readdir(this.directory)).map(async (name) => {
        if (!ARTIFACT_NAME.test(name) && !TEMP_NAME.test(name))
          return undefined;
        const path = join(this.directory, name);
        const info = await lstat(path).catch(() => undefined);
        if (!info?.isFile() || info.isSymbolicLink()) return undefined;
        if (
          TEMP_NAME.test(name) &&
          Date.now() - info.mtimeMs >= STALE_TEMP_MS
        ) {
          await rm(path, { force: true });
          return undefined;
        }
        return {
          name,
          path,
          bytes: info.size,
          mtime: info.mtimeMs,
          artifact: ARTIFACT_NAME.exec(name)?.[1],
        };
      }),
    );
    return entries.filter((entry): entry is OwnedEntry => !!entry);
  }

  private async makeRoom(
    preferredPaths: readonly string[],
    reservedCount: number,
    reservedBytes: number,
  ): Promise<ArtifactCleanup> {
    const deleted: ArtifactCleanup = { ids: [], paths: [] };
    const retained = await this.ownedEntries();
    let total = retained.reduce((sum, entry) => sum + entry.bytes, 0);
    let count = retained.length;
    const priority = new Map(
      preferredPaths.map((path, index) => [path, index]),
    );
    const artifacts = retained
      .filter((entry) => entry.artifact)
      .sort((left, right) => {
        const leftRank = priority.get(left.path);
        const rightRank = priority.get(right.path);
        if (leftRank == null && rightRank != null) return -1;
        if (leftRank != null && rightRank == null) return 1;
        if (leftRank != null && rightRank != null) return leftRank - rightRank;
        return left.mtime - right.mtime;
      });
    for (const entry of artifacts) {
      if (
        count + reservedCount <= MAX_ARTIFACT_COUNT &&
        total + reservedBytes <= MAX_ARTIFACT_TOTAL_BYTES
      )
        break;
      await rm(entry.path, { force: true });
      deleted.ids.push(entry.artifact!);
      deleted.paths.push(entry.path);
      count--;
      total -= entry.bytes;
    }
    if (deleted.paths.length) {
      const paths = new Set(deleted.paths);
      for (const [key, artifact] of this.byKey)
        if (paths.has(artifact.path)) this.byKey.delete(key);
    }
    return deleted;
  }
}
