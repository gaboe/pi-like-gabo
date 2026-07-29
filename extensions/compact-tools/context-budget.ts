const MAX_TOOL_RESULT_TEXT_CHARS = 16_384;

export { MAX_TOOL_RESULT_TEXT_CHARS };

type TextBlock = { type: "text"; text: string };
type ToolResult = { role?: string; content?: unknown; isError?: boolean };

function isTextBlock(value: unknown): value is TextBlock {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === "text" && typeof (value as { text?: unknown }).text === "string";
}

const marker = (omitted: number) => `\n\n[${omitted} chars omitted from LLM context; full output remains in transcript—rerun with narrower output]\n\n`;

/** Pi 0.82.1 OpenAI conversion joins every text block with one newline. */
function providerTextChars(content: unknown[]): number {
  const text = content.filter(isTextBlock);
  return text.reduce((size, block) => size + block.text.length, 0) + Math.max(0, text.length - 1);
}

export function boundToolResultContext<T extends ToolResult>(message: T): T {
  if (message.role !== "toolResult" || !Array.isArray(message.content)) return message;
  if (providerTextChars(message.content) <= MAX_TOOL_RESULT_TEXT_CHARS) return message;
  const normalizedContent = message.content.filter((block) => !isTextBlock(block) || block.text.length > 0);
  if (providerTextChars(normalizedContent) <= MAX_TOOL_RESULT_TEXT_CHARS) {
    return { ...message, content: normalizedContent };
  }
  const source = normalizedContent.filter(isTextBlock);
  const sourceChars = source.reduce((size, block) => size + block.text.length, 0);

  let omitted = 1;
  let content: unknown[] = [];
  for (;;) {
    const retained = Math.max(0, sourceChars - omitted);
    const tailChars = Math.min(message.isError ? 12_288 : 4_096, retained);
    let head = retained - tailChars;
    let tail = tailChars;
    const heads = new Map<number, string>();
    const tails = new Map<number, string>();
    for (let index = 0; index < normalizedContent.length; index++) {
      const block = normalizedContent[index];
      if (!isTextBlock(block) || !head) continue;
      const part = block.text.slice(0, head);
      heads.set(index, part);
      head -= part.length;
    }
    for (let index = normalizedContent.length - 1; index >= 0; index--) {
      const block = normalizedContent[index];
      if (!isTextBlock(block) || !tail) continue;
      const part = block.text.slice(-tail);
      tails.set(index, part);
      tail -= part.length;
    }
    const firstTail = tails.size > 0 ? Math.min(...tails.keys()) : normalizedContent.findIndex(isTextBlock);
    content = normalizedContent.flatMap((block, index) => {
      if (!isTextBlock(block)) return [block];
      const output: unknown[] = [];
      const headPart = heads.get(index);
      if (headPart) output.push({ ...block, text: headPart });
      if (index === firstTail) output.push({ ...block, text: marker(omitted) });
      const tailPart = tails.get(index);
      if (tailPart) output.push({ ...block, text: tailPart });
      return output;
    });
    const actualOmitted = sourceChars - [...heads.values(), ...tails.values()].reduce((size, part) => size + part.length, 0);
    if (actualOmitted === omitted && providerTextChars(content) <= MAX_TOOL_RESULT_TEXT_CHARS) break;
    omitted = Math.min(
      sourceChars,
      Math.max(actualOmitted, omitted + Math.max(1, providerTextChars(content) - MAX_TOOL_RESULT_TEXT_CHARS)),
    );
  }
  return { ...message, content };
}
