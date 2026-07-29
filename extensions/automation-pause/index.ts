import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  requestAutomationPause,
  type AutomationPauseResult,
} from "../../vendor/pi-tools/extensions/shared/automation-pause-protocol.js";

const DOUBLE_ESCAPE_MS = 500;
const ESCAPE = "\u001b";

export class DoubleEscapePauseDetector {
  private firstEscapeAt = 0;
  private firstEscapeHadParent = false;

  handle(options: {
    data: string;
    now: number;
    editorEmpty: boolean;
    parentActive: boolean;
    pause: () => AutomationPauseResult;
  }): AutomationPauseResult & { consume: boolean } {
    if (options.data !== ESCAPE || !options.editorEmpty) {
      this.firstEscapeAt = 0;
      this.firstEscapeHadParent = false;
      return { count: 0, sources: [], consume: false };
    }

    if (
      this.firstEscapeAt > 0 &&
      options.now - this.firstEscapeAt < DOUBLE_ESCAPE_MS
    ) {
      const parentActive = this.firstEscapeHadParent || options.parentActive;
      this.firstEscapeAt = 0;
      this.firstEscapeHadParent = false;
      const result = options.pause();
      return {
        count: result.count + (parentActive ? 1 : 0),
        sources: parentActive
          ? [
              "parent",
              ...result.sources.filter((source) => source !== "parent"),
            ]
          : result.sources,
        consume: parentActive || result.count > 0,
      };
    }

    this.firstEscapeAt = options.now;
    this.firstEscapeHadParent = options.parentActive;
    return { count: 0, sources: [], consume: false };
  }
}

export default function automationPause(pi: ExtensionAPI) {
  let stopInput: (() => void) | undefined;
  const detector = new DoubleEscapePauseDetector();

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    stopInput?.();
    stopInput = ctx.ui.onTerminalInput((data) => {
      const editorEmpty = ctx.ui.getEditorText().trim().length === 0;
      const parentActive = !ctx.isIdle();
      const result = detector.handle({
        data,
        now: Date.now(),
        editorEmpty,
        parentActive,
        pause: () => requestAutomationPause(pi.events),
      });
      if (result.consume) {
        ctx.ui.notify(
          `Paused ${result.count} active operation${result.count === 1 ? "" : "s"}: ${result.sources.join(", ")}.`,
          "warning",
        );
        return { consume: true };
      }
      if (data === ESCAPE && editorEmpty && parentActive) {
        ctx.abort();
        return { consume: true };
      }
    });
  });

  pi.on("session_shutdown", () => {
    stopInput?.();
    stopInput = undefined;
  });
}
