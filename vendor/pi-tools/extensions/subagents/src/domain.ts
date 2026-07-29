/**
 * Domain model for subagents.
 *
 * Everything downstream of a backend (manager, tools, UI) speaks only these
 * types. The Pi in-process backend translates Pi session events into the
 * normalized `SubagentEvent` union.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Data } from "effect";
import type { WorkspaceMutationOwner } from "../../shared/workspace-mutation-lease.ts";

export const BACKEND_NAMES = ["pi"] as const;
export type BackendName = (typeof BACKEND_NAMES)[number];

/**
 * Pi thinking levels. Omitted values inherit the parent level.
 */
export const REASONING_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const MIN_SUBAGENT_TURNS = 4;
export const DEFAULT_SUBAGENT_TURNS = 24;
export const MAX_SUBAGENT_TURNS = 48;
export const MIN_NESTED_WORKER_TURNS = 1;
export const DEFAULT_NESTED_WORKER_TURNS = 8;
export const MAX_NESTED_WORKER_TURNS = 8;

export function normalizeSubagentTurns(turns: number) {
  if (!Number.isFinite(turns)) return DEFAULT_SUBAGENT_TURNS;
  return Math.max(
    MIN_SUBAGENT_TURNS,
    Math.min(MAX_SUBAGENT_TURNS, Math.trunc(turns)),
  );
}

export function normalizeNestedWorkerTurns(turns: number) {
  if (!Number.isFinite(turns)) return DEFAULT_NESTED_WORKER_TURNS;
  return Math.max(
    MIN_NESTED_WORKER_TURNS,
    Math.min(MAX_NESTED_WORKER_TURNS, Math.trunc(turns)),
  );
}

export type SubagentStatus = "running" | "done" | "error";

/** Parent-session context resolved by the tool layer and passed opaquely. */
export interface ParentContext {
  readonly parentCwd: string;
  readonly projectTrusted: boolean;
  /** Parent pi model, for the pi backend's "inherit" default. */
  readonly inheritedModel?: { readonly provider: string; readonly id: string };
  readonly inheritedThinkingLevel?: string;
  /** Parent model registry; required by the pi backend to resolve models. */
  readonly modelRegistry?: ModelRegistry;
}

export type OutputContract = "package_handoff";

export const NESTED_WORKER_ROLES = [
  "reviewer",
  "verifier",
  "finding-fixer",
] as const;
export type NestedWorkerRole = (typeof NESTED_WORKER_ROLES)[number];
export type SubagentRole = "package-worker" | NestedWorkerRole;

export const NESTED_PROMPT_MAX_BYTES = 32 * 1_024;
export const NESTED_NAME_MAX_BYTES = 160;
export const NESTED_OUTPUT_MAX_BYTES = 64 * 1_024;

export interface SubagentLineage {
  readonly parentId?: string;
  readonly depth: 0 | 1;
  readonly role: SubagentRole;
}

export interface NestedSpawnRequest {
  readonly prompt: string;
  readonly title: string;
  readonly role: NestedWorkerRole;
  readonly maxTurns?: number;
}

export interface NestedSpawnResult {
  readonly id: string;
  readonly status: SubagentStatus;
  readonly output: string;
  readonly error?: string;
}

export interface SpawnTask {
  readonly prompt: string;
  readonly title: string;
  readonly cwd: string;
  /**
   * Exact Pi provider/model-id. Omitted values inherit the parent model.
   */
  readonly model?: string;
  /** Pi thinking level. */
  readonly reasoningEffort?: ReasoningEffort;
  readonly maxTurns?: number;
  readonly allowedTools?: ReadonlyArray<string>;
  readonly readOnlyBash?: boolean;
  readonly noExtensions?: boolean;
  readonly suppressResultDelivery?: boolean;
  readonly outputContract?: OutputContract;
  readonly todoId?: number;
  readonly todoToken?: string;
  readonly validateAuthority?: () => string | undefined;
  readonly parent: ParentContext;
}

export interface BackendSpawnTask extends SpawnTask {
  readonly lineage?: SubagentLineage;
  readonly nestedSpawn?: (
    request: NestedSpawnRequest,
    signal?: AbortSignal,
  ) => Promise<NestedSpawnResult>;
  readonly nestedMutationPolicy?: "read-only" | "finding-fixer";
  readonly mutationLeaseOwner?: WorkspaceMutationOwner;
  /** Pi calls this synchronously for each finalized assistant message before
   * its tool batch starts. False rejects every tool in that overflow turn. */
  readonly claimTurn?: () => boolean;
}

export interface SubagentMeta {
  readonly backend: BackendName;
  /** Display label for the selected Pi model. */
  readonly modelLabel?: string;
  /** Context window capacity for utilization display, when known. */
  readonly contextWindow?: number;
  /** Pi subagent session file. */
  readonly sessionFilePath?: string;
  /** Pi session id. */
  readonly nativeSessionId?: string;
}

// --- Transcript ------------------------------------------------------------

export type TranscriptPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "thinking";
      readonly text: string;
      readonly redacted?: boolean;
    }
  | {
      readonly type: "toolCall";
      readonly toolId: string;
      readonly name: string;
      readonly argsPreview?: string;
    };

export type TranscriptItem =
  | { readonly kind: "user"; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly parts: ReadonlyArray<TranscriptPart>;
    }
  | {
      readonly kind: "toolResult";
      readonly toolId: string;
      readonly name: string;
      readonly isError: boolean;
      readonly outputPreview?: string;
    };

export interface LiveToolState {
  readonly toolId: string;
  readonly name: string;
  readonly argsPreview?: string;
  readonly outputPreview?: string;
  readonly done?: boolean;
  readonly isError?: boolean;
}

export interface QueuedMessage {
  readonly text: string;
  readonly kind: "steer" | "follow-up";
}

// --- Events ------------------------------------------------------------------

export type RunOutcome =
  | { readonly _tag: "Completed"; readonly finalText: string }
  | {
      readonly _tag: "Failed";
      readonly errorText: string;
      readonly partialText?: string;
    }
  | { readonly _tag: "Interrupted"; readonly partialText?: string };

/**
 * Normalized activity stream. Previews (`argsPreview`, `outputPreview`) are
 * pre-flattened single-line strings because the UI only ever renders one
 * sanitized line, which keeps three different native tool-result shapes out
 * of the interface.
 */
export type SubagentEvent =
  // lifecycle (a session can run multiple turns via send())
  | { readonly _tag: "RunStarted" }
  | { readonly _tag: "RunSettled"; readonly outcome: RunOutcome }
  // transcript building blocks
  | { readonly _tag: "UserMessage"; readonly text: string }
  | {
      readonly _tag: "AssistantDelta";
      readonly kind: "text" | "thinking";
      readonly delta: string;
    }
  | {
      readonly _tag: "AssistantMessage";
      readonly parts: ReadonlyArray<TranscriptPart>;
    }
  | {
      readonly _tag: "ToolStart";
      readonly toolId: string;
      readonly name: string;
      readonly argsPreview?: string;
    }
  | {
      readonly _tag: "ToolUpdate";
      readonly toolId: string;
      readonly outputPreview?: string;
    }
  | {
      readonly _tag: "ToolEnd";
      readonly toolId: string;
      readonly name: string;
      readonly isError: boolean;
      readonly outputPreview?: string;
    }
  // bookkeeping
  | {
      readonly _tag: "QueueChanged";
      readonly queued: ReadonlyArray<QueuedMessage>;
    }
  | {
      readonly _tag: "UsageChanged";
      readonly tokens?: number;
      readonly contextWindow?: number;
      readonly cost?: number;
    }
  | { readonly _tag: "MetaChanged"; readonly meta: Partial<SubagentMeta> }
  /** Non-fatal diagnostics. Fatal failures arrive as a RunSettled outcome. */
  | { readonly _tag: "BackendError"; readonly message: string };

// --- Snapshot ---------------------------------------------------------------

/**
 * The manager folds `SubagentEvent`s into one snapshot per subagent. This is
 * everything the tools, footer status, and both TUI views read.
 */
export interface SubagentSnapshot {
  /** Changes whenever snapshot-backed takeover content changes. */
  readonly revision?: number;
  readonly id: string;
  readonly backend: BackendName;
  readonly title: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly status: SubagentStatus;
  readonly pendingStart?: boolean;
  readonly createdAt: number;
  readonly settledAt?: number;
  readonly reasoningEffort?: ReasoningEffort;
  readonly outputContract?: OutputContract;
  readonly todoId?: number;
  readonly todoToken?: string;
  readonly lineage?: SubagentLineage;
  readonly maxTurns: number;
  readonly budgetExtension?: {
    readonly additionalTurns: number;
    readonly approvedAt: number;
  };
  readonly errorText?: string;
  readonly meta: SubagentMeta;
  readonly usage: {
    readonly tokens?: number;
    readonly contextWindow?: number;
    readonly cost?: number;
  };
  readonly transcript: ReadonlyArray<TranscriptItem>;
  /** Streaming assistant buffers, cleared when the finalized message lands. */
  readonly liveAssistant?: { readonly text: string; readonly thinking: string };
  readonly liveTools: ReadonlyArray<LiveToolState>;
  readonly queued: ReadonlyArray<QueuedMessage>;
  /** Final text of the most recent completed run (v1 `finalOutput`). */
  readonly finalText: string;
  readonly handoff?: {
    readonly status: "done" | "partial" | "blocked" | "failed";
    readonly rawResponses: ReadonlyArray<string>;
    readonly errors?: ReadonlyArray<string>;
  };
  /** Count of finalized assistant messages (for subagent_check). */
  readonly turns: number;
}

/** Final text, or the live streaming buffer while a run is active (v1 `latestOutput`). */
export function latestText(snap: SubagentSnapshot) {
  const live = snap.liveAssistant?.text.trim();
  if (live) return live;
  return snap.finalText;
}

export function formatElapsed(snap: SubagentSnapshot) {
  const end = snap.settledAt ?? Date.now();
  const totalSeconds = Math.max(0, Math.round((end - snap.createdAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;
}

// --- Errors -------------------------------------------------------------------

export class SpawnError extends Data.TaggedError("SpawnError")<{
  readonly message: string;
}> {}

export class BackendUnavailableError extends Data.TaggedError(
  "BackendUnavailableError",
)<{
  readonly message: string;
}> {}

export class ConcurrencyLimitError extends Data.TaggedError(
  "ConcurrencyLimitError",
)<{
  readonly message: string;
}> {}

export class SendError extends Data.TaggedError("SendError")<{
  readonly message: string;
}> {}
