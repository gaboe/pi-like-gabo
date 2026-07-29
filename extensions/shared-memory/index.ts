import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MAX_MEMORY_LINES = 100;
export const MAX_MEMORY_BYTES = 16_384;
const MEMORY_MARKER = "# Shared Pi + Claude memory";

export function encodeClaudeProjectPath(path: string): string {
	return resolve(path).replace(/[^a-zA-Z0-9_-]/g, "-");
}

function memoryFileFor(projectPath: string, home = homedir()): string {
	return join(home, ".claude", "projects", encodeClaudeProjectPath(projectPath), "memory", "MEMORY.md");
}

export function resolveSharedMemoryFile(cwd: string, home = homedir()): string {
	const absoluteCwd = resolve(cwd);
	const nexusRoot = join(home, "bp", "nexus");
	if (
		existsSync(nexusRoot) &&
		(absoluteCwd === nexusRoot ||
			absoluteCwd.startsWith(`${nexusRoot}/`) ||
			absoluteCwd.includes("/.stax/worktrees/nexus-"))
	) {
		return memoryFileFor(nexusRoot, home);
	}

	for (let candidate = absoluteCwd; ; candidate = dirname(candidate)) {
		const file = memoryFileFor(candidate, home);
		if (existsSync(file)) return file;
		const parent = dirname(candidate);
		if (parent === candidate) break;
	}

	return memoryFileFor(absoluteCwd, home);
}

export function loadMemory(file: string): {
	content: string;
	lines: number;
	bytes: number;
	truncated: boolean;
} {
	if (!existsSync(file)) return { content: "", lines: 0, bytes: 0, truncated: false };
	const raw = readFileSync(file, "utf8");
	const sourceLines = raw.split("\n");
	const selected: string[] = [];
	let injectedBytes = 0;

	for (const line of sourceLines.slice(0, MAX_MEMORY_LINES)) {
		const bytes = Buffer.byteLength(`${line}\n`);
		if (injectedBytes + bytes > MAX_MEMORY_BYTES) break;
		selected.push(line);
		injectedBytes += bytes;
	}

	const bytes = Buffer.byteLength(raw);
	return {
		content: selected.join("\n").trim(),
		lines: sourceLines.length,
		bytes,
		truncated: selected.length < sourceLines.length || injectedBytes < bytes,
	};
}

export default function sharedMemory(pi: ExtensionAPI): void {
	let snapshot: ReturnType<typeof loadMemory> | undefined;
	let snapshotFile: string | undefined;

	const loadSessionSnapshot = (cwd: string) => {
		snapshotFile = resolveSharedMemoryFile(cwd);
		snapshot = loadMemory(snapshotFile);
	};

	pi.on("session_start", (_event, ctx) => loadSessionSnapshot(ctx.cwd));
	pi.on("session_shutdown", () => {
		snapshot = undefined;
		snapshotFile = undefined;
	});

	pi.on("before_agent_start", (event, ctx) => {
		const expectedFile = resolveSharedMemoryFile(ctx.cwd);
		if (!snapshot || snapshotFile !== expectedFile) loadSessionSnapshot(ctx.cwd);
		const file = snapshotFile!;
		const memory = snapshot!;
		const compact = memory.truncated
			? `\nMemory index exceeds ${MAX_MEMORY_LINES} lines or ${MAX_MEMORY_BYTES} bytes. Before adding memory, consolidate duplicate/stale entries and move details into topic files until it fits.`
			: "";
		const contents = memory.content ? `\n\n${memory.content}` : "";

		return {
			systemPrompt: `${event.systemPrompt}\n\n${MEMORY_MARKER}\nShared memory file: ${file}\nUse it for durable preferences, corrections, and concise pointers to project lessons. Reusable procedures belong in skills; current work belongs in TODOs; source-derived facts belong in project documentation. When the user explicitly asks to remember something, update this file with built-in read/edit/write tools. Read linked topic files only when relevant.${compact}${contents}`,
		};
	});

	pi.registerCommand("memory", {
		description: "Show shared Pi and Claude memory status",
		handler: async (_args, ctx) => {
			const file = resolveSharedMemoryFile(ctx.cwd);
			const memory = loadMemory(file);
			ctx.ui.notify(
				`${file}\n${memory.lines} lines, ${memory.bytes} bytes${memory.truncated ? " — compaction required" : ""}`,
				memory.truncated ? "warning" : "info",
			);
		},
	});
}
