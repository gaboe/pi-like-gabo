import { isDeepStrictEqual } from "node:util";
import { JSONPath } from "jsonpath-plus";
import { RE2JS } from "re2js";
import type { JobCondition, JobEvent } from "./types.js";

export const MAX_QUEUE_EVENTS = 256;
export const MAX_QUEUE_BYTES = 1024 * 1024;
export const MAX_DEDUPE_KEYS = 512;
export const DEFAULT_FRAME_BYTES = 256 * 1024;
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export class BoundedEventQueue {
  readonly events: JobEvent[];
  bytes: number;
  droppedEvents = 0;
  droppedBytes = 0;

  constructor(events: JobEvent[] = [], bytes = 0) {
    this.events = events;
    this.bytes = bytes;
    this.trim();
  }

  push(event: JobEvent) {
    this.events.push(event);
    this.bytes += event.bytes;
    this.trim();
  }

  private trim() {
    while (
      this.events.length > MAX_QUEUE_EVENTS ||
      this.bytes > MAX_QUEUE_BYTES
    ) {
      const removed = this.events.shift();
      if (!removed) break;
      this.bytes -= removed.bytes;
      this.droppedEvents++;
      this.droppedBytes += removed.bytes;
    }
  }
}

const regexCache = new WeakMap<JobCondition, RE2JS | Error>();

function compileRegex(condition: JobCondition) {
  const expression =
    condition.type === "regex" ? condition.expression : String(condition.value);
  if (expression.length > 512)
    throw new Error("Regex conditions are limited to 512 characters.");
  const flags = condition.type === "regex" ? (condition.flags ?? "") : "";
  if (/[^imsu]/.test(flags) || new Set(flags).size !== flags.length)
    throw new Error("Regex flags may only contain i, m, s, and u once.");
  const cached = regexCache.get(condition);
  if (cached instanceof Error) throw cached;
  if (cached) return cached;
  try {
    let re2Flags = 0;
    if (flags.includes("i")) re2Flags |= RE2JS.CASE_INSENSITIVE;
    if (flags.includes("m")) re2Flags |= RE2JS.MULTILINE;
    if (flags.includes("s")) re2Flags |= RE2JS.DOTALL;
    const compiled = RE2JS.compile(expression, re2Flags);
    regexCache.set(condition, compiled);
    return compiled;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    regexCache.set(condition, failure);
    throw failure;
  }
}

export function validateConditions(conditions: JobCondition[]) {
  if (conditions.length > 16)
    throw new Error("A job may have at most 16 conditions.");
  for (const condition of conditions) {
    if (!condition.expression || condition.expression.length > 2048)
      throw new Error("Condition expressions must be 1-2048 characters.");
    if (condition.type === "regex") compileRegex(condition);
    else {
      JSONPath({
        path: condition.expression,
        json: {},
        wrap: true,
        eval: "safe",
      });
      const operator = condition.operator ?? "exists";
      if (operator !== "exists" && condition.value === undefined) {
        throw new Error(`JSONPath operator ${operator} requires value.`);
      }
      if (operator === "in" && !Array.isArray(condition.value))
        throw new Error("JSONPath in operator requires an array value.");
      if (operator === "matches") compileRegex(condition);
    }
  }
}

function parsedJson(data: string) {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

export function matchingConditions(
  conditions: JobCondition[],
  event: JobEvent,
) {
  let json: unknown;
  let parsed = false;
  return conditions.filter((condition) => {
    if (condition.type === "regex")
      return compileRegex(condition).test(event.data.slice(0, MAX_QUEUE_BYTES));
    if (!parsed) {
      json = parsedJson(event.data);
      parsed = true;
    }
    if (json === undefined) return false;
    try {
      const matches = JSONPath<unknown[]>({
        path: condition.expression,
        json,
        wrap: true,
        eval: "safe",
      });
      const operator = condition.operator ?? "exists";
      if (operator === "exists") return matches.length > 0;
      if (operator === "equals")
        return matches.some((value) =>
          isDeepStrictEqual(value, condition.value),
        );
      if (operator === "notEquals")
        return matches.some(
          (value) => !isDeepStrictEqual(value, condition.value),
        );
      if (operator === "in")
        return matches.some((value) =>
          (condition.value as unknown[]).some((candidate) =>
            isDeepStrictEqual(value, candidate),
          ),
        );
      if (operator === "matches") {
        const regex = compileRegex(condition);
        return matches.some((value) =>
          regex.test(typeof value === "string" ? value : JSON.stringify(value)),
        );
      }
      if (operator === "greaterThan")
        return matches.some(
          (value) =>
            typeof value === "number" &&
            typeof condition.value === "number" &&
            value > condition.value,
        );
      return matches.some(
        (value) =>
          typeof value === "number" &&
          typeof condition.value === "number" &&
          value < condition.value,
      );
    } catch {
      return false;
    }
  });
}

export function jsonPathValue(path: string | undefined, data: string) {
  if (!path) return undefined;
  const json = parsedJson(data);
  if (json === undefined) return undefined;
  try {
    const [value] = JSONPath<unknown[]>({
      path,
      json,
      wrap: true,
      eval: "safe",
    });
    return value === undefined
      ? undefined
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export function withResumeCursor(
  raw: string,
  query: string | undefined,
  cursor: string | undefined,
) {
  if (!query || cursor === undefined) return raw;
  const url = new URL(raw);
  url.searchParams.set(query, cursor);
  return url.href;
}
