import { basename, relative, resolve } from "node:path";

export type ToolCategory = "read" | "search" | "command" | "other";

const SEARCH_TOOLS = new Set(["grep", "find", "ls", "search", "web_search"]);
const PATH_KEYS = ["path", "file_path", "filePath", "file"] as const;
const LABEL_KEYS = [
  "action",
  "title",
  "subject",
  "query",
  "pattern",
  "name",
] as const;

export function categoryFor(name: string): ToolCategory | undefined {
  const base = name.split(".").pop() ?? name;
  if (base === "edit" || base === "write") return undefined;
  if (base === "read") return "read";
  if (SEARCH_TOOLS.has(base) || base.endsWith("_search")) return "search";
  if (base === "bash") return "command";
  return "other";
}

export function oneLine(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function compactPath(value: unknown, cwd: string): string {
  if (typeof value !== "string" || !value) return "";
  const absolute = resolve(cwd, value);
  const local = relative(cwd, absolute);
  if (local && !local.startsWith("..")) return local;
  return value;
}

function firstString(args: unknown, keys: readonly string[]): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key])
      return oneLine(record[key]);
  }
  return "";
}

export function readTarget(args: unknown, cwd: string): string {
  const path = firstString(args, PATH_KEYS);
  return path ? compactPath(path, cwd) : "file";
}

export function searchTarget(args: unknown): string {
  const value = firstString(args, ["query", "pattern", "search", "glob"]);
  return value ? JSON.stringify(value) : "query";
}

export function commandDisplay(
  args: unknown,
  cwd: string,
): { command: string; location: string } {
  const command = firstString(args, ["command", "cmd"]);
  if (!command) return { command: "command", location: "" };
  const match = command.match(/^cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*(.+)$/);
  if (!match) return { command, location: "" };
  const path = match[1].replace(/^(['"])(.*)\1$/, "$2");
  const absolute = resolve(cwd, path);
  return {
    command: match[2],
    location: absolute === resolve(cwd) ? "." : basename(absolute),
  };
}

export function commandTarget(args: unknown, cwd: string): string {
  const display = commandDisplay(args, cwd);
  return display.location
    ? `${display.location} · ${display.command}`
    : display.command;
}

export function customTarget(name: string, args: unknown): string {
  const label = firstString(args, LABEL_KEYS);
  return label ? `${humanize(name)} ${label}` : humanize(name);
}

export function humanize(name: string): string {
  return name
    .split(".")
    .pop()!
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function resultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (
    result as { content?: Array<{ type?: string; text?: string }> }
  ).content;
  return (
    content?.find(
      (item) => item.type === "text" && typeof item.text === "string",
    )?.text ?? ""
  );
}

export function nonEmptyLineCount(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim()).length;
}

export function resultSummary(
  category: ToolCategory,
  result: unknown,
  partial = false,
): string {
  const text = resultText(result);
  if (!text) return partial ? "running" : "";
  const lines = nonEmptyLineCount(text);
  if (category === "search")
    return `${lines} ${lines === 1 ? "result" : "results"}`;
  if (category === "command") {
    const tests = text.match(/\b(\d+)\s+(?:pass|passed)\b/i)?.[1];
    if (tests) return `${tests} tests passed`;
    const last = text.split(/\r?\n/).map(oneLine).filter(Boolean).at(-1) ?? "";
    const summary = last.length > 72 ? `${last.slice(0, 71)}…` : last;
    return lines > 1 ? `${summary} · ${lines} lines` : summary || "completed";
  }
  if (category === "read") return `${lines} ${lines === 1 ? "line" : "lines"}`;
  return firstMeaningfulLine(text);
}

export function errorPreview(result: unknown, maxLines = 3): string[] {
  return resultText(result)
    .split(/\r?\n/)
    .map(oneLine)
    .filter(Boolean)
    .slice(-maxLines);
}

function firstMeaningfulLine(text: string): string {
  const line = text.split(/\r?\n/).map(oneLine).find(Boolean) ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export function displayTarget(
  category: ToolCategory,
  name: string,
  args: unknown,
  cwd: string,
): string {
  switch (category) {
    case "read":
      return readTarget(args, cwd);
    case "search":
      return searchTarget(args);
    case "command":
      return commandTarget(args, cwd);
    case "other":
      return customTarget(name, args);
  }
}
