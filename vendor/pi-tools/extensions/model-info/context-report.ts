export interface ContextReportInput {
  usage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
  systemPrompt: string;
  entries: readonly unknown[];
  activeTools: readonly {
    name: string;
    description?: string;
    parameters?: unknown;
  }[];
  contextFiles?: readonly { path: string; content: string }[];
  skills?: readonly { name: string; description: string; filePath: string }[];
}

export interface ContextBreakdown {
  systemPrompt: number;
  user: number;
  assistant: number;
  toolResults: number;
  thinking: number;
  images: number;
  toolCalls: number;
  toolCallCount: number;
  compactions: number;
  summaries: number;
  activeTools: number;
  contextFiles: number;
  skills: number;
}

const estimate = (text: string) => Math.ceil(text.length / 4);
const textOf = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");

export function contextBreakdown(input: ContextReportInput): ContextBreakdown {
  const result: ContextBreakdown = {
    systemPrompt: estimate(input.systemPrompt),
    user: 0,
    assistant: 0,
    toolResults: 0,
    thinking: 0,
    images: 0,
    toolCalls: 0,
    toolCallCount: 0,
    compactions: 0,
    summaries: 0,
    activeTools: 0,
    contextFiles: 0,
    skills: 0,
  };
  for (const entry of input.entries) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as {
      type?: string;
      summary?: unknown;
      message?: { role?: string; content?: unknown };
    };
    if (value.type === "compaction") {
      result.compactions++;
      result.summaries += estimate(textOf(value.summary));
    }
    if (value.type !== "message" || !value.message) continue;
    const content = Array.isArray(value.message.content)
      ? value.message.content
      : [value.message.content];
    for (const block of content) {
      const item = block as {
        type?: string;
        text?: unknown;
        content?: unknown;
        thinking?: unknown;
        arguments?: unknown;
      };
      if (item?.type === "image") {
        result.images++;
        continue;
      }
      if (item?.type === "toolCall") {
        result.toolCalls += estimate(textOf(item.arguments));
        result.toolCallCount++;
        continue;
      }
      const tokens = estimate(
        textOf(item?.text ?? item?.content ?? item?.thinking ?? block),
      );
      if (item?.type === "thinking") result.thinking += tokens;
      else if (value.message.role === "toolResult")
        result.toolResults += tokens;
      else if (value.message.role === "user") result.user += tokens;
      else if (value.message.role === "assistant") result.assistant += tokens;
    }
  }
  for (const tool of input.activeTools)
    result.activeTools += estimate(
      `${tool.name}\n${tool.description ?? ""}\n${textOf(tool.parameters)}`,
    );
  for (const file of input.contextFiles ?? [])
    result.contextFiles += estimate(file.content);
  for (const skill of input.skills ?? [])
    result.skills += estimate(
      `${skill.name}\n${skill.description}\n${skill.filePath}`,
    );
  return result;
}

const count = (value: number | null | undefined) =>
  value === null || value === undefined ? "unknown" : value.toLocaleString();

export function contextReportOffset(
  lineCount: number,
  offset: number,
  delta: number,
  height: number,
) {
  return Math.max(
    0,
    Math.min(Math.max(0, lineCount - Math.max(1, height)), offset + delta),
  );
}

export function contextReportPage(
  lines: readonly string[],
  width: number,
  offset: number,
  height: number,
): string[] {
  const safeWidth = Math.max(0, width);
  return lines
    .slice(offset, offset + Math.max(1, height))
    .map((line) =>
      line.length > safeWidth
        ? safeWidth === 0
          ? ""
          : `${line.slice(0, safeWidth - 1)}…`
        : line,
    );
}

export function formatContextReport(input: ContextReportInput): string[] {
  const b = contextBreakdown(input);
  const usage = input.usage;
  const remaining =
    usage?.tokens === null || !usage
      ? null
      : Math.max(0, usage.contextWindow - usage.tokens);
  return [
    "Context diagnostics",
    `Pi context estimate: ${count(usage?.tokens)} tokens / ${count(usage?.contextWindow)} window (${count(usage?.percent)}%)`,
    "Source: Pi hybrid context estimate, not provider-reported token usage.",
    `Remaining: ${count(remaining)} tokens`,
    "",
    "Breakdown estimates use chars ÷ 4 (rounded up); they do not sum to Pi estimate.",
    `  System prompt: ${count(b.systemPrompt)} estimated tokens`,
    `  Conversation: user ${count(b.user)}, assistant ${count(b.assistant)} estimated tokens`,
    `  Tool results: ${count(b.toolResults)} estimated tokens`,
    `  Thinking: ${count(b.thinking)} estimated tokens; image blocks ${b.images}`,
    `  Tool call arguments: ${count(b.toolCalls)} estimated tokens (${b.toolCallCount} calls)`,
    `  Active tool definitions (schemas): ${count(b.activeTools)} estimated tokens (${input.activeTools.length} tools)`,
    `  Context files: ${count(b.contextFiles)} estimated tokens (${input.contextFiles?.length ?? 0} files; included in system prompt)`,
    `  Skill declarations: ${count(b.skills)} estimated tokens (${input.skills?.length ?? 0}; included in system prompt, SKILL.md bodies excluded)`,
    `  Compaction summaries: ${count(b.summaries)} estimated tokens (${b.compactions} compactions)`,
  ];
}
