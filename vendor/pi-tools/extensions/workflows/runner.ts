/**
 * Workflow subagent runner.
 *
 * Each `agent()` call in a workflow script becomes one isolated in-process
 * AgentSession created here: in-memory session, normal trust-aware resources
 * and extensions, recursive orchestration/user-prompt tools denied, and an
 * optional one-shot `structured_output` tool when a schema is supplied.
 *
 * `runAgent()` never throws: every failure mode (session creation, provider
 * errors, aborts, missing structured output) settles into an `AgentOutcome`.
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import {
  bindChildSessionExtensions,
  childToolPolicy,
  createChildResources,
  shutdownAndDisposeChildSession,
} from "../shared/child-session.ts";
import {
  CHILD_TOOL_CALL_TIMEOUT_MS,
  createToolCallTimeoutGuard,
} from "../shared/tool-call-timeout.ts";
import {
  emptyUsage,
  turnBudgetBreakdown,
  type AgentUsage,
  type ProviderErrorMetadata,
  type TranscriptEntry,
} from "./model.ts";
import {
  buildWorkflowAgentPrompt,
  STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION,
  STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
} from "./prompt.ts";
import { safeStringify, truncateUtf8 } from "./serialization.ts";
import {
  registerUnconstrainedWorkspaceWorker,
  type WorkspaceActivity,
} from "../shared/workspace-mutation-lease.ts";

const AGENT_OUTPUT_MAX_BYTES = 64 * 1024;
export const FIRST_RESPONSE_TIMEOUT_MS = 45_000;
export const DEFAULT_AGENT_MAX_TURNS = 12;
export const MAX_AGENT_MAX_TURNS = 12;
const TURN_LIMIT_WARNING_TURNS = 5;
const TRANSCRIPT_ENTRY_MAX_BYTES = 16 * 1024;
const TRANSCRIPT_TOTAL_MAX_BYTES = 256 * 1024;
const TRANSCRIPT_MAX_ENTRIES = 200;

export type WorkflowModel = NonNullable<ExtensionContext["model"]>;
export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type AgentMessage = AgentSession["messages"][number];
type ToolTimingEvent = Extract<
  AgentSessionEvent,
  { type: "tool_execution_start" | "tool_execution_end" }
>;

export interface ToolExecutionTiming {
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

export interface AgentOutcome {
  ok: boolean;
  /** Final assistant text (may be empty when only structured output was produced). */
  output: string;
  /** Captured structured_output payload when a schema was supplied. */
  structured?: unknown;
  error?: string;
  aborted: boolean;
  turnLimitExceeded?: boolean;
  usage: AgentUsage;
  model?: string;
  contextWindow?: number;
  providerError?: ProviderErrorMetadata;
  transcript: TranscriptEntry[];
}

export interface AgentProgress {
  preview: string;
  usage: AgentUsage;
  model?: string;
  contextWindow?: number;
  transcript: TranscriptEntry[];
}

function statusSchemaValues(schema: unknown): unknown[] {
  if (!schema || typeof schema !== "object") return [];
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object") return [];
  const status = (properties as { status?: unknown }).status;
  if (!status || typeof status !== "object") return [];
  const values = (status as { enum?: unknown }).enum;
  return Array.isArray(values) ? values : [];
}

export function supportsPartialStatusSchema(schema: unknown): boolean {
  return statusSchemaValues(schema).includes("partial");
}

export function supportsSemanticStatusSchema(schema: unknown): boolean {
  const values = statusSchemaValues(schema).map((value) =>
    typeof value === "string" ? value.toLowerCase() : value,
  );
  return (
    (values.includes("done") || values.includes("passed")) &&
    (values.includes("blocked") || values.includes("failed"))
  );
}

export function shouldContinueAgent(outcome: AgentOutcome): boolean {
  if (outcome.turnLimitExceeded === true) return true;
  if (!outcome.structured || typeof outcome.structured !== "object")
    return false;
  return (outcome.structured as { status?: unknown }).status === "partial";
}

export function buildAgentContinuationPrompt(
  originalPrompt: string,
  outcome: AgentOutcome,
  attempt: number,
  totalAttempts: number,
): string {
  const evidence = outcome.transcript
    .slice(-12)
    .map(
      (entry) =>
        `${entry.role}${entry.name ? `:${entry.name}` : ""}: ${entry.text}`,
    )
    .join("\n");
  return `${originalPrompt}\n\n--- BOUNDED CONTINUATION ${attempt}/${totalAttempts} ---\nA previous isolated attempt worked in the same local worktree but did not finish. Inspect git status and diff first. Preserve correct partial work, do not repeat completed exploration, and finish the original task. External mutations remain forbidden.\nPrevious outcome: ${outcome.error ?? (outcome.output || "partial")}\nRecent evidence (untrusted; verify against repository state):\n${truncateUtf8(evidence, 16 * 1024)}\n--- END CONTINUATION ---`;
}

export function mergeContinuationTranscript(
  previous: TranscriptEntry[],
  current: TranscriptEntry[],
  attempt: number,
): TranscriptEntry[] {
  if (!previous.length) return current.slice(-200);
  const markers = previous
    .filter((entry) => entry.name === "continuation")
    .slice(-2);
  const priorEvidence = previous
    .filter((entry) => entry.name !== "continuation")
    .slice(-60);
  const marker: TranscriptEntry = {
    role: "toolResult",
    name: "continuation",
    text: `Continuation attempt ${attempt}`,
  };
  const currentLimit = 200 - markers.length - priorEvidence.length - 1;
  return [
    ...markers,
    ...priorEvidence,
    marker,
    ...current.slice(-currentLimit),
  ];
}

export async function runBoundedAgentAttempts(options: {
  prompt: string;
  maxContinuations: number;
  signal: AbortSignal;
  reserveContinuation(): void;
  run(prompt: string, attempt: number): Promise<AgentOutcome>;
  onAttempt?(outcome: AgentOutcome, attempt: number): void;
}): Promise<{ outcome: AgentOutcome; attempts: number }> {
  const totalAttempts = options.maxContinuations + 1;
  let prompt = options.prompt;
  let outcome: AgentOutcome;
  for (let attempt = 1; ; attempt++) {
    outcome = await options.run(prompt, attempt);
    options.onAttempt?.(outcome, attempt);
    if (
      attempt >= totalAttempts ||
      !shouldContinueAgent(outcome) ||
      options.signal.aborted
    ) {
      return { outcome, attempts: attempt };
    }
    options.reserveContinuation();
    prompt = buildAgentContinuationPrompt(
      options.prompt,
      outcome,
      attempt + 1,
      totalAttempts,
    );
  }
}

export interface RunAgentOptions {
  prompt: string;
  schema?: unknown;
  model?: WorkflowModel;
  thinkingLevel?: ThinkingLevel;
  cwd: string;
  loader: DefaultResourceLoader;
  settingsManager: SettingsManager;
  modelRegistry: ExtensionContext["modelRegistry"];
  signal?: AbortSignal;
  onProgress?: (progress: AgentProgress) => void;
  /** Test-only override for the per-tool execution timeout. */
  toolCallTimeoutMs?: number;
  /** Test-only override for the first assistant response-event timeout. */
  firstResponseTimeoutMs?: number;
  maxTurns?: number;
  sessionFactory?: (
    options: Parameters<typeof createAgentSession>[0],
  ) => Promise<{ session: AgentSession }>;
}

export function createAgentTurnBudget(
  maxTurns: number,
  controls: {
    steer(message: string): Promise<unknown>;
    abort(): Promise<unknown>;
    isComplete?(): boolean;
  },
) {
  let turnsStarted = 0;
  let warned = false;
  let finalizationWarningSent = false;
  let exceeded = false;
  const budget = turnBudgetBreakdown(maxTurns);
  const warningTurns = Math.min(
    TURN_LIMIT_WARNING_TURNS,
    Math.max(0, maxTurns - 1),
  );
  const warningAt = maxTurns - warningTurns;
  return {
    observe(event: AgentSessionEvent) {
      if (event.type === "turn_start") {
        turnsStarted++;
        if (turnsStarted > maxTurns && !exceeded) {
          exceeded = true;
          void controls.abort().catch(() => {});
        }
      } else if (event.type === "turn_end") {
        if (warningTurns > 0 && turnsStarted === warningAt && !warned) {
          warned = true;
          void controls
            .steer(
              `Turn budget: ${warningTurns} turns remain. Stop new exploration, finish current work, and return the required final result.`,
            )
            .catch(() => {});
        }
        if (
          budget.usable >= 2 &&
          turnsStarted === budget.usable - 1 &&
          !finalizationWarningSent
        ) {
          finalizationWarningSent = true;
          void controls
            .steer(
              `Turn budget: one of ${budget.usable} usable work turns remains; ${budget.reserve} turns are reserved for reporting a structured handoff. Finish essential local work now. If resumable work remains and the schema supports it, return status "partial", not "blocked", so a configured continuation can proceed.`,
            )
            .catch(() => {});
        }
        const needsAnotherTurn =
          event.message.role === "assistant" &&
          event.message.content.some((part) => part.type === "toolCall");
        if (
          turnsStarted >= maxTurns &&
          needsAnotherTurn &&
          !controls.isComplete?.() &&
          !exceeded
        ) {
          exceeded = true;
          void controls.abort().catch(() => {});
        }
      }
    },
    isFinalizing() {
      return turnsStarted >= Math.max(1, budget.usable + 1);
    },
    error() {
      return exceeded ? `Agent exceeded its ${maxTurns}-turn limit` : undefined;
    },
  };
}

/** Build a fresh extension runtime for each concurrent workflow child. */
export function createWorkflowResources(
  cwd: string,
  variant: "plain" | "structured",
  projectTrusted: boolean,
) {
  return createChildResources({
    cwd,
    projectTrusted,
    ...(variant === "structured"
      ? { appendSystemPrompt: [STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION] }
      : {}),
  });
}

interface WorkflowToolSession {
  getAllTools(): Array<{ name: string }>;
  getToolDefinition(name: string): ToolDefinition | undefined;
  subscribe(listener: AgentSessionEventListener): () => void;
}

/** Guard current tools and tools registered by extensions at later agent starts. */
const EXTERNAL_MUTATION_COMMANDS = [
  /\bgh\b[\s\S]*\b(?:pr\s+merge|workflow\s+(?:run|rerun|dispatch))\b/i,
  /\bdocker\b[\s\S]*(?:\bpush\b|--push\b)/i,
  /\bkubectl\b[\s\S]*\b(?:apply|create|delete|edit|expose|label|annotate|patch|replace|scale|set|taint|cordon|uncordon|drain|rollout\s+(?:restart|undo|pause|resume))\b/i,
  /\bhelm\b[\s\S]*\b(?:install|upgrade|uninstall|rollback)\b/i,
  /\b(?:terraform|tofu)\b[\s\S]*\b(?:apply|destroy|import|taint|untaint)\b/i,
  /\bcurl\b[\s\S]*(?:--(?:data|form|upload-file|request)\b|-d\b|-F\b|-T\b|-X\s*(?:POST|PUT|PATCH|DELETE)\b)/i,
  /\bwget\b[\s\S]*--post-(?:data|file)\b/i,
  /\baz\b[\s\S]*\b(?:create|delete|deploy|import|purge|restart|start|stop|update)\b/i,
  /\b(?:aws|gcloud)\b[\s\S]*\b(?:create|delete|deploy|invoke|put|remove|restart|run|start|stop|terminate|update)\b/i,
  /\bgh-tool\b[\s\S]*\b(?:pr\s+merge|workflow\s+(?:run|rerun|dispatch))\b/i,
  /\brm\b[\s\S]*(?:\s-[^\s]*(?:r|R)[^\s]*|--recursive\b)/i,
  /\bfind\b[\s\S]*\s-delete\b/i,
  /\bk8s-tool\b[\s\S]*\b(?:apply|create|delete|patch|replace|restart|scale|set)\b/i,
  /\bvault-tool\b[\s\S]*\b(?:write|delete|put)\b/i,
];
const WORKFLOW_ALLOWED_TOOLS = new Set([
  "bash",
  "crawl",
  "edit",
  "fetch_content",
  "get_search_content",
  "read",
  "search",
  "scrape",
  "structured_output",
  "web_search",
  "write",
]);
const GIT_MUTATING_SUBCOMMANDS = new Set([
  "add",
  "am",
  "apply",
  "bisect",
  "checkout",
  "cherry-pick",
  "clean",
  "commit",
  "merge",
  "mv",
  "notes",
  "push",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
  "tag",
  "update-index",
  "update-ref",
  "worktree",
]);
const FILESYSTEM_TOOLS = new Set(["read", "edit", "write"]);
const CORE_WORKFLOW_TOOLS = new Set(["bash", ...FILESYSTEM_TOOLS]);

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function workflowRoot(cwd: string) {
  return realpathSync(cwd);
}

export function resolveWorkflowAgentCwd(
  trustedRoot: string,
  requested: unknown,
) {
  const root = workflowRoot(trustedRoot);
  if (requested === undefined) return root;
  if (typeof requested !== "string" || !requested.trim()) {
    throw new Error("Workflow agent cwd must be a non-empty path");
  }
  const candidate = realpathSync(path.resolve(root, requested));
  if (!statSync(candidate).isDirectory()) {
    throw new Error("Workflow agent cwd must be a directory");
  }
  if (isWithin(root, candidate)) return candidate;
  const dotGit = path.join(candidate, ".git");
  if (!existsSync(dotGit) || !lstatSync(dotGit).isFile()) {
    throw new Error(`Workflow agent cwd is outside the trusted root ${root}`);
  }
  const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, "utf8"));
  if (!match)
    throw new Error(`Workflow agent cwd is outside the trusted root ${root}`);
  const gitDirectory = realpathSync(path.resolve(candidate, match[1]));
  if (!isWithin(root, gitDirectory)) {
    throw new Error(
      `Workflow agent gitdir is outside the trusted root ${root}`,
    );
  }
  return candidate;
}

function isWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function assertWorkflowToolPath(cwd: string, value: unknown): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Workflow filesystem tools require a non-empty path");
  }
  if (value.startsWith("@") || value.startsWith("~")) {
    throw new Error("Workflow filesystem paths cannot use @ or ~ aliases");
  }
  const root = workflowRoot(cwd);
  const requested = path.resolve(root, value);
  if (!isWithin(root, requested)) {
    throw new Error(`Workflow filesystem access is confined to ${root}`);
  }
  let current = root;
  for (const segment of path
    .relative(root, requested)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    if (!existsSync(current)) {
      try {
        if (lstatSync(current).isSymbolicLink()) {
          throw new Error("Workflow filesystem paths cannot traverse symlinks");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      continue;
    }
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("Workflow filesystem paths cannot traverse symlinks");
    }
  }
}

function sandboxProfile(cwd: string) {
  const root = workflowRoot(cwd)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  const temporary = realpathSync(tmpdir())
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  return `(version 1) (allow default) (deny network*) (deny file-write*) (allow file-write* (subpath "${root}")) (allow file-write* (subpath "${temporary}")) (allow file-write* (subpath "/private/tmp")) (allow file-write* (literal "/dev/null"))`;
}

export function isolateWorkflowCommand(command: string, cwd = process.cwd()) {
  if (process.platform !== "darwin") {
    throw new Error(
      "Workflow shell verification is unavailable because this platform has no configured network-denial sandbox.",
    );
  }
  return `/usr/bin/sandbox-exec -p ${shellQuote(sandboxProfile(cwd))} /bin/sh -lc ${shellQuote(command)}`;
}

function isGitMutation(command: string) {
  const gitCommand =
    /\bgit\s+(?:(?:(?:-C|-c|--git-dir|--work-tree)\s+(?:"[^"]*"|'[^']*'|\S+)|--no-pager)\s+)*([a-z][\w-]*)([^;&|\n]*)/gi;
  for (const match of command.matchAll(gitCommand)) {
    const subcommand = match[1].toLowerCase();
    const rest = match[2].trim();
    if (GIT_MUTATING_SUBCOMMANDS.has(subcommand)) return true;
    if (subcommand === "branch") {
      if (
        /^(?:$|(?:-(?:a|r|v|vv)|--(?:all|list|remotes|show-current|verbose))\b)/.test(
          rest,
        )
      )
        continue;
      return true;
    }
    if (subcommand === "symbolic-ref" && /^\S+\s+\S+/.test(rest)) return true;
    if (subcommand === "reflog" && /^(?:delete|drop|expire|write)\b/.test(rest))
      return true;
    if (
      subcommand === "remote" &&
      /^(?:add|remove|rename|set-head|set-url)\b/.test(rest)
    )
      return true;
    if (
      subcommand === "config" &&
      !/^(?:--get|--get-all|--get-regexp|--list|-l)\b/.test(rest)
    )
      return true;
  }
  return false;
}

export function isWorkflowExternalMutation(command: string) {
  const normalized = command.replace(/\\\r?\n/g, " ");
  return (
    isGitMutation(normalized) ||
    EXTERNAL_MUTATION_COMMANDS.some((pattern) => pattern.test(normalized)) ||
    /\b(?:nohup|setsid|disown)\b/i.test(normalized) ||
    /(?<![&<>|])&(?![&>])/.test(normalized)
  );
}

export function guardWorkflowChildTools(
  session: WorkflowToolSession,
  timeoutMs?: number,
  isFinalizing: () => boolean = () => false,
  cwd = process.cwd(),
  trustedCoreExecutors = new Map<string, ToolDefinition["execute"]>(),
) {
  const timeoutGuard = createToolCallTimeoutGuard(timeoutMs);
  const policyWrapped = new WeakSet<ToolDefinition>();
  let filesystemTail = Promise.resolve();
  const apply = () => {
    for (const { name } of session.getAllTools()) {
      const definition = session.getToolDefinition(name);
      if (!definition || policyWrapped.has(definition)) continue;
      policyWrapped.add(definition);
      const trustedExecute = trustedCoreExecutors.get(name);
      if (trustedExecute && definition.execute !== trustedExecute) {
        definition.execute = async () => {
          throw new Error(
            `Workflow child core tool "${name}" was replaced by an extension and is blocked.`,
          );
        };
        continue;
      }
      const execute = definition.execute;
      const guardedExecute: ToolDefinition["execute"] = async (
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      ) => {
        if (isFinalizing() && name !== "structured_output") {
          throw new Error(
            `Workflow agent is in finalization mode; tool "${name}" is blocked. Return the required final result now. If resumable work remains and the schema supports it, return status "partial", not "blocked", so a configured continuation can proceed.`,
          );
        }
        if (!WORKFLOW_ALLOWED_TOOLS.has(name)) {
          throw new Error(
            `Workflow children cannot use capability "${name}" because it is not in the read/local-work allowlist. Return the action to the parent for explicit execution.`,
          );
        }
        const toolParams =
          params && typeof params === "object"
            ? (params as {
                command?: unknown;
                timeout?: unknown;
                path?: unknown;
              })
            : {};
        if (FILESYSTEM_TOOLS.has(name)) {
          assertWorkflowToolPath(cwd, toolParams.path);
        }
        const command = toolParams.command;
        const requestedTimeout = toolParams.timeout;
        const effectiveTimeoutMs = timeoutMs ?? CHILD_TOOL_CALL_TIMEOUT_MS;
        const requestedTimeoutMs =
          typeof requestedTimeout !== "number" ||
          !Number.isFinite(requestedTimeout)
            ? undefined
            : name === "scrape"
              ? requestedTimeout
              : name === "bash" || name === "crawl"
                ? requestedTimeout * 1_000
                : undefined;
        if (
          requestedTimeoutMs !== undefined &&
          requestedTimeoutMs > effectiveTimeoutMs
        ) {
          throw new Error(
            `Workflow child tool calls are capped at ${Math.floor(effectiveTimeoutMs / 1_000)} seconds; split this check or return the exact long-running command to the parent for job monitoring.`,
          );
        }
        if (
          typeof command === "string" &&
          isWorkflowExternalMutation(command)
        ) {
          throw new Error(
            "Workflow children cannot perform external or production mutations or launch detached processes. Return the exact action to the parent for explicit scope approval and parent execution.",
          );
        }
        const guardedParams =
          name === "bash" &&
          typeof command === "string" &&
          params &&
          typeof params === "object"
            ? { ...params, command: isolateWorkflowCommand(command, cwd) }
            : params;
        return execute.call(
          definition,
          toolCallId,
          guardedParams,
          signal,
          onUpdate,
          ctx,
        );
      };
      definition.execute = async (
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      ) => {
        if (name !== "bash" && !FILESYSTEM_TOOLS.has(name)) {
          return guardedExecute.call(
            definition,
            toolCallId,
            params,
            signal,
            onUpdate,
            ctx,
          );
        }
        const previous = filesystemTail;
        let release = () => {};
        filesystemTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        try {
          await previous;
          if (signal?.aborted) {
            throw signal.reason instanceof Error
              ? signal.reason
              : new Error("Workflow tool call was aborted");
          }
          return await guardedExecute.call(
            definition,
            toolCallId,
            params,
            signal,
            onUpdate,
            ctx,
          );
        } finally {
          release();
        }
      };
    }
    timeoutGuard.apply(session);
  };
  apply();
  return session.subscribe((event) => {
    if (event.type === "agent_start" || event.type === "message_end") apply();
  });
}

function isJsonSchema(value: unknown): value is TSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const seen = new WeakSet<object>();
  let nodes = 0;
  const validate = (current: unknown, depth: number): boolean => {
    if (++nodes > 10_000 || depth > 24) return false;
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return true;
    }
    if (typeof current === "number") return Number.isFinite(current);
    if (Array.isArray(current)) {
      return current.every((item) => validate(item, depth + 1));
    }
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);
    return Object.keys(current).every((key) => {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        return false;
      }
      return validate((current as Record<string, unknown>)[key], depth + 1);
    });
  };
  return validate(value, 0);
}

/** Preserve the caller's full JSON Schema instead of lossy keyword conversion. */
function jsonSchemaToTypebox(schema: unknown): TSchema {
  if (!isJsonSchema(schema)) {
    throw new Error("structured output schema must be a bounded JSON object");
  }
  return Type.Unsafe(schema);
}

/**
 * One-shot terminating tool injected when a schema is supplied: the subagent
 * calls it as its final action and we capture the validated object.
 */
function makeStructuredOutputTool(
  schema: unknown,
  capture: (value: unknown) => void,
): ToolDefinition {
  return defineTool({
    name: "structured_output",
    label: "Structured Output",
    description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
    parameters: jsonSchemaToTypebox(schema),
    async execute(_toolCallId, params) {
      capture(params);
      return {
        content: [{ type: "text", text: "Recorded structured result." }],
        details: params,
        terminate: true,
      };
    },
  });
}

const TRUSTED_PROVIDER_DIAGNOSTICS = new Set([
  "pi_messages_response_failure",
  "provider_error",
  "api_error",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedField(value: unknown, max = 64) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const clean = String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  return clean ? clean.slice(0, max) : undefined;
}

export function providerErrorMetadataFromMessages(
  messages: AgentMessage[],
): ProviderErrorMetadata | undefined {
  const assistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  if (!assistant || assistant.role !== "assistant") return undefined;
  const diagnostic = [...(assistant.diagnostics ?? [])]
    .reverse()
    .find((item) => TRUSTED_PROVIDER_DIAGNOSTICS.has(item.type));
  if (!diagnostic) return undefined;
  const details = record(diagnostic.details);
  const nestedError = record(details?.error);
  const diagnosticError = record(diagnostic.error);
  const status = Number(
    details?.status ?? details?.statusCode ?? details?.httpStatus,
  );
  const code = boundedField(
    details?.code ?? nestedError?.code ?? diagnosticError?.code,
  );
  const errorType = boundedField(
    details?.errorType ??
      details?.type ??
      nestedError?.type ??
      nestedError?.name ??
      diagnosticError?.name,
  );
  const provider = boundedField(assistant.provider, 128);
  const retryAfter = Number(details?.retryAfter ?? details?.retry_after);
  const resetAt = Number(details?.resetAt ?? details?.reset_at);
  const metadata: ProviderErrorMetadata = {
    ...(Number.isInteger(status) && status >= 100 && status <= 599
      ? { status }
      : {}),
    ...(code ? { code } : {}),
    ...(provider ? { provider } : {}),
    ...(errorType ? { errorType } : {}),
    ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfter } : {}),
    ...(Number.isFinite(resetAt) && resetAt > 0 ? { resetAt } : {}),
  };
  return Object.keys(metadata).length > 1 || !provider ? metadata : undefined;
}

function finalOutput(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = msg.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function safeJson(value: unknown): string {
  return safeStringify(value, {
    maxBytes: TRANSCRIPT_ENTRY_MAX_BYTES,
    maxDepth: 12,
    maxNodes: 2_000,
  });
}

/** Record lifecycle timings without inferring completion from message timestamps. */
export function recordToolExecutionTiming(
  timings: Map<string, ToolExecutionTiming>,
  event: ToolTimingEvent,
  observedAt = Date.now(),
) {
  const previous = timings.get(event.toolCallId);
  if (event.type === "tool_execution_start") {
    if (previous?.startedAt !== undefined) return;
    timings.set(event.toolCallId, { ...previous, startedAt: observedAt });
    return;
  }
  if (previous?.finishedAt !== undefined) return;
  const durationMs =
    previous?.startedAt === undefined
      ? undefined
      : Math.max(0, observedAt - previous.startedAt);
  timings.set(event.toolCallId, {
    ...previous,
    finishedAt: observedAt,
    ...(durationMs === undefined ? {} : { durationMs }),
  });
}

function toolMetadata(
  toolCallId: string,
  timings: ReadonlyMap<string, ToolExecutionTiming>,
) {
  const timing = timings.get(toolCallId);
  return {
    toolCallId: truncateUtf8(toolCallId, 1024),
    ...(timing?.startedAt === undefined ? {} : { startedAt: timing.startedAt }),
    ...(timing?.finishedAt === undefined
      ? {}
      : { finishedAt: timing.finishedAt }),
    ...(timing?.durationMs === undefined
      ? {}
      : { durationMs: timing.durationMs }),
  };
}

/** Convert pi messages into a compact, serializable transcript for the UI. */
export function transcriptFromMessages(
  messages: AgentMessage[],
  toolTimings: ReadonlyMap<string, ToolExecutionTiming> = new Map(),
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((part) =>
                part.type === "text" ? part.text : `[image: ${part.mimeType}]`,
              )
              .join("\n");
      if (text.trim()) {
        entries.push({ role: "user", text, timestamp: message.timestamp });
      }
      continue;
    }

    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text" && part.text.trim()) {
          entries.push({
            role: "assistant",
            text: part.text,
            timestamp: message.timestamp,
          });
        } else if (part.type === "thinking" && part.thinking.trim()) {
          entries.push({
            role: "thinking",
            text: part.thinking,
            timestamp: message.timestamp,
          });
        } else if (part.type === "toolCall") {
          entries.push({
            role: "tool",
            name: part.name,
            text: safeJson(part.arguments),
            timestamp: message.timestamp,
            ...toolMetadata(part.id, toolTimings),
          });
        }
      }
      continue;
    }

    if (message.role !== "toolResult") continue;
    const text = message.content
      .map((part) =>
        part.type === "text" ? part.text : `[image: ${part.mimeType}]`,
      )
      .join("\n");
    entries.push({
      role: "toolResult",
      name: message.toolName,
      text,
      isError: message.isError,
      timestamp: message.timestamp,
      ...toolMetadata(message.toolCallId, toolTimings),
    });
  }
  const selected =
    entries.length <= TRANSCRIPT_MAX_ENTRIES
      ? entries
      : [entries[0], ...entries.slice(-(TRANSCRIPT_MAX_ENTRIES - 1))];
  const bounded: TranscriptEntry[] = [];
  let totalBytes = 0;
  for (const entry of selected) {
    const remaining = TRANSCRIPT_TOTAL_MAX_BYTES - totalBytes;
    if (remaining <= 0) break;
    const text = truncateUtf8(
      entry.text,
      Math.min(TRANSCRIPT_ENTRY_MAX_BYTES, remaining),
    );
    totalBytes += Buffer.byteLength(text, "utf8");
    bounded.push({
      ...entry,
      text:
        text === entry.text ? text : `${text}\n[transcript entry truncated]`,
    });
  }
  if (bounded.length < entries.length) {
    bounded.push({
      role: "toolResult",
      name: "transcript",
      text: `[transcript truncated: retained ${bounded.length} of ${entries.length} entries]`,
    });
  }
  return bounded;
}

function computeUsage(messages: AgentMessage[]): AgentUsage {
  const usage = emptyUsage();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    if (msg.stopReason !== "aborted") usage.turns++;
    const u = msg.usage;
    if (!u) continue;
    usage.input += u.input || 0;
    usage.output += u.output || 0;
    usage.cacheRead += u.cacheRead || 0;
    usage.cacheWrite += u.cacheWrite || 0;
    usage.cost += u.cost?.total || 0;
  }
  return usage;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    16 * 1024,
  );
}

function formatTimeout(timeoutMs: number) {
  return timeoutMs % 1_000 === 0
    ? `${timeoutMs / 1_000} seconds`
    : `${timeoutMs} ms`;
}

/** Abort a provider call that opens but never emits its first assistant event. */
export function createFirstResponseWatchdog(
  onTimeout: () => Promise<unknown>,
  options: { timeoutMs?: number; model?: string } = {},
) {
  const timeoutMs = options.timeoutMs ?? FIRST_RESPONSE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timer = undefined;
      const model = options.model ? ` for ${options.model}` : "";
      reject(
        new Error(
          `Agent received no assistant response event${model} within ${formatTimeout(timeoutMs)}; the provider request may be stalled. Retry the workflow.`,
        ),
      );
      void onTimeout().catch(() => {});
    }, timeoutMs);
  });

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  return {
    markResponse: cancel,
    async waitFor<T>(operation: Promise<T>) {
      try {
        return await Promise.race([operation, timeout]);
      } finally {
        cancel();
      }
    },
  };
}

function isAssistantResponseEvent(event: AgentSessionEvent) {
  return (
    (event.type === "message_start" ||
      event.type === "message_update" ||
      event.type === "message_end") &&
    event.message.role === "assistant"
  );
}

export async function runAgent(
  options: RunAgentOptions,
): Promise<AgentOutcome> {
  let structured: unknown;
  let customTools: ToolDefinition[] | undefined;
  let session: AgentSession | undefined;
  let workspaceWorker: WorkspaceActivity | undefined;
  let unsubscribeToolTimeout: (() => void) | undefined;
  let turnBudget: ReturnType<typeof createAgentTurnBudget> | undefined;
  try {
    workspaceWorker = registerUnconstrainedWorkspaceWorker();
    customTools =
      options.schema !== undefined
        ? [
            makeStructuredOutputTool(options.schema, (value) => {
              structured = value;
            }),
          ]
        : undefined;
    ({ session } = await (options.sessionFactory ?? createAgentSession)({
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.thinkingLevel
        ? { thinkingLevel: options.thinkingLevel }
        : {}),
      resourceLoader: options.loader,
      settingsManager: options.settingsManager,
      sessionManager: SessionManager.inMemory(options.cwd),
      ...(customTools ? { customTools } : {}),
      ...childToolPolicy(),
    }));
    const trustedCoreExecutors = new Map<string, ToolDefinition["execute"]>();
    for (const name of CORE_WORKFLOW_TOOLS) {
      const definition = session.getToolDefinition(name);
      if (definition) trustedCoreExecutors.set(name, definition.execute);
    }
    await bindChildSessionExtensions(session);
    unsubscribeToolTimeout = guardWorkflowChildTools(
      session,
      options.toolCallTimeoutMs,
      () => turnBudget?.isFinalizing() ?? false,
      options.cwd,
      trustedCoreExecutors,
    );
  } catch (error) {
    try {
      unsubscribeToolTimeout?.();
      if (session) await shutdownAndDisposeChildSession(session);
    } finally {
      workspaceWorker?.close();
    }
    return {
      ok: false,
      output: "",
      error: `Failed to create agent session: ${errorText(error)}`,
      aborted: false,
      usage: emptyUsage(),
      model: options.model?.id,
      contextWindow: options.model?.contextWindow,
      transcript: [],
    };
  }

  const childSession = session;
  let usage = emptyUsage();
  let modelId = childSession.model?.id ?? options.model?.id;
  let contextWindow = childSession.model?.contextWindow;
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  const toolTimings = new Map<string, ToolExecutionTiming>();
  turnBudget = createAgentTurnBudget(
    options.maxTurns ?? DEFAULT_AGENT_MAX_TURNS,
    {
      steer: (message) => childSession.steer(message),
      abort: () => childSession.abort(),
      isComplete: () => structured !== undefined,
    },
  );

  const sync = () => {
    const messages = childSession.messages;
    usage = computeUsage(messages);

    const sessionModel = childSession.model;
    modelId = sessionModel?.id ?? modelId;
    contextWindow = sessionModel?.contextWindow ?? contextWindow;
    const context = childSession.getContextUsage();
    if (
      typeof context?.tokens === "number" &&
      Number.isFinite(context.tokens) &&
      context.tokens >= 0
    ) {
      usage.contextTokens = context.tokens;
    }
    if (
      typeof context?.contextWindow === "number" &&
      Number.isFinite(context.contextWindow) &&
      context.contextWindow > 0
    ) {
      contextWindow = context.contextWindow;
    }

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;
      // Some gateways report a concrete fallback model. Prefer its registry
      // metadata when available so capacity tracks the model that served the
      // latest response rather than a hardcoded/configured guess.
      const responseMatchesSession =
        !sessionModel ||
        (msg.provider === sessionModel.provider &&
          msg.model === sessionModel.id);
      const reportedId = msg.responseModel ?? msg.model;
      const reportedModel = responseMatchesSession
        ? options.modelRegistry.find(msg.provider, reportedId)
        : undefined;
      if (reportedModel) {
        modelId = reportedModel.id;
        contextWindow = reportedModel.contextWindow;
      }
      if (msg.stopReason) stopReason = msg.stopReason;
      if (msg.errorMessage) errorMessage = msg.errorMessage;
      break;
    }
  };

  let markFirstResponse = () => {};
  const unsubscribe = childSession.subscribe((event) => {
    turnBudget.observe(event);
    if (isAssistantResponseEvent(event)) markFirstResponse();
    if (
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_end"
    ) {
      recordToolExecutionTiming(toolTimings, event);
    } else if (
      event.type !== "message_end" &&
      event.type !== "compaction_end"
    ) {
      return;
    }
    sync();
    options.onProgress?.({
      preview: finalOutput(childSession.messages),
      usage,
      model: modelId,
      contextWindow,
      transcript: transcriptFromMessages(childSession.messages, toolTimings),
    });
  });

  let aborted = false;
  let abortPromise: Promise<void> | undefined;
  const onAbort = () => {
    aborted = true;
    abortPromise ??= childSession.abort().catch(() => {});
  };
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  let output = "";
  let transcript: TranscriptEntry[] = [];
  let providerError: ProviderErrorMetadata | undefined;
  try {
    if (!aborted) {
      const watchdog = createFirstResponseWatchdog(() => childSession.abort(), {
        timeoutMs: options.firstResponseTimeoutMs,
        model: modelId,
      });
      markFirstResponse = watchdog.markResponse;
      await watchdog.waitFor(
        childSession.prompt(buildWorkflowAgentPrompt(options.prompt)),
      );
    }
  } catch (error) {
    errorMessage = errorMessage ?? errorText(error);
    stopReason = stopReason ?? "error";
  } finally {
    try {
      options.signal?.removeEventListener("abort", onAbort);
      if (abortPromise) await abortPromise;
      unsubscribe();
      unsubscribeToolTimeout?.();
      sync();
      output = truncateUtf8(
        finalOutput(childSession.messages),
        AGENT_OUTPUT_MAX_BYTES,
      );
      transcript = transcriptFromMessages(childSession.messages, toolTimings);
      providerError = providerErrorMetadataFromMessages(childSession.messages);
      await shutdownAndDisposeChildSession(childSession);
    } finally {
      workspaceWorker?.close();
    }
  }

  const providerMetadata = providerError ? { providerError } : {};
  const turnLimitError = turnBudget.error();
  if (turnLimitError || aborted || stopReason === "aborted") {
    return {
      ok: false,
      output,
      structured,
      error: turnLimitError ?? "Agent was aborted",
      aborted: true,
      ...(turnLimitError ? { turnLimitExceeded: true } : {}),
      usage,
      model: modelId,
      contextWindow,
      ...providerMetadata,
      transcript,
    };
  }

  const failed = stopReason === "error" || errorMessage !== undefined;
  if (failed) {
    return {
      ok: false,
      output,
      structured,
      error: errorMessage ?? "Agent failed",
      aborted: false,
      usage,
      model: modelId,
      contextWindow,
      ...providerMetadata,
      transcript,
    };
  }

  if (options.schema !== undefined && structured === undefined) {
    return {
      ok: false,
      output,
      error:
        "Agent finished without calling structured_output; no structured result matching the schema was produced.",
      aborted: false,
      usage,
      model: modelId,
      contextWindow,
      ...providerMetadata,
      transcript,
    };
  }

  return {
    ok: true,
    output,
    structured,
    aborted: false,
    usage,
    model: modelId,
    contextWindow,
    ...providerMetadata,
    transcript,
  };
}
