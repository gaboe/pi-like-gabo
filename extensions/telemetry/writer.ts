import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { normalizeTelemetryEvent, type TelemetryRecord } from "./protocol.js";

export const TELEMETRY_FILE = "telemetry.jsonl";
export const DEFAULT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_ARCHIVES = 4;
const DEFAULT_MAX_PENDING = 1024;
const DEFAULT_CLOSE_TIMEOUT_MS = 250;

async function missingOkay(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export class TelemetryWriter {
  private tail = Promise.resolve();
  private pending = 0;
  private closed = false;

  constructor(
    private readonly directory: string,
    private readonly options: {
      maxBytes?: number;
      archives?: number;
      maxPending?: number;
    } = {},
  ) {}

  write(value: unknown): Promise<void> {
    if (
      this.closed ||
      this.pending >= (this.options.maxPending ?? DEFAULT_MAX_PENDING)
    )
      return Promise.resolve();
    let record: TelemetryRecord | undefined;
    try {
      record = normalizeTelemetryEvent(value);
    } catch {
      return Promise.resolve();
    }
    if (!record) return Promise.resolve();
    const line = `${JSON.stringify(record)}\n`;
    this.pending++;
    const persist = async () => {
      try {
        await this.persist(line);
      } catch {
      } finally {
        this.pending--;
      }
    };
    this.tail = this.tail.then(persist, persist);
    return this.tail;
  }

  async close(timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS): Promise<void> {
    this.closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.tail,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private async persist(line: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directoryStat = await lstat(this.directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
      throw new Error("Telemetry directory is not private storage.");
    await chmod(this.directory, 0o700);
    const path = join(this.directory, TELEMETRY_FILE);
    await this.rotate(path, Buffer.byteLength(line));
    const flags =
      constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      (constants.O_NOFOLLOW ?? 0);
    const file = await open(path, flags, 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(line);
    } finally {
      await file.close();
    }
  }

  private async rotate(path: string, incomingBytes: number): Promise<void> {
    let size = 0;
    try {
      const current = await lstat(path);
      if (!current.isFile() || current.isSymbolicLink())
        throw new Error("Telemetry file is not a regular file.");
      size = current.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (
      size === 0 ||
      size + incomingBytes <= (this.options.maxBytes ?? DEFAULT_MAX_BYTES)
    )
      return;
    const archives = Math.max(0, this.options.archives ?? DEFAULT_ARCHIVES);
    if (archives === 0) {
      await missingOkay(rm(path));
      return;
    }
    await missingOkay(rm(`${path}.${archives}`));
    for (let index = archives - 1; index >= 1; index--) {
      await missingOkay(rename(`${path}.${index}`, `${path}.${index + 1}`));
    }
    await missingOkay(rename(path, `${path}.1`));
  }
}
