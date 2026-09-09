import {
  isBoundedMetadata,
  isCanonicalArray,
  MAX_METADATA_ARRAY_LENGTH,
} from "../tool/types.js";

const REDACTED = "[REDACTED]";

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[^\s,;]{8,}/gi,
  /\b(?:token|api[_ -]?key|password|secret)\s*[:=]\s*[^\s,;]{8,}/gi,
];

export function redactTodoText(value: string): string {
  return SECRET_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, REDACTED),
    value,
  );
}

export function redactTodoValue(value: unknown): unknown {
  if (typeof value === "string") return redactTodoText(value);
  if (Array.isArray(value)) {
    if (!isCanonicalArray(value, MAX_METADATA_ARRAY_LENGTH)) return undefined;
    return value.map(redactTodoValue);
  }
  if (!value || typeof value !== "object") return value;
  // Validate descriptors before reading values: persistence must not run getters.
  if (!isBoundedMetadata(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value))
    output[key] = redactTodoValue(entry);
  return output;
}
