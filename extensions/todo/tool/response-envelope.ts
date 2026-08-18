import type { TaskState } from "../state/state.js";
import type { Op } from "../state/state-reducer.js";
import { deriveBlocks } from "../state/task-graph.js";
import { formatPreparationProgress } from "../view/format.js";
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
  const form =
    t.status === "in_progress" && t.activeForm
      ? ` (${t.activeForm})`
      : preparation
        ? ` (${preparation})`
        : "";
  return `[${preparation ? "preparing" : t.status}] #${t.id} ${t.subject}${form}${block}`;
}

/**
 * Multi-line presentation for the `get` action. Order of rows is pinned by
 * pre-refactor `todo.ts:354-376` — description, activeForm, blockedBy, blocks,
 * owner — so envelope-level snapshot tests stay byte-equivalent.
 */
function formatGetLines(task: Task, state: TaskState): string {
  const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
  const lines = [`#${task.id} [${task.status}] ${task.subject}`];
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
  if (task.owner) lines.push(`  owner: ${task.owner}`);
  if (task.result) lines.push(`  result: ${task.result}`);
  for (const evidence of task.evidence ?? []) lines.push(`  completionEvidence: ${evidence}`);
  if (task.review) {
    lines.push(`  review: ${task.review.status}`);
    lines.push(`  reviewer: ${task.review.reviewer.id} (${task.review.reviewer.model})`);
    if (task.review.feedback) lines.push(`  reviewFeedback: ${task.review.feedback}`);
    if (task.review.failedAt !== undefined) {
      lines.push(`  reviewFailure: ${new Date(task.review.failedAt).toISOString()}`);
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
    if (delegation?.status === "cancelling" && delegation.cancellationError)
      lines.push(
        `  cancellationError: ${String(delegation.cancellationError)}`,
      );
  }
  const preparation = task.metadata?.preparation as
    Record<string, unknown> | undefined;
  if (preparation) {
    lines.push(`  preparation: ${String(preparation.status ?? "unknown")}`);
    if (typeof preparation.token === "string" && preparation.token.trim()) {
      lines.push(`  todo_id: ${task.id}`, `  todo_token: ${preparation.token}`);
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
      return `Created #${t.id}: ${t.subject} (pending)`;
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
      : op.kind === "update" || op.kind === "delete"
        ? state.tasks.find((candidate) => candidate.id === op.id)
        : undefined;
  const details: TaskDetails = {
    action,
    params: rendererParams(params),
    ...(task ? { task: { status: task.status } } : {}),
    ...(op.kind === "error" ? { error: op.message } : {}),
  };
  return { content: [{ type: "text", text }], details };
}
