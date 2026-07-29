import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizePath(input: string, normalizeToolInput = false): string {
  let normalized = normalizeToolInput
    ? input.replace(UNICODE_SPACES, " ")
    : input;
  if (normalizeToolInput && normalized.startsWith("@"))
    normalized = normalized.slice(1);
  if (normalized === "~") return homedir();
  if (
    normalized.startsWith("~/") ||
    (process.platform === "win32" && normalized.startsWith("~\\"))
  )
    return join(homedir(), normalized.slice(2));
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

export function resolveWorkspaceMutationPath(input: unknown, cwd: string) {
  if (typeof input !== "string")
    throw new TypeError("Workspace mutation path must be a string.");
  const normalized = normalizePath(input, true);
  const normalizedCwd = normalizePath(cwd);
  return isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(normalizedCwd, normalized);
}
