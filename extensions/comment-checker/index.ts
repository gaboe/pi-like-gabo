import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkComments, type CheckerInput } from "./runner.js";

const binaryPath = fileURLToPath(new URL(`../../bin/${process.platform}-${process.arch}/comment-checker`, import.meta.url));

function executableExists(): boolean {
	try {
		accessSync(binaryPath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function checkerInput(event: { toolName: string; input: Record<string, unknown> }, cwd: string): CheckerInput | undefined {
	const path = typeof event.input.path === "string" ? resolve(cwd, event.input.path.replace(/^@/, "")) : undefined;
	if (!path) return;
	const edits = Array.isArray(event.input.edits)
		? event.input.edits.flatMap((edit) =>
			edit && typeof edit === "object" &&
			typeof (edit as Record<string, unknown>).oldText === "string" &&
			typeof (edit as Record<string, unknown>).newText === "string"
				? [{
					old_string: (edit as Record<string, string>).oldText,
					new_string: (edit as Record<string, string>).newText,
				}]
				: [],
		)
		: [];
	return {
		session_id: "pi",
		tool_name: event.toolName === "edit" ? "MultiEdit" : "Write",
		transcript_path: "",
		cwd,
		hook_event_name: "PostToolUse",
		tool_input: {
			file_path: path,
			...(typeof event.input.content === "string" ? { content: event.input.content } : {}),
			...(edits.length ? { edits } : {}),
		},
	};
}

export default function (pi: ExtensionAPI): void {
	let warnedMissing = false;
	const reportedThisTurn = new Set<string>();

	pi.on("turn_start", () => reportedThisTurn.clear());
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError || (event.toolName !== "edit" && event.toolName !== "write")) return;
		const input = checkerInput(event as typeof event & { input: Record<string, unknown> }, ctx.cwd);
		if (!input || reportedThisTurn.has(input.tool_input.file_path)) return;
		if (!executableExists()) {
			if (!warnedMissing) ctx.ui.notify("Comment checker binary is missing; run npm run build:comment-checker", "warning");
			warnedMissing = true;
			return;
		}
		const warning = await checkComments(binaryPath, input, 5_000);
		if (!warning) return;
		reportedThisTurn.add(input.tool_input.file_path);
		return {
			content: [...event.content, { type: "text", text: `Comment checker (${input.tool_input.file_path}):\n${warning}` }],
		};
	});
}
