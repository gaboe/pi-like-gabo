import {
  buildContextEntries,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  contextReportOffset,
  contextReportPage,
  formatContextReport,
} from "./context-report.ts";
import {
  CHILD_COST_CHANNEL,
  CHILD_COST_ENTRY,
  emptyModelInfoState,
  isChildCostUpdate,
  MODEL_INFO_CHANNEL,
  REFRESH_CHANNEL,
} from "../shared/dashboard-state.ts";

const CHARS_PER_ESTIMATED_TOKEN = 4;
const LIVE_UPDATE_INTERVAL_MS = 200;

function isStaleContextError(error: unknown): boolean {
  return /stale after session replacement/.test(String(error));
}

export function getSessionCost(ctx: ExtensionContext) {
  let cost = 0;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      cost += entry.message.usage.cost.total;
    }
  }

  return cost;
}

export function collectPersistedChildCosts(entries: readonly unknown[]) {
  const costs = new Map<string, number>();
  for (const value of entries) {
    if (!value || typeof value !== "object") continue;
    const entry = value as {
      type?: unknown;
      customType?: unknown;
      data?: unknown;
    };
    if (
      entry.type === "custom" &&
      entry.customType === CHILD_COST_ENTRY &&
      isChildCostUpdate(entry.data)
    ) {
      costs.set(entry.data.key, entry.data.cost);
    }
  }
  return costs;
}

export function totalChildCost(costs: ReadonlyMap<string, number>) {
  let total = 0;
  for (const cost of costs.values()) total += cost;
  return total;
}

function estimateContentTokens(characters: number) {
  return Math.ceil(characters / CHARS_PER_ESTIMATED_TOKEN);
}

export default function modelInfo(pi: ExtensionAPI) {
  let state = emptyModelInfoState();
  let contentStreamStart: number | null = null;
  let lastContentDeltaAt: number | null = null;
  let contentCharacters = 0;
  let firstContentDeltaCharacters = 0;
  let contentDeltaCount = 0;
  let sawToolCall = false;
  let runContentTokens = 0;
  let runContentStreamMs = 0;
  let lastLiveUpdate = 0;
  let currentContext: ExtensionContext | undefined;
  let childCosts = new Map<string, number>();
  const persistedChildCosts = new Set<string>();
  const disposeCallbacks: (() => void)[] = [];

  const publish = () => pi.events.emit(MODEL_INFO_CHANNEL, { ...state });

  pi.registerCommand("context", {
    description: "Show Pi context estimate and estimated context breakdown",
    handler: async (_args, ctx) => {
      const options = ctx.getSystemPromptOptions();
      const skills = options.skills?.map(({ name, description, filePath }) => ({
        name,
        description,
        filePath,
      }));
      const lines = formatContextReport({
        usage: ctx.getContextUsage(),
        systemPrompt: ctx.getSystemPrompt(),
        entries: buildContextEntries(ctx.sessionManager.getBranch()),
        activeTools: pi
          .getAllTools()
          .filter((tool) => pi.getActiveTools().includes(tool.name)),
        contextFiles: options.contextFiles,
        skills,
      });
      await ctx.ui.custom(
        (tui, theme, _keybindings, done) => {
          let offset = 0;
          const pageHeight = () =>
            Math.max(1, Math.floor(tui.terminal.rows * 0.9) - 1);
          const move = (delta: number) => {
            offset = contextReportOffset(
              lines.length,
              offset,
              delta,
              pageHeight(),
            );
            tui.requestRender();
          };
          return {
            render: (width: number) => {
              const page = contextReportPage(
                lines,
                width,
                offset,
                pageHeight(),
              );
              return [
                ...page.map((line, index) =>
                  index === 0 && offset === 0
                    ? theme.fg("accent", truncateToWidth(line, width, "…"))
                    : truncateToWidth(line, width, "…"),
                ),
                truncateToWidth(
                  `↑↓/jk scroll · PgUp/PgDn or u/d page · Home/End · ${offset + 1}-${offset + page.length}/${lines.length} · Esc/q/Enter close`,
                  width,
                  "…",
                ),
              ];
            },
            handleInput: (data: string) => {
              if (
                matchesKey(data, Key.escape) ||
                data === "q" ||
                matchesKey(data, Key.enter)
              )
                done(undefined);
              else if (matchesKey(data, Key.up) || data === "k") move(-1);
              else if (matchesKey(data, Key.down) || data === "j") move(1);
              else if (matchesKey(data, Key.pageUp) || data === "u")
                move(-pageHeight());
              else if (matchesKey(data, Key.pageDown) || data === "d")
                move(pageHeight());
              else if (matchesKey(data, Key.home)) move(-lines.length);
              else if (matchesKey(data, Key.end)) move(lines.length);
            },
            invalidate: () => {},
          };
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            margin: 1,
            maxHeight: "90%",
            minWidth: 60,
            width: "90%",
          },
        },
      );
    },
  });

  function refresh(ctx: ExtensionContext) {
    currentContext = ctx;
    const model = ctx.model;
    const usage = ctx.getContextUsage();

    state = {
      ...state,
      provider: model?.provider ?? "",
      modelId: model?.id ?? "no-model",
      modelName: model?.name ?? model?.id ?? "No model",
      thinking: model?.reasoning ? pi.getThinkingLevel() : "off",
      contextTokens: usage?.tokens ?? null,
      contextWindow: usage?.contextWindow ?? model?.contextWindow ?? 0,
      contextPercent: usage?.percent ?? null,
      cost: getSessionCost(ctx) + totalChildCost(childCosts),
    };
    publish();
  }

  function restoreChildCosts(ctx: ExtensionContext) {
    childCosts = collectPersistedChildCosts(ctx.sessionManager.getBranch());
    persistedChildCosts.clear();
    for (const key of childCosts.keys()) persistedChildCosts.add(key);
  }

  function resetMessageTracking() {
    contentStreamStart = null;
    lastContentDeltaAt = null;
    contentCharacters = 0;
    firstContentDeltaCharacters = 0;
    contentDeltaCount = 0;
    sawToolCall = false;
    lastLiveUpdate = 0;
  }

  disposeCallbacks.push(
    pi.events.on(CHILD_COST_CHANNEL, (value) => {
      if (!isChildCostUpdate(value)) return;
      childCosts.set(value.key, value.cost);
      if (
        value.settled &&
        currentContext &&
        !persistedChildCosts.has(value.key)
      ) {
        persistedChildCosts.add(value.key);
        pi.appendEntry(CHILD_COST_ENTRY, value);
      }
      if (currentContext) refresh(currentContext);
    }),
  );

  disposeCallbacks.push(
    pi.events.on(REFRESH_CHANNEL, () => {
      if (currentContext) refresh(currentContext);
    }),
  );

  pi.on("session_start", (_event, ctx) => {
    restoreChildCosts(ctx);
    resetMessageTracking();
    runContentTokens = 0;
    runContentStreamMs = 0;
    state = { ...state, tokensPerSecond: null, generating: false };
    refresh(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreChildCosts(ctx);
    refresh(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    state = {
      ...state,
      provider: event.model.provider,
      modelId: event.model.id,
      modelName: event.model.name,
      thinking: event.model.reasoning ? pi.getThinkingLevel() : "off",
      contextWindow: event.model.contextWindow,
    };
    refresh(ctx);
  });

  pi.on("thinking_level_select", (event) => {
    state = { ...state, thinking: event.level };
    publish();
  });

  pi.on("agent_start", (_event, ctx) => {
    runContentTokens = 0;
    runContentStreamMs = 0;
    resetMessageTracking();
    state = { ...state, tokensPerSecond: null, generating: true };
    refresh(ctx);
  });

  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") resetMessageTracking();
  });

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;

    const streamEvent = event.assistantMessageEvent;
    if (streamEvent.type === "toolcall_delta") {
      sawToolCall = true;
      return;
    }
    if (
      streamEvent.type !== "text_delta" &&
      streamEvent.type !== "thinking_delta"
    )
      return;
    if (!streamEvent.delta) return;

    const now = Date.now();
    if (contentStreamStart === null) {
      contentStreamStart = now;
      firstContentDeltaCharacters = streamEvent.delta.length;
    }
    lastContentDeltaAt = now;
    contentCharacters += streamEvent.delta.length;
    contentDeltaCount += 1;

    const elapsedMs = now - contentStreamStart;
    const streamedCharacters = contentCharacters - firstContentDeltaCharacters;
    if (
      contentDeltaCount < 2 ||
      elapsedMs <= 0 ||
      streamedCharacters <= 0 ||
      now - lastLiveUpdate < LIVE_UPDATE_INTERVAL_MS
    ) {
      return;
    }
    lastLiveUpdate = now;

    state = {
      ...state,
      tokensPerSecond:
        estimateContentTokens(streamedCharacters) / (elapsedMs / 1000),
    };
    publish();
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;

    sawToolCall ||= event.message.content.some(
      (block) => block.type === "toolCall",
    );

    if (contentStreamStart !== null && contentCharacters > 0) {
      const streamEnd = lastContentDeltaAt ?? contentStreamStart;
      const streamMs = streamEnd - contentStreamStart;
      const estimatedFirstDeltaTokens = estimateContentTokens(
        firstContentDeltaCharacters,
      );
      // Measure tokens received after the first content event over the interval
      // from the first event to the last. This avoids counting an initial chunk
      // as if it were generated instantaneously at t=0.
      const streamedTokens =
        !sawToolCall && event.message.usage.output > 0
          ? Math.max(0, event.message.usage.output - estimatedFirstDeltaTokens)
          : Math.max(
              0,
              estimateContentTokens(contentCharacters) -
                estimatedFirstDeltaTokens,
            );

      // A single event or a sub-50ms burst has no useful observable cadence.
      if (contentDeltaCount >= 2 && streamMs >= 50 && streamedTokens > 0) {
        runContentTokens += streamedTokens;
        runContentStreamMs += streamMs;
        state = {
          ...state,
          tokensPerSecond: runContentTokens / (runContentStreamMs / 1000),
        };
      }
    }

    resetMessageTracking();
    refresh(ctx);
  });

  pi.on("turn_end", (_event, ctx) => refresh(ctx));

  pi.on("agent_settled", (_event, ctx) => {
    state = { ...state, generating: false };
    try {
      refresh(ctx);
    } catch (error) {
      if (!isStaleContextError(error)) throw error;
      currentContext = undefined;
      publish();
    }
  });

  pi.on("session_shutdown", () => {
    currentContext = undefined;
    childCosts.clear();
    persistedChildCosts.clear();
    resetMessageTracking();
    runContentTokens = 0;
    runContentStreamMs = 0;
    for (const dispose of disposeCallbacks.splice(0)) dispose();
  });
}
