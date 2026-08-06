import type { ProviderErrorMetadata, RetryCategory } from "./model.ts";

export type { RetryCategory } from "./model.ts";

export interface RetryClassification {
  category: RetryCategory;
  retryable: boolean;
  retryAfter?: number;
  resetAt?: number;
}

export interface PausedProviderMetadata {
  provider?: string;
  reason: string;
}

const text = (value: unknown) =>
  (value instanceof Error ? value.message : String(value ?? "")).slice(0, 2048);

const clean = (value: unknown, max: number) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, max);

export function pausedProviderMetadata(
  metadata: ProviderErrorMetadata | undefined,
): PausedProviderMetadata {
  const provider = clean(metadata?.provider, 128);
  return {
    ...(provider ? { provider } : {}),
    reason: metadata?.code
      ? `Provider quota (${clean(metadata.code, 64)})`
      : "Provider quota exhausted",
  };
}

export function classifyRetry(
  error: unknown,
  metadata?: ProviderErrorMetadata,
): RetryClassification {
  const status = metadata?.status;
  const code = metadata?.code?.toLowerCase();
  const message = text(error).toLowerCase();
  const hints = {
    ...(metadata?.retryAfter !== undefined
      ? { retryAfter: metadata.retryAfter }
      : {}),
    ...(metadata?.resetAt !== undefined ? { resetAt: metadata.resetAt } : {}),
  };
  if (
    status === 429 ||
    (code !== undefined &&
      [
        "429",
        "rate_limit",
        "rate_limit_exceeded",
        "quota_exceeded",
        "insufficient_quota",
        "resource_exhausted",
        "too_many_requests",
      ].includes(code))
  )
    return { category: "quota", retryable: false, ...hints };
  if (status !== undefined && [400, 401, 403, 404, 422].includes(status)) {
    return {
      category: status === 403 ? "policy" : "validation",
      retryable: false,
    };
  }
  if (status !== undefined && status >= 500 && status < 600) {
    return { category: "transport", retryable: true };
  }
  if (
    /\b(econnreset|enotfound|eai_again|network error|socket hang up)\b/.test(
      message,
    )
  )
    return { category: "transport", retryable: true };
  if (/\b(timeout|timed out|no assistant response event)\b/.test(message))
    return { category: "timeout", retryable: false };
  if (
    /\b(startup|initializ(?:e|ation)|failed to create agent session)\b/.test(
      message,
    )
  )
    return { category: "transient_startup", retryable: true };
  if (/\b(validation|invalid request|schema)\b/.test(message))
    return { category: "validation", retryable: false };
  if (/\b(policy|permission denied|forbidden)\b/.test(message))
    return { category: "policy", retryable: false };
  return { category: "unknown", retryable: false };
}
