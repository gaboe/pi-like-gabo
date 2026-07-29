/**
 * pi backend — real implementation over the pi SDK.
 *
 * Each subagent is an in-process `AgentSession` (a port of v1
 * subagents/manager.ts + shared/child-session.ts):
 * - persistent session files kept outside /resume history, child resources
 *   loaded per-cwd with trust gating, and the child tool denylist;
 * - `session.subscribe()` events translated to normalized SubagentEvents;
 * - send() steers a streaming run or starts a fresh prompt() when idle;
 * - interrupt clears the queue and aborts; closing the session scope emits
 *   the child session_shutdown hook and disposes the session.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  StringEnum,
  type AssistantMessage,
  type Message,
  type Model,
} from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
  ModelRegistry,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  defineTool,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Cause, Scope } from "effect";
import { Effect, Queue, Stream } from "effect";
import {
  CHILD_EXCLUDED_TOOL_NAMES,
  createChildResources,
} from "../../../shared/child-session.ts";
import type { SubagentBackend, SubagentSession } from "../backend.ts";
import { openAiSubagentModelError } from "../model-policy.ts";
import type {
  BackendSpawnTask,
  NestedSpawnRequest,
  SubagentEvent,
  SubagentMeta,
  TranscriptPart,
} from "../domain.ts";
import {
  NESTED_NAME_MAX_BYTES,
  NESTED_OUTPUT_MAX_BYTES,
  NESTED_PROMPT_MAX_BYTES,
  SendError,
  SpawnError,
} from "../domain.ts";
import { createSafeMutationContext } from "../safe-mutation.ts";
import { resolveWorkspaceMutationPath } from "../../../shared/resolve-to-cwd.ts";
import {
  beginGlobalShellExecution,
  beginWorkspaceToolExecution,
  type WorkspaceMutationOwner,
} from "../../../shared/workspace-mutation-lease.ts";
import { createToolCallTimeoutGuard } from "../../../shared/tool-call-timeout.ts";

const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;
const SUBAGENT_SESSION_DIR = "subagent-sessions";

export function createPiSubagentSessionManager(cwd: string) {
  return SessionManager.create(cwd, join(getAgentDir(), SUBAGENT_SESSION_DIR));
}
const READ_ONLY_COMMANDS = new Set(["rg", "find"]);

function isBoundedRipgrep(words: string[]): boolean {
  return (
    words.includes("--files") &&
    words.slice(1).every((arg) => arg === "--files" || arg === "--hidden")
  );
}

export function isIdleWaitCommand(command: string): boolean {
  const normalized = command.trim().replace(/^rtk\s+/, "");
  if (/^sleep\s+\d+(?:\.\d+)?[smhd]?$/i.test(normalized)) return true;
  return /^(?:sh|bash|zsh)\s+-c\s+(['"])\s*sleep\s+\d+(?:\.\d+)?[smhd]?\s*\1$/i.test(
    normalized,
  );
}

export function isReadOnlyBashCommand(command: string): boolean {
  const normalized = command.startsWith("rtk ") ? command.slice(4) : command;
  if (
    !normalized.trim() ||
    /[\n\r;><`&|$(){}~\/\\'"*?\[\]]|\.\./.test(normalized)
  )
    return false;
  const words = normalized.trim().split(/\s+/);
  const executable = words[0];
  if (!executable || !READ_ONLY_COMMANDS.has(executable)) return false;
  if (executable === "rg") return isBoundedRipgrep(words);
  return !words.some(
    (word) =>
      word === "-files0-from" ||
      word.startsWith("-files0-from=") ||
      [
        "-H",
        "-L",
        "-follow",
        "-delete",
        "-exec",
        "-execdir",
        "-ok",
        "-okdir",
        "-fprint",
        "-fprintf",
        "-fls",
      ].includes(word),
  );
}

// --- Model + effort resolution -----------------------------------------------

type ThinkingLevel = NonNullable<
  NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"]
>;

/**
 * Resolve the generic model hint against the parent registry (v1 semantics):
 * "provider/model-id" is exact; a bare id prefers the inherited provider,
 * then must be unambiguous across providers. No hint inherits the parent
 * model; with nothing to inherit, the SDK default applies.
 */
export function resolvePiModel(
  registry: ModelRegistry,
  hint: string | undefined,
  inherited: { provider: string; id: string } | undefined,
): Model<any> | undefined {
  if (!hint) {
    if (!inherited) return undefined;
    return registry.find(inherited.provider, inherited.id) ?? undefined;
  }
  const slash = hint.indexOf("/");
  if (slash > 0) {
    const provider = hint.slice(0, slash);
    const id = hint.slice(slash + 1);
    const found = registry.find(provider, id);
    if (found) return found;
    throw new Error(`Unknown model "${hint}".`);
  }
  if (inherited) {
    const found = registry.find(inherited.provider, hint);
    if (found) return found;
  }
  const matches = registry.getAll().filter((m) => m.id === hint);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Model "${hint}" exists in multiple providers (${matches.map((m) => m.provider).join(", ")}). Use "provider/${hint}".`,
    );
  }
  throw new Error(`Unknown model "${hint}".`);
}

// --- Child session helpers (ported from v1 shared/child-session.ts) -----------

function waitBounded(operation: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([
    operation.then(
      () => undefined,
      () => undefined,
    ),
    timeout,
  ])
    .catch(() => {})
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

/** Emit child session_shutdown (bounded), then dispose. Never throws. */
async function shutdownAndDisposeChildSession(session: AgentSession) {
  try {
    if (session.extensionRunner.hasHandlers("session_shutdown")) {
      await waitBounded(
        session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        }),
        CHILD_SHUTDOWN_TIMEOUT_MS,
      );
    }
  } catch {
    // Extension runner inspection/emission is best-effort during teardown.
  } finally {
    try {
      session.dispose();
    } catch {
      // Disposal is terminal and must remain idempotent for callers.
    }
  }
}

// --- Tool-call timeout guard (ported from v1 shared/tool-call-timeout.ts) -----

/**
 * Wrap every registered child tool with an independent execution timeout so a
 * hung tool cannot wedge a headless child forever. apply() is idempotent and
 * re-applied on agent_start to pick up tools registered between runs.
 */
function isInside(root: string, target: string) {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

function nearestExistingRealpath(target: string) {
  let existing = target;
  while (true) {
    try {
      lstatSync(existing);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  return realpathSync(existing);
}

export function isPathInsideRoot(
  root: string,
  input: string,
  allowMissing = false,
): boolean {
  try {
    const canonicalRoot = realpathSync(root);
    const target = resolve(root, input);
    return isInside(
      canonicalRoot,
      allowMissing ? nearestExistingRealpath(target) : realpathSync(target),
    );
  } catch {
    return false;
  }
}

function applyNoIdleWaitPolicy(session: AgentSession) {
  const bash = session.getToolDefinition("bash");
  if (!bash) return;
  const execute = bash.execute;
  bash.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
    const command = (params as { command?: unknown }).command;
    if (typeof command === "string" && isIdleWaitCommand(command)) {
      throw new Error(
        "Subagents cannot spend a tool turn on bare sleep. Run the bounded operation directly, continue useful work, or return partial evidence.",
      );
    }
    return execute.call(bash, toolCallId, params, signal, onUpdate, ctx);
  };
}

export function isFindingFixerBashCommand(command: string): boolean {
  return isReadOnlyBashCommand(command);
}

export function applyReadConfinement(session: AgentSession, cwd: string) {
  const read = session.getToolDefinition("read");
  if (!read) return;
  const execute = read.execute;
  read.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
    const path = (params as { path?: unknown }).path;
    if (typeof path !== "string" || !isPathInsideRoot(cwd, path, true)) {
      throw new Error(
        "Nested worker rejected a read outside its package root.",
      );
    }
    return execute.call(read, toolCallId, params, signal, onUpdate, ctx);
  };
}

export function createLiveToolGate(
  error: () => string | undefined,
  prefix: string,
) {
  const wrapped = new WeakSet<ToolDefinition>();
  return {
    apply(session: AgentSession) {
      for (const { name } of session.getAllTools()) {
        const definition = session.getToolDefinition(name);
        if (!definition || wrapped.has(definition)) continue;
        wrapped.add(definition);
        const execute = definition.execute;
        definition.execute = async (...args) => {
          const reason = error();
          if (reason) throw new Error(`${prefix}: ${reason}`);
          return execute.call(definition, ...args);
        };
      }
    },
  };
}

export function createHandoffOnlyToolGate() {
  let handoffOnly = false;
  return {
    ...createLiveToolGate(
      () =>
        handoffOnly
          ? "correction turn accepts final JSON/text only; tools are disabled"
          : undefined,
      "Package handoff-only mode",
    ),
    enter() {
      handoffOnly = true;
    },
  };
}

export function createSynchronousTurnGate() {
  let accepted = true;
  const wrapped = new WeakSet<ToolDefinition>();
  return {
    claim(claim: (() => boolean) | undefined) {
      if (accepted) accepted = claim?.() ?? true;
      return accepted;
    },
    apply(session: AgentSession) {
      for (const { name } of session.getAllTools()) {
        const definition = session.getToolDefinition(name);
        if (!definition || wrapped.has(definition)) continue;
        wrapped.add(definition);
        const execute = definition.execute;
        definition.execute = async (...args) => {
          if (!accepted)
            throw new Error(
              "Package turn budget rejected this overflow tool before execution.",
            );
          return execute.call(definition, ...args);
        };
      }
    },
  };
}

function applyReadOnlyInspectionPolicy(session: AgentSession, cwd: string) {
  const bash = session.getToolDefinition("bash");
  if (bash) {
    const execute = bash.execute;
    bash.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
      const command = (params as { command?: unknown }).command;
      if (typeof command !== "string" || !isReadOnlyBashCommand(command)) {
        throw new Error(
          `Read-only subagent rejected bash command: ${JSON.stringify(command)}.`,
        );
      }
      return execute.call(bash, toolCallId, params, signal, onUpdate, ctx);
    };
  }
  applyReadConfinement(session, cwd);
}

function canonicalGitAdminRoots(root: string): string[] {
  const dotGit = resolve(realpathSync(root), ".git");
  if (!existsSync(dotGit)) return [];
  let gitDir: string;
  try {
    if (lstatSync(dotGit).isFile()) {
      const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, "utf8"));
      if (!match) return [];
      gitDir = realpathSync(resolve(dirname(dotGit), match[1]));
    } else {
      gitDir = realpathSync(dotGit);
    }
  } catch {
    return [];
  }

  const roots = [gitDir];
  try {
    const commonDir = resolve(gitDir, "commondir");
    if (existsSync(commonDir)) {
      roots.push(
        realpathSync(resolve(gitDir, readFileSync(commonDir, "utf8").trim())),
      );
    }
  } catch {}
  return roots;
}

export function isFindingFixerPathAllowed(root: string, input: string) {
  const canonicalRoot = realpathSync(root);
  const lexical = resolve(canonicalRoot, input);
  if (!isInside(canonicalRoot, lexical) || !isPathInsideRoot(root, input, true))
    return false;
  if (isInside(resolve(canonicalRoot, ".git"), lexical)) return false;

  let current = canonicalRoot;
  for (const component of relative(canonicalRoot, lexical).split(sep)) {
    if (!component) continue;
    current = resolve(current, component);
    try {
      const target = lstatSync(current);
      if (target.isSymbolicLink()) return false;
      if (current === lexical && target.isFile() && target.nlink > 1)
        return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      return false;
    }
  }

  let existing = lexical;
  while (!existsSync(existing)) existing = dirname(existing);
  const canonicalTarget = realpathSync(existing);
  return !canonicalGitAdminRoots(canonicalRoot).some((gitRoot) =>
    isInside(gitRoot, canonicalTarget),
  );
}

function applyFindingFixerPolicy(session: AgentSession, cwd: string) {
  const bash = session.getToolDefinition("bash");
  if (bash) {
    const execute = bash.execute;
    bash.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
      const command = (params as { command?: unknown }).command;
      if (typeof command !== "string" || !isFindingFixerBashCommand(command)) {
        throw new Error(
          `Finding-fixer rejected non-local or mutating bash command: ${JSON.stringify(command)}.`,
        );
      }
      return execute.call(bash, toolCallId, params, signal, onUpdate, ctx);
    };
  }
  applyReadConfinement(session, cwd);
}

export function createPiWorkspaceMutationGuard(
  cwd: string,
  owner?: WorkspaceMutationOwner,
) {
  const wrapped = new WeakSet<ToolDefinition>();
  return {
    apply(session: AgentSession) {
      for (const name of ["write", "edit", "bash"]) {
        const definition = session.getToolDefinition(name);
        if (!definition || wrapped.has(definition)) continue;
        wrapped.add(definition);
        const execute = definition.execute;
        definition.execute = async (...args) => {
          const target = (args[1] as { path?: unknown } | undefined)?.path;
          const activity =
            name === "bash"
              ? beginGlobalShellExecution()
              : beginWorkspaceToolExecution(
                  resolveWorkspaceMutationPath(target, cwd),
                  owner,
                );
          try {
            return await execute.call(definition, ...args);
          } finally {
            activity.close();
          }
        };
      }
    },
  };
}

export function createRootNestedExecutionGuard(
  spawn: NonNullable<BackendSpawnTask["nestedSpawn"]>,
) {
  let bashStarted = false;
  return {
    spawn: async (request: NestedSpawnRequest, signal?: AbortSignal) => {
      if (bashStarted)
        throw new Error(
          "Nested worker spawn rejected because root bash already ran; untracked descendants may still exist.",
        );
      return spawn(request, signal);
    },
    apply(session: AgentSession) {
      const bash = session.getToolDefinition("bash");
      if (!bash) return;
      const execute = bash.execute;
      bash.execute = async (...args) => {
        bashStarted = true;
        return execute.call(bash, ...args);
      };
    },
  };
}

export function createNestedWorkerTool(
  spawn: NonNullable<BackendSpawnTask["nestedSpawn"]>,
) {
  return defineTool({
    name: "package_worker_spawn",
    label: "Spawn Package Reviewer",
    description:
      "Run one Pi-only nested reviewer, verifier, or finding-fixer through the parent package manager. Child inherits package cwd/scope/trust, occupies a global worker slot, cannot nest, and returns bounded evidence. Must run before root bash; use no more than needed and never auto-respawn.",
    executionMode: "sequential",
    parameters: Type.Object({
      prompt: Type.String({
        description: "Bounded task within package scope",
        minLength: 1,
        maxLength: NESTED_PROMPT_MAX_BYTES,
      }),
      name: Type.String({
        description: "Short child label",
        minLength: 1,
        maxLength: NESTED_NAME_MAX_BYTES,
      }),
      role: StringEnum(["reviewer", "verifier", "finding-fixer"] as const),
      max_turns: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    }),
    async execute(_id, params, signal) {
      const result = await spawn(
        {
          prompt: params.prompt,
          title: params.name,
          role: params.role,
          maxTurns: params.max_turns,
        },
        signal,
      );
      const output = Buffer.from(result.output)
        .subarray(0, NESTED_OUTPUT_MAX_BYTES)
        .toString("utf8")
        .replace(/\uFFFD$/, "");
      const error = result.error
        ? Buffer.from(result.error)
            .subarray(0, NESTED_OUTPUT_MAX_BYTES)
            .toString("utf8")
            .replace(/\uFFFD$/, "")
        : undefined;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: result.id,
              status: result.status,
              output,
              ...(error ? { error } : {}),
            }),
          },
        ],
        details: { id: result.id, status: result.status, role: params.role },
      };
    },
  });
}

// --- Event translation ----------------------------------------------------------

function messageRole(msg: unknown): Message["role"] | undefined {
  const role = (msg as { role?: string } | undefined)?.role;
  if (role === "user" || role === "assistant" || role === "toolResult")
    return role;
  return undefined;
}

function lastAssistantMessage(
  session: AgentSession,
): AssistantMessage | undefined {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (messageRole(msg) === "assistant") return msg as AssistantMessage;
  }
  return undefined;
}

/** Final assistant text output (last assistant message with text), v1 semantics. */
function finalOutput(session: AgentSession): string {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (messageRole(msg) !== "assistant") continue;
    const text = (msg as AssistantMessage).content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function safeJson(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value);
    return text === "{}" ? undefined : text.slice(0, 4_096);
  } catch {
    return undefined;
  }
}

/** First non-empty line of a tool result-ish value (v1 liveToolPreview). */
function toolPreview(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value
      .split("\n")
      .find((line) => line.trim())
      ?.trim();
  }
  if (!value || typeof value !== "object") return undefined;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") continue;
    const firstLine = record.text.split("\n").find((line) => line.trim());
    if (firstLine) return firstLine.trim();
  }
  return undefined;
}

function assistantParts(msg: AssistantMessage): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  for (const part of msg.content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "thinking") {
      parts.push({
        type: "thinking",
        text: part.redacted ? "" : part.thinking,
        redacted: part.redacted,
      });
    } else if (part.type === "toolCall") {
      parts.push({
        type: "toolCall",
        toolId: part.id,
        name: part.name,
        argsPreview: safeJson(part.arguments),
      });
    }
  }
  return parts;
}

function userText(msg: Message): string {
  const content = (msg as { content: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

// --- The session ------------------------------------------------------------------

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    4096,
  );
}

const makePiSession = (
  task: BackendSpawnTask,
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    const registry = task.parent.modelRegistry;
    if (!registry) {
      return yield* new SpawnError({
        message: "pi backend requires the parent session's model registry.",
      });
    }

    const model = yield* Effect.try({
      try: () =>
        resolvePiModel(registry, task.model, task.parent.inheritedModel),
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    });
    const modelPolicyError = openAiSubagentModelError(
      model ? `${model.provider}/${model.id}` : undefined,
    );
    if (modelPolicyError) {
      return yield* new SpawnError({ message: modelPolicyError });
    }
    // pi's thinking levels ARE the shared reasoning-effort scale.
    const thinkingLevel = (task.reasoningEffort ??
      task.parent.inheritedThinkingLevel) as ThinkingLevel | undefined;

    const safeMutation = yield* Effect.try({
      try: () =>
        task.lineage?.depth === 1
          ? createSafeMutationContext(
              task.cwd,
              undefined,
              undefined,
              undefined,
              undefined,
              task.mutationLeaseOwner,
            )
          : undefined,
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    });
    const nestedExecution = task.nestedSpawn
      ? createRootNestedExecutionGuard(task.nestedSpawn)
      : undefined;
    const workspaceMutation = createPiWorkspaceMutationGuard(
      task.cwd,
      task.mutationLeaseOwner,
    );
    const session = yield* Effect.tryPromise({
      try: async () => {
        try {
          const { loader, settingsManager } = await createChildResources({
            cwd: task.cwd,
            projectTrusted: task.parent.projectTrusted,
            noExtensions: task.noExtensions,
          });
          const customTools = [
            ...(nestedExecution
              ? [createNestedWorkerTool(nestedExecution.spawn)]
              : []),
            ...(safeMutation?.tools ?? []),
          ];
          const { session } = await createAgentSession({
            cwd: task.cwd,
            sessionManager: createPiSubagentSessionManager(task.cwd),
            settingsManager,
            resourceLoader: loader,
            model,
            thinkingLevel,
            excludeTools: [...CHILD_EXCLUDED_TOOL_NAMES],
            customTools: customTools.length ? customTools : undefined,
          });
          try {
            await session.bindExtensions({ mode: "print" });
            if (safeMutation) {
              for (const tool of safeMutation.tools) {
                if (session.getToolDefinition(tool.name) !== tool)
                  throw new Error(
                    `Native nested-worker ${tool.name} override was not installed; refusing built-in file tool.`,
                  );
              }
            }
            if (task.allowedTools) {
              const available = new Set(
                session.getAllTools().map(({ name }) => name),
              );
              session.setActiveToolsByName(
                task.allowedTools.filter((name) => available.has(name)),
              );
            }
            nestedExecution?.apply(session);
            applyNoIdleWaitPolicy(session);
            if (task.nestedMutationPolicy === "read-only" || task.readOnlyBash)
              applyReadOnlyInspectionPolicy(session, task.cwd);
            if (task.nestedMutationPolicy === "finding-fixer")
              applyFindingFixerPolicy(session, task.cwd);
            workspaceMutation.apply(session);
          } catch (error) {
            await shutdownAndDisposeChildSession(session);
            throw error;
          }
          return session;
        } catch (error) {
          safeMutation?.close();
          throw error;
        }
      },
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    });

    const state = {
      closed: false,
      /** prompt() rejection for the active run; folded into RunSettled. */
      runError: undefined as string | undefined,
      /** One terminal event per run: lifecycle, prompt-rejection, and abort
       * fallbacks can all race to settle; the first wins. */
      settled: false,
    };

    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const emit = (event: SubagentEvent) => {
      Queue.offerUnsafe(events, event);
    };

    const toolTimeout = createToolCallTimeoutGuard();
    const turnGate = createSynchronousTurnGate();
    const authorityGate = task.validateAuthority
      ? createLiveToolGate(
          task.validateAuthority,
          "Package Worker authority revoked",
        )
      : undefined;
    const handoffOnlyGate = createHandoffOnlyToolGate();
    authorityGate?.apply(session);
    handoffOnlyGate.apply(session);
    toolTimeout.apply(session);
    turnGate.apply(session);

    const activeModel = (): Model<any> | undefined => {
      const sessionModel = session.model;
      const last = lastAssistantMessage(session);
      if (!last) return sessionModel;
      if (
        sessionModel &&
        (last.provider !== sessionModel.provider ||
          last.model !== sessionModel.id)
      ) {
        // The session changed models after this assistant response.
        return sessionModel;
      }
      return (
        registry.find(last.provider, last.responseModel ?? last.model) ??
        sessionModel
      );
    };

    const currentMeta = (): SubagentMeta => {
      const m = activeModel();
      return {
        backend: "pi",
        modelLabel: m ? `${m.provider}/${m.id}` : undefined,
        contextWindow: m?.contextWindow,
        sessionFilePath: session.sessionFile,
      };
    };

    const emitUsage = () => {
      const usage = session.getContextUsage();
      let cost = 0;
      for (const message of session.messages) {
        if (message.role === "assistant") cost += message.usage.cost.total;
      }
      emit({
        _tag: "UsageChanged",
        tokens: usage?.tokens ?? undefined,
        contextWindow: activeModel()?.contextWindow ?? usage?.contextWindow,
        cost,
      });
    };

    const settle = () => {
      if (state.settled) return;
      state.settled = true;
      const last = lastAssistantMessage(session);
      const partialText = finalOutput(session) || undefined;
      if (last?.stopReason === "aborted") {
        emit({
          _tag: "RunSettled",
          outcome: { _tag: "Interrupted", partialText },
        });
        return;
      }
      const errorText =
        state.runError ??
        (last?.stopReason === "error"
          ? (last.errorMessage ?? "Run failed")
          : undefined);
      if (errorText !== undefined) {
        emit({
          _tag: "RunSettled",
          outcome: {
            _tag: "Failed",
            errorText: boundedError(errorText),
            partialText,
          },
        });
        return;
      }
      emit({
        _tag: "RunSettled",
        outcome: { _tag: "Completed", finalText: finalOutput(session) },
      });
    };

    const handleEvent = (event: AgentSessionEvent) => {
      if (state.closed) return;
      switch (event.type) {
        case "agent_start":
          // Extensions may register tools between runs; guard new ones too.
          workspaceMutation.apply(session);
          authorityGate?.apply(session);
          handoffOnlyGate.apply(session);
          toolTimeout.apply(session);
          turnGate.apply(session);
          state.settled = false;
          emit({ _tag: "RunStarted" });
          break;
        case "message_update": {
          const streamEvent = event.assistantMessageEvent;
          if (streamEvent.type === "text_delta") {
            emit({
              _tag: "AssistantDelta",
              kind: "text",
              delta: streamEvent.delta,
            });
          } else if (streamEvent.type === "thinking_delta") {
            emit({
              _tag: "AssistantDelta",
              kind: "thinking",
              delta: streamEvent.delta,
            });
          }
          break;
        }
        case "message_end": {
          const role = messageRole(event.message);
          if (role === "user") {
            const text = userText(event.message as Message);
            if (text.trim()) emit({ _tag: "UserMessage", text });
          } else if (role === "assistant") {
            const assistant = event.message as AssistantMessage;
            if (!turnGate.claim(task.claimTurn)) {
              state.runError =
                "Package turn budget was exhausted before the assistant tool batch.";
              setImmediate(() => void session.abort().catch(() => undefined));
              break;
            }
            emit({
              _tag: "AssistantMessage",
              parts: assistantParts(assistant),
            });
            emitUsage();
            emit({ _tag: "MetaChanged", meta: currentMeta() });
          }
          // toolResult messages are covered by tool_execution_end.
          break;
        }
        case "tool_execution_start":
          emit({
            _tag: "ToolStart",
            toolId: event.toolCallId,
            name: event.toolName,
            argsPreview: safeJson(event.args),
          });
          break;
        case "tool_execution_update":
          emit({
            _tag: "ToolUpdate",
            toolId: event.toolCallId,
            outputPreview: toolPreview(event.partialResult),
          });
          break;
        case "tool_execution_end":
          emit({
            _tag: "ToolEnd",
            toolId: event.toolCallId,
            name: event.toolName,
            isError: event.isError,
            outputPreview: toolPreview(event.result),
          });
          break;
        case "queue_update":
          emit({
            _tag: "QueueChanged",
            queued: [
              ...event.steering.map((text) => ({
                text,
                kind: "steer" as const,
              })),
              ...event.followUp.map((text) => ({
                text,
                kind: "follow-up" as const,
              })),
            ],
          });
          break;
        case "agent_settled":
          settle();
          break;
      }
    };
    const unsubscribe = session.subscribe(handleEvent);

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        state.closed = true;
        unsubscribe();
        try {
          session.clearQueue();
        } catch {
          // Continue with abort/dispose.
        }
        await waitBounded(session.abort(), CHILD_SHUTDOWN_TIMEOUT_MS);
        await shutdownAndDisposeChildSession(session);
        safeMutation?.close();
        Queue.endUnsafe(events);
      }),
    );

    /** Start a fresh run (v1 manager.run): fire-and-forget, errors -> events. */
    const startRun = (text: string) => {
      state.runError = undefined;
      state.settled = false;
      emit({ _tag: "RunStarted" });
      void session.prompt(text).catch((error) => {
        state.runError = boundedError(error);
        // Preflight failures may never start the agent lifecycle, so no
        // agent_settled will arrive for them.
        if (!session.isStreaming) settle();
      });
    };

    // Session naming is best-effort.
    yield* Effect.try(() =>
      session.sessionManager.appendSessionInfo(`subagent: ${task.title}`),
    ).pipe(Effect.ignore);

    emit({ _tag: "MetaChanged", meta: currentMeta() });

    return {
      meta: Effect.sync(currentMeta),
      events: Stream.fromQueue(events),
      start: Effect.sync(() => startRun(task.prompt)),
      send: (text) =>
        Effect.suspend((): Effect.Effect<void, SendError> => {
          if (state.closed) {
            return new SendError({ message: "Subagent session is closed." });
          }
          if (session.isStreaming) {
            // Steer the active run via the SDK's queue; queue_update events
            // render it, message_end(user) lands it in the transcript. A
            // rejected steer is a real send failure, not a diagnostic.
            return Effect.tryPromise({
              try: () => session.steer(text),
              catch: (error) => new SendError({ message: boundedError(error) }),
            }).pipe(Effect.asVoid);
          }
          return Effect.sync(() => startRun(text));
        }),
      enterHandoffOnly: () => handoffOnlyGate.enter(),
      interrupt: Effect.promise(async () => {
        if (state.closed) return;
        try {
          session.clearQueue();
        } catch {
          // Abort regardless.
        }
        await session.abort().catch(() => undefined);
        // Only resolve once streaming has actually stopped: reporting the
        // interrupt as complete while the run keeps working would let the
        // manager settle a run that is still mutating the workspace. The
        // manager bounds this effect at 5s and force-disposes on timeout.
        while (!state.closed && session.isStreaming) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        // No streaming run means no agent_settled will arrive; emit the
        // terminal event (once) so the run cannot look running forever.
        if (!state.closed && !state.settled) {
          state.settled = true;
          emit({ _tag: "RunSettled", outcome: { _tag: "Interrupted" } });
        }
      }),
    } satisfies SubagentSession;
  });

export const piBackend: SubagentBackend = {
  name: "pi",
  capabilities: { steering: true, modelSelection: true, reasoningEffort: true },
  // In-process SDK: always available.
  available: Effect.succeed(true),
  spawn: makePiSession,
};
