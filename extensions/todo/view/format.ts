import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatStatusLabel } from "../state/i18n-bridge.js";
import { selectTaskSubjectById } from "../state/selectors.js";
import type { TaskState } from "../state/state.js";
import type {
  Task,
  TaskAction,
  TaskDetails,
  TaskMutationParams,
  TaskStatus,
  TaskWait,
} from "../tool/types.js";

// Re-export so legacy import paths (todo.ts, tests) continue to resolve;
// the canonical definition lives in the i18n bridge.
export { formatStatusLabel };

// ---------------------------------------------------------------------------
// Status presentation tables — the single source of truth for glyph/color.
// ---------------------------------------------------------------------------

export const STATUS_GLYPH: Record<TaskStatus, string> = {
  pending: "○",
  in_progress: "◐",
  "waiting:user": "?",
  "waiting:jobs": "◌",
  completed: "●",
  deleted: "⊘",
};

/**
 * Color palette for the renderResult status echo. `deleted` uses `muted` so a
 * successful delete is visually distinct from the error branch (which uses
 * `error` + `✗`). Mirrors pre-refactor `todo.ts:444-450`.
 */
export const STATUS_COLOR: Record<
  TaskStatus,
  "dim" | "warning" | "success" | "muted"
> = {
  pending: "dim",
  in_progress: "warning",
  "waiting:user": "warning",
  "waiting:jobs": "muted",
  completed: "success",
  deleted: "muted",
};

/**
 * Per-action prefix glyph for renderCall. `+` create, `→` update, `×` delete,
 * `›` get, `☰` list, `∅` clear. Pre-refactor `todo.ts:457-464`.
 */
export const ACTION_GLYPH: Record<TaskAction, string> = {
  create: "+",
  update: "→",
  delete: "×",
  get: "›",
  list: "☰",
  clear: "∅",
};

export function formatPreparationProgress(task: Task): string | undefined {
  if (task.status !== "pending") return undefined;
  const preparation = task.metadata?.preparation as
    Record<string, unknown> | undefined;
  if (preparation?.status === "queued") return "preparing: queued";
  if (preparation?.status !== "running") return undefined;
  const progress =
    typeof preparation.progress === "string"
      ? preparation.progress
      : "analyzing task";
  return `preparing: ${progress}`;
}

function formatJobWait(wait: Extract<TaskWait, { kind: "jobs" }>): string {
  const remaining = wait.jobIds.filter((id) => !wait.settled[id]);
  const settled = wait.jobIds.length - remaining.length;
  const progress = settled ? ` · ${settled}/${wait.jobIds.length} settled` : "";
  return `(${wait.mode}: ${remaining.join(",") || "settling"}${progress})`;
}

/**
 * Glyph for the persistent overlay's per-task row. Differs from `STATUS_GLYPH`
 * for `completed` (`✓` vs `●`) and `deleted` (`✗` vs `⊘`) because the
 * overlay caller never renders a `deleted` row but uses `✗` in its
 * error-toned palette. Mirrors pre-refactor `todo-overlay.ts:23-33`.
 */
export function overlayStatusGlyph(status: TaskStatus, theme: Theme): string {
  switch (status) {
    case "pending":
      return theme.fg("dim", "○");
    case "in_progress":
      return theme.fg("warning", "◐");
    case "waiting:user":
      return theme.fg("warning", "?");
    case "waiting:jobs":
      return theme.fg("muted", "◌");
    case "completed":
      return theme.fg("success", "✓");
    case "deleted":
      return theme.fg("error", "✗");
  }
}

/**
 * Format a single task for the overlay (with theme + glyph + dep suffix).
 * Used by `TodoOverlay.formatTaskLine` post-refactor; behavior is unchanged.
 */
export function formatOverlayTaskLine(
  t: Task,
  theme: Theme,
  showId: boolean,
): string {
  const preparation = formatPreparationProgress(t);
  const glyph = preparation
    ? theme.fg("warning", "◐")
    : overlayStatusGlyph(t.status, theme);
  const subjectColor =
    t.status === "completed" || t.status === "deleted" ? "dim" : "text";
  let subject = theme.fg(subjectColor, t.subject);
  if (t.status === "completed" || t.status === "deleted") {
    subject = theme.strikethrough(subject);
  }
  let line = `${glyph}`;
  if (showId) line += ` ${theme.fg("accent", `#${t.id}`)}`;
  line += ` ${subject}`;
  if (t.status === "in_progress" && t.activeForm) {
    line += ` ${theme.fg("dim", `(${t.activeForm})`)}`;
  } else if (preparation) {
    line += ` ${theme.fg("dim", `(${preparation})`)}`;
  }
  if (t.blockedBy && t.blockedBy.length > 0) {
    line += ` ${theme.fg("dim", `⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
  }
  if (t.wait?.kind === "user")
    line += ` ${theme.fg("dim", `(${t.wait.questions.length} question${t.wait.questions.length === 1 ? "" : "s"})`)}`;
  if (t.wait?.kind === "jobs")
    line += ` ${theme.fg("dim", formatJobWait(t.wait))}`;
  return line;
}

/**
 * Format a single task line for the `/todos` slash command (no glyph color,
 * indented bullet prefix). Pre-refactor `todo.ts:670-674`.
 */
export function formatCommandTaskLine(t: Task, glyph: string): string {
  const preparation = formatPreparationProgress(t);
  if (preparation) glyph = "◐";
  const form =
    t.status === "in_progress" && t.activeForm
      ? ` (${t.activeForm})`
      : preparation
        ? ` (${preparation})`
        : "";
  const block = t.blockedBy?.length
    ? `    ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`
    : "";
  const wait =
    t.wait?.kind === "user"
      ? ` (${t.wait.questions.join(" | ")})`
      : t.wait?.kind === "jobs"
        ? ` ${formatJobWait(t.wait)}`
        : "";
  return `  ${glyph} #${t.id} ${t.subject}${form}${wait}${block}`;
}

// ---------------------------------------------------------------------------
// Tool render hooks — wrapped so `todo.ts` becomes a thin call-site.
// ---------------------------------------------------------------------------

/**
 * `renderCall` body. Receives the parsed args, the theme, and the live
 * `TaskState` (resolved by the caller via `getState()`). Returns a `Text`
 * node identical to pre-refactor `todo.ts:507-525`.
 */
export function renderTodoCall(
  args: TaskMutationParams & { action: TaskAction },
  theme: Theme,
  state: TaskState,
): Text {
  const glyph = ACTION_GLYPH[args.action] ?? args.action;
  let text =
    theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", glyph);

  if (args.action === "create" && args.subject) {
    text += ` ${theme.fg("dim", args.subject)}`;
  } else if (
    (args.action === "update" ||
      args.action === "get" ||
      args.action === "delete") &&
    args.id !== undefined
  ) {
    const subject = selectTaskSubjectById(state, args.id);
    text += ` ${theme.fg("accent", subject ?? `#${args.id}`)}`;
    if (args.action === "update") {
      if (args.removeBlockedBy?.length)
        text += ` ${theme.fg("dim", `− blocker ${args.removeBlockedBy.map((id) => `#${id}`).join(",")}`)}`;
      else if (args.addBlockedBy?.length)
        text += ` ${theme.fg("dim", `+ blocker ${args.addBlockedBy.map((id) => `#${id}`).join(",")}`)}`;
      else if (args.status)
        text += ` ${theme.fg("dim", `→ ${formatStatusLabel(args.status)}`)}`;
    }
  } else if (args.action === "list" && args.status) {
    text += ` ${theme.fg("muted", formatStatusLabel(args.status))}`;
  }
  return new Text(text, 0, 0);
}

/**
 * `renderResult` body. Inspects `details` to show either a status transition
 * or the concrete dependency mutation; non-mutating actions use plain `✓`.
 */
export function renderTodoResult(
  result: { details?: unknown },
  theme: Theme,
): Text {
  const details = result.details as TaskDetails | undefined;
  let status: TaskStatus | undefined;
  if (details) {
    const params = details.params as TaskMutationParams;
    switch (details.action) {
      case "create":
        status = details.task?.status;
        break;
      case "update":
        status = params.status;
        if (!status) {
          const changed = params.removeBlockedBy?.length
            ? `removed blocker ${params.removeBlockedBy.map((id) => `#${id}`).join(",")}`
            : params.addBlockedBy?.length
              ? `added blocker ${params.addBlockedBy.map((id) => `#${id}`).join(",")}`
              : "updated";
          return new Text(theme.fg("success", `✓ ${changed}`), 0, 0);
        }
        break;
      case "delete":
        status = details.task?.status;
        break;
      case "list":
      case "get":
      case "clear":
        break;
    }
  }
  if (status) {
    return new Text(
      theme.fg(
        STATUS_COLOR[status],
        `${STATUS_GLYPH[status]} ${formatStatusLabel(status)}`,
      ),
      0,
      0,
    );
  }
  return new Text(theme.fg("success", "✓"), 0, 0);
}
