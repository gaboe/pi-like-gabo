import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseTurnBudgetRequest } from "./turn-budget.ts";

export const PACKAGE_HANDOFF_STATUSES = [
  "done",
  "partial",
  "blocked",
  "failed",
] as const;
export type PackageHandoffStatus = (typeof PACKAGE_HANDOFF_STATUSES)[number];

export const MAX_HANDOFF_RAW_BYTES = 64 * 1024;
export const MAX_HANDOFF_ARRAY_ITEMS = 64;
export const MAX_HANDOFF_CHANGED_PATHS = 256;
export const MAX_HANDOFF_STRING_LENGTH = 4_096;
const RAW_EVIDENCE_PREFIX_BYTES = 4_096;

export interface PackageHandoff {
  readonly status: PackageHandoffStatus;
  readonly acceptance: ReadonlyArray<{
    readonly criterion: string;
    readonly passed: boolean;
    readonly evidence: ReadonlyArray<string>;
  }>;
  readonly changed_paths: ReadonlyArray<string>;
  readonly checks: ReadonlyArray<{
    readonly name: string;
    readonly result: string;
  }>;
  readonly review: string;
  readonly remaining_work: ReadonlyArray<string>;
  readonly risks: ReadonlyArray<string>;
  readonly budget_request?: {
    readonly additional_turns: number;
    readonly reason: string;
  };
}

export type HandoffValidation =
  | { readonly valid: true; readonly handoff: PackageHandoff }
  | { readonly valid: false; readonly errors: ReadonlyArray<string> };

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function nonBlankString(
  value: unknown,
  field: string,
  errors: string[],
  maxLength = MAX_HANDOFF_STRING_LENGTH,
) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${field} must be a non-empty string.`);
    return "";
  }
  if (value.length > maxLength) {
    errors.push(`${field} must be at most ${maxLength} characters.`);
    return value.slice(0, maxLength);
  }
  return value.trim();
}

function strings(
  value: unknown,
  field: string,
  errors: string[],
  maxItems = MAX_HANDOFF_ARRAY_ITEMS,
) {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array of strings.`);
    return [];
  }
  if (value.length > maxItems)
    errors.push(`${field} must contain at most ${maxItems} entries.`);
  const output: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.slice(0, maxItems).entries()) {
    const text = nonBlankString(item, `${field}[${index}]`, errors);
    if (!text) continue;
    if (seen.has(text)) errors.push(`${field} must not contain duplicates.`);
    else {
      seen.add(text);
      output.push(text);
    }
  }
  return output;
}

function changedPaths(value: unknown, cwd: string, errors: string[]) {
  const paths = strings(
    value,
    "changed_paths",
    errors,
    MAX_HANDOFF_CHANGED_PATHS,
  );
  const root = resolve(cwd);
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const [index, input] of paths.entries()) {
    const absolute = isAbsolute(input) ? resolve(input) : resolve(root, input);
    const fromRoot = relative(root, absolute);
    if (
      !fromRoot ||
      fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      errors.push(`changed_paths[${index}] must resolve inside task.cwd.`);
      continue;
    }
    const path = fromRoot.split(sep).join("/");
    if (seen.has(path))
      errors.push("changed_paths must not contain duplicates.");
    else {
      seen.add(path);
      normalized.push(path);
    }
  }
  return normalized;
}

export function handoffRawEvidence(text: string) {
  const raw = Buffer.from(text);
  if (raw.byteLength <= MAX_HANDOFF_RAW_BYTES) return text;
  const prefix = raw.subarray(0, RAW_EVIDENCE_PREFIX_BYTES).toString("utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  return `${prefix}\n\n[truncated package handoff: ${raw.byteLength} bytes, sha256:${hash}]`;
}

export function parsePackageHandoff(
  text: string,
  cwd: string,
): HandoffValidation {
  const byteLength = Buffer.byteLength(text);
  if (byteLength > MAX_HANDOFF_RAW_BYTES) {
    return {
      valid: false,
      errors: [
        `Final handoff must be at most ${MAX_HANDOFF_RAW_BYTES} bytes; received ${byteLength}.`,
      ],
    };
  }

  const errors: string[] = [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { valid: false, errors: ["Final handoff must be a JSON object."] };
  }
  const input = object(value);
  if (!input)
    return { valid: false, errors: ["Final handoff must be a JSON object."] };
  const status = input.status;
  if (!PACKAGE_HANDOFF_STATUSES.includes(status as PackageHandoffStatus))
    errors.push("status must be done, partial, blocked, or failed.");

  const acceptanceInput = input.acceptance;
  const acceptance: Array<PackageHandoff["acceptance"][number]> = [];
  const criteria = new Set<string>();
  if (!Array.isArray(acceptanceInput) || acceptanceInput.length === 0) {
    errors.push("acceptance must be a non-empty array.");
  } else {
    if (acceptanceInput.length > MAX_HANDOFF_ARRAY_ITEMS)
      errors.push(
        `acceptance must contain at most ${MAX_HANDOFF_ARRAY_ITEMS} entries.`,
      );
    for (const [index, item] of acceptanceInput
      .slice(0, MAX_HANDOFF_ARRAY_ITEMS)
      .entries()) {
      const criterion = object(item);
      const criterionText = nonBlankString(
        criterion?.criterion,
        `acceptance[${index}].criterion`,
        errors,
      );
      if (criterionText) {
        if (criteria.has(criterionText))
          errors.push("acceptance must not contain duplicate criteria.");
        criteria.add(criterionText);
      }
      if (!criterion || typeof criterion.passed !== "boolean")
        errors.push(`acceptance[${index}].passed must be a boolean.`);
      const evidence = strings(
        criterion?.evidence,
        `acceptance[${index}].evidence`,
        errors,
      );
      acceptance.push({
        criterion: criterionText,
        passed: criterion?.passed === true,
        evidence,
      });
    }
  }

  const changed_paths = changedPaths(input.changed_paths, cwd, errors);
  const remaining_work = strings(
    input.remaining_work,
    "remaining_work",
    errors,
  );
  const risks = strings(input.risks, "risks", errors);
  const checksInput = input.checks;
  const checks: Array<PackageHandoff["checks"][number]> = [];
  const checkNames = new Set<string>();
  if (!Array.isArray(checksInput)) errors.push("checks must be an array.");
  else {
    if (checksInput.length > MAX_HANDOFF_ARRAY_ITEMS)
      errors.push(
        `checks must contain at most ${MAX_HANDOFF_ARRAY_ITEMS} entries.`,
      );
    for (const [index, item] of checksInput
      .slice(0, MAX_HANDOFF_ARRAY_ITEMS)
      .entries()) {
      const check = object(item);
      const name = nonBlankString(check?.name, `checks[${index}].name`, errors);
      const result = nonBlankString(
        check?.result,
        `checks[${index}].result`,
        errors,
      );
      if (name) {
        if (checkNames.has(name))
          errors.push("checks must not contain duplicate names.");
        checkNames.add(name);
      }
      checks.push({ name, result });
    }
  }
  const review = nonBlankString(input.review, "review", errors);
  const budgetRequest = parseTurnBudgetRequest(text);
  if (input.budget_request !== undefined && !budgetRequest)
    errors.push(
      "budget_request requires partial status, additional_turns from 1 to 48, a non-empty reason, and non-empty remaining_work.",
    );
  if (acceptance.some((item) => item.evidence.length === 0))
    errors.push("Every acceptance criterion requires non-empty evidence.");
  if (status === "done" && acceptance.some((item) => !item.passed))
    errors.push("done requires every acceptance criterion to pass.");
  return errors.length
    ? { valid: false, errors }
    : {
        valid: true,
        handoff: {
          status: status as PackageHandoffStatus,
          acceptance,
          changed_paths,
          checks,
          review,
          remaining_work,
          risks,
          budget_request: budgetRequest
            ? {
                additional_turns: budgetRequest.additionalTurns,
                reason: budgetRequest.reason,
              }
            : undefined,
        },
      };
}

export function packageHandoffCorrection(errors: ReadonlyArray<string>) {
  return `Mechanical Handoff Gate rejected final output:\n${errors.map((error) => `- ${error}`).join("\n")}\n\nReturn one corrected JSON Package Handoff only. Required fields: status, acceptance [{criterion, passed, evidence}], changed_paths, checks [{name, result}], review, remaining_work, risks. Optional budget_request is {additional_turns, reason} and requires partial status plus non-empty remaining_work. This is your reserved correction opportunity.`;
}
