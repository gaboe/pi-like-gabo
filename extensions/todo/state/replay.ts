import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  JobWaitEvidence,
  Task,
  TaskReview,
  TaskStatus,
  TaskWait,
} from "../tool/types.js";
import {
  MAX_JOB_EVIDENCE_ERROR_LENGTH,
  MAX_JOB_EVIDENCE_ID_LENGTH,
  MAX_METADATA_KEYS,
  MAX_TASK_ACTIVE_FORM_LENGTH,
  MAX_TASK_DESCRIPTION_LENGTH,
  MAX_TASK_EVIDENCE_COUNT,
  MAX_TASK_EVIDENCE_LENGTH,
  MAX_TASK_OWNER_LENGTH,
  MAX_TASK_RESULT_LENGTH,
  MAX_TASK_SUBJECT_LENGTH,
  MAX_BLOCKED_BY,
  MAX_REVIEW_DIGEST_LENGTH,
  MAX_REVIEW_FEEDBACK_LENGTH,
  MAX_REVIEW_ID_LENGTH,
  MAX_REVIEW_MODEL_LENGTH,
  MAX_REVIEW_TOKEN_LENGTH,
  MAX_WAIT_JOB_COUNT,
  MAX_WAIT_JOB_ID_LENGTH,
  MAX_WAIT_QUESTION_LENGTH,
  MAX_WAIT_SETTLED_COUNT,
  MAX_WAIT_EVIDENCE_COUNT,
  isCanonicalArray,
  isTaskReviewScope,
  isBoundedMetadata,
  sanitizeMetadata,
} from "../tool/types.js";
import {
  COMPLETION_REVIEW_MODEL,
  COMPLETION_REVIEWER_ID,
} from "./completion.js";
import {
  EMPTY_STATE,
  CANCELLATION_CAPACITY_ERROR,
  CANCELLATION_QUARANTINE_ERROR,
  cancellationIntentTargetKey,
  delegationWorkerIds,
  normalizeCancellationIntent,
  MAX_CANCELLATION_INTENTS,
  MAX_CANCELLATION_RECOVERY_ENTRIES,
  type TaskState,
  type TodoCancellationIntent,
} from "./state.js";
import { detectCycle } from "./task-graph.js";
import { isTaskArchivable } from "./completion.js";
import { propagatePrerequisiteFailure } from "./inbox.js";
import { redactTodoText, redactTodoValue } from "./redaction.js";

const STATUSES = new Set<TaskStatus>([
  "pending",
  "in_progress",
  "waiting:user",
  "waiting:jobs",
  "completed",
  "deleted",
]);
const TERMINAL_JOB_STATUSES = new Set([
  "wake",
  "succeeded",
  "failed",
  "killed",
  "timed_out",
]);

export const TODO_SNAPSHOT_TYPE = "rpiv-todo:snapshot";
export const TODO_SNAPSHOT_VERSION = 1;
export const TODO_PATCH_VERSION = 2;
export const MAX_PERSISTED_TASKS = 1024;
const MAX_HISTORICAL_ARRAY_LENGTH = 256;
const MAX_HISTORICAL_SHAPE_ARRAY_LENGTH = MAX_PERSISTED_TASKS * 2;

export interface TodoSnapshot {
  version: typeof TODO_SNAPSHOT_VERSION;
  revision: number;
  tasks: Task[];
  nextId: number;
  orchestrator?: { setting: "on" | "off" | "auto"; sticky?: boolean };
  cancellationIntents?: TodoCancellationIntent[];
  cancellationOverflow?: TodoCancellationIntent[];
  cancellationQuarantine?: TodoCancellationIntent[];
  cancellationCapacityError?: string;
}

export interface TodoPatch {
  version: typeof TODO_PATCH_VERSION;
  baseRevision: number;
  revision: number;
  upsertedTasks: Task[];
  removedIds: number[];
  taskOrder: number[];
  nextId: number;
  orchestrator: TaskState["orchestrator"] | null;
  cancellationIntents?: TodoCancellationIntent[];
  cancellationOverflow?: TodoCancellationIntent[];
  cancellationQuarantine?: TodoCancellationIntent[];
  cancellationCapacityError?: string | null;
}

const ORCHESTRATOR_KEYS = new Set(["setting", "sticky"]);
const CANCELLATION_STATE_KEYS = [
  "cancellationIntents",
  "cancellationOverflow",
  "cancellationQuarantine",
  "cancellationCapacityError",
] as const;
const TASK_STATE_KEYS = new Set([
  "tasks",
  "nextId",
  "revision",
  "orchestrator",
  ...CANCELLATION_STATE_KEYS,
]);
const SNAPSHOT_KEYS = new Set([
  "version",
  "revision",
  "tasks",
  "nextId",
  "orchestrator",
  ...CANCELLATION_STATE_KEYS,
]);
const PATCH_KEYS = new Set([
  "version",
  "baseRevision",
  "revision",
  "upsertedTasks",
  "removedIds",
  "taskOrder",
  "nextId",
  "orchestrator",
  ...CANCELLATION_STATE_KEYS,
]);
const TASK_KEYS = new Set([
  "id",
  "subject",
  "description",
  "activeForm",
  "status",
  "result",
  "mergedInto",
  "evidence",
  "review",
  "blockedBy",
  "owner",
  "metadata",
  "wait",
  "waitEvidence",
]);
const WAIT_USER_KEYS = new Set(["kind", "questions"]);
const WAIT_JOBS_KEYS = new Set([
  "kind",
  "jobIds",
  "mode",
  "deadline",
  "settled",
  "waitToken",
  "registeredAt",
  "generation",
  "incarnations",
  "reconciliationAttempts",
  "reconciliationError",
]);
const WAIT_KEYS = new Set([...WAIT_USER_KEYS, ...WAIT_JOBS_KEYS]);
const EVIDENCE_KEYS = new Set(["id", "status", "settledAt", "error"]);
const REVIEW_KEYS = new Set([
  "status",
  "generation",
  "token",
  "completionRevision",
  "requestedAt",
  "dispatchedAt",
  "reviewedAt",
  "failedAt",
  "attempts",
  "inputDigest",
  "scope",
  "reviewer",
  "feedback",
]);
const REVIEWER_KEYS = new Set(["id", "model"]);

function isCancellationIntent(value: unknown): value is TodoCancellationIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "kind",
    "taskId",
    "token",
    "ids",
    "generation",
    "attempts",
    "correlationId",
    "workerGeneration",
    "error",
    "orphaned",
    "rearmed",
  ]);
  const keys = boundedOwnKeys(intent, allowedKeys.size);
  if (!keys || keys.some((key) => !allowedKeys.has(key))) return false;
  const kind = intent.kind;
  const ids = intent.ids;
  const validString = (candidate: unknown, max: number, nonEmpty = true) =>
    typeof candidate === "string" &&
    candidate.length <= max &&
    candidate === candidate.trim() &&
    (!nonEmpty || candidate.length > 0);
  return (
    (kind === "delegation" || kind === "preparation") &&
    Number.isSafeInteger(intent.taskId) &&
    Number(intent.taskId) > 0 &&
    validString(intent.token, 256) &&
    isCanonicalArray(ids, 1) &&
    ids.length === 1 &&
    ids.every((id) => validString(id, 256)) &&
    new Set(ids).size === ids.length &&
    Number.isSafeInteger(intent.generation) &&
    Number(intent.generation) > 0 &&
    Number.isSafeInteger(intent.attempts) &&
    Number(intent.attempts) >= 0 &&
    Number(intent.attempts) <= 3 &&
    optionalField(
      intent,
      "correlationId",
      (value) => typeof value === "string" && /^[a-f0-9]{16,64}$/.test(value),
    ) &&
    (kind === "preparation"
      ? hasOwn(intent, "workerGeneration") &&
        intent.workerGeneration !== undefined &&
        Number.isSafeInteger(intent.workerGeneration) &&
        Number(intent.workerGeneration) >= 0
      : !hasOwn(intent, "workerGeneration")) &&
    optionalField(intent, "error", (value) => validString(value, 512)) &&
    optionalField(intent, "orphaned", (value) => value === true) &&
    optionalField(intent, "rearmed", (value) => value === true)
  );
}

function isCancellationIntentArray(
  value: unknown,
): value is TodoCancellationIntent[] {
  if (!isCanonicalArray(value, MAX_CANCELLATION_INTENTS)) return false;
  if (!value.every(isCancellationIntent)) return false;
  return (
    new Set(value.map((intent) => cancellationIntentTargetKey(intent))).size ===
    value.length
  );
}

function isCancellationQuarantineArray(
  value: unknown,
): value is TodoCancellationIntent[] {
  if (
    !isCanonicalArray(value, MAX_CANCELLATION_RECOVERY_ENTRIES) ||
    !value.every(isCancellationIntent)
  )
    return false;
  return (
    new Set(value.map((intent) => cancellationIntentTargetKey(intent))).size ===
    value.length
  );
}

function isBoundedCancellationRecovery(
  intents: unknown,
  overflow: unknown,
  quarantine: unknown,
): boolean {
  const fields: unknown[] = [intents, overflow, quarantine];
  return (
    fields.every(
      (value) =>
        !Array.isArray(value) ||
        isCanonicalArray(value, MAX_CANCELLATION_RECOVERY_ENTRIES),
    ) &&
    fields.reduce<number>(
      (total, value) => total + (Array.isArray(value) ? value.length : 0),
      0,
    ) <= MAX_CANCELLATION_RECOVERY_ENTRIES
  );
}

function isCancellationRecoveryCandidate(
  intents: unknown,
  overflow: unknown,
  quarantine: unknown,
): boolean {
  if (
    (intents !== undefined && !isCancellationIntentArray(intents)) ||
    (overflow !== undefined && !isCancellationIntentArray(overflow)) ||
    (quarantine !== undefined && !isCancellationQuarantineArray(quarantine)) ||
    !isBoundedCancellationRecovery(intents, overflow, quarantine)
  )
    return false;
  const keys = new Set<string>();
  for (const field of [intents, overflow, quarantine]) {
    if (!Array.isArray(field)) continue;
    for (const intent of field) {
      const key = cancellationIntentTargetKey(intent);
      if (keys.has(key)) return false;
      keys.add(key);
    }
  }
  return true;
}

function isEvidence(value: unknown): value is JobWaitEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  if (!hasExactOwnKeys(evidence, EVIDENCE_KEYS, ["id", "status"])) return false;
  return (
    typeof evidence.id === "string" &&
    evidence.id.length > 0 &&
    evidence.id.length <= MAX_JOB_EVIDENCE_ID_LENGTH &&
    evidence.id === evidence.id.trim() &&
    TERMINAL_JOB_STATUSES.has(evidence.status as string) &&
    optionalField(
      evidence,
      "settledAt",
      (value) => typeof value === "number" && Number.isFinite(value),
    ) &&
    optionalField(
      evidence,
      "error",
      (value) =>
        typeof value === "string" &&
        value.length <= MAX_JOB_EVIDENCE_ERROR_LENGTH,
    )
  );
}

function isWait(value: unknown): value is TaskWait {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const wait = value as Record<string, unknown>;
  if (!hasExactOwnKeys(wait, WAIT_KEYS)) return false;
  if (wait.kind === "user") {
    if (!hasExactOwnKeys(wait, WAIT_USER_KEYS, ["kind", "questions"]))
      return false;
    return (
      isCanonicalArray(wait.questions, 8) &&
      wait.questions.length >= 1 &&
      wait.questions.length <= 8 &&
      wait.questions.every(
        (question) =>
          typeof question === "string" &&
          question.length <= MAX_WAIT_QUESTION_LENGTH &&
          question.trim(),
      )
    );
  }
  if (wait.kind !== "jobs") return false;
  if (
    !hasExactOwnKeys(wait, WAIT_JOBS_KEYS, [
      "kind",
      "jobIds",
      "mode",
      "deadline",
      "settled",
    ])
  )
    return false;
  const jobIds = wait.jobIds as unknown[];
  const settled = wait.settled as Record<string, unknown> | undefined;
  if (
    !isCanonicalArray(jobIds, MAX_WAIT_JOB_COUNT) ||
    jobIds.length < 1 ||
    jobIds.length > MAX_WAIT_JOB_COUNT ||
    jobIds.some(
      (id) =>
        typeof id !== "string" ||
        !id ||
        id.length > MAX_WAIT_JOB_ID_LENGTH ||
        id !== id.trim(),
    ) ||
    new Set(jobIds).size !== jobIds.length ||
    (wait.mode !== "all" && wait.mode !== "any") ||
    typeof wait.deadline !== "number" ||
    !Number.isFinite(wait.deadline) ||
    (wait.waitToken !== undefined &&
      (typeof wait.waitToken !== "string" ||
        wait.waitToken.length === 0 ||
        wait.waitToken.length > 128)) ||
    (wait.registeredAt !== undefined &&
      (typeof wait.registeredAt !== "number" ||
        !Number.isFinite(wait.registeredAt))) ||
    (wait.generation !== undefined &&
      (typeof wait.generation !== "number" ||
        !Number.isSafeInteger(wait.generation) ||
        wait.generation < 1)) ||
    (wait.incarnations !== undefined &&
      (!wait.incarnations ||
        typeof wait.incarnations !== "object" ||
        Array.isArray(wait.incarnations) ||
        !Object.entries(wait.incarnations as Record<string, unknown>).every(
          ([id, incarnation]) =>
            jobIds.includes(id) &&
            typeof incarnation === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              incarnation,
            ),
        ))) ||
    (wait.waitToken !== undefined &&
      (wait.registeredAt === undefined || wait.generation === undefined)) ||
    (wait.reconciliationAttempts !== undefined &&
      (typeof wait.reconciliationAttempts !== "number" ||
        !Number.isSafeInteger(wait.reconciliationAttempts) ||
        wait.reconciliationAttempts < 0 ||
        wait.reconciliationAttempts > 3)) ||
    (wait.reconciliationError !== undefined &&
      wait.reconciliationError !== "query_unavailable") ||
    !settled ||
    typeof settled !== "object" ||
    Array.isArray(settled)
  ) {
    return false;
  }
  const settledKeys = boundedOwnKeys(settled, MAX_WAIT_SETTLED_COUNT);
  if (!settledKeys) return false;
  return settledKeys.every((id) => {
    const evidence = settled[id];
    return jobIds.includes(id) && isEvidence(evidence) && evidence.id === id;
  });
}

function isReview(value: unknown): value is TaskReview {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const review = value as Record<string, unknown>;
  if (
    !hasExactOwnKeys(review, REVIEW_KEYS, [
      "status",
      "generation",
      "token",
      "completionRevision",
      "requestedAt",
      "reviewer",
    ])
  )
    return false;
  const reviewer = review.reviewer;
  const generation = review.generation;
  const completionRevision = review.completionRevision;
  const reviewerRecord =
    reviewer && typeof reviewer === "object" && !Array.isArray(reviewer)
      ? (reviewer as Record<string, unknown>)
      : undefined;
  if (
    reviewerRecord &&
    !hasExactOwnKeys(reviewerRecord, REVIEWER_KEYS, ["id", "model"])
  )
    return false;
  const reviewerId = reviewerRecord?.id;
  const reviewerModel = reviewerRecord?.model;
  return (
    (review.status === "pending" ||
      review.status === "approved" ||
      review.status === "rejected") &&
    Number.isSafeInteger(review.generation) &&
    typeof generation === "number" &&
    generation > 0 &&
    typeof review.token === "string" &&
    review.token.length > 0 &&
    review.token.length <= MAX_REVIEW_TOKEN_LENGTH &&
    review.token === review.token.trim() &&
    Number.isSafeInteger(review.completionRevision) &&
    typeof completionRevision === "number" &&
    completionRevision >= 0 &&
    typeof review.requestedAt === "number" &&
    Number.isFinite(review.requestedAt) &&
    optionalField(
      review,
      "dispatchedAt",
      (value) => typeof value === "number" && Number.isFinite(value),
    ) &&
    optionalField(
      review,
      "reviewedAt",
      (value) => typeof value === "number" && Number.isFinite(value),
    ) &&
    optionalField(
      review,
      "failedAt",
      (value) => typeof value === "number" && Number.isFinite(value),
    ) &&
    optionalField(
      review,
      "attempts",
      (value) =>
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= 3,
    ) &&
    optionalField(
      review,
      "inputDigest",
      (value) =>
        typeof value === "string" &&
        value.length <= MAX_REVIEW_DIGEST_LENGTH &&
        value === value.trim(),
    ) &&
    optionalField(review, "scope", isTaskReviewScope) &&
    typeof reviewerId === "string" &&
    reviewerId.length <= MAX_REVIEW_ID_LENGTH &&
    typeof reviewerModel === "string" &&
    reviewerModel.length <= MAX_REVIEW_MODEL_LENGTH &&
    optionalField(
      review,
      "feedback",
      (value) =>
        typeof value === "string" && value.length <= MAX_REVIEW_FEEDBACK_LENGTH,
    )
  );
}

function boundedHistoricalString(
  value: unknown,
  max: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const bounded = value.slice(0, max);
  return bounded.length > 0 ? bounded : undefined;
}

function boundedOwnKeys(value: object, max: number): string[] | undefined {
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length > max) return undefined;
    for (const key of keys) {
      if (
        typeof key !== "string" ||
        !Object.prototype.propertyIsEnumerable.call(value, key)
      )
        return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        Object.hasOwn(descriptor, "get") ||
        Object.hasOwn(descriptor, "set") ||
        !descriptor.enumerable ||
        !descriptor.writable ||
        !descriptor.configurable
      )
        return undefined;
    }
    return keys as string[];
  } catch {
    return undefined;
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function canonicalHistoricalRecord(
  value: unknown,
  maxKeys: number,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return boundedOwnKeys(value, maxKeys)
    ? (value as Record<string, unknown>)
    : undefined;
}

function historicalShapeSafe(value: unknown, depth = 0): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    value === undefined
  )
    return true;
  if (depth >= 8) return true;
  if (Array.isArray(value)) {
    try {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false;
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
        length.value < 0
      )
        return false;
      if (length.value > MAX_HISTORICAL_SHAPE_ARRAY_LENGTH) return false;
      return (
        isCanonicalArray(value, MAX_HISTORICAL_SHAPE_ARRAY_LENGTH) &&
        value.every((entry) => historicalShapeSafe(entry, depth + 1))
      );
    } catch {
      return false;
    }
  }
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_METADATA_KEYS) return true;
    for (const key of keys) {
      if (
        typeof key !== "string" ||
        !Object.prototype.propertyIsEnumerable.call(value, key)
      )
        return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        Object.hasOwn(descriptor, "get") ||
        Object.hasOwn(descriptor, "set") ||
        !descriptor.enumerable ||
        !descriptor.writable ||
        !descriptor.configurable ||
        !historicalShapeSafe((value as Record<string, unknown>)[key], depth + 1)
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

function optionalField(
  value: Record<string, unknown>,
  key: string,
  validate: (candidate: unknown) => boolean,
): boolean {
  return (
    !hasOwn(value, key) || (value[key] !== undefined && validate(value[key]))
  );
}

function hasExactOwnKeys(
  value: object,
  allowed: ReadonlySet<string>,
  required: readonly string[] = [],
): boolean {
  const keys = boundedOwnKeys(value, allowed.size + 1);
  return Boolean(
    keys &&
    keys.every((key) => allowed.has(key)) &&
    required.every((key) => hasOwn(value, key)),
  );
}

export function isPersistableOrchestrator(
  value: unknown,
): value is { setting: "on" | "off" | "auto"; sticky?: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Boolean(
    hasExactOwnKeys(record, ORCHESTRATOR_KEYS, ["setting"]) &&
    (record.setting === "on" ||
      record.setting === "off" ||
      record.setting === "auto") &&
    (!Object.hasOwn(record, "sticky") || typeof record.sticky === "boolean"),
  );
}

function copyHistoricalFields(
  source: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const field of fields)
    if (Object.hasOwn(source, field)) copy[field] = source[field];
  return copy;
}

function migrateHistoricalEvidence(
  value: unknown,
  expectedId?: string,
): JobWaitEvidence | undefined {
  const source = canonicalHistoricalRecord(value, EVIDENCE_KEYS.size);
  if (
    !source ||
    !historicalShapeSafe(source) ||
    Object.keys(source).some((key) => !EVIDENCE_KEYS.has(key))
  )
    return undefined;
  const id = boundedHistoricalString(source.id, MAX_JOB_EVIDENCE_ID_LENGTH);
  const error = boundedHistoricalString(
    source.error,
    MAX_JOB_EVIDENCE_ERROR_LENGTH,
  );
  const evidence = {
    id,
    status: source.status,
    ...(typeof source.settledAt === "number" &&
    Number.isFinite(source.settledAt)
      ? { settledAt: source.settledAt }
      : {}),
    ...(error ? { error } : {}),
  };
  return id && (!expectedId || id === expectedId) && isEvidence(evidence)
    ? evidence
    : undefined;
}

function migrateHistoricalReview(value: unknown): TaskReview | undefined {
  const source = canonicalHistoricalRecord(value, REVIEW_KEYS.size);
  if (
    !source ||
    !historicalShapeSafe(source) ||
    Object.keys(source).some((key) => !REVIEW_KEYS.has(key))
  )
    return undefined;
  const reviewerRecord = canonicalHistoricalRecord(
    source.reviewer,
    REVIEWER_KEYS.size,
  );
  if (!reviewerRecord) return undefined;
  const id = boundedHistoricalString(reviewerRecord.id, MAX_REVIEW_ID_LENGTH);
  const model = boundedHistoricalString(
    reviewerRecord.model,
    MAX_REVIEW_MODEL_LENGTH,
  );
  const token = boundedHistoricalString(source.token, MAX_REVIEW_TOKEN_LENGTH);
  if (
    !id ||
    !model ||
    !token ||
    !["pending", "approved", "rejected"].includes(source.status as string) ||
    !Number.isSafeInteger(source.generation) ||
    (source.generation as number) <= 0 ||
    !Number.isSafeInteger(source.completionRevision) ||
    (source.completionRevision as number) < 0 ||
    typeof source.requestedAt !== "number" ||
    !Number.isFinite(source.requestedAt)
  )
    return undefined;
  const review: TaskReview = {
    status: source.status as TaskReview["status"],
    generation: source.generation as number,
    token,
    completionRevision: source.completionRevision as number,
    requestedAt: source.requestedAt,
    reviewer: { id, model },
  };
  for (const field of ["dispatchedAt", "reviewedAt", "failedAt"] as const) {
    const timestamp = source[field];
    if (typeof timestamp === "number" && Number.isFinite(timestamp))
      review[field] = timestamp;
  }
  if (Number.isSafeInteger(source.attempts) && (source.attempts as number) >= 0)
    review.attempts = Math.min(3, source.attempts as number);
  const inputDigest = boundedHistoricalString(
    source.inputDigest,
    MAX_REVIEW_DIGEST_LENGTH,
  );
  const feedback = boundedHistoricalString(
    source.feedback,
    MAX_REVIEW_FEEDBACK_LENGTH,
  );
  if (inputDigest) review.inputDigest = inputDigest;
  if (isTaskReviewScope(source.scope)) review.scope = source.scope;
  if (feedback) review.feedback = feedback;
  return isReview(review) ? review : undefined;
}

function migrateHistoricalWait(value: unknown): TaskWait | undefined {
  const source = canonicalHistoricalRecord(value, WAIT_KEYS.size);
  if (
    !source ||
    !historicalShapeSafe(source) ||
    Object.keys(source).some((key) => !WAIT_KEYS.has(key))
  )
    return undefined;
  if (source.kind === "user") {
    const questions = isCanonicalArray(
      source.questions,
      MAX_HISTORICAL_ARRAY_LENGTH,
    )
      ? source.questions
          .slice(0, 8)
          .map((question) =>
            boundedHistoricalString(question, MAX_WAIT_QUESTION_LENGTH),
          )
          .filter((question): question is string => question !== undefined)
      : [];
    return questions.length ? { kind: "user", questions } : undefined;
  }
  if (
    source.kind !== "jobs" ||
    !isCanonicalArray(source.jobIds, MAX_HISTORICAL_ARRAY_LENGTH)
  )
    return undefined;
  const jobIds = source.jobIds
    .slice(0, MAX_WAIT_JOB_COUNT)
    .map((id) => boundedHistoricalString(id, MAX_WAIT_JOB_ID_LENGTH))
    .filter((id): id is string => id !== undefined);
  if (
    !jobIds.length ||
    new Set(jobIds).size !== jobIds.length ||
    (source.mode !== "all" && source.mode !== "any") ||
    typeof source.deadline !== "number" ||
    !Number.isFinite(source.deadline)
  )
    return undefined;
  const settled: Record<string, JobWaitEvidence> = {};
  if (
    source.settled &&
    typeof source.settled === "object" &&
    !Array.isArray(source.settled)
  ) {
    const settledRecord = canonicalHistoricalRecord(
      source.settled,
      MAX_WAIT_SETTLED_COUNT,
    );
    if (!settledRecord) return undefined;
    const keys = boundedOwnKeys(settledRecord, MAX_WAIT_SETTLED_COUNT);
    if (!keys) return undefined;
    for (const id of keys) {
      const candidate = settledRecord[id];
      const evidence = migrateHistoricalEvidence(candidate, id);
      if (evidence && jobIds.includes(id)) settled[id] = evidence;
    }
  }
  const waitToken = boundedHistoricalString(source.waitToken, 128);
  const registeredAt = source.registeredAt;
  const generation = source.generation;
  const incarnations = canonicalHistoricalRecord(
    source.incarnations,
    MAX_WAIT_JOB_COUNT,
  );
  const reconciliationAttempts = source.reconciliationAttempts;
  const reconciliationError = source.reconciliationError;
  return {
    kind: "jobs",
    jobIds,
    mode: source.mode,
    deadline: source.deadline,
    settled,
    ...(waitToken &&
    typeof registeredAt === "number" &&
    Number.isFinite(registeredAt) &&
    typeof generation === "number" &&
    Number.isSafeInteger(generation) &&
    generation > 0
      ? { waitToken, registeredAt, generation }
      : {}),
    ...(incarnations &&
    Object.entries(incarnations).every(
      ([id, incarnation]) =>
        jobIds.includes(id) &&
        typeof incarnation === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          incarnation,
        ),
    )
      ? { incarnations: incarnations as Record<string, string> }
      : {}),
    ...(typeof reconciliationAttempts === "number" &&
    Number.isSafeInteger(reconciliationAttempts) &&
    reconciliationAttempts >= 0 &&
    reconciliationAttempts <= 3
      ? { reconciliationAttempts }
      : {}),
    ...(reconciliationError === "query_unavailable"
      ? { reconciliationError }
      : {}),
  };
}

function hasValidFailureSource(metadata: unknown): boolean {
  if (metadata === undefined) return true;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return false;
  const inbox = (metadata as Record<string, unknown>).inbox;
  if (inbox === undefined) return true;
  if (!inbox || typeof inbox !== "object" || Array.isArray(inbox)) return false;
  const record = inbox as Record<string, unknown>;
  const hasSource = Object.hasOwn(record, "sourceFailureId");
  if (record.reason !== "failed prerequisite") return !hasSource;
  return (
    hasSource &&
    Number.isSafeInteger(record.sourceFailureId) &&
    (record.sourceFailureId as number) > 0
  );
}

function failureSourceId(task: Task): number | undefined {
  const inbox = task.metadata?.inbox;
  if (!inbox || typeof inbox !== "object" || Array.isArray(inbox))
    return undefined;
  const sourceFailureId = (inbox as Record<string, unknown>).sourceFailureId;
  return Number.isSafeInteger(sourceFailureId) &&
    (sourceFailureId as number) > 0
    ? (sourceFailureId as number)
    : undefined;
}

function isFailureRoot(task: Task): boolean {
  if (failureSourceId(task) !== undefined) return false;
  const inbox = task.metadata?.inbox as Record<string, unknown> | undefined;
  const preparation = task.metadata?.preparation as
    Record<string, unknown> | undefined;
  const verification = task.metadata?.verification as
    Record<string, unknown> | undefined;
  return (
    String(task.status) === "failed" ||
    inbox?.lifecycle === "failed" ||
    preparation?.status === "failed" ||
    verification?.state === "failed"
  );
}

export function isPersistableTask(value: unknown): value is Task {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const task = value as Record<string, unknown>;
  const valid =
    hasExactOwnKeys(task, TASK_KEYS, ["id", "subject", "status"]) &&
    Number.isSafeInteger(task.id) &&
    (task.id as number) > 0 &&
    typeof task.subject === "string" &&
    task.subject.trim().length > 0 &&
    task.subject.length <= MAX_TASK_SUBJECT_LENGTH &&
    optionalField(
      task,
      "description",
      (value) =>
        typeof value === "string" &&
        value.length <= MAX_TASK_DESCRIPTION_LENGTH,
    ) &&
    optionalField(
      task,
      "activeForm",
      (value) =>
        typeof value === "string" &&
        value.length <= MAX_TASK_ACTIVE_FORM_LENGTH,
    ) &&
    optionalField(
      task,
      "owner",
      (value) =>
        typeof value === "string" && value.length <= MAX_TASK_OWNER_LENGTH,
    ) &&
    optionalField(
      task,
      "result",
      (value) =>
        typeof value === "string" && value.length <= MAX_TASK_RESULT_LENGTH,
    ) &&
    optionalField(
      task,
      "mergedInto",
      (value) => Number.isSafeInteger(value) && (value as number) > 0,
    ) &&
    optionalField(
      task,
      "evidence",
      (value) =>
        isCanonicalArray(value, MAX_TASK_EVIDENCE_COUNT) &&
        value.every(
          (entry) =>
            typeof entry === "string" &&
            entry.length > 0 &&
            entry.length <= MAX_TASK_EVIDENCE_LENGTH,
        ),
    ) &&
    optionalField(task, "review", isReview) &&
    optionalField(task, "metadata", isBoundedMetadata) &&
    hasValidFailureSource(task.metadata) &&
    STATUSES.has(task.status as TaskStatus) &&
    optionalField(
      task,
      "blockedBy",
      (value) =>
        isCanonicalArray(value, MAX_BLOCKED_BY) &&
        new Set(value).size === value.length &&
        value.every(
          (id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0,
        ),
    ) &&
    optionalField(
      task,
      "waitEvidence",
      (value) =>
        isCanonicalArray(value, MAX_WAIT_EVIDENCE_COUNT) &&
        value.every(isEvidence),
    );
  if (!valid) return false;
  if (task.status === "waiting:user" || task.status === "waiting:jobs") {
    return (
      hasOwn(task, "wait") &&
      task.wait !== undefined &&
      isWait(task.wait) &&
      task.wait.kind === task.status.slice("waiting:".length)
    );
  }
  return !hasOwn(task, "wait");
}

function cancellationTaskIds(value: unknown): Set<number> {
  if (!isCanonicalArray(value, MAX_CANCELLATION_RECOVERY_ENTRIES))
    return new Set();
  return new Set(
    value.flatMap((intent) => {
      if (!intent || typeof intent !== "object" || Array.isArray(intent))
        return [];
      const taskId = (intent as { taskId?: unknown }).taskId;
      return Number.isSafeInteger(taskId) && (taskId as number) > 0
        ? [taskId as number]
        : [];
    }),
  );
}

function hasActiveTaskOwner(task: Task): boolean {
  const metadata = task.metadata;
  const preparation = metadata?.preparation as
    { status?: unknown; activeWorkerIds?: unknown } | undefined;
  const delegation = metadata?.delegation as
    Record<string, unknown> | undefined;
  return (
    ["queued", "running", "classifying"].includes(
      String(preparation?.status),
    ) ||
    (Array.isArray(preparation?.activeWorkerIds) &&
      preparation.activeWorkerIds.length > 0) ||
    ["running", "interrupted", "cancelling"].includes(
      String(delegation?.status),
    ) ||
    delegationWorkerIds(delegation).length > 0
  );
}

function isPrunableTombstone(
  task: Task,
  protectedTaskIds: ReadonlySet<number>,
): boolean {
  if (protectedTaskIds.has(task.id) || hasActiveTaskOwner(task)) return false;
  return task.status === "deleted" || isTaskArchivable(task);
}

function pruneHistoricalTasks(
  tasks: readonly Task[],
  protectedTaskIds: ReadonlySet<number>,
): Task[] | undefined {
  if (tasks.length <= MAX_PERSISTED_TASKS) return [...tasks];
  const requiredByUnresolved = new Set(
    tasks
      .filter((task) => !isPrunableTombstone(task, protectedTaskIds))
      .flatMap((task) => task.blockedBy ?? []),
  );
  const removable = tasks.filter(
    (task) =>
      isPrunableTombstone(task, protectedTaskIds) &&
      !requiredByUnresolved.has(task.id),
  );
  const count = tasks.length - MAX_PERSISTED_TASKS;
  if (removable.length < count) return undefined;
  const removed = new Set(removable.slice(0, count).map((task) => task.id));
  return tasks.filter((task) => !removed.has(task.id));
}

function protectedTaskIdsFromRecord(
  source: Record<string, unknown>,
): Set<number> | undefined {
  const fields = [
    "cancellationIntents",
    "cancellationOverflow",
    "cancellationQuarantine",
  ] as const;
  let total = 0;
  for (const field of fields) {
    if (!hasOwn(source, field)) continue;
    const value = source[field];
    if (!isCanonicalArray(value, MAX_CANCELLATION_RECOVERY_ENTRIES))
      return undefined;
    total += value.length;
    if (total > MAX_CANCELLATION_RECOVERY_ENTRIES) return undefined;
  }
  const ids = new Set<number>();
  for (const field of fields)
    for (const id of cancellationTaskIds(
      hasOwn(source, field) ? source[field] : [],
    ))
      ids.add(id);
  return ids;
}

export function pruneTodoStateForPersistence(
  state: TaskState,
): TaskState | undefined {
  if (!isPersistableTaskState(state, { allowTaskOverflow: true }))
    return undefined;
  if (!isCanonicalArray(state.tasks, MAX_PERSISTED_TASKS * 2)) return undefined;
  const protectedTaskIds = new Set([
    ...cancellationTaskIds(state.cancellationIntents),
    ...cancellationTaskIds(state.cancellationOverflow),
    ...cancellationTaskIds(state.cancellationQuarantine),
  ]);
  const redacted = state.tasks.map((task) => ({
    ...task,
    subject: redactTodoText(task.subject),
    ...(task.description === undefined
      ? {}
      : { description: redactTodoText(task.description) }),
    ...(task.activeForm === undefined
      ? {}
      : { activeForm: redactTodoText(task.activeForm) }),
    ...(task.owner === undefined ? {} : { owner: redactTodoText(task.owner) }),
    ...(task.result === undefined
      ? {}
      : { result: redactTodoText(task.result) }),
    ...(task.evidence === undefined
      ? {}
      : { evidence: task.evidence.map(redactTodoText) }),
    ...(task.metadata === undefined
      ? {}
      : {
          metadata: redactTodoValue(task.metadata) as Record<string, unknown>,
        }),
    ...(task.wait?.kind === "user"
      ? {
          wait: {
            ...task.wait,
            questions: task.wait.questions.map(redactTodoText),
          },
        }
      : task.wait?.kind === "jobs"
        ? {
            wait: {
              ...task.wait,
              settled: Object.fromEntries(
                Object.entries(task.wait.settled).map(([id, entry]) => [
                  id,
                  {
                    ...entry,
                    ...(entry.error === undefined
                      ? {}
                      : { error: redactTodoText(entry.error) }),
                  },
                ]),
              ),
            },
          }
        : {}),
    ...(task.review?.feedback === undefined
      ? {}
      : {
          review: {
            ...task.review,
            feedback: redactTodoText(task.review.feedback),
          },
        }),
    ...(task.waitEvidence === undefined
      ? {}
      : {
          waitEvidence: task.waitEvidence.map((entry) => ({
            ...entry,
            ...(entry.error === undefined
              ? {}
              : { error: redactTodoText(entry.error) }),
          })),
        }),
  }));
  const normalized = redacted.map((task) => {
    if (
      task.status !== "completed" ||
      protectedTaskIds.has(task.id) ||
      hasActiveTaskOwner(task) ||
      (typeof task.result === "string" &&
        task.result.trim() &&
        Array.isArray(task.evidence) &&
        task.evidence.length > 0)
    )
      return task;
    const recovered = { ...task, status: "pending" as const };
    delete recovered.result;
    delete recovered.evidence;
    delete recovered.review;
    delete recovered.wait;
    return recovered;
  });
  const tasks = pruneHistoricalTasks(normalized, protectedTaskIds);
  if (!tasks) return undefined;
  const redactIntents = (intents: TaskState["cancellationIntents"]) =>
    intents?.map((intent) => ({
      ...intent,
      ...(intent.error === undefined
        ? {}
        : { error: redactTodoText(intent.error) }),
    }));
  return {
    ...state,
    tasks,
    ...(state.cancellationIntents === undefined
      ? {}
      : { cancellationIntents: redactIntents(state.cancellationIntents) }),
    ...(state.cancellationOverflow === undefined
      ? {}
      : { cancellationOverflow: redactIntents(state.cancellationOverflow) }),
    ...(state.cancellationQuarantine === undefined
      ? {}
      : {
          cancellationQuarantine: redactIntents(state.cancellationQuarantine),
        }),
  };
}

function legacyCompletionReviewInputDigest(task: {
  subject: string;
  description?: string;
  result?: string;
  evidence?: string[];
  metadata?: Record<string, unknown>;
}): string {
  const preparation = task.metadata?.preparation;
  const reviewTarget =
    preparation && typeof preparation === "object"
      ? (preparation as { reviewTarget?: unknown }).reviewTarget
      : null;
  return createHash("sha256")
    .update(
      JSON.stringify([
        task.subject,
        task.description ?? null,
        task.result ?? null,
        task.evidence ?? null,
        reviewTarget,
      ]),
    )
    .digest("hex");
}

function migrateHistoricalTask(value: unknown): Task | undefined {
  const source = canonicalHistoricalRecord(value, TASK_KEYS.size);
  if (
    !source ||
    !historicalShapeSafe(source) ||
    Object.keys(source).some((key) => !TASK_KEYS.has(key))
  )
    return undefined;
  const task = copyHistoricalFields(source, [
    "id",
    "subject",
    "description",
    "activeForm",
    "status",
    "result",
    "mergedInto",
    "evidence",
    "review",
    "blockedBy",
    "owner",
    "metadata",
    "wait",
    "waitEvidence",
  ]);
  if (typeof task.subject === "string")
    task.subject = task.subject.slice(0, MAX_TASK_SUBJECT_LENGTH);
  if (typeof task.description === "string")
    task.description = task.description.slice(0, MAX_TASK_DESCRIPTION_LENGTH);
  if (typeof task.activeForm === "string")
    task.activeForm = task.activeForm.slice(0, MAX_TASK_ACTIVE_FORM_LENGTH);
  if (typeof task.owner === "string")
    task.owner = task.owner.slice(0, MAX_TASK_OWNER_LENGTH);
  if (task.metadata !== undefined)
    task.metadata = sanitizeMetadata(task.metadata);
  const result = boundedHistoricalString(task.result, MAX_TASK_RESULT_LENGTH);
  if (result) task.result = result;
  else delete task.result;
  if (isCanonicalArray(task.evidence, MAX_HISTORICAL_ARRAY_LENGTH)) {
    const evidence = task.evidence
      .slice(0, MAX_TASK_EVIDENCE_COUNT)
      .map((entry) => boundedHistoricalString(entry, MAX_TASK_EVIDENCE_LENGTH))
      .filter((entry): entry is string => entry !== undefined);
    if (evidence.length) task.evidence = evidence;
    else delete task.evidence;
  } else delete task.evidence;
  const review = migrateHistoricalReview(task.review);
  if (review) task.review = review;
  else delete task.review;
  if (isCanonicalArray(task.waitEvidence, MAX_HISTORICAL_ARRAY_LENGTH)) {
    const waitEvidence = task.waitEvidence
      .slice(0, MAX_WAIT_EVIDENCE_COUNT)
      .map((entry) => migrateHistoricalEvidence(entry))
      .filter((entry): entry is JobWaitEvidence => entry !== undefined);
    if (waitEvidence.length) task.waitEvidence = waitEvidence;
    else delete task.waitEvidence;
  } else delete task.waitEvidence;
  const wait = migrateHistoricalWait(task.wait);
  if (task.status === "waiting:user" || task.status === "waiting:jobs") {
    if (wait && wait.kind === task.status.slice("waiting:".length))
      task.wait = wait;
    else {
      task.status = "pending";
      delete task.wait;
    }
  } else delete task.wait;
  if (task.status === "completed") {
    const hasCompletionEvidence =
      typeof task.result === "string" &&
      Boolean(task.result.trim()) &&
      Array.isArray(task.evidence) &&
      task.evidence.length > 0;
    if (
      !hasCompletionEvidence &&
      !hasActiveTaskOwner(task as unknown as Task)
    ) {
      task.status = "pending";
      delete task.result;
      delete task.evidence;
      delete task.review;
    } else if (hasCompletionEvidence && !task.review) {
      task.review = {
        status: "pending",
        generation: 1,
        token: `legacy-completion-${String(task.id)}`,
        completionRevision: 0,
        requestedAt: 0,
        inputDigest: legacyCompletionReviewInputDigest(
          task as {
            subject: string;
            description?: string;
            result?: string;
            evidence?: string[];
            metadata?: Record<string, unknown>;
          },
        ),
        reviewer: {
          id: COMPLETION_REVIEWER_ID,
          model: COMPLETION_REVIEW_MODEL,
        },
      };
    }
  }
  const persistedTask = task as unknown as Task;
  return {
    ...persistedTask,
    subject: redactTodoText(persistedTask.subject),
    ...(persistedTask.description === undefined
      ? {}
      : { description: redactTodoText(persistedTask.description) }),
    ...(persistedTask.activeForm === undefined
      ? {}
      : { activeForm: redactTodoText(persistedTask.activeForm) }),
    ...(persistedTask.owner === undefined
      ? {}
      : { owner: redactTodoText(persistedTask.owner) }),
    ...(persistedTask.result === undefined
      ? {}
      : { result: redactTodoText(persistedTask.result) }),
    ...(persistedTask.evidence === undefined
      ? {}
      : { evidence: persistedTask.evidence.map(redactTodoText) }),
    ...(persistedTask.metadata === undefined
      ? {}
      : {
          metadata: redactTodoValue(persistedTask.metadata) as Record<
            string,
            unknown
          >,
        }),
    ...(persistedTask.review?.feedback === undefined
      ? {}
      : {
          review: {
            ...persistedTask.review,
            feedback: redactTodoText(persistedTask.review.feedback),
          },
        }),
    ...(persistedTask.wait?.kind === "user"
      ? {
          wait: {
            ...persistedTask.wait,
            questions: persistedTask.wait.questions.map(redactTodoText),
          },
        }
      : {}),
    ...(persistedTask.waitEvidence === undefined
      ? {}
      : {
          waitEvidence: persistedTask.waitEvidence.map((entry) => ({
            ...entry,
            ...(entry.error === undefined
              ? {}
              : { error: redactTodoText(entry.error) }),
          })),
        }),
  };
}

function migrateHistoricalTaskArray(value: unknown): Task[] | undefined {
  if (!isCanonicalArray(value, MAX_PERSISTED_TASKS)) return undefined;
  const tasks: Task[] = [];
  for (const entry of value) {
    const migrated = migrateHistoricalTask(entry);
    if (!migrated) return undefined;
    tasks.push(migrated);
  }
  return tasks;
}

function migrateHistoricalStateCandidateUnsafe(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = canonicalHistoricalRecord(
    value,
    Math.max(SNAPSHOT_KEYS.size, PATCH_KEYS.size),
  );
  if (
    !source ||
    Object.keys(source).some(
      (key) => !SNAPSHOT_KEYS.has(key) && !PATCH_KEYS.has(key),
    )
  )
    return value;
  for (const field of [
    "tasks",
    "upsertedTasks",
    "removedIds",
    "taskOrder",
    "cancellationIntents",
    "cancellationOverflow",
    "cancellationQuarantine",
  ]) {
    if (hasOwn(source, field) && !historicalShapeSafe(source[field]))
      return value;
  }
  if (
    (source.version === TODO_SNAPSHOT_VERSION &&
      !hasExactOwnKeys(source, SNAPSHOT_KEYS, [
        "version",
        "revision",
        "tasks",
        "nextId",
      ])) ||
    (source.version === TODO_PATCH_VERSION &&
      !hasExactOwnKeys(source, PATCH_KEYS, [
        "version",
        "baseRevision",
        "revision",
        "upsertedTasks",
        "removedIds",
        "taskOrder",
        "nextId",
        "orchestrator",
      ]))
  )
    return value;
  const protectedTaskIds = protectedTaskIdsFromRecord(source);
  if (
    (source.cancellationIntents !== undefined ||
      source.cancellationOverflow !== undefined ||
      source.cancellationQuarantine !== undefined) &&
    !protectedTaskIds
  )
    return value;
  if (isCanonicalArray(source.upsertedTasks, MAX_PERSISTED_TASKS)) {
    const upsertedTasks = migrateHistoricalTaskArray(source.upsertedTasks);
    if (!upsertedTasks) return value;
    const migrated = copyHistoricalFields(source, [
      "version",
      "baseRevision",
      "revision",
      "upsertedTasks",
      "removedIds",
      "taskOrder",
      "nextId",
      "orchestrator",
      "cancellationIntents",
      "cancellationOverflow",
      "cancellationQuarantine",
      "cancellationCapacityError",
    ]);
    return {
      ...migrated,
      upsertedTasks,
      ...(isCanonicalArray(source.removedIds, MAX_PERSISTED_TASKS)
        ? { removedIds: source.removedIds }
        : {}),
      ...(isCanonicalArray(source.taskOrder, MAX_PERSISTED_TASKS)
        ? { taskOrder: source.taskOrder }
        : {}),
    };
  }
  if (!Array.isArray(source.tasks)) return value;
  const tasks = migrateHistoricalTaskArray(source.tasks);
  if (!tasks) return value;
  const pruned = pruneHistoricalTasks(tasks, protectedTaskIds ?? new Set());
  if (!pruned) return value;
  return {
    ...copyHistoricalFields(source, [
      "version",
      "revision",
      "tasks",
      "nextId",
      "orchestrator",
      "cancellationIntents",
      "cancellationOverflow",
      "cancellationQuarantine",
      "cancellationCapacityError",
    ]),
    tasks: pruned,
  };
}

function migrateHistoricalStateCandidate(value: unknown): unknown {
  try {
    return migrateHistoricalStateCandidateUnsafe(value);
  } catch {
    return value;
  }
}

/** Reject malformed or graph-invalid historical state instead of poisoning the live store. */
export interface LegacyTaskDetails {
  tasks: Task[];
  nextId: number;
}

/** Structural guard for pre-snapshot tool-result replay only. */
export function isLegacyTaskDetails(
  value: unknown,
  options: { allowTaskOverflow?: boolean } = {},
): value is LegacyTaskDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const details = value as Record<string, unknown>;
  if (
    !isCanonicalArray(
      details.tasks,
      options.allowTaskOverflow ? MAX_PERSISTED_TASKS * 2 : MAX_PERSISTED_TASKS,
    ) ||
    !details.tasks.every(isPersistableTask) ||
    !Number.isSafeInteger(details.nextId)
  )
    return false;
  const tasks = details.tasks as Task[];
  const ids = new Set(tasks.map((task) => task.id));
  const maxId = tasks.reduce((max, task) => Math.max(max, task.id), 0);
  if (ids.size !== tasks.length || (details.nextId as number) <= maxId)
    return false;
  if (
    tasks.some((task) =>
      task.blockedBy?.some((id) => !ids.has(id) || id === task.id),
    )
  )
    return false;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (
    tasks.some(
      (task) =>
        task.mergedInto !== undefined &&
        (task.mergedInto === task.id ||
          !byId.has(task.mergedInto) ||
          byId.get(task.mergedInto)?.mergedInto !== undefined),
    ) ||
    tasks.some((task) => {
      const sourceFailureId = failureSourceId(task);
      if (sourceFailureId === undefined) return false;
      const source = byId.get(sourceFailureId);
      return sourceFailureId === task.id || !source || !isFailureRoot(source);
    })
  )
    return false;
  return !detectCycle(tasks, -1, []);
}

/**
 * The live mutation seams use this exact replay shape before publishing a
 * revision. Keeping the check here prevents reducer, enrichment, and replay
 * from drifting apart.
 */
export function isPersistableTaskState(
  value: unknown,
  options: { allowTaskOverflow?: boolean } = {},
): value is TaskState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (!hasExactOwnKeys(state, TASK_STATE_KEYS, ["tasks", "nextId", "revision"]))
    return false;
  const legacy =
    Number.isSafeInteger(state.revision) &&
    (state.revision as number) >= 0 &&
    isLegacyTaskDetails({ tasks: state.tasks, nextId: state.nextId }, options);
  const orchestratorValid = optionalField(
    state,
    "orchestrator",
    isPersistableOrchestrator,
  );
  const intentsValid = optionalField(
    state,
    "cancellationIntents",
    isCancellationIntentArray,
  );
  const overflowValid = optionalField(
    state,
    "cancellationOverflow",
    isCancellationIntentArray,
  );
  const quarantineValid = optionalField(
    state,
    "cancellationQuarantine",
    isCancellationQuarantineArray,
  );
  const capacityValid = optionalField(
    state,
    "cancellationCapacityError",
    (value) =>
      value === CANCELLATION_CAPACITY_ERROR ||
      value === CANCELLATION_QUARANTINE_ERROR,
  );
  const recoveryValid = isCancellationRecoveryCandidate(
    state.cancellationIntents,
    state.cancellationOverflow,
    state.cancellationQuarantine,
  );
  return (
    legacy &&
    orchestratorValid &&
    intentsValid &&
    overflowValid &&
    quarantineValid &&
    capacityValid &&
    recoveryValid
  );
}

export function isTodoSnapshot(value: unknown): value is TodoSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (
    !hasExactOwnKeys(snapshot, SNAPSHOT_KEYS, [
      "version",
      "revision",
      "tasks",
      "nextId",
    ])
  )
    return false;
  return (
    snapshot.version === TODO_SNAPSHOT_VERSION &&
    Number.isSafeInteger(snapshot.revision) &&
    (snapshot.revision as number) >= 0 &&
    isLegacyTaskDetails({ tasks: snapshot.tasks, nextId: snapshot.nextId }) &&
    optionalField(snapshot, "orchestrator", isPersistableOrchestrator) &&
    optionalField(snapshot, "cancellationIntents", isCancellationIntentArray) &&
    optionalField(
      snapshot,
      "cancellationOverflow",
      isCancellationIntentArray,
    ) &&
    optionalField(
      snapshot,
      "cancellationQuarantine",
      isCancellationQuarantineArray,
    ) &&
    optionalField(
      snapshot,
      "cancellationCapacityError",
      (value) =>
        value === CANCELLATION_CAPACITY_ERROR ||
        value === CANCELLATION_QUARANTINE_ERROR,
    ) &&
    isCancellationRecoveryCandidate(
      snapshot.cancellationIntents,
      snapshot.cancellationOverflow,
      snapshot.cancellationQuarantine,
    )
  );
}

export function isTodoPatch(value: unknown): value is TodoPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const patch = value as Record<string, unknown>;
  if (
    !hasExactOwnKeys(patch, PATCH_KEYS, [
      "version",
      "baseRevision",
      "revision",
      "upsertedTasks",
      "removedIds",
      "taskOrder",
      "nextId",
      "orchestrator",
    ])
  )
    return false;
  return (
    patch.version === TODO_PATCH_VERSION &&
    Number.isSafeInteger(patch.baseRevision) &&
    Number.isSafeInteger(patch.revision) &&
    (patch.baseRevision as number) >= 0 &&
    (patch.revision as number) > (patch.baseRevision as number) &&
    isCanonicalArray(patch.upsertedTasks, MAX_PERSISTED_TASKS) &&
    patch.upsertedTasks.every(isPersistableTask) &&
    new Set((patch.upsertedTasks as Task[]).map((task) => task.id)).size ===
      patch.upsertedTasks.length &&
    isCanonicalArray(patch.removedIds, MAX_PERSISTED_TASKS) &&
    patch.removedIds.every(
      (id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0,
    ) &&
    new Set(patch.removedIds).size === patch.removedIds.length &&
    isCanonicalArray(patch.taskOrder, MAX_PERSISTED_TASKS) &&
    patch.taskOrder.every(
      (id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0,
    ) &&
    new Set(patch.taskOrder).size === patch.taskOrder.length &&
    Number.isSafeInteger(patch.nextId) &&
    (patch.orchestrator === null ||
      isPersistableOrchestrator(patch.orchestrator)) &&
    optionalField(patch, "cancellationIntents", isCancellationIntentArray) &&
    optionalField(patch, "cancellationOverflow", isCancellationIntentArray) &&
    optionalField(
      patch,
      "cancellationQuarantine",
      isCancellationQuarantineArray,
    ) &&
    optionalField(
      patch,
      "cancellationCapacityError",
      (value) =>
        value === null ||
        value === CANCELLATION_CAPACITY_ERROR ||
        value === CANCELLATION_QUARANTINE_ERROR,
    ) &&
    isCancellationRecoveryCandidate(
      patch.cancellationIntents,
      patch.cancellationOverflow,
      patch.cancellationQuarantine,
    )
  );
}

function cloneTasks(tasks: readonly Task[]): Task[] {
  return tasks.map((task) => {
    const copy: Task = { ...task };
    if (task.blockedBy !== undefined) copy.blockedBy = [...task.blockedBy];
    if (task.metadata !== undefined) copy.metadata = { ...task.metadata };
    if (task.wait?.kind === "user")
      copy.wait = { kind: "user", questions: [...task.wait.questions] };
    else if (task.wait?.kind === "jobs")
      copy.wait = {
        ...task.wait,
        jobIds: [...task.wait.jobIds],
        settled: { ...task.wait.settled },
      };
    if (task.waitEvidence !== undefined)
      copy.waitEvidence = task.waitEvidence.map((evidence) => ({
        ...evidence,
      }));
    return copy;
  });
}

function cloneCancellationIntents(
  intents: readonly TodoCancellationIntent[] | undefined,
): TodoCancellationIntent[] | undefined {
  return intents?.map((intent) => reconstructCancellationIntent(intent));
}

function reconstructCancellationIntent(
  intent: TodoCancellationIntent,
): TodoCancellationIntent {
  return normalizeCancellationIntent({
    kind: intent.kind,
    taskId: intent.taskId,
    token: intent.token,
    ids: [...intent.ids],
    generation: intent.generation,
    attempts: intent.attempts,
    ...(intent.correlationId === undefined
      ? {}
      : { correlationId: intent.correlationId }),
    ...(intent.workerGeneration === undefined
      ? {}
      : { workerGeneration: intent.workerGeneration }),
    ...(intent.error === undefined ? {} : { error: intent.error }),
    ...(intent.orphaned === undefined ? {} : { orphaned: intent.orphaned }),
    ...(intent.rearmed === undefined ? {} : { rearmed: intent.rearmed }),
  });
}

export function createTodoSnapshot(state: TaskState): TodoSnapshot {
  if (!isPersistableTaskState(state, { allowTaskOverflow: true }))
    throw new Error("TODO snapshot contains a non-canonical state");
  const bounded = pruneTodoStateForPersistence(state);
  if (!bounded) throw new Error("TODO snapshot exceeds the bounded task limit");
  return {
    version: TODO_SNAPSHOT_VERSION,
    revision: bounded.revision,
    tasks: cloneTasks(bounded.tasks),
    nextId: bounded.nextId,
    ...(bounded.orchestrator
      ? { orchestrator: { ...bounded.orchestrator } }
      : {}),
    ...(bounded.cancellationIntents?.length
      ? {
          cancellationIntents: cloneCancellationIntents(
            bounded.cancellationIntents,
          ),
        }
      : {}),
    ...(bounded.cancellationOverflow?.length
      ? {
          cancellationOverflow: cloneCancellationIntents(
            bounded.cancellationOverflow,
          ),
        }
      : {}),
    ...(bounded.cancellationQuarantine?.length
      ? {
          cancellationQuarantine: cloneCancellationIntents(
            bounded.cancellationQuarantine,
          ),
        }
      : {}),
    ...(bounded.cancellationCapacityError
      ? { cancellationCapacityError: bounded.cancellationCapacityError }
      : {}),
  };
}

export function createTodoPatch(
  previous: TaskState,
  next: TaskState,
): TodoPatch {
  if (
    !isPersistableTaskState(previous, { allowTaskOverflow: true }) ||
    !isPersistableTaskState(next, { allowTaskOverflow: true })
  )
    throw new Error("TODO patch contains a non-canonical state");
  const boundedPrevious = pruneTodoStateForPersistence(previous);
  const boundedNext = pruneTodoStateForPersistence(next);
  if (!boundedPrevious || !boundedNext)
    throw new Error("TODO patch exceeds the bounded task limit");
  previous = boundedPrevious;
  next = boundedNext;
  const previousTasks = new Map(previous.tasks.map((task) => [task.id, task]));
  const nextIds = new Set(next.tasks.map((task) => task.id));
  return {
    version: TODO_PATCH_VERSION,
    baseRevision: previous.revision,
    revision: next.revision,
    upsertedTasks: cloneTasks(
      next.tasks.filter(
        (task) => !isDeepStrictEqual(previousTasks.get(task.id), task),
      ),
    ),
    removedIds: previous.tasks
      .filter((task) => !nextIds.has(task.id))
      .map((task) => task.id),
    taskOrder: next.tasks.map((task) => task.id),
    nextId: next.nextId,
    orchestrator: next.orchestrator ? { ...next.orchestrator } : null,
    cancellationIntents:
      cloneCancellationIntents(next.cancellationIntents) ?? [],
    ...(next.cancellationOverflow?.length
      ? {
          cancellationOverflow: cloneCancellationIntents(
            next.cancellationOverflow,
          ),
        }
      : previous.cancellationOverflow?.length
        ? { cancellationOverflow: [] }
        : {}),
    ...(next.cancellationQuarantine?.length
      ? {
          cancellationQuarantine: cloneCancellationIntents(
            next.cancellationQuarantine,
          ),
        }
      : previous.cancellationQuarantine?.length
        ? { cancellationQuarantine: [] }
        : {}),
    ...(next.cancellationCapacityError
      ? { cancellationCapacityError: next.cancellationCapacityError }
      : previous.cancellationCapacityError
        ? { cancellationCapacityError: null }
        : {}),
  };
}

function propagateReplayPrerequisiteFailures(state: TaskState): TaskState {
  const tasks = propagatePrerequisiteFailure(state.tasks);
  return tasks.some((task, index) => task !== state.tasks[index])
    ? { ...state, tasks, revision: state.revision + 1 }
    : state;
}

function historicalPropagationRevision(state: TaskState): TaskState {
  const propagated = propagateReplayPrerequisiteFailures(state);
  if (propagated.revision !== state.revision) return propagated;
  const hasPersistedFailure = state.tasks.some((task) => {
    const inbox = task.metadata?.inbox as
      | { lifecycle?: unknown; reason?: unknown; sourceFailureId?: unknown }
      | undefined;
    return (
      inbox?.lifecycle === "failed" &&
      inbox.reason === "failed prerequisite" &&
      Number.isSafeInteger(inbox.sourceFailureId)
    );
  });
  return hasPersistedFailure
    ? { ...state, revision: state.revision + 1 }
    : state;
}

/** Restore the latest valid todo snapshot from the current conversation branch. */
export function replayFromBranch(ctx: {
  sessionManager: { getBranch(): Iterable<unknown> };
}): TaskState {
  let result: TaskState = {
    tasks: [...EMPTY_STATE.tasks],
    nextId: EMPTY_STATE.nextId,
    revision: EMPTY_STATE.revision,
  };
  let sawVersionedSnapshot = false;
  for (const entry of ctx.sessionManager.getBranch()) {
    const e = entry as {
      type?: string;
      customType?: string;
      data?: unknown;
      message?: { role?: string; toolName?: string; details?: unknown };
    };
    if (e.type === "custom" && e.customType === TODO_SNAPSHOT_TYPE) {
      const migratedData = migrateHistoricalStateCandidate(e.data);
      if (isTodoSnapshot(migratedData)) {
        sawVersionedSnapshot = true;
        if (migratedData.revision >= result.revision) {
          result = {
            tasks: cloneTasks(migratedData.tasks),
            nextId: migratedData.nextId,
            revision: migratedData.revision,
            ...(migratedData.orchestrator
              ? { orchestrator: { ...migratedData.orchestrator } }
              : {}),
            ...(migratedData.cancellationIntents?.length
              ? {
                  cancellationIntents: cloneCancellationIntents(
                    migratedData.cancellationIntents,
                  ),
                }
              : {}),
            ...(migratedData.cancellationOverflow?.length
              ? {
                  cancellationOverflow: cloneCancellationIntents(
                    migratedData.cancellationOverflow,
                  ),
                }
              : {}),
            ...(migratedData.cancellationQuarantine?.length
              ? {
                  cancellationQuarantine: cloneCancellationIntents(
                    migratedData.cancellationQuarantine,
                  ),
                }
              : {}),
            ...(migratedData.cancellationCapacityError
              ? {
                  cancellationCapacityError:
                    migratedData.cancellationCapacityError,
                }
              : {}),
          };
        }
        continue;
      }
      if (isTodoPatch(migratedData)) {
        const bridgesHistoricalPropagation =
          migratedData.baseRevision === result.revision + 1 &&
          migratedData.revision === migratedData.baseRevision + 1;
        const patchBase = bridgesHistoricalPropagation
          ? historicalPropagationRevision(result)
          : result;
        if (migratedData.baseRevision !== patchBase.revision) continue;
        const removed = new Set(migratedData.removedIds);
        const available = new Map(
          patchBase.tasks
            .filter((task) => !removed.has(task.id))
            .map((task) => [task.id, task]),
        );
        for (const task of cloneTasks(migratedData.upsertedTasks))
          available.set(task.id, task);
        if (
          available.size !== migratedData.taskOrder.length ||
          migratedData.taskOrder.some((id) => !available.has(id))
        )
          continue;
        const tasks = migratedData.taskOrder.map((id) => available.get(id)!);
        const candidate = {
          tasks,
          nextId: migratedData.nextId,
          revision: migratedData.revision,
          ...(migratedData.orchestrator
            ? { orchestrator: { ...migratedData.orchestrator } }
            : {}),
          ...(migratedData.cancellationIntents !== undefined ||
          patchBase.cancellationIntents !== undefined
            ? {
                cancellationIntents: cloneCancellationIntents(
                  migratedData.cancellationIntents ??
                    patchBase.cancellationIntents,
                ),
              }
            : {}),
          ...(migratedData.cancellationOverflow !== undefined ||
          patchBase.cancellationOverflow !== undefined
            ? {
                cancellationOverflow: cloneCancellationIntents(
                  migratedData.cancellationOverflow ??
                    patchBase.cancellationOverflow,
                ),
              }
            : {}),
          ...(migratedData.cancellationQuarantine !== undefined ||
          patchBase.cancellationQuarantine !== undefined
            ? {
                cancellationQuarantine: cloneCancellationIntents(
                  migratedData.cancellationQuarantine ??
                    patchBase.cancellationQuarantine,
                ),
              }
            : {}),
          ...(migratedData.cancellationCapacityError === null
            ? {}
            : migratedData.cancellationCapacityError !== undefined ||
                patchBase.cancellationCapacityError !== undefined
              ? {
                  cancellationCapacityError:
                    migratedData.cancellationCapacityError ??
                    patchBase.cancellationCapacityError,
                }
              : {}),
        };
        if (
          isPersistableTaskState(candidate) &&
          isCancellationRecoveryCandidate(
            candidate.cancellationIntents,
            candidate.cancellationOverflow,
            candidate.cancellationQuarantine,
          )
        ) {
          result = candidate;
          sawVersionedSnapshot = true;
        }
        continue;
      }
    }
    const message = e.type === "message" ? e.message : undefined;
    const migratedLegacyDetails =
      message?.role === "toolResult" && message.toolName === "todo"
        ? migrateHistoricalStateCandidate(message.details)
        : undefined;
    if (sawVersionedSnapshot || !isLegacyTaskDetails(migratedLegacyDetails))
      continue;
    const tasks = cloneTasks(migratedLegacyDetails.tasks);
    const changed =
      JSON.stringify([result.tasks, result.nextId]) !==
      JSON.stringify([tasks, migratedLegacyDetails.nextId]);
    result = {
      tasks,
      nextId: migratedLegacyDetails.nextId,
      revision: changed ? result.revision + 1 : result.revision,
    };
  }
  return propagateReplayPrerequisiteFailures(result);
}
