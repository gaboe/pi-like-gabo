import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { SummaryConfig } from "./config.ts";
import { throwIfAborted, withAbortTimeout } from "./abort.ts";
import { buildSummaryPrompt, SUMMARY_SYSTEM_PROMPT } from "./prompt.ts";

const RECAP_MAX_LENGTH = 2_400;
const NEXT_MAX_LENGTH = 400;

class SummaryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SummaryError";
  }
}

export interface RunRecap {
  readonly recap: string;
  readonly next: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function cleanField(value: string, maxLength: number) {
  const cleaned = value
    .replace(
      // Strip ANSI/OSC sequences before rendering model output in the terminal.
      // eslint-disable-next-line no-control-regex
      /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g,
      "",
    )
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .trim();
  return cleaned.length <= maxLength
    ? cleaned
    : `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
}

function parseCandidate(candidate: string) {
  try {
    const value: unknown = JSON.parse(candidate);
    if (
      !isRecord(value) ||
      Object.keys(value).sort().join(",") !== "next,recap" ||
      typeof value.recap !== "string" ||
      typeof value.next !== "string"
    ) {
      return undefined;
    }

    const recap = cleanField(value.recap, RECAP_MAX_LENGTH);
    const next = cleanField(
      value.next.replace(/^next\s*:\s*/i, ""),
      NEXT_MAX_LENGTH,
    );
    if (!recap || !next) return undefined;
    return { recap, next } satisfies RunRecap;
  } catch {
    return undefined;
  }
}

export function parseRecapResponse(text: string) {
  const trimmed = text.trim();
  const candidates = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]) candidates.push(match[1].trim());
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    const parsed = parseCandidate(candidate);
    if (parsed) return parsed;
  }
  throw new SummaryError("The summary model did not return valid recap JSON.");
}

export function reasoningOptions(reasoning: SummaryConfig["reasoning"]) {
  return reasoning === "off" ? {} : { reasoning };
}

function assistantText(
  content: Awaited<ReturnType<typeof completeSimple>>["content"],
) {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export async function summarizeRun(options: {
  readonly modelRegistry: ModelRegistry;
  readonly config: SummaryConfig;
  readonly transcript: string;
  readonly signal: AbortSignal;
}) {
  const operation = withAbortTimeout(options.signal, 45_000);
  try {
    throwIfAborted(operation.signal);
    const model = options.modelRegistry.find(
      options.config.provider,
      options.config.model,
    );
    if (!model) {
      throw new SummaryError(
        `Summary model is unavailable: ${options.config.provider}/${options.config.model}`,
      );
    }

    const auth = await options.modelRegistry.getApiKeyAndHeaders(model);
    throwIfAborted(operation.signal);
    if (!auth.ok) throw new SummaryError(auth.error);

    const response = await completeSimple(
      model,
      {
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildSummaryPrompt(options.transcript),
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        env: auth.env,
        headers: auth.headers,
        maxTokens: 1_000,
        maxRetries: 1,
        signal: operation.signal,
        timeoutMs: 40_000,
        ...reasoningOptions(options.config.reasoning),
      },
    );

    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new SummaryError(
        response.errorMessage ?? "Summary model request failed.",
      );
    }
    return parseRecapResponse(assistantText(response.content));
  } catch (cause) {
    if (cause instanceof SummaryError) throw cause;
    throw new SummaryError(
      cause instanceof Error ? cause.message : String(cause),
      { cause },
    );
  } finally {
    operation.dispose();
  }
}
