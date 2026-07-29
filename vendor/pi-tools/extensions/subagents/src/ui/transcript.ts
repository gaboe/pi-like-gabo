/**
 * Transcript rendering for the takeover view: turns a SubagentSnapshot's
 * normalized transcript + live state into plain wrapped lines. Ported from
 * v1, with the session-poking replaced by snapshot reads.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
  SubagentSnapshot,
  TranscriptItem,
  TranscriptPart,
} from "../domain.ts";
import {
  getCompactToolRenderer,
  type CompactToolEntry,
} from "../../../shared/compact-tool-renderer-protocol.ts";

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/**
 * Strip raw ANSI codes, expand tabs, and drop control chars. Terminal-expanded
 * tabs (and stray escapes) make lines wider than the width we declare to the
 * TUI, which desyncs the renderer and smears the overlay.
 */
export function sanitizeText(text: string): string {
  return text
    .replace(ANSI_PATTERN, "")
    .replaceAll("\t", "  ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

function renderUserText(
  theme: Theme,
  text: string,
  width: number,
  out: string[],
) {
  const clean = sanitizeText(text).trim();
  if (!clean) return;
  const wrapped = wrapTextWithAnsi(clean, Math.max(10, width - 2));
  for (let i = 0; i < wrapped.length; i++) {
    const prefix = i === 0 ? theme.fg("accent", "> ") : "  ";
    out.push(
      truncateToWidth(prefix + theme.fg("userMessageText", wrapped[i]), width),
    );
  }
}

function renderThinking(
  theme: Theme,
  text: string,
  width: number,
  out: string[],
) {
  const reasoning = sanitizeText(text).trim();
  if (!reasoning) return;
  const prefix = theme.fg("dim", "~ ");
  const wrapped = wrapTextWithAnsi(reasoning, Math.max(10, width - 2));
  for (let i = 0; i < wrapped.length; i++) {
    out.push(
      truncateToWidth(
        (i === 0 ? prefix : "  ") + theme.fg("muted", theme.italic(wrapped[i])),
        width,
      ),
    );
  }
}

function renderAssistantPart(
  theme: Theme,
  part: Exclude<TranscriptPart, { type: "toolCall" }>,
  width: number,
  out: string[],
) {
  if (part.type === "text") {
    const text = sanitizeText(part.text).trim();
    if (text) out.push(...wrapTextWithAnsi(text, width));
    return;
  }
  renderThinking(
    theme,
    part.redacted ? "[redacted reasoning]" : part.text,
    width,
    out,
  );
}

function renderToolResultItem(
  theme: Theme,
  item: Extract<TranscriptItem, { kind: "toolResult" }>,
  width: number,
  out: string[],
) {
  const firstLine =
    sanitizeText(item.outputPreview ?? "")
      .split("\n")
      .find((line) => line.trim()) ?? "";
  const label = item.isError
    ? theme.fg("error", "  error: ")
    : theme.fg("dim", "  output: ");
  out.push(
    truncateToWidth(label + theme.fg("dim", firstLine || "(no output)"), width),
  );
}

export function createTranscriptLineCache() {
  let transcript: SubagentSnapshot["transcript"] | undefined;
  let transcriptLength = -1;
  let width = -1;
  let history: string[] = [];
  let lines: string[] = [];
  return {
    get(snap: SubagentSnapshot, nextWidth: number, theme: Theme) {
      if (
        transcript !== snap.transcript ||
        transcriptLength !== snap.transcript.length ||
        width !== nextWidth
      ) {
        transcript = snap.transcript;
        transcriptLength = snap.transcript.length;
        width = nextWidth;
        history = buildTranscriptLines(
          { ...snap, liveAssistant: undefined, liveTools: [], queued: [] },
          width,
          theme,
        );
      }
      if (!snap.liveAssistant && !snap.liveTools.length && !snap.queued.length)
        return history;
      const live = buildTranscriptLines(
        { ...snap, transcript: [], finalText: "" },
        width,
        theme,
      );
      lines =
        history.length && live.length
          ? [...history, "", ...live]
          : [...history, ...live];
      return lines;
    },
  };
}

/** Render a subagent's conversation as plain lines, wrapped to `width`. */
export function buildTranscriptLines(
  snap: SubagentSnapshot,
  width: number,
  theme: Theme,
): string[] {
  const out: string[] = [];
  const compactRenderer = getCompactToolRenderer();
  const renderer =
    compactRenderer?.enabled() === false ? undefined : compactRenderer;
  const results = new Map(
    snap.transcript
      .filter(
        (item): item is Extract<TranscriptItem, { kind: "toolResult" }> =>
          item.kind === "toolResult",
      )
      .map((item) => [item.toolId, item]),
  );
  const seenToolIds = new Set<string>();
  let pendingTools: CompactToolEntry[] = [];

  const finishSection = (before: number) => {
    if (out.length > before) out.push("");
  };
  const flushTools = () => {
    if (!pendingTools.length) return;
    const before = out.length;
    if (renderer) {
      out.push(
        ...renderer.render(pendingTools, { cwd: snap.cwd, width, theme }),
      );
    } else {
      for (const tool of pendingTools) {
        const preview = tool.args
          ? sanitizeText(JSON.stringify(tool.args))
          : "";
        out.push(
          truncateToWidth(
            theme.fg("muted", "→ ") +
              theme.fg("toolTitle", tool.name) +
              (preview && preview !== "{}"
                ? theme.fg("dim", ` ${preview}`)
                : ""),
            width,
          ),
        );
        renderToolResultItem(
          theme,
          {
            kind: "toolResult",
            toolId: tool.toolId,
            name: tool.name,
            isError: tool.isError ?? false,
            outputPreview: tool.output,
          },
          width,
          out,
        );
      }
    }
    pendingTools = [];
    finishSection(before);
  };
  const queueTool = (part: Extract<TranscriptPart, { type: "toolCall" }>) => {
    const result = results.get(part.toolId);
    seenToolIds.add(part.toolId);
    let args: unknown = part.argsPreview;
    if (part.argsPreview) {
      try {
        args = JSON.parse(part.argsPreview);
      } catch {}
    }
    pendingTools.push({
      toolId: part.toolId,
      name: part.name,
      args,
      output: result?.outputPreview,
      isError: result?.isError,
    });
  };

  for (const item of snap.transcript) {
    if (item.kind === "toolResult") continue;
    if (item.kind === "user") {
      flushTools();
      const before = out.length;
      renderUserText(theme, item.text, width, out);
      finishSection(before);
      continue;
    }
    for (const part of item.parts) {
      if (part.type === "toolCall") {
        queueTool(part);
      } else {
        flushTools();
        const before = out.length;
        renderAssistantPart(theme, part, width, out);
        finishSection(before);
      }
    }
  }
  for (const item of results.values()) {
    if (seenToolIds.has(item.toolId)) continue;
    pendingTools.push({
      toolId: item.toolId,
      name: item.name,
      output: item.outputPreview,
      isError: item.isError,
    });
  }
  flushTools();
  while (out.length > 0 && out[out.length - 1] === "") out.pop();

  // Live streaming assistant buffers (cleared when the finalized message lands).
  if (snap.liveAssistant) {
    const { thinking, text } = snap.liveAssistant;
    const before = out.length;
    const separated = before > 0;
    if (separated) out.push("");
    if (thinking.trim()) renderThinking(theme, thinking, width, out);
    if (text.trim())
      out.push(...wrapTextWithAnsi(sanitizeText(text).trim(), width));
    if (separated && out.length === before + 1) out.pop();
  }

  // Live tool executions (present until the ToolEnd lands in the transcript).
  if (snap.liveTools.length > 0) {
    if (out.length > 0) out.push("");
    if (renderer) {
      out.push(
        ...renderer.render(
          snap.liveTools.map((tool) => {
            let args: unknown = tool.argsPreview;
            if (tool.argsPreview) {
              try {
                args = JSON.parse(tool.argsPreview);
              } catch {}
            }
            return {
              toolId: tool.toolId,
              name: tool.name,
              args,
              output: tool.outputPreview,
              isError: tool.isError,
              running: !tool.done,
            };
          }),
          { cwd: snap.cwd, width, theme },
        ),
      );
    } else {
      for (const tool of snap.liveTools) {
        const marker = tool.done
          ? tool.isError
            ? theme.fg("error", "error")
            : theme.fg("success", "done")
          : theme.fg("warning", "running");
        let line = `${theme.fg("toolTitle", tool.name)} · ${marker}`;
        const preview = tool.outputPreview && sanitizeText(tool.outputPreview);
        if (preview) line += theme.fg("dim", ` · ${preview}`);
        out.push(truncateToWidth(line, width));
      }
    }
  }

  // Queued steering/follow-up messages: show them immediately so Enter
  // visibly acknowledges the user's input instead of appearing to do nothing.
  for (const message of snap.queued) {
    if (out.length > 0) out.push("");
    const prefix = theme.fg("warning", `> [queued ${message.kind}] `);
    const wrapped = wrapTextWithAnsi(
      sanitizeText(message.text),
      Math.max(10, width - visibleWidth(prefix)),
    );
    for (let i = 0; i < wrapped.length; i++) {
      out.push(
        truncateToWidth(
          (i === 0 ? prefix : " ".repeat(visibleWidth(prefix))) +
            theme.fg("muted", wrapped[i]),
          width,
        ),
      );
    }
  }

  return out;
}
