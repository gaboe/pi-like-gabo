import {
  getSupportedThinkingLevels,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ALL_LEVELS: ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function adjacentThinkingLevel(
  levels: readonly ModelThinkingLevel[],
  current: ModelThinkingLevel,
  direction: 1 | -1,
): ModelThinkingLevel {
  if (levels.length === 0) return "off";
  const index = levels.indexOf(current);
  const start = index < 0 ? 0 : index;
  return levels[Math.max(0, Math.min(levels.length - 1, start + direction))];
}

export default function thinkingShortcuts(pi: ExtensionAPI) {
  const change = (direction: 1 | -1) =>
    pi.registerShortcut(direction === 1 ? "shift+up" : "shift+down", {
      description:
        direction === 1 ? "Increase thinking level" : "Decrease thinking level",
      handler: async (ctx) => {
        const levels = ctx.model
          ? getSupportedThinkingLevels(ctx.model)
          : ALL_LEVELS;
        const current = pi.getThinkingLevel();
        const next = adjacentThinkingLevel(levels, current, direction);
        if (next === current) {
          ctx.ui.notify(
            `Thinking already ${direction === 1 ? "maximum" : "minimum"}: ${current}`,
            "info",
          );
          return;
        }
        pi.setThinkingLevel(next);
        ctx.ui.notify(`Thinking: ${next}`, "info");
      },
    });

  change(1);
  change(-1);
}
