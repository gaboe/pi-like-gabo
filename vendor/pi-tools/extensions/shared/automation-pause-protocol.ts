export const AUTOMATION_PAUSE_CHANNEL = "automation:pause:v1";

export type AutomationPauseSource =
  | "parent"
  | "todo"
  | "subagents"
  | "workflows"
  | "jobs"
  | "background-terminals";

export interface AutomationPauseRequest {
  reason: "double-escape";
  acknowledge(source: AutomationPauseSource, count: number): void;
}

export interface AutomationPauseResult {
  count: number;
  sources: AutomationPauseSource[];
}

export function requestAutomationPause(bus: {
  emit(channel: string, value: unknown): unknown;
}): AutomationPauseResult {
  let count = 0;
  const sources = new Set<AutomationPauseSource>();
  bus.emit(AUTOMATION_PAUSE_CHANNEL, {
    reason: "double-escape",
    acknowledge(source, sourceCount) {
      if (!Number.isSafeInteger(sourceCount) || sourceCount <= 0) return;
      count += sourceCount;
      sources.add(source);
    },
  } satisfies AutomationPauseRequest);
  return { count, sources: [...sources] };
}
