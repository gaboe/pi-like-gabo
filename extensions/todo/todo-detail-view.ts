import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type TUI,
} from "@earendil-works/pi-tui";
import { formatStatusLabel } from "./state/i18n-bridge.js";
import { selectVisibleTasks } from "./state/selectors.js";
import { getState } from "./state/store.js";
import type { Task } from "./tool/types.js";

type ViewResult =
  { action: "edit"; id: number } | { action: "add" } | undefined;

function preparation(task: Task): Record<string, unknown> {
  const value = task.metadata?.preparation;
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function detailSections(task: Task): Array<[string, string[]]> {
  const prep = preparation(task);
  const sections: Array<[string, string[]]> = [
    ["Raw request", [task.description ?? task.subject]],
  ];
  if (typeof prep.status === "string") {
    const values = [prep.status];
    if (typeof prep.analysisKind === "string") values.push(prep.analysisKind);
    if (typeof prep.analysisCwd === "string") values.push(prep.analysisCwd);
    sections.push(["Preparation", values]);
  }
  if (typeof prep.summary === "string")
    sections.push(["Analysis", [prep.summary]]);
  for (const [label, key] of [
    ["Affected paths", "affectedPaths"],
    ["Steps", "steps"],
    ["Candidate questions", "questions"],
    ["Risks", "risks"],
    ["Sources", "sources"],
  ] as const) {
    const values = stringList(prep[key]);
    if (values.length) sections.push([label, values]);
  }
  if (task.wait?.kind === "user")
    sections.push(["Waiting for user", task.wait.questions]);
  if (task.wait?.kind === "jobs")
    sections.push(["Waiting for jobs", task.wait.jobIds]);
  return sections;
}

function renderDetail(task: Task, theme: Theme, width: number): string[] {
  const lines: string[] = [];
  for (const [label, values] of detailSections(task)) {
    lines.push(theme.fg("accent", theme.bold(label)));
    for (const value of values) {
      const wrapped = wrapTextWithAnsi(
        theme.fg("text", value),
        Math.max(12, width - 4),
      );
      for (const [index, line] of wrapped.entries())
        lines.push(`${theme.fg("dim", index === 0 ? "  • " : "    ")}${line}`);
    }
  }
  return lines;
}

export class TodoDetailView {
  private selected = 0;
  private detailOffset = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly getTasks: () => readonly Task[],
    private readonly done: (result: ViewResult) => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) this.done(undefined);
    else if (matchesKey(data, Key.up)) {
      this.selected = Math.max(0, this.selected - 1);
      this.detailOffset = 0;
    } else if (matchesKey(data, Key.down)) {
      this.selected = Math.min(
        Math.max(0, this.visibleTasks().length - 1),
        this.selected + 1,
      );
      this.detailOffset = 0;
    } else if (matchesKey(data, Key.pageUp)) {
      this.detailOffset = Math.max(
        0,
        this.detailOffset - this.rowBudgets().detail,
      );
    } else if (matchesKey(data, Key.pageDown)) {
      this.detailOffset += this.rowBudgets().detail;
    } else if (matchesKey(data, Key.enter) || data.toLowerCase() === "e") {
      const task = this.visibleTasks()[this.selected];
      if (task) this.done({ action: "edit", id: task.id });
    } else if (data.toLowerCase() === "a") {
      this.done({ action: "add" });
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const tasks = this.visibleTasks();
    this.selected = Math.min(this.selected, Math.max(0, tasks.length - 1));
    const inner = Math.max(20, width - 4);
    const budgets = this.rowBudgets();
    const lines = [
      truncateToWidth(
        `${this.theme.fg("accent", this.theme.bold("TODO details"))} ${this.theme.fg("dim", `· ${tasks.length} tasks`)}`,
        width,
      ),
      "",
    ];
    const start = Math.max(
      0,
      Math.min(this.selected - budgets.tasks + 1, tasks.length - budgets.tasks),
    );
    for (const [offset, task] of tasks
      .slice(start, start + budgets.tasks)
      .entries()) {
      const index = start + offset;
      const marker = index === this.selected ? "›" : " ";
      const color = index === this.selected ? "accent" : "muted";
      lines.push(
        truncateToWidth(
          `${this.theme.fg(color, marker)} ${this.theme.fg(color, `#${task.id}`)} ${task.subject} ${this.theme.fg("dim", `[${formatStatusLabel(task.status)}]`)}`,
          width,
          "…",
        ),
      );
    }
    if (!tasks.length) {
      lines.push(
        "",
        this.theme.fg("muted", "No visible TODOs"),
        "",
        this.theme.fg("dim", "a add · esc close"),
      );
      return lines.map((line) => truncateToWidth(line, width, "…"));
    }
    lines.push("", this.theme.fg("dim", "─".repeat(inner)), "");
    const task = tasks[this.selected];
    lines.push(
      truncateToWidth(
        `${this.theme.fg("accent", this.theme.bold(`#${task.id} ${task.subject}`))} ${this.theme.fg("dim", `[${formatStatusLabel(task.status)}]`)}`,
        width,
      ),
    );
    const detail = renderDetail(task, this.theme, width);
    const maxOffset = Math.max(0, detail.length - budgets.detail);
    this.detailOffset = Math.min(this.detailOffset, maxOffset);
    lines.push(
      ...detail.slice(this.detailOffset, this.detailOffset + budgets.detail),
    );
    if (detail.length > budgets.detail)
      lines.push(
        this.theme.fg(
          "dim",
          `${this.detailOffset + 1}-${Math.min(detail.length, this.detailOffset + budgets.detail)}/${detail.length} · pgup/pgdn scroll`,
        ),
      );
    lines.push(
      "",
      this.theme.fg(
        "dim",
        "↑↓ select · enter/e edit via prompt · a add · pgup/pgdn detail · esc close",
      ),
    );
    return lines.map((line) => truncateToWidth(line, width, "…"));
  }

  invalidate(): void {}

  private visibleTasks(): readonly Task[] {
    return this.getTasks().filter((task) => task.status !== "deleted");
  }

  private rowBudgets() {
    const available = Math.max(10, this.tui.terminal.rows - 9);
    const tasks = Math.max(4, Math.min(10, Math.floor(available * 0.35)));
    return { tasks, detail: Math.max(6, available - tasks) };
  }
}

export async function showTodoDetailView(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const tasks = selectVisibleTasks(getState());
  if (!tasks.length) return;
  const result = await ctx.ui.custom<ViewResult>(
    (tui, theme, _keybindings, done) =>
      new TodoDetailView(
        tui,
        theme,
        () => selectVisibleTasks(getState()),
        done,
      ),
  );
  if (!result) return;
  if (result.action === "add") {
    ctx.ui.setEditorText("/todos add ");
    return;
  }
  const task = selectVisibleTasks(getState()).find(
    (candidate) => candidate.id === result.id,
  );
  if (!task) return;
  ctx.ui.setEditorText(
    `Update TODO #${task.id}. Current raw request:\n${task.description ?? task.subject}\n\nChange requested: `,
  );
}
