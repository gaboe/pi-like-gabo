import {
  isBoundedMetadata,
  MAX_TASK_EVIDENCE_COUNT,
  MAX_TASK_EVIDENCE_LENGTH,
  MAX_TASK_RESULT_LENGTH,
  type Task,
} from "../tool/types.js";
import { getState, replaceState } from "./store.js";

export const PUBLIC_TODO_STATES = [
  "preparing",
  "ready",
  "in_progress",
  "waiting",
  "verifying",
  "completed",
  "failed",
] as const;

export type PublicTodoState = (typeof PUBLIC_TODO_STATES)[number];
export type ExecutionOwner = "parent" | "package-worker";

export const MAX_VERIFICATION_EXCHANGES = 3;

const PREPARATION_STATES = new Set([
  "classifying",
  "queued",
  "running",
  "insufficient",
  "not_needed",
  "awaiting_approval",
]);
const MAX_TEXT = 1_000;

type RecordValue = Record<string, unknown>;

export interface VerificationExchange {
  decision: "needs-fix" | "approved";
  finding: string;
  evidence: string[];
  rationale: string;
}

interface VerificationMetadata {
  exchanges?: VerificationExchange[];
  state?: "active" | "approved" | "failed" | "recovering";
  failure?: string;
  recovery?: "automatic" | "manual";
  retryPolicy?: string;
  challenge?: {
    decision: string;
    evidence: string[];
    rationale: string;
    priorUserMessage?: { id: string; content: string };
  };
  prompt?: string;
}

/** The adapter exposes the existing live store; it does not create a store. */
export const authoritativeTodoStore = { getState, replaceState } as const;

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function preparationOf(task: Task): RecordValue | undefined {
  return record(task.metadata?.preparation);
}

function verificationOf(task: Task): VerificationMetadata | undefined {
  return record(task.metadata?.verification) as
    VerificationMetadata | undefined;
}

function inboxOf(task: Task): RecordValue | undefined {
  return record(task.metadata?.inbox);
}

function hasFailedLifecycle(task: Task): boolean {
  const preparation = preparationOf(task);
  const verification = verificationOf(task);
  return (
    String(task.status) === "failed" ||
    inboxOf(task)?.lifecycle === "failed" ||
    preparation?.status === "failed" ||
    verification?.state === "failed"
  );
}

function hasSemanticFailure(task: Task): boolean {
  const inbox = inboxOf(task);
  return (
    String(task.status) === "failed" ||
    (inbox?.lifecycle === "failed" && inbox.reason !== "failed prerequisite") ||
    verificationOf(task)?.state === "failed"
  );
}

/** Derive the only public lifecycle from the existing persisted task shape. */
export function publicTodoState(task: Task): PublicTodoState {
  if (task.status === "completed") {
    if (task.review?.status === "pending") return "verifying";
    // An explicit inbox failure is a lifecycle invalidation; technical
    // preparation/review residue cannot reopen a genuinely completed task.
    return inboxOf(task)?.lifecycle === "failed" ? "failed" : "completed";
  }
  if (hasFailedLifecycle(task)) return "failed";

  const verification = verificationOf(task);
  if (verification?.recovery === "automatic" && task.status === "in_progress")
    return "in_progress";
  if (task.status === "waiting:user" || task.status === "waiting:jobs")
    return "waiting";
  if (task.review?.status === "pending") return "verifying";

  const preparation = preparationOf(task);
  if (PREPARATION_STATES.has(String(preparation?.status))) return "preparing";
  if (task.status === "in_progress") return "in_progress";
  if (
    task.status === "pending" &&
    (preparation === undefined ||
      ["ready", "cancelled", "failed"].includes(String(preparation.status)))
  )
    return "ready";
  return "failed";
}

function dependencyIds(task: Task): number[] {
  if (!Array.isArray(task.blockedBy)) return [];
  return task.blockedBy.filter(
    (id): id is number => Number.isSafeInteger(id) && id > 0,
  );
}

function dependenciesReady(
  task: Task,
  byId: ReadonlyMap<number, Task>,
): boolean {
  return dependencyIds(task).every((id) => {
    const dependency = byId.get(id);
    return (
      dependency !== undefined && publicTodoState(dependency) === "completed"
    );
  });
}

function validCandidateOrder(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || !value.every(Number.isSafeInteger))
    return undefined;
  const ids = value as number[];
  return new Set(ids).size === ids.length ? ids : undefined;
}

/** Return safe ready tasks, applying only a validated explicit ID order. */
export function selectReadyTasks(
  tasks: readonly Task[],
  options: { orderedCandidateIds?: readonly number[] } = {},
): Task[] {
  const byId = new Map<number, Task>();
  for (const task of tasks) {
    if (task && Number.isSafeInteger(task.id) && !byId.has(task.id))
      byId.set(task.id, task);
  }
  const ready = tasks.filter(
    (task) =>
      task &&
      task.mergedInto === undefined &&
      publicTodoState(task) === "ready" &&
      dependenciesReady(task, byId),
  );
  const order = validCandidateOrder(options.orderedCandidateIds);
  if (!order) return [...ready];
  const positions = new Map(order.map((id, index) => [id, index]));
  return ready
    .map((task, index) => ({ task, index }))
    .sort(
      (left, right) =>
        (positions.get(left.task.id) ?? order.length + left.index) -
        (positions.get(right.task.id) ?? order.length + right.index),
    )
    .map(({ task }) => task);
}

export interface ExecutionOwnershipFacts {
  task: Task;
  explicitOwner?: ExecutionOwner;
}

/** Map existing classifier/delegation facts to the two existing owner paths. */
export function chooseExecutionOwner({
  task,
  explicitOwner,
}: ExecutionOwnershipFacts): ExecutionOwner {
  if (explicitOwner === "parent" || explicitOwner === "package-worker")
    return explicitOwner;
  const delegation = record(task.metadata?.delegation);
  if (
    ["running", "interrupted", "cancelling"].includes(
      String(delegation?.status),
    )
  )
    return "package-worker";
  return "parent";
}

function boundedText(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_TEXT) : "";
}

function boundedEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().slice(0, MAX_TEXT))
    .filter(Boolean)
    .slice(0, 8);
}

function verificationExchanges(task: Task): VerificationExchange[] {
  const exchanges = verificationOf(task)?.exchanges;
  if (!Array.isArray(exchanges)) return [];
  return exchanges
    .slice(0, MAX_VERIFICATION_EXCHANGES)
    .filter(
      (exchange): exchange is VerificationExchange =>
        record(exchange) !== undefined &&
        (exchange.decision === "needs-fix" ||
          exchange.decision === "approved") &&
        typeof exchange.finding === "string" &&
        Array.isArray(exchange.evidence) &&
        typeof exchange.rationale === "string",
    );
}

function withVerification(
  task: Task,
  verification: VerificationMetadata,
): Task {
  const metadata = {
    ...(task.metadata ?? {}),
    verification,
  };
  if (!isBoundedMetadata(metadata)) return task;
  return {
    ...task,
    metadata,
  };
}

/** Persist one bounded verifier correction exchange on the existing Task. */
export function recordVerificationExchange(
  task: Task,
  exchange: Partial<VerificationExchange>,
): Task {
  const decision = exchange.decision;
  const finding = boundedText(exchange.finding);
  const evidence = boundedEvidence(exchange.evidence);
  const rationale = boundedText(exchange.rationale);
  if (
    (decision !== "needs-fix" && decision !== "approved") ||
    !finding ||
    !evidence.length ||
    !rationale
  )
    return task;

  const prior = verificationOf(task) ?? {};
  const exchanges = verificationExchanges(task);
  if (prior.state === "approved" || prior.state === "failed") return task;
  const unresolved = exchanges.filter(
    (entry) => entry.decision === "needs-fix",
  ).length;
  if (unresolved >= MAX_VERIFICATION_EXCHANGES) {
    return withVerification(task, {
      ...prior,
      exchanges,
      state: "failed",
      failure: "verification correction limit exhausted",
    });
  }
  if (exchanges.length >= MAX_VERIFICATION_EXCHANGES) return task;

  const nextExchanges = [
    ...exchanges,
    { decision, finding, evidence, rationale },
  ];
  const nextUnresolved = unresolved + (decision === "needs-fix" ? 1 : 0);
  return withVerification(task, {
    ...prior,
    exchanges: nextExchanges,
    ...(decision === "approved"
      ? { state: "approved" as const }
      : nextUnresolved >= MAX_VERIFICATION_EXCHANGES
        ? {
            state: "failed" as const,
            failure: "verification correction limit exhausted",
          }
        : { state: "active" as const }),
  });
}

/** Persist a parent challenge without deleting the original verifier finding. */
export function challengeVerificationFinding(
  task: Task,
  challenge: {
    decision: string;
    evidence?: unknown;
    rationale?: unknown;
    priorUserMessage?: unknown;
  },
  verifiedUserMessages: ReadonlyMap<string, string> = new Map(),
): Task {
  const exchanges = verificationExchanges(task);
  const latest = exchanges.at(-1);
  const prior = verificationOf(task) ?? {};
  const evidence = boundedEvidence(challenge.evidence);
  const rationale = boundedText(challenge.rationale);
  const rawMessage =
    challenge.priorUserMessage &&
    typeof challenge.priorUserMessage === "object" &&
    !Array.isArray(challenge.priorUserMessage)
      ? (challenge.priorUserMessage as Record<string, unknown>)
      : undefined;
  const messageId = boundedText(rawMessage?.id);
  const messageContent = boundedText(rawMessage?.content);
  const priorUserMessage =
    messageId &&
    messageContent &&
    verifiedUserMessages.get(messageId) === messageContent
      ? { id: messageId, content: messageContent }
      : undefined;
  if (
    !latest ||
    latest.decision !== "needs-fix" ||
    prior.state === "approved" ||
    prior.state === "failed" ||
    (challenge.decision !== "challenge" && challenge.decision !== "skip") ||
    (!evidence.length && !priorUserMessage) ||
    !rationale
  )
    return task;
  return withVerification(task, {
    ...prior,
    exchanges,
    challenge: {
      decision: boundedText(challenge.decision),
      evidence,
      rationale,
      ...(priorUserMessage ? { priorUserMessage } : {}),
    },
  });
}

export function recoverInternalVerificationFailure(
  task: Task,
  failure: string,
): Task {
  if (task.status === "completed" || task.status === "deleted") return task;
  const metadata = withVerification(task, {
    ...(verificationOf(task) ?? {}),
    state: "failed",
    recovery: "manual",
    failure: boundedText(failure),
    retryPolicy:
      "Automatic completion-review retries exhausted; explicitly recomplete with changed evidence after remediation.",
  });
  if (metadata === task) return task;
  const recovered = { ...metadata, status: "in_progress" as const };
  delete recovered.wait;
  return recovered;
}

export interface MergeOverlapDecision {
  basis: "same-subject" | "shared-request-scope";
  sharedSubjectTerms: string[];
  sharedScopeTerms: string[];
  sharedPaths: string[];
}

const MERGE_STOP_WORDS = new Set([
  "add",
  "and",
  "code",
  "continue",
  "current",
  "fix",
  "implement",
  "prepare",
  "task",
  "the",
  "todo",
  "update",
]);

function overlapTerms(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .normalize("NFKD")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((term) => term.length >= 3 && !MERGE_STOP_WORDS.has(term)) ?? [],
  );
}

function sharedValues(left: Set<string>, right: Set<string>): string[] {
  return [...left]
    .filter((value) => right.has(value))
    .sort()
    .slice(0, 12);
}

function affectedPaths(task: Task): Set<string> {
  const paths = preparationOf(task)?.affectedPaths;
  return new Set(
    Array.isArray(paths)
      ? paths
          .filter((path): path is string => typeof path === "string")
          .map((path) => path.trim())
          .filter(Boolean)
      : [],
  );
}

export function materialOverlapDecision(
  owner: Task,
  duplicate: Task,
): MergeOverlapDecision | undefined {
  const normalizedOwnerSubject = owner.subject.trim().toLowerCase();
  const normalizedDuplicateSubject = duplicate.subject.trim().toLowerCase();
  const ownerSubject = overlapTerms(owner.subject);
  const duplicateSubject = overlapTerms(duplicate.subject);
  const sharedSubjectTerms = sharedValues(ownerSubject, duplicateSubject);
  const sharedScopeTerms = sharedValues(
    overlapTerms(owner.description),
    overlapTerms(duplicate.description),
  );
  const sharedPaths = sharedValues(
    affectedPaths(owner),
    affectedPaths(duplicate),
  );
  if (
    normalizedOwnerSubject.length >= 4 &&
    normalizedOwnerSubject === normalizedDuplicateSubject &&
    (sharedScopeTerms.length >= 2 || sharedPaths.length > 0)
  )
    return {
      basis: "same-subject",
      sharedSubjectTerms,
      sharedScopeTerms,
      sharedPaths,
    };
  const minimumSubjectSize = Math.min(ownerSubject.size, duplicateSubject.size);
  const materialSubjectOverlap =
    sharedSubjectTerms.length >= 2 &&
    minimumSubjectSize > 0 &&
    sharedSubjectTerms.length / minimumSubjectSize >= 0.5;
  if (
    materialSubjectOverlap &&
    (sharedScopeTerms.length >= 2 || sharedPaths.length > 0)
  )
    return {
      basis: "shared-request-scope",
      sharedSubjectTerms,
      sharedScopeTerms,
      sharedPaths,
    };
  return undefined;
}

export function mergeDuplicateItems(
  items: readonly Task[],
  executionOwnerId: number,
  duplicateId: number,
  shared?: { result: string; evidence: readonly string[] },
  decision?: MergeOverlapDecision,
): { items: Task[]; executionOwnerId: number } {
  if (
    executionOwnerId === duplicateId ||
    !Number.isSafeInteger(executionOwnerId) ||
    !Number.isSafeInteger(duplicateId) ||
    !items.some((item) => item.id === executionOwnerId) ||
    !items.some((item) => item.id === duplicateId)
  )
    return { items: [...items], executionOwnerId };
  const result = shared?.result.trim().slice(0, MAX_TASK_RESULT_LENGTH);
  const evidence = shared?.evidence
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().slice(0, MAX_TASK_EVIDENCE_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_TASK_EVIDENCE_COUNT);
  if (shared && (!result || !evidence?.length))
    return { items: [...items], executionOwnerId };
  return {
    executionOwnerId,
    items: items.map((item) => {
      if (item.id !== executionOwnerId && item.id !== duplicateId) return item;
      const duplicateMetadata =
        item.id === duplicateId && decision
          ? {
              ...(item.metadata ?? {}),
              inbox: {
                ...(inboxOf(item) ?? {}),
                mergeDecision: {
                  executionOwnerId,
                  duplicateId,
                  ...decision,
                },
              },
            }
          : undefined;
      return {
        ...item,
        ...(result && evidence ? { result, evidence: [...evidence] } : {}),
        ...(item.id === duplicateId ? { mergedInto: executionOwnerId } : {}),
        ...(duplicateMetadata ? { metadata: duplicateMetadata } : {}),
      };
    }),
  };
}

function markFailed(task: Task, sourceFailureId: number): Task {
  const inbox = inboxOf(task);
  if (
    inbox?.lifecycle === "failed" &&
    inbox.reason === "failed prerequisite" &&
    inbox.sourceFailureId === sourceFailureId
  )
    return task;
  const metadata = {
    ...(task.metadata ?? {}),
    inbox: {
      ...(inbox ?? {}),
      lifecycle: "failed",
      reason: "failed prerequisite",
      sourceFailureId,
    },
  };
  if (!isBoundedMetadata(metadata)) return task;
  return {
    ...task,
    metadata,
  };
}

/** Propagate failure iteratively, so deep and cyclic malformed graphs are safe. */
export function propagatePrerequisiteFailure(tasks: readonly Task[]): Task[] {
  const dependents = new Map<number, number[]>();
  const failed = new Set<number>();
  for (const task of tasks) {
    if (!task || !Number.isSafeInteger(task.id)) continue;
    if (hasSemanticFailure(task)) failed.add(task.id);
    for (const dependency of dependencyIds(task)) {
      const owners = dependents.get(dependency) ?? [];
      if (!owners.includes(task.id)) owners.push(task.id);
      dependents.set(dependency, owners);
    }
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const retainedSource = (task: Task): number | undefined => {
    const sourceFailureId = inboxOf(task)?.sourceFailureId;
    if (!Number.isSafeInteger(sourceFailureId) || sourceFailureId === task.id)
      return undefined;
    const source = byId.get(sourceFailureId as number);
    return source &&
      hasSemanticFailure(source) &&
      inboxOf(source)?.sourceFailureId === undefined
      ? (sourceFailureId as number)
      : undefined;
  };
  const sourceByTask = new Map<number, number>();
  for (const task of tasks) {
    const sourceFailureId = retainedSource(task);
    if (sourceFailureId !== undefined)
      sourceByTask.set(task.id, sourceFailureId);
  }
  const failedRoots = tasks
    .filter(
      (task) =>
        task &&
        failed.has(task.id) &&
        retainedSource(task) === undefined &&
        !dependencyIds(task).some((dependency) => failed.has(dependency)),
    )
    .map((task) => task.id)
    .sort((left, right) => left - right);
  const roots =
    failedRoots.length > 0
      ? failedRoots
      : [...failed]
          .filter((id) => !sourceByTask.has(id))
          .sort((left, right) => left - right);
  for (const sourceFailureId of roots) {
    const queue = [sourceFailureId];
    const visited = new Set(queue);
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      const currentSource = sourceByTask.get(current) ?? sourceFailureId;
      for (const dependent of dependents.get(current) ?? []) {
        if (!sourceByTask.has(dependent))
          sourceByTask.set(dependent, currentSource);
        if (visited.has(dependent)) continue;
        visited.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return tasks.map((task) => {
    if (!task) return task;
    const sourceFailureId = sourceByTask.get(task.id);
    if (sourceFailureId !== undefined) return markFailed(task, sourceFailureId);
    const inbox = inboxOf(task);
    if (inbox?.reason !== "failed prerequisite") return task;
    const {
      lifecycle: _lifecycle,
      reason: _reason,
      sourceFailureId: _source,
      ...rest
    } = inbox;
    const metadata = { ...(task.metadata ?? {}) };
    if (Object.keys(rest).length) metadata.inbox = rest;
    else delete metadata.inbox;
    const recovered = { ...task };
    if (Object.keys(metadata).length) recovered.metadata = metadata;
    else delete recovered.metadata;
    return recovered;
  });
}
