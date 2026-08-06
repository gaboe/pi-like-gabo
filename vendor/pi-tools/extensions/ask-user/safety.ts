export const ASK_USER_TIMEOUT_MS = 600_000;

export type TimeoutVerdict =
  | { verdict: "select"; index: number; audit: string }
  | { verdict: "decline"; audit: string };

type AskOption = { label: string; description?: string; details?: string };
type AskParams = {
  question: string;
  options: AskOption[];
  multiSelect?: boolean;
  context?: string;
  considerations?: string[];
  recommendation?: string;
  approvalScope?: string;
  explanation?: Record<string, unknown>;
};

const LOCAL =
  /\b(read|inspect|check|build|tests?|lint|format|status|diff|workspace)\b/i;
const UNSAFE =
  /\b(pr\b|pull request|push|deploy|release|publish|email|mail|jira|ticket|issue|commit|merge|rebase|delete|remove|drop|reset|destroy|truncate|credential|secret|token|password|money|pay|purchase|transfer|external|ambiguous|ambiguity|conflict|unknown|unavailable|error|malformed)\b/i;
const LIMITS = { label: 160 };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function parseTimeoutVerdict(
  value: unknown,
  optionCount: number,
): TimeoutVerdict | undefined {
  if (typeof value !== "string" || value.length > 1_000) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return;
  }
  const result = record(parsed);
  if (!result || typeof result.audit !== "string" || result.audit.length > 500)
    return;
  if (result.verdict === "decline" && keys(result, ["verdict", "audit"]))
    return { verdict: "decline", audit: result.audit };
  const index = result.index;
  if (
    result.verdict === "select" &&
    keys(result, ["verdict", "index", "audit"]) &&
    Number.isInteger(index) &&
    typeof index === "number" &&
    index >= 0 &&
    index < optionCount
  )
    return { verdict: "select", index, audit: result.audit };
}

export function isClearlyLocalReversibleOption(
  label: unknown,
): label is string {
  return (
    typeof label === "string" &&
    label.length > 0 &&
    label.length <= LIMITS.label &&
    LOCAL.test(label) &&
    !UNSAFE.test(label)
  );
}

function prose(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(prose);
  const object = record(value);
  return object ? Object.values(object).flatMap(prose) : [];
}

export function timeoutPreflight(params: AskParams, index: number) {
  const selected = params.options[index];
  if (
    params.multiSelect ||
    !selected ||
    !isClearlyLocalReversibleOption(selected.label)
  )
    return false;
  return !prose([
    params.question,
    params.context,
    params.approvalScope,
    params.considerations,
    params.recommendation,
    params.options,
    params.explanation,
  ]).some((value) => UNSAFE.test(value));
}

export function verifiedLocalSelection(
  output: unknown,
  input: AskParams | readonly AskOption[],
): (TimeoutVerdict & { verdict: "select"; index: number }) | undefined {
  const params: AskParams = Array.isArray(input)
    ? { question: "", options: input as AskOption[] }
    : (input as AskParams);
  const verdict = parseTimeoutVerdict(output, params.options.length);
  return verdict?.verdict === "select" &&
    verdict.index !== undefined &&
    timeoutPreflight(params, verdict.index)
    ? verdict
    : undefined;
}

export type TimeoutVerifierOutcome =
  | {
      kind: "selected";
      verdict: TimeoutVerdict & { verdict: "select"; index: number };
    }
  | { kind: "defer"; verdict: TimeoutVerdict }
  | { kind: "aborted" };

type TimeoutVerifierCompletion = {
  status: "done" | "error";
  output: string;
  error?: string;
};

type TimeoutVerifierDependency = {
  run: (onSpawn: (id: string) => void) => Promise<TimeoutVerifierCompletion>;
  cancel?: (ids: readonly string[]) => Promise<unknown>;
};

function boundedAudit(value: unknown) {
  return (
    (typeof value === "string" && value) ||
    "Verifier unavailable or invalid"
  ).slice(0, 500);
}

/** Selected verdict indexes are zero-based; callers map them to user-facing one-based indexes. */
export async function runTimeoutVerifier(
  params: AskParams,
  dependency: TimeoutVerifierDependency | undefined,
  parentSignal?: AbortSignal,
): Promise<TimeoutVerifierOutcome> {
  if (parentSignal?.aborted) return { kind: "aborted" };
  if (!dependency)
    return {
      kind: "defer",
      verdict: { verdict: "decline", audit: "Verifier unavailable or invalid" },
    };
  let id: string | undefined;
  const cancel = () => {
    if (id) void dependency.cancel?.([id]);
  };
  parentSignal?.addEventListener("abort", cancel, { once: true });
  try {
    const completion = await dependency.run((spawned) => {
      id = spawned;
      if (parentSignal?.aborted) cancel();
    });
    if (parentSignal?.aborted) return { kind: "aborted" };
    const parsed =
      completion.status === "done"
        ? parseTimeoutVerdict(completion.output, params.options.length)
        : undefined;
    const selection =
      completion.status === "done"
        ? verifiedLocalSelection(completion.output, params)
        : undefined;
    if (selection) return { kind: "selected", verdict: selection };
    return {
      kind: "defer",
      verdict: parsed ?? {
        verdict: "decline",
        audit: boundedAudit(completion.error),
      },
    };
  } catch (error) {
    if (parentSignal?.aborted) return { kind: "aborted" };
    return {
      kind: "defer",
      verdict: {
        verdict: "decline",
        audit: boundedAudit(error instanceof Error ? error.message : undefined),
      },
    };
  } finally {
    parentSignal?.removeEventListener("abort", cancel);
  }
}

export function deadlineDelay(now: number, deadline: number) {
  return Math.max(0, deadline - now);
}

export function createTuiDeadline(
  timeoutMs: number,
  parentSignal?: AbortSignal,
  timers = { setTimeout, clearTimeout },
) {
  const controller = new AbortController();
  let timedOut = false;
  let parentAborted = false;
  const cancel = () => {
    parentAborted = true;
    controller.abort();
  };
  parentSignal?.addEventListener("abort", cancel, { once: true });
  const timer = timers.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    parentAborted: () => parentAborted,
    cleanup: () => {
      timers.clearTimeout(timer);
      parentSignal?.removeEventListener("abort", cancel);
    },
  };
}
