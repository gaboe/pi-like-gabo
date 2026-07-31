import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Editor,
  isKeyRelease,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  FLEET_SETTLED_LINGER_MS,
  type FleetItem,
  type FleetOpenRequest,
  type FleetState,
} from "../../vendor/pi-tools/extensions/shared/fleet-protocol.ts";

const WIDGET_KEY = "fleet-navigation";
const MAX_VISIBLE_ITEMS = 5;
const TICK_MS = 250;
export const STALE_AFTER_MS = 60_000;

type FleetEntry = { kind: "main" } | FleetItem;

function entryKey(entry: FleetEntry | undefined): string | undefined {
  return entry?.kind === "main"
    ? "main"
    : entry
      ? `${entry.source}:${entry.kind}:${entry.id}`
      : undefined;
}

export function aggregateFleetStates(
  states: Iterable<FleetState>,
  now = Date.now(),
): FleetItem[] {
  const items: FleetItem[] = [];
  for (const state of states) items.push(...state.items);
  return items
    .filter(
      (item) =>
        item.status === "running" ||
        (item.settledAt !== undefined &&
          now - item.settledAt < FLEET_SETTLED_LINGER_MS),
    )
    .sort(
      (a, b) =>
        a.startedAt - b.startedAt ||
        (a.kind === "workflow-run" ? -1 : b.kind === "workflow-run" ? 1 : 0),
    );
}

function formatElapsed(startedAt: number, settledAt?: number): string {
  const seconds = Math.max(
    0,
    Math.round(((settledAt ?? Date.now()) - startedAt) / 1_000),
  );
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
    : `${seconds}s`;
}

export function isStale(item: FleetItem, now = Date.now()): boolean {
  const activityAt = item.lastActivityAt ?? item.updatedAt;
  return (
    item.status === "running" &&
    activityAt !== undefined &&
    now - activityAt >= STALE_AFTER_MS
  );
}

function formatAge(at: number, now = Date.now()): string {
  return formatElapsed(at, now);
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function rightAlign(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  const clipped = truncateToWidth(left, Math.max(0, width - rightWidth - 1));
  return truncateToWidth(
    `${clipped}${" ".repeat(Math.max(1, width - visibleWidth(clipped) - rightWidth))}${right}`,
    width,
  );
}

export class FleetView {
  private readonly states = new Map<FleetState["source"], FleetState>();
  private readonly unsubscribeInput: () => void;
  private tui?: TUI;
  private mainEditor?: unknown;
  private timer?: ReturnType<typeof setInterval>;
  private widgetRegistered = false;
  private active = false;
  private selectedIndex = 0;
  private renderSignature?: string;
  private disposed = false;

  constructor(
    private readonly ui: ExtensionUIContext,
    private readonly onOpen: (request: FleetOpenRequest) => void,
  ) {
    this.unsubscribeInput = ui.onTerminalInput((data) => this.handleKey(data));
  }

  setState(state: FleetState): void {
    if (this.disposed) return;
    const selected = entryKey(this.roster()[this.selectedIndex]);
    this.states.set(state.source, state);
    if (selected) {
      const index = this.roster().findIndex(
        (entry) => entryKey(entry) === selected,
      );
      if (index >= 0) this.selectedIndex = index;
    }
    this.update();
  }

  handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (this.disposed || isKeyRelease(data)) return undefined;
    if (!this.editorHasFocus() || this.ui.getEditorText() !== "") {
      if (this.active) this.deactivate();
      return undefined;
    }

    if (!this.active) {
      if (
        (matchesKey(data, Key.down) || matchesKey(data, Key.left)) &&
        this.items().length > 0
      ) {
        this.active = true;
        this.selectedIndex = 0;
        this.requestRender();
        return { consume: true };
      }
      return undefined;
    }

    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(
        this.roster().length - 1,
        this.selectedIndex + 1,
      );
      this.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, Key.up)) {
      if (this.selectedIndex === 0) this.deactivate();
      else {
        this.selectedIndex -= 1;
        this.requestRender();
      }
      return { consume: true };
    }
    if (matchesKey(data, Key.escape)) {
      this.deactivate();
      return { consume: true };
    }
    if (matchesKey(data, Key.enter)) {
      this.openSelected();
      return { consume: true };
    }

    this.deactivate();
    return undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeInput();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.widgetRegistered) this.ui.setWidget(WIDGET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.mainEditor = undefined;
    this.states.clear();
  }

  private items(): FleetItem[] {
    return aggregateFleetStates(this.states.values());
  }

  private roster(): FleetEntry[] {
    return [{ kind: "main" }, ...this.items()];
  }

  private update(): void {
    const items = this.items();
    if (items.length === 0) {
      this.active = false;
      this.selectedIndex = 0;
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      if (this.widgetRegistered) {
        this.widgetRegistered = false;
        this.ui.setWidget(WIDGET_KEY, undefined);
      }
      this.tui = undefined;
      this.mainEditor = undefined;
      this.renderSignature = undefined;
      return;
    }

    this.selectedIndex = Math.min(this.selectedIndex, items.length);
    this.timer ??= setInterval(() => this.update(), TICK_MS);
    const signature = this.getRenderSignature(items);
    if (!this.widgetRegistered) {
      this.widgetRegistered = true;
      this.ui.setWidget(
        WIDGET_KEY,
        (tui, theme) => {
          this.tui = tui;
          const focused = (tui as unknown as { focusedComponent?: unknown })
            .focusedComponent;
          if (focused instanceof Editor) this.mainEditor = focused;
          return {
            render: (width: number) => this.render(width, theme),
            invalidate() {},
          };
        },
        { placement: "belowEditor" },
      );
      this.renderSignature = signature;
    } else if (signature !== this.renderSignature) {
      this.renderSignature = signature;
      this.requestRender();
    }
  }

  private getRenderSignature(items: FleetItem[]): string {
    return JSON.stringify([
      this.active,
      this.selectedIndex,
      items.map((item) => [
        item.source,
        item.kind,
        item.id,
        item.title,
        item.detail,
        item.status,
        item.settledAt,
        formatElapsed(item.startedAt, item.settledAt),
        item.tokens,
        item.turns,
        item.maxTurns,
      ]),
    ]);
  }

  private editorHasFocus(): boolean {
    const focused = (
      this.tui as unknown as { focusedComponent?: unknown } | undefined
    )?.focusedComponent;
    return this.mainEditor !== undefined && focused === this.mainEditor;
  }

  private requestRender(): void {
    this.renderSignature = this.getRenderSignature(this.items());
    this.tui?.requestRender();
  }

  private deactivate(): void {
    this.active = false;
    this.selectedIndex = 0;
    this.requestRender();
  }

  private openSelected(): void {
    const selected = this.roster()[this.selectedIndex];
    this.deactivate();
    if (!selected || selected.kind === "main") return;
    if (selected.kind === "workflow-agent") {
      this.onOpen({
        source: selected.source,
        kind: selected.kind,
        id: selected.id,
        parentId: selected.parentId,
        agentIndex: selected.agentIndex,
      });
      return;
    }
    if (selected.kind === "subagent") {
      this.onOpen({ source: "subagents", kind: "subagent", id: selected.id });
    } else if (selected.kind === "job") {
      this.onOpen({ source: "jobs", kind: "job", id: selected.id });
    } else {
      this.onOpen({
        source: "workflows",
        kind: "workflow-run",
        id: selected.id,
      });
    }
  }

  private render(width: number, theme: Theme): string[] {
    const items = this.items();
    if (items.length === 0) return [];
    const selected = Math.min(this.selectedIndex, items.length);
    const lines = [
      truncateToWidth(
        `  ${theme.fg("dim", this.active ? "↑↓ select · enter open · esc back" : "↓/← manage jobs, agents and workflows")}`,
        width,
      ),
      "",
      truncateToWidth(`  ${this.marker(0, selected, theme)} main`, width),
    ];
    const selectedItem = Math.max(0, selected - 1);
    const start = Math.max(
      0,
      Math.min(
        selectedItem - MAX_VISIBLE_ITEMS + 1,
        items.length - MAX_VISIBLE_ITEMS,
      ),
    );
    const visible = items.slice(start, start + MAX_VISIBLE_ITEMS);
    if (start > 0) lines.push(theme.fg("dim", `  ↑ ${start} more`));
    for (const [offset, item] of visible.entries()) {
      lines.push(
        this.renderItem(item, start + offset + 1, selected, width, theme),
      );
    }
    const hidden = items.length - start - visible.length;
    if (hidden > 0) lines.push(theme.fg("dim", `  ↓ ${hidden} more`));
    return lines.map((line) => truncateToWidth(line, width));
  }

  private marker(index: number, selected: number, theme: Theme): string {
    return index === selected ? theme.fg("accent", "⏺") : theme.fg("dim", "◯");
  }

  private renderItem(
    item: FleetItem,
    index: number,
    selected: number,
    width: number,
    theme: Theme,
  ): string {
    const statusColor =
      item.status === "running"
        ? "warning"
        : item.status === "done"
          ? "success"
          : "error";
    const kind =
      item.kind === "job"
        ? "job"
        : item.kind === "subagent"
          ? "agent"
          : item.kind === "workflow-run"
            ? "workflow"
            : "  ↳ agent";
    const left = `  ${this.marker(index, selected, theme)} ${theme.fg(statusColor, "■")} ${theme.fg("muted", kind)}  ${item.title}${item.detail ? theme.fg("dim", ` · ${item.detail}`) : ""}`;
    const activityAt = item.lastActivityAt ?? item.updatedAt;
    const stats = [
      formatElapsed(item.startedAt, item.settledAt),
      activityAt !== undefined ? `active ${formatAge(activityAt)} ago` : undefined,
      isStale(item) ? "stale" : undefined,
      item.retryState,
      item.quotaState,
      item.tokens ? `${formatTokens(item.tokens)} tokens` : undefined,
      item.turns
        ? `${item.turns}${item.maxTurns ? `/${item.maxTurns}` : ""} turns`
        : undefined,
    ].filter(Boolean);
    return rightAlign(left, theme.fg("dim", stats.join(" · ")), width);
  }
}
