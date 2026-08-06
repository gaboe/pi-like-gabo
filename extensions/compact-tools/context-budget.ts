export const MAX_TOOL_RESULT_TEXT_CHARS = 16_384;
export const MAX_TOOL_HISTORY_TEXT_CHARS = 65_536;
export const NON_TEXT_PROVIDER_PLACEHOLDER_CHARS = "(see attached image)".length;
export const MAX_NON_TEXT_BLOCKS_PER_RESULT = 16;
const NO_TOOL_OUTPUT_CHARS = "(no tool output)".length;
const OMITTED_TOOL_RESULT = "[Older tool output omitted from LLM context; full output remains in transcript]";
const GENERATED_OMISSION = Symbol("compact-tools-generated-omission");

type TextBlock = { type: "text"; text: string; [GENERATED_OMISSION]?: boolean };
type ToolResult = { role?: string; toolCallId?: string; content?: unknown; isError?: boolean };

export type RecoveryInfo = {
	omitted: number;
	start: number;
	end: number;
	total: number;
	omittedNonText: number;
};
export type RecoveryMarker = (message: ToolResult, info: RecoveryInfo, index: number) => string | undefined;

function isTextBlock(value: unknown): value is TextBlock {
	return !!value && typeof value === "object" && (value as { type?: unknown }).type === "text" && typeof (value as { text?: unknown }).text === "string";
}

function isNonTextBlock(value: unknown): boolean {
	return !!value && typeof value === "object" && (value as { type?: unknown }).type !== "text";
}

export function providerText(content: readonly unknown[]): string {
	return content.filter(isTextBlock).map((block) => block.text).join("\n");
}

function nonTextCount(content: readonly unknown[]): number {
	return content.filter(isNonTextBlock).length;
}

/** Text Pi sends plus explicit modeled cost for each image/binary block. */
export function modeledProviderChars(content: readonly unknown[]): number {
	const text = providerText(content);
	const attachments = nonTextCount(content);
	return (text.length || attachments ? text.length : NO_TOOL_OUTPUT_CHARS) + attachments * NON_TEXT_PROVIDER_PLACEHOLDER_CHARS;
}

function defaultMarker(info: RecoveryInfo): string {
	return `\n\n[${info.omitted} chars omitted from LLM context; full output remains in transcript—rerun with narrower output]\n\n`;
}

function marker(message: ToolResult, info: RecoveryInfo, recovery: RecoveryMarker | undefined, index: number): string {
	return recovery?.(message, info, index) ?? defaultMarker(info);
}

function boundNonText(content: readonly unknown[]): { content: unknown[]; omitted: number; originalText: Set<object> } {
	const originalText = new Set(content.filter(isTextBlock) as object[]);
	const attachments = content.filter(isNonTextBlock).length;
	if (attachments <= MAX_NON_TEXT_BLOCKS_PER_RESULT) return { content: [...content], omitted: 0, originalText };
	let seen = 0;
	let inserted = false;
	const omitted = attachments - MAX_NON_TEXT_BLOCKS_PER_RESULT;
	const output = content.flatMap((block) => {
		if (!isNonTextBlock(block)) return [block];
		seen++;
		if (seen > omitted) return [block];
		if (inserted) return [];
		inserted = true;
		return [{ type: "text", text: `[${omitted} image/binary blocks omitted from LLM context; binary data is not persisted]`, [GENERATED_OMISSION]: true } satisfies TextBlock];
	});
	return { content: output, omitted, originalText };
}

function rebuildText(
	content: readonly unknown[],
	originalText: Set<object>,
	head: string,
	middle: string,
	tail: string,
): unknown[] {
	const sourceBlocks = content.filter((block) => isTextBlock(block) && originalText.has(block as object)) as TextBlock[];
	const first = sourceBlocks[0];
	const last = sourceBlocks.at(-1);
	let insertedHead = false;
	return content.flatMap((block) => {
		if (!isTextBlock(block) || !originalText.has(block as object)) return [block];
		const output: unknown[] = [];
		if (!insertedHead) {
			insertedHead = true;
			if (head) output.push({ ...first, text: head });
			output.push({ ...first, text: middle, [GENERATED_OMISSION]: true });
		}
		if (block === last && tail) output.push({ ...last, text: tail });
		return output;
	});
}

function boundToolResultContextAt<T extends ToolResult>(message: T, recovery: RecoveryMarker | undefined, index: number): T {
	if (message.role !== "toolResult" || !Array.isArray(message.content)) return message;
	const boundedNonText = boundNonText(message.content);
	if (!boundedNonText.omitted && modeledProviderChars(message.content) <= MAX_TOOL_RESULT_TEXT_CHARS) return message;

	const source = providerText(message.content);
	if (modeledProviderChars(boundedNonText.content) <= MAX_TOOL_RESULT_TEXT_CHARS) {
		return { ...message, content: boundedNonText.content };
	}
	if (!source.length) return { ...message, content: boundedNonText.content };

	let omitted = Math.max(1, source.length - MAX_TOOL_RESULT_TEXT_CHARS);
	let content: unknown[] = [];
	for (;;) {
		const retained = Math.max(0, source.length - omitted);
		const tailChars = Math.min(message.isError ? 12_288 : 4_096, retained);
		const headChars = retained - tailChars;
		const info: RecoveryInfo = {
			omitted,
			start: headChars + 1,
			end: source.length - tailChars,
			total: source.length,
			omittedNonText: boundedNonText.omitted,
		};
		content = rebuildText(
			boundedNonText.content,
			boundedNonText.originalText,
			source.slice(0, headChars),
			marker(message, info, recovery, index),
			source.slice(source.length - tailChars),
		);
		const overflow = modeledProviderChars(content) - MAX_TOOL_RESULT_TEXT_CHARS;
		if (overflow <= 0 || omitted === source.length) break;
		omitted = Math.min(source.length, omitted + Math.max(1, overflow));
	}
	return { ...message, content };
}

export function boundToolResultContext<T extends ToolResult>(message: T, recovery?: RecoveryMarker): T {
	return boundToolResultContextAt(message, recovery, -1);
}

function replaceToolResult<T extends ToolResult>(message: T, text: string): T {
	if (!Array.isArray(message.content)) return message;
	const template = message.content.find(isTextBlock);
	return { ...message, content: [{ ...(template ?? { type: "text" }), text }] };
}

export function boundToolResultHistory<T extends ToolResult>(messages: readonly T[], recovery?: RecoveryMarker): T[] {
	const individuallyBounded = messages.map((message, index) => boundToolResultContextAt(message, recovery, index));
	const output = messages.map((message) => {
		if (message.role !== "toolResult" || !Array.isArray(message.content)) return message;
		return replaceToolResult(message, nonTextCount(message.content) ? "[output omitted]" : "…");
	});
	let used = output.reduce((total, message) => (
		total + (message.role === "toolResult" && Array.isArray(message.content) ? modeledProviderChars(message.content) : 0)
	), 0);

	for (let index = 0; used > MAX_TOOL_HISTORY_TEXT_CHARS && index < output.length; index++) {
		const message = output[index];
		if (message.role !== "toolResult" || !Array.isArray(message.content) || providerText(message.content) === "…") continue;
		const replacement = replaceToolResult(message, "…");
		used += modeledProviderChars(replacement.content as unknown[]) - modeledProviderChars(message.content);
		output[index] = replacement;
	}

	for (let index = output.length - 1; index >= 0; index--) {
		const original = messages[index];
		const candidate = individuallyBounded[index];
		const current = output[index];
		if (original.role !== "toolResult" || !Array.isArray(original.content) || !Array.isArray(candidate.content) || !Array.isArray(current.content)) continue;
		const room = MAX_TOOL_HISTORY_TEXT_CHARS - used;
		const delta = modeledProviderChars(candidate.content) - modeledProviderChars(current.content);
		if (delta <= room) {
			output[index] = candidate;
			used += delta;
			continue;
		}
		const text = providerText(original.content);
		if (!recovery || !text.length) continue;
		const info: RecoveryInfo = {
			omitted: text.length,
			start: 1,
			end: text.length,
			total: text.length,
			omittedNonText: nonTextCount(original.content),
		};
		const recoveryText = marker(original, info, recovery, index);
		const replacement = replaceToolResult(original, recoveryText);
		const recoveryDelta = modeledProviderChars(replacement.content as unknown[]) - modeledProviderChars(current.content);
		if (recoveryDelta <= room) {
			output[index] = replacement;
			used += recoveryDelta;
		}
	}
	if (used > MAX_TOOL_HISTORY_TEXT_CHARS) {
		return output.filter((message) => {
			if (used <= MAX_TOOL_HISTORY_TEXT_CHARS || message.role !== "toolResult" || !Array.isArray(message.content)) return true;
			used -= modeledProviderChars(message.content);
			return false;
		});
	}
	return output;
}

export { OMITTED_TOOL_RESULT };
