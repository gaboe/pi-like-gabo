import type { TaskState } from "../state/state.js";
import type { Op } from "../state/state-reducer.js";
import { deriveBlocks } from "../state/task-graph.js";
import { formatPreparationProgress } from "../view/format.js";
import { publicTodoState } from "../state/inbox.js";
import {
  isTodoReviewTargetIdentity,
  todoReviewTargetIdentityBinding,
  validateTodoReviewTarget,
} from "../enrichment.js";
import { isBoundedMetadata } from "./types.js";
import type {
  Task,
  TaskAction,
  TaskDetails,
  TaskMutationParams,
} from "./types.js";

/**
 * Format a single task as a `[status] #id subject [(activeForm)] [⛓ #dep,…]`
 * line. Used by the `list` content branch only — the overlay and `/todos`
 * formatting paths use `view/format.ts` for richer presentations.
 */
function rendererParams(params: TaskMutationParams): TaskDetails["params"] {
  return {
    ...(params.id === undefined ? {} : { id: params.id }),
    ...(params.duplicateId === undefined
      ? {}
      : { duplicateId: params.duplicateId }),
    ...(params.decision === undefined ? {} : { decision: params.decision }),
    ...(params.challengeEvidence?.length
      ? { challengeEvidence: [...params.challengeEvidence] }
      : {}),
    ...(params.rationale === undefined ? {} : { rationale: params.rationale }),
    ...(params.status === undefined ? {} : { status: params.status }),
    ...(params.addBlockedBy?.length
      ? { addBlockedBy: [...params.addBlockedBy] }
      : {}),
    ...(params.removeBlockedBy?.length
      ? { removeBlockedBy: [...params.removeBlockedBy] }
      : {}),
  };
}

function formatListLine(t: Task): string {
  const block = t.blockedBy?.length
    ? ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`
    : "";
  const preparation = formatPreparationProgress(t);
  const merged =
    t.mergedInto === undefined ? "" : ` → merged into #${t.mergedInto}`;
  const form =
    t.status === "in_progress" && t.activeForm
      ? ` (${t.activeForm})`
      : preparation
        ? ` (${preparation})`
        : "";
  return `[${publicTodoState(t)}] #${t.id} ${t.subject}${form}${block}${merged}`;
}

/**
 * Multi-line presentation for the `get` action. Order of rows is pinned by
 * pre-refactor `todo.ts:354-376` — description, activeForm, blockedBy, blocks,
 * owner — so envelope-level snapshot tests stay byte-equivalent.
 */
function packageAssignmentHandshake(task: Task): string[] | undefined {
  const preparation = task.metadata?.preparation;
  if (!isBoundedMetadata(preparation)) return undefined;
  const capability = preparation.hostAssignment;
  if (!isBoundedMetadata(capability)) return undefined;
  if (
    preparation.status !== "ready" ||
    typeof preparation.token !== "string" ||
    capability.source !== "host" ||
    capability.version !== 1 ||
    capability.token !== preparation.token ||
    typeof capability.targetBinding !== "string"
  )
    return undefined;
  const target = preparation.reviewTarget;
  const identity =
    target && isBoundedMetadata(target) && target.status === "selected"
      ? target.identity
      : preparation.analysisCwdIdentity;
  const cwd =
    target && isBoundedMetadata(target) && target.status === "selected"
      ? target.path
      : preparation.analysisCwd;
  if (
    typeof cwd !== "string" ||
    !isTodoReviewTargetIdentity(identity) ||
    validateTodoReviewTarget(cwd, identity) !== cwd ||
    todoReviewTargetIdentityBinding(identity) !== capability.targetBinding
  )
    return undefined;
  return [
    `  todo_id: ${task.id}`,
    `  todo_token: ${preparation.token}`,
    `  targetBinding: ${capability.targetBinding}`,
  ];
}

function formatGetLines(task: Task, state: TaskState): string {
  const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
  const lines = [`#${task.id} [${publicTodoState(task)}] ${task.subject}`];
  if (task.description) lines.push(`  description: ${task.description}`);
  if (task.activeForm) lines.push(`  activeForm: ${task.activeForm}`);
  if (task.blockedBy?.length) {
    lines.push(
      `  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`,
    );
  }
  if (blocks.length) {
    lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
  }
  if (task.mergedInto !== undefined)
    lines.push(`  merged into: #${task.mergedInto}`);
  if (task.owner) lines.push(`  owner: ${task.owner}`);
  const inbox = task.metadata?.inbox as Record<string, unknown> | undefined;
  if (
    inbox?.reason === "failed prerequisite" &&
    Number.isSafeInteger(inbox.sourceFailureId)
  )
    lines.push(
      `  failure: failed prerequisite #${String(inbox.sourceFailureId)}`,
    );
  if (task.result) lines.push(`  result: ${task.result}`);
  for (const evidence of task.evidence ?? [])
    lines.push(`  completionEvidence: ${evidence}`);
  if (task.review) {
    lines.push(`  review: ${task.review.status}`);
    lines.push(
      `  reviewer: ${task.review.reviewer.id} (${task.review.reviewer.model})`,
    );
    if (task.review.feedback)
      lines.push(`  reviewFeedback: ${task.review.feedback}`);
    if (task.review.failedAt !== undefined) {
      lines.push(
        `  reviewFailure: ${new Date(task.review.failedAt).toISOString()}`,
      );
    }
  }
  const orchestrator = task.metadata?.orchestrator as
    Record<string, unknown> | undefined;
  if (orchestrator?.mode && orchestrator.mode !== "direct")
    lines.push(`  orchestrator: ${String(orchestrator.mode)}`);
  const classifier = task.metadata?.classifier as
    Record<string, unknown> | undefined;
  if (classifier?.status === "fallback" || orchestrator?.fallback)
    lines.push("  classifier: fallback (structural)");
  const delegation = task.metadata?.delegation as
    Record<string, unknown> | undefined;
  if (
    ["running", "settled", "interrupted", "cancelling", "cancelled"].includes(
      String(delegation?.status),
    )
  ) {
    lines.push(`  delegation: ${String(delegation?.status)}`);
    if (delegation?.status === "interrupted")
      lines.push("  recovery: inspect current diff/worktree before redispatch");
    if (delegation?.status === "cancelling") {
      const attempts = Number.isSafeInteger(delegation.cancellationAttempts)
        ? Number(delegation.cancellationAttempts)
        : 0;
      const cancellation =
        attempts >= 3
          ? "exhausted; re-arm required"
          : delegation.cancellationError
            ? "failed; retry pending"
            : "pending";
      lines.push(`  cancellation: ${cancellation}`);
    }
  }
  const preparation = task.metadata?.preparation as
    Record<string, unknown> | undefined;
  if (preparation) {
    lines.push(`  preparation: ${String(preparation.status ?? "unknown")}`);
    const handshake = packageAssignmentHandshake(task);
    if (handshake) lines.push(...handshake);
    const target = preparation.reviewTarget;
    if (target && typeof target === "object" && !Array.isArray(target)) {
      const selected = target as {
        status?: unknown;
        path?: unknown;
        identity?: unknown;
      };
      if (
        selected.status === "selected" &&
        typeof selected.path === "string" &&
        isTodoReviewTargetIdentity(selected.identity)
      ) {
        lines.push(`  executionTarget: ${selected.path}`);
      } else if (selected.status === "unresolved") {
        lines.push("  executionTarget: unresolved (explicit checkout target)");
      }
    } else if (
      typeof preparation.analysisCwd === "string" &&
      isTodoReviewTargetIdentity(preparation.analysisCwdIdentity)
    ) {
      const canonical = validateTodoReviewTarget(
        preparation.analysisCwd,
        preparation.analysisCwdIdentity,
      );
      if (canonical === preparation.analysisCwd) {
        lines.push(`  executionTarget: ${canonical}`);
      } else {
        lines.push("  executionTarget: unresolved (checkout identity changed)");
      }
    }
    if (typeof preparation.summary === "string")
      lines.push(`  preparedSummary: ${preparation.summary}`);
    for (const path of Array.isArray(preparation.affectedPaths)
      ? preparation.affectedPaths
      : []) {
      if (typeof path === "string") lines.push(`  affectedPath: ${path}`);
    }
    for (const step of Array.isArray(preparation.steps)
      ? preparation.steps
      : []) {
      if (typeof step === "string") lines.push(`  preparedStep: ${step}`);
    }
    for (const question of Array.isArray(preparation.questions)
      ? preparation.questions
      : []) {
      if (typeof question === "string")
        lines.push(`  candidateQuestion: ${question}`);
    }
    for (const risk of Array.isArray(preparation.risks)
      ? preparation.risks
      : []) {
      if (typeof risk === "string") lines.push(`  preparedRisk: ${risk}`);
    }
    if (typeof preparation.error === "string")
      lines.push(`  preparationError: ${preparation.error}`);
  }
  if (task.wait?.kind === "user")
    lines.push(
      ...task.wait.questions.map((question) => `  question: ${question}`),
    );
  if (task.wait?.kind === "jobs") {
    lines.push(
      `  jobs: ${task.wait.mode} ${task.wait.jobIds.join(", ")}`,
      `  deadline: ${new Date(task.wait.deadline).toISOString()}`,
    );
  }
  for (const evidence of task.waitEvidence ?? []) {
    lines.push(
      `  evidence: ${evidence.id} ${evidence.status}${evidence.error ? ` (${evidence.error})` : ""}`,
    );
  }
  return lines.join("\n");
}

/**
 * Pure formatter: `(op, state) → string`. Closed switch on `op.kind` —
 * adding a new `Op` variant fails to compile here until a branch is added.
 * The strings on each branch are byte-equivalent to pre-refactor `todo.ts`
 * reducer output.
 */
export function formatContent(op: Op, state: TaskState): string {
  switch (op.kind) {
    case "create": {
      const t = state.tasks.find((x) => x.id === op.taskId);
      // Defensive — `op.taskId` always resolves on success path.
      if (!t) return `Created #${op.taskId}`;
      return `Created #${t.id}: ${t.subject} (${publicTodoState(t)})`;
    }
    case "update": {
      const task = state.tasks.find((candidate) => candidate.id === op.id);
      if (op.toStatus === "completed" && task?.review?.status === "pending") {
        return `Submitted #${op.id} completion evidence for independent review`;
      }
      const transition =
        op.fromStatus !== op.toStatus
          ? ` (${op.fromStatus} → ${op.toStatus})`
          : "";
      return `Updated #${op.id}${transition}`;
    }
    case "merge":
      return `Merged #${op.duplicateId} into execution owner #${op.executionOwnerId}`;
    case "challenge":
      return `Recorded verification challenge for #${op.id}`;
    case "delete":
      return `Deleted #${op.id}: ${op.subject}`;
    case "clear":
      return `Archived ${op.count} completed tasks`;
    case "list": {
      let view = state.tasks;
      if (!op.includeDeleted) view = view.filter((t) => t.status !== "deleted");
      if (op.statusFilter)
        view = view.filter((t) => t.status === op.statusFilter);
      return view.length === 0
        ? "No tasks"
        : view.map(formatListLine).join("\n");
    }
    case "get":
      return formatGetLines(op.task, state);
    case "error":
      return `Error: ${op.message}`;
  }
}

/**
 * Build the LLM-facing tool envelope after the store has committed the
 * reducer's new state. Versioned custom snapshots own persistence + replay.
 *
 * Mirrors `packages/rpiv-ask-user-question/tool/response-envelope.ts:13-47`.
 */
export function buildToolResult(
  action: TaskAction,
  params: TaskMutationParams,
  state: TaskState,
  op: Op,
): { content: Array<{ type: "text"; text: string }>; details: TaskDetails } {
  const text = formatContent(op, state);
  const task =
    op.kind === "create"
      ? state.tasks.find((candidate) => candidate.id === op.taskId)
      : op.kind === "update" || op.kind === "challenge" || op.kind === "delete"
        ? state.tasks.find((candidate) => candidate.id === op.id)
        : op.kind === "merge"
          ? state.tasks.find((candidate) => candidate.id === op.duplicateId)
          : undefined;
  const details: TaskDetails = {
    action,
    params: rendererParams(params),
    ...(task ? { task: { status: task.status } } : {}),
    ...(op.kind === "error" ? { error: op.message } : {}),
  };
  return { content: [{ type: "text", text }], details };
}
