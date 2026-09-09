import { spawn } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  categoryFor,
  displayTarget,
  resultSummary,
  resultText,
  nonEmptyLineCount,
  type ToolCategory,
} from "./format.js";
import { renderCompactEntries } from "./shared-render.js";
import {
  getCompactToolRenderer,
  setCompactToolRenderer,
  type CompactToolRendererApi,
} from "../../vendor/pi-tools/extensions/shared/compact-tool-renderer-protocol.js";
import { artifactLocation, ToolResultArtifacts } from "./artifacts.js";
import {
  boundToolResultHistory,
  providerText,
  type RecoveryMarker,
} from "./context-budget.js";

const CONFIG_ENTRY = "compact-tools-config";
const SUMMARY_ENTRY = "compact-tools-summary";
const PATCH_KEY = Symbol.for("pi-plugins.compact-tools.patch.v1");
const STATE_KEY = Symbol.for("pi-plugins.compact-tools.state.v1");
const RENDERER_OWNER_KEY = Symbol.for(
  "pi-plugins.compact-tools.renderer-owner.v1",
);
const RENDERER_PRIOR_KEY = Symbol.for(
  "pi-plugins.compact-tools.renderer-prior.v1",
);
const RENDERER_ACTIVE_KEY = Symbol.for(
  "pi-plugins.compact-tools.renderer-active.v1",
);
const COMPACT_CONTEXT_AT_TOKENS = 100_000;
const REARM_CONTEXT_COMPACTION_AT_TOKENS = 80_000;
const MAX_WIDTH = 110;
const BATCH_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "rg",
  "fd",
] as const;
type BatchToolInputName = (typeof BATCH_TOOL_NAMES)[number];
type BatchToolName = Exclude<BatchToolInputName, "rg">;
type BatchCall = { tool: BatchToolName; args: Record<string, unknown> };

const BATCH_ARGUMENT_KEYS: Record<BatchToolInputName, readonly string[]> = {
  read: ["path", "offset", "limit"],
  grep: [
    "pattern",
    "path",
    "glob",
    "ignoreCase",
    "literal",
    "context",
    "limit",
  ],
  find: ["pattern", "path", "limit"],
  ls: ["path", "limit"],
  bash: ["command", "timeout"],
  rg: [
    "pattern",
    "path",
    "glob",
    "case_sensitive",
    "fixed_strings",
    "context",
    "limit",
  ],
  fd: ["pattern", "path", "extension", "glob", "limit"],
};

const BATCH_ARGUMENT_PROPERTIES = {
  path: { type: "string" },
  offset: { type: "integer", minimum: 1 },
  limit: { type: "integer", minimum: 1 },
  pattern: { type: "string" },
  glob: { type: "string" },
  ignoreCase: { type: "boolean" },
  literal: { type: "boolean" },
  context: { type: "integer", minimum: 0 },
  command: { type: "string" },
  timeout: { type: "number", minimum: 0 },
  case_sensitive: { type: "boolean" },
  fixed_strings: { type: "boolean" },
  extension: { type: "string" },
} as const;

const BATCH_REQUIRED_ARGUMENT_KEYS: Record<
  BatchToolInputName,
  readonly string[]
> = {
  read: ["path"],
  grep: ["pattern"],
  find: ["pattern"],
  ls: [],
  bash: ["command"],
  rg: ["pattern"],
  fd: [],
};

function batchArgumentProperties(tool: BatchToolInputName) {
  return Object.fromEntries(
    BATCH_ARGUMENT_KEYS[tool].map((key) => {
      if (key === "glob" && tool === "fd") return [key, { type: "boolean" }];
      if (key === "limit" && tool === "rg")
        return [key, { type: "integer", minimum: 1, maximum: 1_000 }];
      if (key === "context" && tool === "rg")
        return [key, { type: "integer", minimum: 0, maximum: 20 }];
      return [
        key,
        BATCH_ARGUMENT_PROPERTIES[
          key as keyof typeof BATCH_ARGUMENT_PROPERTIES
        ],
      ];
    }),
  );
}

function batchCallSchema(
  tool: BatchToolInputName,
  selector: "tool" | "name",
  mode: "flat" | "args" | "arguments",
) {
  const argumentProperties = batchArgumentProperties(tool);
  const requiredArguments = [...BATCH_REQUIRED_ARGUMENT_KEYS[tool]];
  const selectorProperty = { type: "string", enum: [tool] };
  if (mode === "flat")
    return {
      type: "object",
      additionalProperties: false,
      properties: { [selector]: selectorProperty, ...argumentProperties },
      required: [selector, ...requiredArguments],
    };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      [selector]: selectorProperty,
      [mode]: {
        type: "object",
        additionalProperties: false,
        properties: argumentProperties,
        ...(requiredArguments.length > 0
          ? { required: requiredArguments }
          : {}),
      },
    },
    required: [selector, mode],
  };
}

const BATCH_CALL_SCHEMAS = BATCH_TOOL_NAMES.flatMap((tool) =>
  (["tool", "name"] as const).flatMap((selector) =>
    (["flat", "args", "arguments"] as const).map((mode) =>
      batchCallSchema(tool, selector, mode),
    ),
  ),
);

export const MAX_BATCH_CALLS = 8;
export const MAX_BATCH_OUTPUT_BYTES = 50_000;
export const MAX_BATCH_OUTPUT_LINES = 2_000;
const BATCH_OUTPUT_TRUNCATION_MARKER =
  "[tool_batch output truncated; rerun with narrower calls]";

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  let end = Math.min(bytes.byteLength, maxBytes);
  while (end > 0) {
    let start = end - 1;
    while (start > 0 && (bytes[start] & 0xc0) === 0x80) start--;
    const lead = bytes[start];
    const width =
      lead < 0x80
        ? 1
        : lead >= 0xc2 && lead <= 0xdf
          ? 2
          : lead >= 0xe0 && lead <= 0xef
            ? 3
            : lead >= 0xf0 && lead <= 0xf4
              ? 4
              : 1;
    if (start + width <= end) break;
    end = start;
  }
  return bytes.subarray(0, end).toString("utf8");
}

export function boundBatchOutput(value: string): string {
  let body = value;
  let truncated = false;
  if (body.split("\n").length > MAX_BATCH_OUTPUT_LINES) {
    body = body
      .split("\n")
      .slice(0, MAX_BATCH_OUTPUT_LINES - 1)
      .join("\n");
    truncated = true;
  }
  const markerBytes = Buffer.byteLength(
    `\n${BATCH_OUTPUT_TRUNCATION_MARKER}`,
    "utf8",
  );
  if (
    truncated ||
    Buffer.byteLength(body, "utf8") + markerBytes > MAX_BATCH_OUTPUT_BYTES
  ) {
    body = body
      .split("\n")
      .slice(0, MAX_BATCH_OUTPUT_LINES - 1)
      .join("\n");
    body = truncateUtf8(
      body,
      Math.max(0, MAX_BATCH_OUTPUT_BYTES - markerBytes),
    );
    truncated = true;
  }
  if (!truncated) return body;
  const marker = `\n${BATCH_OUTPUT_TRUNCATION_MARKER}`;
  return `${truncateUtf8(body, MAX_BATCH_OUTPUT_BYTES - Buffer.byteLength(marker, "utf8"))}${marker}`;
}

export const TOOL_BATCH_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    calls: {
      type: "array",
      minItems: 1,
      maxItems: MAX_BATCH_CALLS,
      items: { oneOf: BATCH_CALL_SCHEMAS },
    },
    concurrency: { type: "integer", minimum: 1, maximum: 8 },
  },
  required: ["calls"],
} as const;

function definedArgs(args: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== undefined),
  );
}

function canonicalBatchRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`${label} must be an object`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    )
      throw new Error(`${label} must contain only plain data properties`);
  }
  return value as Record<string, unknown>;
}

function validateBatchArgs(
  tool: BatchToolInputName,
  args: Record<string, unknown>,
  index: number,
): void {
  const fail = (message: string): never => {
    throw new Error(`tool_batch call ${index + 1} ${message}`);
  };
  const allowed = new Set(BATCH_ARGUMENT_KEYS[tool]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) fail(`has an unknown ${tool} argument: ${key}`);
  }
  const string = (key: string, required = false): void => {
    const value = args[key];
    if (value === undefined) {
      if (required) fail(`requires ${key}`);
      return;
    }
    if (typeof value !== "string" || (required && !value.trim()))
      fail(`requires ${key} to be a${required ? " non-empty" : ""} string`);
  };
  const boolean = (key: string): void => {
    if (args[key] !== undefined && typeof args[key] !== "boolean")
      fail(`requires ${key} to be a boolean`);
  };
  const integer = (key: string, minimum: number, maximum?: number): void => {
    const value = args[key];
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) ||
        (value as number) < minimum ||
        (maximum !== undefined && (value as number) > maximum))
    )
      fail(
        `requires ${key} to be an integer from ${minimum}${maximum === undefined ? "" : ` to ${maximum}`}`,
      );
  };
  string("path", tool === "read");
  integer("limit", 1, tool === "rg" ? 1_000 : undefined);
  if (tool === "read") integer("offset", 1);
  if (tool === "grep" || tool === "rg") {
    string("pattern", true);
    string("glob");
    integer("context", 0, tool === "rg" ? 20 : undefined);
  }
  if (tool === "grep") {
    boolean("ignoreCase");
    boolean("literal");
  }
  if (tool === "find") string("pattern", true);
  if (tool === "bash") {
    string("command", true);
    const timeout = args.timeout;
    if (
      timeout !== undefined &&
      (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0)
    )
      fail("requires timeout to be a finite non-negative number");
  }
  if (tool === "rg") {
    boolean("case_sensitive");
    boolean("fixed_strings");
  }
  if (tool === "fd") {
    string("pattern");
    string("extension");
    boolean("glob");
  }
}

export function normalizeBatchCalls(value: unknown): BatchCall[] {
  if (!Array.isArray(value))
    throw new Error("tool_batch calls must be an array");
  if (value.length === 0)
    throw new Error("tool_batch calls must contain at least one call");
  if (value.length > MAX_BATCH_CALLS)
    throw new Error(
      `tool_batch calls must not contain more than ${MAX_BATCH_CALLS} calls`,
    );
  return value.map((raw, index): BatchCall => {
    const record = canonicalBatchRecord(raw, `tool_batch call ${index + 1}`);
    const hasTool = Object.prototype.hasOwnProperty.call(record, "tool");
    const hasName = Object.prototype.hasOwnProperty.call(record, "name");
    const hasArgs = Object.prototype.hasOwnProperty.call(record, "args");
    const hasArguments = Object.prototype.hasOwnProperty.call(
      record,
      "arguments",
    );
    if (hasArgs && hasArguments)
      throw new Error(
        `tool_batch call ${index + 1} must not contain both args and arguments`,
      );
    if (hasTool === hasName)
      throw new Error(
        `tool_batch call ${index + 1} must contain exactly one of tool or name`,
      );
    const tool = (hasTool ? record.tool : record.name) as BatchToolInputName;
    if (typeof tool !== "string" || !BATCH_TOOL_NAMES.includes(tool))
      throw new Error(
        `tool_batch call ${index + 1} has an invalid tool selector`,
      );
    const allowedWrapperKeys = new Set([
      "tool",
      "name",
      "args",
      "arguments",
      ...BATCH_ARGUMENT_KEYS[tool],
    ]);
    for (const key of Object.keys(record)) {
      if (!allowedWrapperKeys.has(key))
        throw new Error(
          `tool_batch call ${index + 1} has an unknown wrapper key: ${key}`,
        );
    }
    const hasNested = hasArgs || hasArguments;
    const nestedValue = hasArgs
      ? record.args
      : hasArguments
        ? record.arguments
        : undefined;
    const nested = hasNested
      ? canonicalBatchRecord(
          nestedValue,
          `tool_batch call ${index + 1} arguments`,
        )
      : {};
    const flat = Object.fromEntries(
      Object.entries(record).filter(
        ([key]) => !["tool", "name", "args", "arguments"].includes(key),
      ),
    );
    if (hasNested && Object.keys(flat).length > 0)
      throw new Error(
        `tool_batch call ${index + 1} cannot mix inline and nested arguments`,
      );
    const args = hasNested ? nested : flat;
    validateBatchArgs(tool, args, index);
    if (tool === "rg") {
      return {
        tool: "grep",
        args: definedArgs({
          pattern: args.pattern,
          path: args.path,
          glob: args.glob,
          ignoreCase: args.case_sensitive === false ? true : undefined,
          literal: args.fixed_strings === true ? true : undefined,
          context: args.context,
          limit: args.limit,
        }),
      };
    }
    if (tool === "fd") {
      return {
        tool: "fd",
        args: definedArgs({
          pattern: args.pattern,
          path: args.path,
          extension: args.extension,
          glob: args.glob,
          limit: args.limit,
        }),
      };
    }
    return { tool, args };
  });
}

function createFdTool(cwd: string) {
  return {
    name: "fd",
    async execute(
      _id: string,
      args: {
        pattern?: string;
        path?: string;
        extension?: string;
        glob?: boolean;
        limit?: number;
      },
      signal?: AbortSignal,
    ) {
      const searchPath = args.path ?? ".";
      const commandArgs = ["--color=never", "--hidden"];
      if (args.glob === true) commandArgs.push("--glob");
      if (args.extension !== undefined)
        commandArgs.push("--extension", args.extension.replace(/^\./, ""));
      commandArgs.push("--max-results", String(args.limit ?? 1_000), "--");
      commandArgs.push(args.pattern ?? ".", searchPath);
      return new Promise((resolve, reject) => {
        const child = spawn("fd", commandArgs, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          signal,
        });
        let output = "";
        let error = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (error += chunk));
        child.once("error", (cause) => reject(cause));
        child.once("close", (code) => {
          if (signal?.aborted) return reject(signal.reason);
          if (code !== 0)
            return reject(
              new Error(error.trim() || `fd exited with code ${code}`),
            );
          resolve({
            content: [
              {
                type: "text",
                text: output.trim() || "No files found matching pattern",
              },
            ],
          });
        });
      });
    },
  };
}

function batchTool(name: BatchToolName, cwd: string) {
  switch (name) {
    case "read":
      return createReadTool(cwd);
    case "grep":
      return createGrepTool(cwd);
    case "find":
      return createFindTool(cwd);
    case "fd":
      return createFdTool(cwd);
    case "ls":
      return createLsTool(cwd);
    case "bash":
      return createBashTool(cwd);
  }
}

export function registerToolBatch(
  pi: ExtensionAPI,
  cwd: string | (() => string),
) {
  pi.registerTool({
    name: "tool_batch",
    label: "Tool Batch",
    description:
      "Run independent read/grep/find/ls/bash calls together. rg/fd are compatibility aliases normalized to grep/find.",
    parameters: TOOL_BATCH_PARAMETERS as never,
    async execute(id, params: any, signal) {
      const executionCwd = typeof cwd === "function" ? cwd() : cwd;
      const calls = normalizeBatchCalls(params.calls);
      const results = new Array<string>(calls.length);
      let next = 0;
      let cancelled = false;
      let abortFailure: unknown;
      const batchController = new AbortController();
      const childSignal = signal
        ? AbortSignal.any([signal, batchController.signal])
        : batchController.signal;
      const abortBatch = (reason: unknown): void => {
        cancelled = true;
        abortFailure ??= reason;
        if (!batchController.signal.aborted) batchController.abort(reason);
      };
      const onCallerAbort = (): void =>
        abortBatch(signal?.reason ?? new Error("tool batch aborted"));
      signal?.addEventListener("abort", onCallerAbort, { once: true });
      if (signal?.aborted) onCallerAbort();
      const isAbortFailure = (error: unknown): boolean => {
        if (batchController.signal.aborted) return true;
        if (error !== null && typeof error === "object") {
          const name = (error as { name?: unknown }).name;
          if (name === "AbortError" || name === "TimeoutError") return true;
        }
        return (
          (error instanceof Error &&
            /^(?:command\s+)?(?:aborted|cancelled|canceled)\b/i.test(
              error.message,
            )) ||
          (error instanceof Error &&
            /^command\s+timed\s+out\b/i.test(error.message))
        );
      };
      if (
        params.concurrency !== undefined &&
        (!Number.isFinite(params.concurrency) ||
          !Number.isInteger(params.concurrency) ||
          params.concurrency < 1 ||
          params.concurrency > 8)
      )
        throw new Error(
          "tool_batch concurrency must be an integer from 1 to 8",
        );
      const concurrency = Math.min(
        calls.length,
        params.concurrency ?? calls.length,
        8,
      );
      const workers = Array.from({ length: concurrency }, async () => {
        while (next < calls.length) {
          if (cancelled || childSignal.aborted) {
            const reason =
              childSignal.reason ?? new Error("tool batch aborted");
            abortBatch(reason);
            throw reason;
          }
          const index = next++;
          const call = calls[index];
          try {
            const tool = batchTool(call.tool, executionCwd) as any;
            const result = await tool.execute(
              `${id}:${index}`,
              call.args,
              childSignal,
            );
            results[index] =
              `## ${index + 1}. ${call.tool}\n${resultText(result) || "(no output)"}`;
          } catch (error) {
            if (isAbortFailure(error)) {
              abortBatch(error);
              throw error;
            }
            results[index] =
              `## ${index + 1}. ${call.tool}\nError: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
      });
      try {
        await Promise.allSettled(workers);
        if (signal?.aborted || childSignal.aborted)
          abortBatch(
            signal?.reason ??
              childSignal.reason ??
              new Error("tool batch aborted"),
          );
        if (abortFailure !== undefined) throw abortFailure;
        return {
          content: [
            {
              type: "text",
              text: boundBatchOutput(
                `Batch: ${calls.length} call(s)\n\n${results.join("\n\n")}`,
              ),
            },
          ],
          details: { calls: calls.length },
        };
      } finally {
        signal?.removeEventListener("abort", onCallerAbort);
      }
    },
  });
}

export function compactionThresholds(contextWindow: number | undefined) {
  if (!contextWindow)
    return {
      compactAt: COMPACT_CONTEXT_AT_TOKENS,
      rearmAt: REARM_CONTEXT_COMPACTION_AT_TOKENS,
    };
  const compactAt = Math.min(
    COMPACT_CONTEXT_AT_TOKENS,
    Math.floor(contextWindow * 0.7),
  );
  return { compactAt, rearmAt: Math.floor(compactAt * 0.8) };
}

type ToolInfo = {
  id: string;
  name: string;
  category: ToolCategory;
  args: unknown;
  target: string;
  hidden: boolean;
  running: boolean;
  isError: boolean;
  startedAt?: number;
  durationMs?: number;
  result?: unknown;
  compactOutput?: string;
  compactSummary?: string;
  outputLineCount?: number;
  finalResult?: unknown;
  group?: ToolInfo[];
  invalidate?: () => void;
};

type Stats = {
  startedAt: number;
  reads: number;
  searches: number;
  commands: number;
  mutations: number;
  others: number;
  failed: number;
};

type RuntimeState = {
  enabled: boolean;
  cwd: string;
  theme?: Theme;
  tools: Map<string, ToolInfo>;
  group: ToolInfo[];
  components: Set<any>;
  stats: Stats;
};

type Summary = Omit<Stats, "startedAt"> & { durationMs: number };

function newStats(): Stats {
  return {
    startedAt: Date.now(),
    reads: 0,
    searches: 0,
    commands: 0,
    mutations: 0,
    others: 0,
    failed: 0,
  };
}

function runtime(): RuntimeState {
  const root = globalThis as typeof globalThis & { [STATE_KEY]?: RuntimeState };
  return (root[STATE_KEY] ??= {
    enabled: true,
    cwd: process.cwd(),
    tools: new Map(),
    group: [],
    components: new Set(),
    stats: newStats(),
  });
}

const state = runtime();
type OwnedRendererApi = CompactToolRendererApi & {
  [RENDERER_OWNER_KEY]: symbol;
  [RENDERER_PRIOR_KEY]: CompactToolRendererApi | undefined;
  [RENDERER_ACTIVE_KEY]: boolean;
};

function createRendererApi(
  owner: symbol,
  prior: CompactToolRendererApi | undefined,
): OwnedRendererApi {
  const api: CompactToolRendererApi = {
    version: 1,
    enabled: () => state.enabled,
    render: renderCompactEntries,
  };
  Object.defineProperties(api, {
    [RENDERER_OWNER_KEY]: { value: owner },
    [RENDERER_PRIOR_KEY]: { value: prior },
    [RENDERER_ACTIVE_KEY]: { value: true, writable: true },
  });
  return api as OwnedRendererApi;
}

function isOwnedRenderer(
  api: CompactToolRendererApi | undefined,
): api is OwnedRendererApi {
  return (
    !!api &&
    typeof (api as Partial<OwnedRendererApi>)[RENDERER_OWNER_KEY] === "symbol"
  );
}

function activeRenderer(
  api: CompactToolRendererApi | undefined,
): CompactToolRendererApi | undefined {
  while (isOwnedRenderer(api) && !api[RENDERER_ACTIVE_KEY])
    api = api[RENDERER_PRIOR_KEY];
  return api;
}

function resetRun() {
  state.tools = new Map();
  state.group = [];
  state.stats = newStats();
}

function capture(ctx: ExtensionContext) {
  state.cwd = ctx.cwd;
  state.theme = ctx.ui.theme;
}

function groupable(info: ToolInfo): boolean {
  return info.category === "read" || info.category === "search";
}

function joinGroup(info: ToolInfo) {
  if (!groupable(info)) {
    state.group = [];
    return;
  }
  if (state.group.at(-1)?.category !== info.category) state.group = [];
  if (!state.group.some((item) => item.id === info.id)) state.group.push(info);
  for (const item of state.group) item.group = state.group;
  for (const item of state.group.slice(0, -1)) item.hidden = true;
  state.group.at(-2)?.invalidate?.();
}

function hydrate(
  id: string,
  name: string,
  args: unknown,
  isError = false,
): ToolInfo | undefined {
  const category = categoryFor(name);
  if (!category) {
    state.group = [];
    return undefined;
  }
  let info = state.tools.get(id);
  if (!info) {
    info = {
      id,
      name,
      category,
      args,
      target: displayTarget(category, name, args, state.cwd),
      hidden: false,
      running: false,
      isError,
    };
    state.tools.set(id, info);
    joinGroup(info);
  }
  return info;
}

function recordStart(name: string) {
  const category = categoryFor(name);
  if (!category) {
    state.stats.mutations++;
    state.group = [];
    return;
  }
  if (category === "read") state.stats.reads++;
  else if (category === "search") state.stats.searches++;
  else if (category === "command") state.stats.commands++;
  else state.stats.others++;
}

function begin(id: string, name: string, args: unknown) {
  recordStart(name);
  const info = hydrate(id, name, args);
  if (!info) return;
  info.args = args;
  info.target = displayTarget(info.category, name, args, state.cwd);
  info.running = true;
  info.startedAt = Date.now();
  info.invalidate?.();
}

function finalizeOutput(info: ToolInfo, result: unknown) {
  if (info.finalResult === result) return;
  info.finalResult = result;
  info.result = result;
  info.compactOutput = resultText(result);
  info.compactSummary = resultSummary(info.category, result);
  info.outputLineCount = nonEmptyLineCount(info.compactOutput);
}

function finish(
  id: string,
  result: unknown,
  isError: boolean,
  partial: boolean,
) {
  const info = state.tools.get(id);
  if (!info) return;
  if (!partial) finalizeOutput(info, result);
  info.isError ||= isError;
  if (!partial) {
    info.running = false;
    if (info.startedAt) info.durationMs = Date.now() - info.startedAt;
    if (isError) {
      state.stats.failed++;
      const prior = (info.group ?? []).filter((item) => item !== info);
      if (prior.length) {
        for (const item of prior) item.group = prior;
        prior.at(-1)!.hidden = false;
        prior.at(-1)!.invalidate?.();
      }
      info.group = [info];
      info.hidden = false;
      state.group = [];
    }
  }
  info.invalidate?.();
}

function activeGroup(info: ToolInfo): ToolInfo[] {
  return groupable(info) && info.group?.length ? info.group : [info];
}

function compactLines(info: ToolInfo, theme: Theme): string[] {
  return renderCompactEntries(
    activeGroup(info).map((item) => ({
      toolId: item.id,
      name: item.name,
      args: item.args,
      output: item.compactOutput ?? "",
      summary: item.compactSummary,
      outputLineCount: item.outputLineCount,
      isError: item.isError,
      running: item.running,
      durationMs: item.durationMs,
    })),
    {
      cwd: state.cwd,
      width: Math.min(process.stdout.columns || 100, MAX_WIDTH),
      theme,
    },
  );
}

type RendererPatch = {
  owner: symbol;
  active: boolean;
  prior?: RendererPatch;
  originalUpdateDisplay: (...args: any[]) => any;
  originalRender: (...args: any[]) => any;
  rootUpdateDisplay: (...args: any[]) => any;
  rootRender: (...args: any[]) => any;
  updateDisplay: (...args: any[]) => any;
  render: (...args: any[]) => any;
};

function patchRenderer(owner: symbol) {
  const proto = ToolExecutionComponent.prototype as any;
  if (
    typeof proto.updateDisplay !== "function" ||
    typeof proto.render !== "function"
  )
    return;
  const prior = proto[PATCH_KEY] as RendererPatch | undefined;
  const originalUpdateDisplay = proto.updateDisplay;
  const originalRender = proto.render;
  const rootUpdateDisplay = prior?.rootUpdateDisplay ?? originalUpdateDisplay;
  const rootRender = prior?.rootRender ?? originalRender;

  const updateDisplay = function compactToolsUpdateDisplay(this: any) {
    const category = categoryFor(this.toolName ?? "");
    if (
      !state.enabled ||
      !category ||
      this.expanded ||
      !this.toolCallId ||
      !this.selfRenderContainer?.clear
    ) {
      this.__compactToolsActive = false;
      this.__compactToolsHidden = false;
      return originalUpdateDisplay.call(this);
    }
    state.components.add(this);
    const invalidate = () => {
      this.invalidate?.();
      this.ui?.requestRender?.();
    };
    const info = hydrate(
      this.toolCallId,
      this.toolName,
      this.args,
      this.result?.isError ?? false,
    )!;
    info.args = this.args;
    info.target = displayTarget(category, this.toolName, this.args, state.cwd);
    info.invalidate = invalidate;
    if (this.result) {
      info.isError ||= this.result.isError ?? false;
      info.running = this.isPartial ?? false;
      if (!info.running) finalizeOutput(info, this.result);
    }
    if (info.hidden) {
      this.__compactToolsActive = true;
      this.__compactToolsHidden = true;
      return;
    }
    if (!state.theme) return originalUpdateDisplay.call(this);
    this.__compactToolsActive = true;
    this.__compactToolsHidden = false;
    this.selfRenderContainer.clear();
    for (const line of compactLines(info, state.theme)) {
      this.selfRenderContainer.addChild(new Text(line, 0, 0));
    }
  };

  const render = function compactToolsRender(this: any, width: number) {
    if (this.hideComponent || this.__compactToolsHidden) return [];
    if (this.__compactToolsActive)
      return this.selfRenderContainer.render(width);
    return originalRender.call(this, width);
  };
  proto.updateDisplay = updateDisplay;
  proto.render = render;
  proto[PATCH_KEY] = {
    owner,
    active: true,
    prior,
    originalUpdateDisplay,
    originalRender,
    rootUpdateDisplay,
    rootRender,
    updateDisplay,
    render,
  } satisfies RendererPatch;
}

function restoreRendererPatch(owner: symbol) {
  const proto = ToolExecutionComponent.prototype as any;
  let patch = proto[PATCH_KEY] as RendererPatch | undefined;
  while (patch && patch.owner !== owner) patch = patch.prior;
  if (!patch) return;
  patch.active = false;
  const current = proto[PATCH_KEY] as RendererPatch | undefined;
  if (!current || current.owner !== owner) return;
  let restore = current.prior;
  while (restore && !restore.active) restore = restore.prior;
  if (restore) {
    proto.updateDisplay = restore.updateDisplay;
    proto.render = restore.render;
    proto[PATCH_KEY] = restore;
  } else {
    proto.updateDisplay = current.rootUpdateDisplay;
    proto.render = current.rootRender;
    delete proto[PATCH_KEY];
  }
}

function refresh() {
  let ui: any;
  for (const component of state.components) {
    try {
      component.invalidate?.();
      ui ??= component.ui;
    } catch {
      state.components.delete(component);
    }
  }
  ui?.requestRender?.();
}

function restoreConfig(ctx: ExtensionContext) {
  state.enabled = true;
  for (const entry of ctx.sessionManager.getBranch()) {
    const data =
      entry.type === "custom"
        ? (entry.data as { enabled?: unknown } | undefined)
        : undefined;
    if (
      entry.type === "custom" &&
      entry.customType === CONFIG_ENTRY &&
      typeof data?.enabled === "boolean"
    ) {
      state.enabled = data.enabled;
    }
  }
}

function summaryText(data: Summary): string {
  const parts = [
    data.reads && `Read ${data.reads}`,
    data.searches && `Search ${data.searches}`,
    data.mutations && `Edit/write ${data.mutations}`,
    data.commands && `Bash ${data.commands}`,
    data.others && `Other ${data.others}`,
    data.failed && `${data.failed} failed`,
  ].filter(Boolean);
  if (!parts.length) return "";
  const seconds = Math.round(data.durationMs / 1000);
  return `${parts.join(" · ")}${seconds ? ` · ${seconds}s` : ""}`;
}

export default function compactTools(pi: ExtensionAPI) {
  let contextCompactionArmed = true;
  let batchCwd = process.cwd();
  if (typeof pi.registerTool === "function")
    registerToolBatch(pi, () => batchCwd);
  const artifactStores = new Map<string, ToolResultArtifacts>();
  const patchOwner = Symbol("pi-plugins.compact-tools.patch-owner");
  const priorRenderer = getCompactToolRenderer();
  const rendererApi = createRendererApi(patchOwner, priorRenderer);
  setCompactToolRenderer(rendererApi);
  patchRenderer(patchOwner);
  pi.on("context", async (event, ctx) => {
    const location = await artifactLocation(
      ctx.sessionManager.getSessionDir(),
      ctx.sessionManager.getSessionId(),
    );
    let artifacts: ToolResultArtifacts | undefined;
    if (location) {
      artifacts = artifactStores.get(location.directory);
      if (!artifacts) {
        artifacts = new ToolResultArtifacts(location.directory, {
          root: location.root,
        });
        artifactStores.set(location.directory, artifacts);
      }
    }
    const baseline = boundToolResultHistory(event.messages);
    const pending = event.messages.flatMap((message, index) => {
      const bounded = baseline[index] as { role?: string; content?: unknown[] };
      if (
        message.role !== "toolResult" ||
        !Array.isArray(message.content) ||
        !Array.isArray(bounded?.content)
      )
        return [];
      const text = providerText(message.content);
      if (!text || text === providerText(bounded.content)) return [];
      return [
        { index, identity: `${index}\0${message.toolCallId ?? ""}`, text },
      ];
    });
    const persisted =
      artifacts && pending.length ? await artifacts.persistBatch(pending) : [];
    const recovered = new Map(
      pending.flatMap((item, pendingIndex) => {
        const artifact = persisted[pendingIndex];
        return artifact
          ? [
              [
                item.index,
                { ...artifact, lines: item.text.split("\n").length },
              ] as const,
            ]
          : [];
      }),
    );
    const recovery: RecoveryMarker = (_message, info, index) => {
      const artifact = recovered.get(index);
      if (!artifact) return undefined;
      const nonText = info.omittedNonText
        ? ` nonText=${info.omittedNonText} omitted/not-persisted;`
        : "";
      return `\n\n[Output omitted from LLM context. Recovery id=${artifact.id} path=${artifact.path} sha256=${artifact.sha256} utf8Bytes=${artifact.bytes} lines=1-${artifact.lines} chars=${info.start}-${info.end} omitted=${info.omitted} chars total=${info.total};${nonText} use read/rg.]\n\n`;
    };
    return { messages: boundToolResultHistory(event.messages, recovery) };
  });
  pi.on("agent_end", (_event, ctx) => {
    const usage = ctx.getContextUsage();
    const tokens = usage?.tokens;
    if (tokens == null) return;
    const { compactAt, rearmAt } = compactionThresholds(usage?.contextWindow);
    if (tokens <= rearmAt) {
      contextCompactionArmed = true;
      return;
    }
    if (tokens <= compactAt || !contextCompactionArmed) return;
    contextCompactionArmed = false;
    ctx.compact({
      onError: (error) => {
        if (error.message.startsWith("Nothing to compact")) return;
        contextCompactionArmed = true;
        if (ctx.hasUI)
          ctx.ui.notify(
            `Automatic context compaction failed: ${error.message}`,
            "warning",
          );
      },
    });
  });
  pi.registerCommand("compact-tools", {
    description: "Toggle general compact tool rendering.",
    handler: async (args, ctx) => {
      capture(ctx);
      const value = args.trim().toLowerCase();
      if (value === "status") {
        ctx.ui.notify(`Compact tools: ${state.enabled ? "on" : "off"}`, "info");
        return;
      }
      if (value && value !== "on" && value !== "off" && value !== "toggle") {
        ctx.ui.notify(
          "Usage: /compact-tools [on|off|toggle|status]",
          "warning",
        );
        return;
      }
      state.enabled = value === "on" || (value !== "off" && !state.enabled);
      pi.appendEntry(CONFIG_ENTRY, { enabled: state.enabled });
      refresh();
      ctx.ui.notify(`Compact tools: ${state.enabled ? "on" : "off"}`, "info");
    },
  });
  pi.registerEntryRenderer<Summary>(SUMMARY_ENTRY, (entry, _options, theme) => {
    if (!entry.data) return undefined;
    const text = summaryText(entry.data);
    return text ? new Text(theme.fg("dim", text), 0, 0) : undefined;
  });
  pi.on("session_shutdown", () => {
    rendererApi[RENDERER_ACTIVE_KEY] = false;
    restoreRendererPatch(patchOwner);
    if (getCompactToolRenderer() === rendererApi)
      setCompactToolRenderer(activeRenderer(priorRenderer));
    state.components.clear();
  });
  pi.on("session_start", async (_event, ctx) => {
    batchCwd = ctx.cwd;
    contextCompactionArmed = true;
    restoreConfig(ctx);
    capture(ctx);
    resetRun();
    state.components = new Set();
  });
  pi.on("agent_start", (_event, ctx) => {
    capture(ctx);
    resetRun();
  });
  pi.on("message_update", (event) => {
    if (
      event.assistantMessageEvent?.type === "text_delta" &&
      event.assistantMessageEvent.delta?.trim()
    )
      state.group = [];
  });
  pi.on("tool_execution_start", (event, ctx) => {
    capture(ctx);
    begin(event.toolCallId, event.toolName, event.args);
  });
  pi.on("tool_execution_update", (event, ctx) => {
    capture(ctx);
    finish(event.toolCallId, event.partialResult, false, true);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    capture(ctx);
    finish(event.toolCallId, event.result, event.isError, false);
  });
  pi.on("agent_end", () => {
    const { startedAt, ...counts } = state.stats;
    const summary = { ...counts, durationMs: Date.now() - startedAt };
    if (summaryText(summary)) pi.appendEntry(SUMMARY_ENTRY, summary);
    state.group = [];
  });
}
