import { StringEnum } from "@earendil-works/pi-ai";
import { isDeepStrictEqual } from "node:util";
import { type Static, Type } from "typebox";

// ---------------------------------------------------------------------------
// Tool / command identity — verbatim string boundaries.
// Tool name "todo" is the persistence key for branch replay (filtering
// `toolResult.toolName === "todo"`) AND the permissions entry at
// `templates/pi-permissions.jsonc:26`. DO NOT rename.
// ---------------------------------------------------------------------------

export const TOOL_NAME = "todo";
export const TOOL_LABEL = "Todo";
export const COMMAND_NAME = "todos";

// ---------------------------------------------------------------------------
// User-facing strings (kept stable for /todos UX parity).
// ---------------------------------------------------------------------------

export const ERR_REQUIRES_INTERACTIVE = "/todos requires interactive mode";
export const MSG_NO_TODOS = "No todos yet. Ask the agent to add some!";

export const MAX_TASK_SUBJECT_LENGTH = 200;
export const MAX_TASK_DESCRIPTION_LENGTH = 4_000;
export const MAX_TASK_ACTIVE_FORM_LENGTH = 200;
export const MAX_TASK_OWNER_LENGTH = 200;
export const MAX_TASK_RESULT_LENGTH = 4_000;
export const MAX_TASK_EVIDENCE_COUNT = 8;
export const MAX_TASK_EVIDENCE_LENGTH = 1_000;
export const MAX_WAIT_QUESTION_LENGTH = 500;
export const MAX_WAIT_JOB_COUNT = 64;
export const MAX_WAIT_JOB_ID_LENGTH = 200;
export const MAX_WAIT_SETTLED_COUNT = 64;
export const MAX_WAIT_EVIDENCE_COUNT = 64;
export const MAX_BLOCKED_BY = 256;
export const MAX_JOB_EVIDENCE_ID_LENGTH = 200;
export const MAX_JOB_EVIDENCE_ERROR_LENGTH = 1_000;
export const MAX_REVIEW_TOKEN_LENGTH = 256;
export const MAX_REVIEW_ID_LENGTH = 200;
export const MAX_REVIEW_MODEL_LENGTH = 200;
export const MAX_REVIEW_FEEDBACK_LENGTH = 4_000;
export const MAX_REVIEW_DIGEST_LENGTH = 128;
export const MAX_REVIEW_SCOPE_PATHS = 128;
export const MAX_REVIEW_SCOPE_PATH_LENGTH = 512;
export const MAX_METADATA_DEPTH = 6;
export const MAX_METADATA_KEYS = 64;
export const MAX_METADATA_ARRAY_LENGTH = 128;
export const MAX_METADATA_STRING_LENGTH = 4_000;
export const MAX_METADATA_SERIALIZED_BYTES = 64 * 1024;

export function isCanonicalArray(
  value: unknown,
  maxLength: number,
): value is unknown[] {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    )
      return false;
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !length ||
      !Object.hasOwn(length, "value") ||
      Object.hasOwn(length, "get") ||
      Object.hasOwn(length, "set") ||
      length.enumerable ||
      !length.writable ||
      length.configurable ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0 ||
      length.value > maxLength
    )
      return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length.value + 1 || keys.length > maxLength + 1)
      return false;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) return false;
      if (key === "length") {
        if (
          Object.hasOwn(descriptor, "get") ||
          Object.hasOwn(descriptor, "set") ||
          descriptor.enumerable
        )
          return false;
        continue;
      }
      if (
        typeof key !== "string" ||
        !/^(0|[1-9]\d*)$/.test(key) ||
        Number(key) >= length.value ||
        !Object.hasOwn(descriptor, "value") ||
        Object.hasOwn(descriptor, "get") ||
        Object.hasOwn(descriptor, "set") ||
        !descriptor.enumerable ||
        !descriptor.writable ||
        !descriptor.configurable
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public domain types
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "waiting:user"
  | "waiting:jobs"
  | "completed"
  | "deleted";

export type JobStatus =
  "running" | "wake" | "succeeded" | "failed" | "killed" | "timed_out";

export interface JobStateEvent {
  id: string;
  status: JobStatus;
  /** Echoed only after jobs accepted this host wait registration. */
  waitToken?: string;
  waitRegisteredAt?: number;
  waitGeneration?: number;
  /** Exact job incarnation acknowledged by jobs for this registration. */
  waitIncarnation?: string;
  settledAt?: number | string;
  error?: string;
}

export interface JobWaitEvidence {
  id: string;
  status: Exclude<JobStatus, "running">;
  settledAt?: number;
  error?: string;
}

export type TaskWait =
  | { kind: "user"; questions: string[] }
  | {
      kind: "jobs";
      jobIds: string[];
      mode: "all" | "any";
      deadline: number;
      settled: Record<string, JobWaitEvidence>;
      /** Host-issued incarnation; new waits never accept an unfenced event. */
      waitToken?: string;
      registeredAt?: number;
      generation?: number;
      /** Per-job host acknowledgements; missing means unbound and fails closed after replay. */
      incarnations?: Record<string, string>;
      reconciliationAttempts?: number;
      reconciliationError?: "query_unavailable";
    };

export type TaskAction =
  | "create"
  | "update"
  | "merge"
  | "challenge"
  | "list"
  | "get"
  | "delete"
  | "clear";

export type TaskReviewStatus = "pending" | "approved" | "rejected";

export interface TaskReviewScopeEntry {
  path: string;
  digest: string;
  blob?: string | null;
  indexBlob?: string | null;
}

export interface TaskReviewScope {
  version: 1;
  targetBinding: string;
  baseline: TaskReviewScopeEntry[];
}

export interface TaskReview {
  status: TaskReviewStatus;
  generation: number;
  token: string;
  completionRevision: number;
  requestedAt: number;
  dispatchedAt?: number;
  reviewedAt?: number;
  failedAt?: number;
  /** Failed dispatches so far. Drives retry backoff and the give-up transition. */
  attempts?: number;
  /** Digest of the task inputs bound to the claimed reviewer. */
  inputDigest?: string;
  scope?: TaskReviewScope;
  reviewer: { id: string; model: string };
  feedback?: string;
}

export interface Task {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: TaskStatus;
  /** Required audit record when status is completed. */
  result?: string;
  mergedInto?: number;
  evidence?: string[];
  review?: TaskReview;
  blockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
  wait?: TaskWait;
  waitEvidence?: JobWaitEvidence[];
}

export function isTaskReviewScope(value: unknown): value is TaskReviewScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  if (
    Object.getPrototypeOf(scope) !== Object.prototype ||
    Object.keys(scope).sort().join(",") !== "baseline,targetBinding,version" ||
    scope.version !== 1 ||
    typeof scope.targetBinding !== "string" ||
    !/^[a-f0-9]{64}$/.test(scope.targetBinding) ||
    !isCanonicalArray(scope.baseline, MAX_REVIEW_SCOPE_PATHS)
  )
    return false;
  const paths = new Set<string>();
  for (const value of scope.baseline) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const entry = value as Record<string, unknown>;
    const keys = Object.keys(entry)
      .sort((a, b) => a.localeCompare(b))
      .join(",");
    if (
      Object.getPrototypeOf(entry) !== Object.prototype ||
      ![
        "digest,path",
        "blob,digest,path",
        "blob,digest,indexBlob,path",
      ].includes(keys) ||
      typeof entry.path !== "string" ||
      !entry.path ||
      entry.path.length > MAX_REVIEW_SCOPE_PATH_LENGTH ||
      !/^[-\x20-\x7e]+$/.test(entry.path) ||
      entry.path.startsWith("/") ||
      entry.path.includes("\\") ||
      entry.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      typeof entry.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.digest) ||
      (entry.blob !== undefined &&
        entry.blob !== null &&
        (typeof entry.blob !== "string" ||
          !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.blob))) ||
      (entry.indexBlob !== undefined &&
        entry.indexBlob !== null &&
        (typeof entry.indexBlob !== "string" ||
          !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.indexBlob))) ||
      paths.has(entry.path)
    )
      return false;
    paths.add(entry.path);
  }
  try {
    return (
      Buffer.byteLength(JSON.stringify(scope)) <= MAX_METADATA_SERIALIZED_BYTES
    );
  } catch {
    return false;
  }
}

function metadataBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function sanitizeMetadata(value: unknown): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown, depth: number): unknown => {
    if (depth >= MAX_METADATA_DEPTH) return "[metadata truncated]";
    if (candidate === undefined) return undefined;
    if (typeof candidate === "string")
      return candidate.slice(0, MAX_METADATA_STRING_LENGTH);
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
    )
      return candidate;
    if (Array.isArray(candidate))
      if (seen.has(candidate)) return "[metadata cycle]";
    if (Array.isArray(candidate)) {
      if (!isCanonicalArray(candidate, MAX_METADATA_ARRAY_LENGTH))
        return "[metadata omitted]";
      seen.add(candidate);
      const output = candidate
        .slice(0, MAX_METADATA_ARRAY_LENGTH)
        .map((entry) => (entry === undefined ? null : visit(entry, depth + 1)));
      seen.delete(candidate);
      return output;
    }
    if (!candidate || typeof candidate !== "object")
      return "[metadata omitted]";
    if (seen.has(candidate)) return "[metadata cycle]";
    seen.add(candidate);
    let keys: (string | symbol)[];
    try {
      if (Object.getPrototypeOf(candidate) !== Object.prototype)
        return "[metadata omitted]";
      keys = Reflect.ownKeys(candidate);
      if (
        keys.length > MAX_METADATA_KEYS ||
        keys.some((key) => {
          if (
            typeof key !== "string" ||
            !Object.prototype.propertyIsEnumerable.call(candidate, key)
          )
            return true;
          const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
          return (
            !descriptor ||
            !Object.hasOwn(descriptor, "value") ||
            Object.hasOwn(descriptor, "get") ||
            Object.hasOwn(descriptor, "set") ||
            !descriptor.enumerable ||
            !descriptor.writable ||
            !descriptor.configurable
          );
        })
      )
        return "[metadata omitted]";
    } catch {
      return "[metadata omitted]";
    }
    const output: Record<string, unknown> = {};
    let keyCount = 0;
    for (const key in candidate) {
      if (!Object.hasOwn(candidate, key)) continue;
      if (keyCount >= MAX_METADATA_KEYS) break;
      keyCount++;
      const boundedKey = key.slice(0, 128);
      const child = visit(
        (candidate as Record<string, unknown>)[key],
        depth + 1,
      );
      if (child !== undefined) output[boundedKey] = child;
    }
    seen.delete(candidate);
    return output;
  };
  const sanitized = visit(value, 0);
  if (
    sanitized &&
    typeof sanitized === "object" &&
    !Array.isArray(sanitized) &&
    metadataBytes(sanitized) <= MAX_METADATA_SERIALIZED_BYTES
  )
    return sanitized as Record<string, unknown>;
  return { _truncated: "metadata exceeded the bounded replay budget" };
}

export function isBoundedMetadata(
  value: unknown,
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const seen = new WeakSet<object>();
  const valid = (candidate: unknown, depth: number): boolean => {
    if (candidate === undefined) return false;
    if (typeof candidate === "string")
      return candidate.length <= MAX_METADATA_STRING_LENGTH;
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
    )
      return true;
    if (depth >= MAX_METADATA_DEPTH) return false;
    if (Array.isArray(candidate)) if (seen.has(candidate)) return false;
    if (Array.isArray(candidate)) {
      if (!isCanonicalArray(candidate, MAX_METADATA_ARRAY_LENGTH)) {
        seen.delete(candidate);
        return false;
      }
      seen.add(candidate);
      const result = candidate.every((entry) => valid(entry, depth + 1));
      seen.delete(candidate);
      return result;
    }
    if (!candidate || typeof candidate !== "object") return false;
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    let prototype: object | null;
    let keys: (string | symbol)[];
    try {
      prototype = Object.getPrototypeOf(candidate);
      keys = Reflect.ownKeys(candidate);
    } catch {
      seen.delete(candidate);
      return false;
    }
    if (
      keys.length > MAX_METADATA_KEYS ||
      prototype !== Object.prototype ||
      keys.some((key) => {
        if (
          typeof key !== "string" ||
          !Object.prototype.propertyIsEnumerable.call(candidate, key)
        )
          return true;
        let descriptor: PropertyDescriptor | undefined;
        try {
          descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        } catch {
          return true;
        }
        return (
          !descriptor ||
          !Object.hasOwn(descriptor, "value") ||
          Object.hasOwn(descriptor, "get") ||
          Object.hasOwn(descriptor, "set") ||
          !descriptor.enumerable ||
          !descriptor.writable ||
          !descriptor.configurable
        );
      })
    ) {
      seen.delete(candidate);
      return false;
    }
    for (const key of keys as string[]) {
      if (
        key.length > 128 ||
        !valid((candidate as Record<string, unknown>)[key], depth + 1)
      ) {
        seen.delete(candidate);
        return false;
      }
    }
    seen.delete(candidate);
    return true;
  };
  if (!valid(value, 0) || metadataBytes(value) > MAX_METADATA_SERIALIZED_BYTES)
    return false;
  try {
    const roundTripped = JSON.parse(JSON.stringify(value)) as unknown;
    return isDeepStrictEqual(roundTripped, value);
  } catch {
    return false;
  }
}

/**
 * Bounded renderer projection. Versioned custom snapshots own replay; legacy
 * tool-result snapshots remain accepted by `state/replay.ts`.
 */
export interface TaskDetails {
  action: TaskAction;
  params: Pick<
    TaskMutationParams,
    | "id"
    | "duplicateId"
    | "decision"
    | "challengeEvidence"
    | "rationale"
    | "status"
    | "addBlockedBy"
    | "removeBlockedBy"
  >;
  task?: Pick<Task, "status">;
  error?: string;
}

/**
 * Open-shape input bag the reducer accepts. Stays an interface so the index
 * signature (`[key: string]: unknown`) lets the runtime pass through TypeBox
 * `Static<typeof TodoParamsSchema>` without `as` casts.
 */
export interface TaskMutationParams {
  [key: string]: unknown;
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: TaskStatus;
  result?: string;
  evidence?: string[];
  blockedBy?: number[];
  addBlockedBy?: number[];
  removeBlockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
  id?: number;
  duplicateId?: number;
  decision?: "challenge" | "skip";
  challengeEvidence?: string[];
  rationale?: string;
  includeDeleted?: boolean;
  questions?: string[];
  jobIds?: string[];
  jobMode?: "all" | "any";
  timeoutSeconds?: number;
  prepare?: boolean;
}

// ---------------------------------------------------------------------------
// TypeBox parameter schema — every `description` doubles as LLM-facing prompt
// copy. Field order and wording are pinned by registration tests and the
// pre-refactor schema at `packages/rpiv-todo/todo.ts:512-573`.
// ---------------------------------------------------------------------------

export const TodoParamsSchema = Type.Object({
  action: StringEnum([
    "create",
    "update",
    "merge",
    "challenge",
    "list",
    "get",
    "delete",
    "clear",
  ] as const),
  subject: Type.Optional(
    Type.String({
      maxLength: MAX_TASK_SUBJECT_LENGTH,
      description: "Task subject line (required for create)",
    }),
  ),
  description: Type.Optional(
    Type.String({
      maxLength: MAX_TASK_DESCRIPTION_LENGTH,
      description: "Long-form task description",
    }),
  ),
  activeForm: Type.Optional(
    Type.String({
      maxLength: MAX_TASK_ACTIVE_FORM_LENGTH,
      description:
        "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')",
    }),
  ),
  status: Type.Optional(
    StringEnum(
      [
        "pending",
        "in_progress",
        "waiting:user",
        "waiting:jobs",
        "completed",
        "deleted",
      ] as const,
      {
        description: "Target status (update) or list filter (list)",
      },
    ),
  ),
  result: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: MAX_TASK_RESULT_LENGTH,
      description:
        "Concrete outcome required when completing a task; trimmed and stored for audit",
    }),
  ),
  evidence: Type.Optional(
    Type.Array(
      Type.String({ minLength: 1, maxLength: MAX_TASK_EVIDENCE_LENGTH }),
      {
        minItems: 1,
        maxItems: MAX_TASK_EVIDENCE_COUNT,
        description:
          "One to eight concrete verification entries required when completing a task; trimmed and stored for audit",
      },
    ),
  ),
  questions: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
      minItems: 1,
      maxItems: 8,
      description:
        "Exact concrete questions required when setting status to waiting:user (1-8)",
    }),
  ),
  jobIds: Type.Optional(
    Type.Array(
      Type.String({ minLength: 1, maxLength: MAX_WAIT_JOB_ID_LENGTH }),
      {
        minItems: 1,
        maxItems: MAX_WAIT_JOB_COUNT,
        description:
          "Unique running job ids required when setting status to waiting:jobs",
      },
    ),
  ),
  jobMode: Type.Optional(
    StringEnum(["all", "any"] as const, {
      description:
        "Wake after all linked jobs settle or after any linked job settles",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 86400,
      description:
        "Bounded relative timeout in seconds for waiting:jobs (1-86400); the extension owns the deadline",
    }),
  ),
  blockedBy: Type.Optional(
    Type.Array(Type.Number(), {
      maxItems: MAX_BLOCKED_BY,
      description: "Initial blockedBy ids (create only)",
    }),
  ),
  addBlockedBy: Type.Optional(
    Type.Array(Type.Number(), {
      maxItems: MAX_BLOCKED_BY,
      description: "Task ids to add to blockedBy (update only, additive merge)",
    }),
  ),
  removeBlockedBy: Type.Optional(
    Type.Array(Type.Number(), {
      maxItems: MAX_BLOCKED_BY,
      description:
        "Task ids to remove from blockedBy (update only, additive merge)",
    }),
  ),
  owner: Type.Optional(
    Type.String({
      maxLength: MAX_TASK_OWNER_LENGTH,
      description: "Agent/owner assigned to this task",
    }),
  ),
  metadata: Type.Optional(
    Type.Record(Type.String({ maxLength: 128 }), Type.Unknown(), {
      description:
        "Arbitrary metadata except reserved orchestration keys; pass null value for a key to delete that key on update",
    }),
  ),
  id: Type.Optional(
    Type.Number({
      description: "Task id (required for update, get, delete)",
    }),
  ),
  duplicateId: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "Duplicate task id (required for merge; id is the execution owner)",
    }),
  ),
  decision: Type.Optional(StringEnum(["challenge", "skip"] as const)),
  challengeEvidence: Type.Optional(
    Type.Array(Type.String({ maxLength: MAX_TASK_EVIDENCE_LENGTH }), {
      maxItems: MAX_TASK_EVIDENCE_COUNT,
    }),
  ),
  rationale: Type.Optional(
    Type.String({ maxLength: MAX_TASK_DESCRIPTION_LENGTH }),
  ),
  includeDeleted: Type.Optional(
    Type.Boolean({
      description:
        "If true, list action returns deleted (tombstoned) tasks as well. Default: false.",
    }),
  ),
});

export type TodoParams = Static<typeof TodoParamsSchema>;
