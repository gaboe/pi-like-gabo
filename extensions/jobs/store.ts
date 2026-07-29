import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BoundedEventQueue, jsonPathValue, MAX_DEDUPE_KEYS } from "./core.js";
import type { JobEvent, JobRecord, PersistedScope } from "./types.js";

const MAX_LOG_BYTES = 64 * 1024 * 1024;
const RETAINED_LOG_BYTES = 32 * 1024 * 1024;

function isPersistedScope(value: unknown, sessionId: string, cwd: string): value is PersistedScope {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const scope = value as Partial<PersistedScope>;
	if (scope.version !== 1 || scope.sessionId !== sessionId || typeof scope.cwd !== "string" || resolve(scope.cwd) !== resolve(cwd) || !Array.isArray(scope.jobs)) return false;
	return scope.jobs.every((job) => {
		if (!job || typeof job !== "object") return false;
		const record = job as Partial<JobRecord>;
		return (
			typeof record.id === "string" && /^job-[a-f0-9]{8}$/.test(record.id) &&
			record.definition !== undefined && typeof record.definition === "object" &&
			typeof record.status === "string" &&
			typeof record.createdAt === "number" && Number.isFinite(record.createdAt) &&
			typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) &&
			Array.isArray(record.events) &&
			Array.isArray(record.recentDedupeKeys) &&
			typeof record.logPath === "string"
		);
	});
}

export class JobStore {
	readonly root: string;
	private file = "";
	private logDir = "";
	private writes = Promise.resolve();

	constructor(root = join(homedir(), ".pi", "agent", "jobs")) {
		this.root = root;
	}

	async open(sessionId: string, cwd: string) {
		const scope = createHash("sha256").update(sessionId).update("\0").update(resolve(cwd)).digest("hex");
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		await chmod(this.root, 0o700);
		this.file = join(this.root, `${scope}.json`);
		this.logDir = join(this.root, scope);
		await mkdir(this.logDir, { recursive: true, mode: 0o700 });
		await chmod(this.logDir, 0o700);
		try {
			const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
			if (isPersistedScope(parsed, sessionId, cwd)) {
				for (const job of parsed.jobs) {
					job.logPath = this.logPath(job.id);
					await this.replay(job);
				}
				return parsed;
			}
			await rename(this.file, `${this.file}.invalid-${Date.now()}`).catch(() => undefined);
			return undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			await rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => undefined);
			return undefined;
		}
	}

	logPath(id: string) {
		if (!this.logDir) throw new Error("Job store is not open.");
		return join(this.logDir, `${id}.jsonl`);
	}

	save(scope: PersistedScope) {
		const write = async () => {
			const temp = `${this.file}.${randomUUID()}.tmp`;
			const handle = await open(temp, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(scope)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temp, this.file);
			await chmod(this.file, 0o600);
		};
		this.writes = this.writes.then(write, write);
		return this.writes;
	}

	async append(record: JobRecord, event: JobEvent) {
		const handle = await open(record.logPath, "a", 0o600);
		try {
			await handle.appendFile(`${JSON.stringify(event)}\n`, "utf8");
		} finally {
			await handle.close();
		}
		await chmod(record.logPath, 0o600);
		const size = (await stat(record.logPath)).size;
		if (size <= MAX_LOG_BYTES) return;
		const content = await readFile(record.logPath);
		const tail = content.subarray(Math.max(0, content.length - RETAINED_LOG_BYTES));
		const newline = tail.indexOf(0x0a);
		const retained = newline >= 0 ? tail.subarray(newline + 1) : tail;
		const temp = `${record.logPath}.${randomUUID()}.tmp`;
		const replacement = await open(temp, "wx", 0o600);
		try {
			await replacement.writeFile(retained);
			await replacement.sync();
		} finally {
			await replacement.close();
		}
		await rename(temp, record.logPath);
	}

	async delete(record: JobRecord) {
		await rm(record.logPath, { force: true });
	}

	private async replay(job: JobRecord) {
		const checkpoint = job.events.at(-1)?.sequence ?? job.droppedEvents;
		let content: string;
		try {
			content = await readFile(job.logPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const queue = new BoundedEventQueue(job.events, job.eventBytes);
		for (const line of content.split("\n")) {
			if (!line) continue;
			let event: JobEvent;
			try {
				event = JSON.parse(line) as JobEvent;
			} catch {
				continue;
			}
			if (event.sequence <= checkpoint) continue;
			queue.push(event);
			job.updatedAt = event.at;
			const { definition } = job;
			if (definition.dedupeJsonPath) {
				const selected = jsonPathValue(definition.dedupeJsonPath, event.data);
				job.recentDedupeKeys.push(
					createHash("sha256").update(event.source).update("\0").update(selected ?? event.data).digest("hex"),
				);
				if (job.recentDedupeKeys.length > MAX_DEDUPE_KEYS)
					job.recentDedupeKeys.shift();
			}
			const cursor = jsonPathValue(
				definition.kind === "command" ? undefined : definition.cursorJsonPath,
				event.data,
			);
			if (cursor !== undefined) job.cursor = cursor.slice(0, 2048);
		}
		job.eventBytes = queue.bytes;
		job.droppedEvents += queue.droppedEvents;
		job.droppedBytes += queue.droppedBytes;
	}
}
