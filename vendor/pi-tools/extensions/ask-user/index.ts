/**
 * ask_user - Lets the model ask a single multiple-choice question.
 *
 * - 2 to 5 model-provided options, plus an always-present "Write my own answer" option
 * - Popup UI: choose one option by default or multiple options when enabled
 * - "Write my own answer" opens an inline editor (Esc returns to the options)
 * - Esc on the options dismisses the question (the model is told you declined)
 */

import {
  highlightCode,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  ASK_USER_PARAMETER_DESCRIPTIONS,
  ASK_USER_PROMPT_GUIDELINES,
  ASK_USER_PROMPT_SNIPPET,
  ASK_USER_TOOL_DESCRIPTION,
  buildAskUserResultMessage,
} from "./prompt.ts";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;

const OptionSchema = Type.Object({
  label: Type.String({
    maxLength: 160,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.optionLabel,
  }),
  description: Type.Optional(
    Type.String({
      maxLength: 500,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.optionDescription,
    }),
  ),
  details: Type.Optional(
    Type.String({
      maxLength: 3_000,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.optionDetails,
    }),
  ),
});

const ExplanationModeSchema = Type.Object({
  label: Type.String({
    maxLength: 160,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.explanationMode,
  }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  details: Type.Optional(Type.String({ maxLength: 3_000 })),
});

const ExplanationSchema = Type.Object(
  {
    label: Type.String({
      maxLength: 160,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.explanationLabel,
    }),
    description: Type.Optional(Type.String({ maxLength: 500 })),
    question: Type.String({
      maxLength: 1_000,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.explanationQuestion,
    }),
    answerLabel: Type.String({
      maxLength: 160,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.answerLabel,
    }),
    rationale: ExplanationModeSchema,
    flow: ExplanationModeSchema,
    code: ExplanationModeSchema,
    alternatives: ExplanationModeSchema,
    custom: ExplanationModeSchema,
  },
  { description: ASK_USER_PARAMETER_DESCRIPTIONS.explanation },
);

const AskUserParams = Type.Object({
  multiSelect: Type.Optional(
    Type.Boolean({
      description: ASK_USER_PARAMETER_DESCRIPTIONS.multiSelect,
    }),
  ),
  explanation: Type.Optional(ExplanationSchema),
  context: Type.Optional(
    Type.String({
      maxLength: 2_000,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.context,
    }),
  ),
  considerations: Type.Optional(
    Type.Array(Type.String({ maxLength: 500 }), {
      minItems: 1,
      maxItems: 5,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.considerations,
    }),
  ),
  recommendation: Type.Optional(
    Type.String({
      maxLength: 1_000,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.recommendation,
    }),
  ),
  approvalScope: Type.Optional(
    Type.String({
      maxLength: 1_500,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.approvalScope,
    }),
  ),
  question: Type.String({
    maxLength: 1_000,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.question,
  }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
  }),
});

export type AskUserInput = Static<typeof AskUserParams>;

type ExplanationInput = Static<typeof ExplanationSchema>;
type ExplanationMode =
  "rationale" | "flow" | "code" | "alternatives" | "custom";

interface AskUserDetails {
  question: string;
  context?: string;
  considerations?: string[];
  recommendation?: string;
  approvalScope?: string;
  options: string[];
  multiSelect: boolean;
  answer: string | null;
  answers?: string[];
  indices?: number[];
  wasCustom: boolean;
  cancelled: boolean;
  explanationRequested: boolean;
  explanationMode?: ExplanationMode;
  explanationModes?: ExplanationMode[];
  explanationRequest?: string;
}

type SelectionResult =
  | { kind: "selected"; answer: string; index: number }
  | { kind: "selected-many"; answers: string[]; indices: number[] }
  | { kind: "custom"; answer: string }
  | {
      kind: "explanation";
      modes: ExplanationMode[];
      request?: string;
    }
  | null;

export interface DisplayOption {
  label: string;
  description?: string;
  details?: string;
  isOther?: boolean;
  isExplanation?: boolean;
  explanationMode?: ExplanationMode;
  isChecked?: boolean;
}

const EXPLANATION_MODES: ExplanationMode[] = [
  "rationale",
  "flow",
  "code",
  "alternatives",
  "custom",
];

const DEFAULT_EXPLANATION: ExplanationInput = {
  label: "Explain more…",
  description:
    "Ask for rationale, flow, code/diff, alternatives, or clarify your own concern.",
  question: "What would make this decision clearer?",
  answerLabel: "Write my own answer…",
  rationale: {
    label: "Explain rationale and trade-offs",
    description: "Why this is needed, what it optimizes, and material risks.",
  },
  flow: {
    label: "Show the flow step by step",
    description: "Walk through the resulting behavior from start to finish.",
  },
  code: {
    label: "Show a code or diff example",
    description:
      "Provide the concrete proposed implementation before deciding.",
  },
  alternatives: {
    label: "Compare the alternatives",
    description:
      "Contrast consequences, reversibility, and when each option fits.",
  },
  custom: {
    label: "Ask a specific clarification",
    description: "Write what is still unclear in your own words.",
  },
};

function explanationOptions(copy: ExplanationInput): DisplayOption[] {
  return EXPLANATION_MODES.map((mode) => ({
    ...copy[mode],
    explanationMode: mode,
    isOther: mode === "custom",
  }));
}

function optionMarker(option: DisplayOption, index: number): string {
  if (typeof option.isChecked === "boolean")
    return option.isChecked ? "[x]" : "[ ]";
  if (option.isExplanation) return "?";
  if (option.isOther) return "✎";
  return `${index + 1}.`;
}

export interface AskUserContextSection {
  label: string;
  text: string;
}

export function buildAskUserContextSections(
  input: Pick<
    AskUserInput,
    "context" | "considerations" | "recommendation" | "approvalScope"
  >,
): AskUserContextSection[] {
  const sections: AskUserContextSection[] = [];
  if (input.context?.trim()) {
    sections.push({ label: "Context", text: input.context.trim() });
  }
  if (input.considerations?.length) {
    sections.push({
      label: "Considerations",
      text: input.considerations.map((item) => `• ${item.trim()}`).join("\n"),
    });
  }
  if (input.recommendation?.trim()) {
    sections.push({
      label: "Recommendation",
      text: input.recommendation.trim(),
    });
  }
  if (input.approvalScope?.trim()) {
    sections.push({
      label: "Approval scope",
      text: input.approvalScope.trim(),
    });
  }
  return sections;
}

function splitVisibleWord(word: string, width: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of Array.from(word)) {
    if (chunk && visibleWidth(chunk + character) > width) {
      chunks.push(chunk);
      chunk = character;
    } else {
      chunk += character;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function wrapText(text: string, width: number): string[] {
  width = Math.max(1, width);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const chunks = splitVisibleWord(word, width);
      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index];
        const candidate = current ? `${current} ${chunk}` : chunk;
        if (visibleWidth(candidate) > width && current) {
          lines.push(current);
          current = chunk;
        } else {
          current = candidate;
        }
        if (index < chunks.length - 1) {
          lines.push(current);
          current = "";
        }
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

function limitedWrap(text: string, width: number, maxLines: number): string[] {
  const lines = wrapText(text, width);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = truncateToWidth(
    `${kept[maxLines - 1]}…`,
    Math.max(1, width),
    "…",
  );
  return kept;
}

function markdownThemeFrom(theme: Theme): MarkdownTheme {
  const styled = (
    method: "bold" | "italic" | "strikethrough" | "underline",
    text: string,
  ) => theme[method]?.(text) ?? text;
  return {
    heading: (text) => theme.fg("mdHeading", text),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => styled("bold", text),
    italic: (text) => styled("italic", text),
    strikethrough: (text) => styled("strikethrough", text),
    underline: (text) => styled("underline", text),
    highlightCode(code, language) {
      try {
        return highlightCode(code, language);
      } catch {
        return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
      }
    },
  };
}

function askUserMarkdownTheme(base: MarkdownTheme): MarkdownTheme {
  let insideCodeBlock = false;
  return {
    ...base,
    codeBlockIndent: "│ ",
    codeBlockBorder(fence) {
      const opening = !insideCodeBlock;
      insideCodeBlock = !insideCodeBlock;
      const language = opening ? fence.slice(3).trim() : "";
      return base.codeBlockBorder(
        opening ? `┌─${language ? ` ${language}` : ""}` : "└─",
      );
    },
  };
}

function renderMarkdownLines(
  text: string,
  width: number,
  theme: MarkdownTheme,
): string[] {
  const lines = new Markdown(text, 0, 0, askUserMarkdownTheme(theme)).render(
    Math.max(1, width),
  );
  while (lines.at(-1)?.trim() === "") lines.pop();
  return lines;
}

export function renderAskUserLayout(options: {
  params: AskUserInput;
  allOptions: DisplayOption[];
  optionIndex: number;
  editMode: boolean;
  width: number;
  theme: Theme;
  markdownTheme?: MarkdownTheme;
  expanded?: boolean;
  scrollOffset?: number;
  viewportHeight?: number;
  editorLines?: string[];
  multiSelect?: boolean;
}): string[] {
  const { params, optionIndex, editMode, theme } = options;
  const width = Math.max(1, Math.floor(options.width));
  const allOptions = options.allOptions.slice(0, MAX_OPTIONS + 2);
  const question = params.question.slice(0, 1_000);
  const lines: string[] = [];
  const add = (line: string) => lines.push(truncateToWidth(line, width));
  const sections = buildAskUserContextSections(params).map((section) => ({
    ...section,
    text: section.text.slice(0, 2_500),
  }));
  const rich =
    sections.length > 0 || allOptions.some((option) => option.details?.trim());
  const markdownTheme =
    options.markdownTheme ?? markdownThemeFrom(options.theme);
  const sectionStyle: Record<
    string,
    { icon: string; color: "text" | "muted" | "success" | "warning" }
  > = {
    Context: { icon: "●", color: "text" },
    Considerations: { icon: "◆", color: "muted" },
    Recommendation: { icon: "✓", color: "success" },
    "Approval scope": { icon: "⚠", color: "warning" },
  };
  const sectionLineLimits: Record<string, number> = {
    Context: 4,
    Considerations: 3,
    Recommendation: 2,
    "Approval scope": 2,
  };

  if (options.expanded && rich) {
    const detailWidth = Math.max(1, width < 24 ? width : width - 7);
    const detailLines: string[] = [];
    for (const section of sections) {
      const style = sectionStyle[section.label] ?? {
        icon: "•",
        color: "text" as const,
      };
      detailLines.push(
        `${theme.fg(style.color, style.icon)} ${theme.fg("accent", theme.bold(section.label.toUpperCase()))}`,
      );
      detailLines.push(
        ...renderMarkdownLines(
          section.text,
          detailWidth - 2,
          markdownTheme,
        ).map((line) => `  ${line}`),
        "",
      );
    }
    const questionStyle = sectionStyle.Context;
    detailLines.push(
      `${theme.fg(questionStyle.color, "?")} ${theme.fg("accent", theme.bold("QUESTION"))}`,
      ...renderMarkdownLines(question, detailWidth - 2, markdownTheme).map(
        (line) => `  ${line}`,
      ),
      "",
      `${theme.fg("text", "◆")} ${theme.fg("accent", theme.bold("OPTIONS"))}`,
    );
    for (let index = 0; index < allOptions.length; index++) {
      const option = allOptions[index];
      const prefix = `  ${optionMarker(option, index)} `;
      const optionLabelLines = wrapText(
        option.label.slice(0, 160),
        Math.max(1, detailWidth - visibleWidth(prefix)),
      );
      detailLines.push(
        ...optionLabelLines.map(
          (line, lineIndex) =>
            `${lineIndex === 0 ? prefix : " ".repeat(visibleWidth(prefix))}${line}`,
        ),
      );
      if (option.description) {
        detailLines.push(
          ...renderMarkdownLines(
            option.description.slice(0, 500),
            detailWidth - 4,
            markdownTheme,
          ).map((line) => `    ${line}`),
        );
      }
      if (option.details?.trim()) {
        detailLines.push(
          `    ${theme.fg("accent", theme.bold("Proposal"))}`,
          ...renderMarkdownLines(
            option.details.slice(0, 3_000),
            detailWidth - 4,
            markdownTheme,
          ).map((line) => `    ${line}`),
        );
      }
    }
    while (detailLines.at(-1) === "") detailLines.pop();

    const viewportHeight = Math.max(
      4,
      Math.floor(options.viewportHeight ?? detailLines.length + 1),
    );
    const bodyHeight = Math.max(1, viewportHeight - 1);
    const maxScroll = Math.max(0, detailLines.length - bodyHeight);
    const scrollOffset = Math.min(
      Math.max(0, Math.floor(options.scrollOffset ?? 0)),
      maxScroll,
    );
    const visibleDetails = detailLines.slice(
      scrollOffset,
      scrollOffset + bodyHeight,
    );
    const position = `${scrollOffset + 1}-${Math.min(detailLines.length, scrollOffset + bodyHeight)} / ${detailLines.length}`;
    const hint = maxScroll
      ? "↑↓ line • PgUp/PgDn page • e/Esc back"
      : "e/Esc back";

    if (width < 24) {
      add(theme.fg("accent", theme.bold(`Details ${position}`)));
      for (const line of visibleDetails) add(line);
      add(theme.fg("dim", hint));
      return lines;
    }

    const rail = theme.fg("accent", "│");
    const framed = (line = "") => {
      const body = truncateToWidth(
        `${rail}${line ? ` ${line}` : ""}`,
        width - 1,
      );
      add(
        `${body}${" ".repeat(Math.max(0, width - visibleWidth(body) - 1))}${rail}`,
      );
    };
    const heading = " Decision details ";
    add(
      theme.fg(
        "accent",
        `╭─${heading}${"─".repeat(Math.max(0, width - heading.length - 3))}╮`,
      ),
    );
    framed(theme.fg("dim", position));
    for (const line of visibleDetails) framed(line);
    framed(theme.fg("dim", hint));
    add(theme.fg("accent", `╰${"─".repeat(Math.max(0, width - 2))}╯`));
    return lines;
  }

  if (width < 24) {
    add(theme.fg("accent", theme.bold("Question")));
    for (const line of limitedWrap(question, width, 5))
      add(theme.fg("text", line));
    for (let index = 0; index < allOptions.length; index++) {
      const option = allOptions[index];
      const marker = optionMarker(option, index);
      const prefix = `${index === optionIndex ? "❯" : " "} ${marker} `;
      const prefixWidth = visibleWidth(prefix);
      const labelWidth = Math.max(1, width - prefixWidth);
      const labelLines = limitedWrap(
        option.label.slice(0, 160),
        prefixWidth >= width || labelWidth < 3 ? width : labelWidth,
        10,
      );
      if (prefixWidth >= width || labelWidth < 3) {
        add(prefix);
        for (const line of labelLines) add(line);
      } else {
        add(`${prefix}${labelLines[0] ?? ""}`);
        for (const line of labelLines.slice(1))
          add(`${" ".repeat(prefixWidth)}${line}`);
      }
      if (option.description) {
        for (const line of limitedWrap(
          option.description.slice(0, 500),
          width,
          4,
        ))
          add(theme.fg("muted", line));
      }
    }
    const selectedDetails = allOptions[optionIndex]?.details?.trim();
    if (selectedDetails) {
      add(theme.fg("accent", theme.bold("Selected option")));
      const rendered = renderMarkdownLines(
        selectedDetails.slice(0, 3_000),
        width,
        markdownTheme,
      );
      for (const line of rendered.slice(0, 6)) add(line);
      if (rendered.length > 6) add(theme.fg("dim", "…"));
    }
    if (options.multiSelect) {
      add(
        theme.fg(
          "dim",
          `Space toggle • Enter ${params.multiSelect ? "confirm" : "explain"} • Esc ${params.multiSelect ? "dismiss" : "back"}`,
        ),
      );
    } else if (rich) {
      add(theme.fg("dim", "e details"));
    }
    return lines;
  }

  const contentWidth = Math.max(10, width - 5);
  const rail = theme.fg("accent", "│");
  const framed = (line = "") => {
    const body = truncateToWidth(`${rail}${line ? ` ${line}` : ""}`, width - 1);
    add(
      `${body}${" ".repeat(Math.max(0, width - visibleWidth(body) - 1))}${rail}`,
    );
  };
  const heading = rich ? " Decision required " : " Question ";
  add(
    theme.fg(
      "accent",
      `╭─${heading}${"─".repeat(Math.max(0, width - heading.length - 3))}╮`,
    ),
  );

  let detailsHidden = false;
  for (const section of sections) {
    const style = sectionStyle[section.label] ?? {
      icon: "•",
      color: "text" as const,
    };
    framed(
      `${theme.fg(style.color, style.icon)} ${theme.fg("accent", theme.bold(section.label.toUpperCase()))}`,
    );
    const rendered = renderMarkdownLines(
      section.text,
      contentWidth - 2,
      markdownTheme,
    );
    const limit = sectionLineLimits[section.label] ?? 6;
    const hidden = rendered.length > limit;
    detailsHidden ||= hidden;
    for (const line of rendered.slice(0, limit)) framed(`  ${line}`);
    if (hidden) framed(`  ${theme.fg("dim", "…")}`);
    framed();
  }

  if (sections.length > 0) {
    const label = " DECISION ";
    add(
      theme.fg(
        "accent",
        `├─${label}${"─".repeat(Math.max(0, width - label.length - 3))}┤`,
      ),
    );
  }
  const questionLines = wrapText(question, contentWidth);
  detailsHidden ||= questionLines.length > 4;
  for (const line of questionLines.slice(0, 4)) {
    framed(theme.fg("text", theme.bold(line)));
  }
  if (questionLines.length > 4) framed(theme.fg("dim", "…"));
  framed();

  for (let i = 0; i < allOptions.length; i++) {
    const option = allOptions[i];
    const selected = i === optionIndex;
    const marker = optionMarker(option, i);
    const prefix = `${selected ? "❯" : " "} ${marker} `;
    const fullLabelLines = wrapText(
      option.label.slice(0, 160),
      Math.max(1, contentWidth - visibleWidth(prefix)),
    );
    const labelLines = fullLabelLines.slice(0, 2);
    detailsHidden ||= fullLabelLines.length > labelLines.length;
    for (let lineIndex = 0; lineIndex < labelLines.length; lineIndex++) {
      const label = `${lineIndex === 0 ? prefix : " ".repeat(visibleWidth(prefix))}${labelLines[lineIndex]}`;
      framed(
        selected
          ? theme.fg("accent", theme.bold(label))
          : theme.fg(option.isOther ? "muted" : "text", label),
      );
    }
    if (fullLabelLines.length > labelLines.length) {
      framed(`${" ".repeat(visibleWidth(prefix))}${theme.fg("dim", "…")}`);
    }
    if (option.description) {
      const descriptionLines = wrapText(
        option.description.slice(0, 500),
        contentWidth - 4,
      );
      detailsHidden ||= descriptionLines.length > 2;
      for (const line of descriptionLines.slice(0, 2)) {
        framed(`    ${theme.fg("muted", line)}`);
      }
      if (descriptionLines.length > 2) framed(`    ${theme.fg("dim", "…")}`);
    }
  }

  const selectedDetails = allOptions[optionIndex]?.details?.trim();
  if (selectedDetails) {
    const label = " SELECTED OPTION ";
    add(
      theme.fg(
        "accent",
        `├─${label}${"─".repeat(Math.max(0, width - label.length - 3))}┤`,
      ),
    );
    framed(
      theme.fg(
        "accent",
        theme.bold(allOptions[optionIndex].label.slice(0, 160)),
      ),
    );
    const rendered = renderMarkdownLines(
      selectedDetails.slice(0, 3_000),
      contentWidth,
      markdownTheme,
    );
    detailsHidden ||= rendered.length > 16;
    for (const line of rendered.slice(0, 16)) framed(line);
    if (rendered.length > 16) framed(theme.fg("dim", "…"));
  }

  if (editMode) {
    framed();
    framed(theme.fg("muted", "Your answer:"));
    for (const line of (options.editorLines ?? []).slice(0, 8)) framed(line);
  }

  framed();
  framed(
    theme.fg(
      "dim",
      editMode
        ? "Enter submit • Esc back to options"
        : options.multiSelect
          ? `${rich ? `${detailsHidden ? "e expand" : "e details"} • ` : ""}↑↓ move • Space or 1-${allOptions.length} toggle • Enter ${params.multiSelect ? "confirm" : "explain"} • Esc ${params.multiSelect ? "dismiss" : "back"}`
          : `${rich ? `${detailsHidden ? "e expand" : "e details"} • ` : ""}↑↓ or 1-${allOptions.length} select • Enter confirm • Esc dismiss`,
    ),
  );
  add(theme.fg("accent", `╰${"─".repeat(Math.max(0, width - 2))}╯`));
  return lines;
}

export default function askUser(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: ASK_USER_TOOL_DESCRIPTION,
    promptSnippet: ASK_USER_PROMPT_SNIPPET,
    promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
    parameters: AskUserParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const reply = (
        text: string,
        outcome: {
          answer?: string;
          answers?: string[];
          indices?: number[];
          wasCustom?: boolean;
          cancelled?: boolean;
          explanationModes?: ExplanationMode[];
          explanationRequest?: string;
        } = {},
      ) => ({
        content: [{ type: "text" as const, text }],
        details: {
          question: params.question,
          context: params.context,
          considerations: params.considerations,
          recommendation: params.recommendation,
          approvalScope: params.approvalScope,
          options: params.options.map((o) => o.label),
          multiSelect: params.multiSelect ?? false,
          answer: outcome.answer ?? null,
          answers: outcome.answers,
          indices: outcome.indices,
          wasCustom: outcome.wasCustom ?? false,
          cancelled: outcome.cancelled ?? true,
          explanationRequested: Boolean(outcome.explanationModes?.length),
          explanationMode: outcome.explanationModes?.[0],
          explanationModes: outcome.explanationModes,
          explanationRequest: outcome.explanationRequest,
        } satisfies AskUserDetails,
      });

      if (
        params.options.length < MIN_OPTIONS ||
        params.options.length > MAX_OPTIONS
      ) {
        throw new Error(
          `ask_user requires between ${MIN_OPTIONS} and ${MAX_OPTIONS} options (got ${params.options.length}). Retry with a valid number of options.`,
        );
      }

      if (ctx.mode !== "tui") {
        return reply(buildAskUserResultMessage({ kind: "no-ui" }));
      }

      if (signal?.aborted) {
        return reply(buildAskUserResultMessage({ kind: "cancelled" }));
      }

      const explanation = params.explanation ?? DEFAULT_EXPLANATION;
      const explanationMenuOptions = explanationOptions(explanation);
      const allOptions: DisplayOption[] = [
        ...params.options,
        {
          label: explanation.label,
          description: explanation.description,
          isExplanation: true,
        },
        { label: explanation.answerLabel, isOther: true },
      ];

      const showQuestion = (uiSignal: AbortSignal) =>
        ctx.ui.custom<SelectionResult>((tui, theme, _kb, done) => {
          let optionIndex = 0;
          let explanationIndex = 0;
          let explanationMenu = false;
          const selectedExplanationModes = new Set<ExplanationMode>();
          const selectedDecisionIndices = new Set<number>();
          let editMode = false;
          let editorPurpose: "answer" | "explanation" = "answer";
          let expanded = false;
          let scrollOffset = 0;
          let cachedLines: string[] | undefined;
          let cachedWidth: number | undefined;
          let cachedRows: number | undefined;
          const hasDetails =
            buildAskUserContextSections(params).length > 0 ||
            params.options.some((option) => option.details?.trim());
          const hasExplanationDetails = explanationMenuOptions.some((option) =>
            option.details?.trim(),
          );
          const markdownTheme = markdownThemeFrom(theme);

          let settled = false;

          function finish(result: SelectionResult) {
            if (settled) return;
            settled = true;
            uiSignal.removeEventListener("abort", cancel);
            done(result);
          }

          function cancel() {
            finish(null);
          }

          uiSignal.addEventListener("abort", cancel, { once: true });
          if (uiSignal.aborted) queueMicrotask(cancel);

          const editorTheme: EditorTheme = {
            borderColor: (s) => theme.fg("accent", s),
            selectList: {
              selectedPrefix: (t) => theme.fg("accent", t),
              selectedText: (t) => theme.fg("accent", t),
              description: (t) => theme.fg("muted", t),
              scrollInfo: (t) => theme.fg("dim", t),
              noMatch: (t) => theme.fg("warning", t),
            },
          };
          const editor = new Editor(tui, editorTheme);

          editor.onSubmit = (value) => {
            const trimmed = value.trim();
            if (trimmed) {
              finish(
                editorPurpose === "explanation"
                  ? {
                      kind: "explanation",
                      modes: EXPLANATION_MODES.filter(
                        (mode) =>
                          mode === "custom" ||
                          selectedExplanationModes.has(mode),
                      ),
                      request: trimmed,
                    }
                  : { kind: "custom", answer: trimmed },
              );
            } else {
              editMode = false;
              editor.setText("");
              refresh();
            }
          };

          function refresh() {
            cachedLines = undefined;
            cachedWidth = undefined;
            cachedRows = undefined;
            tui.requestRender();
          }

          function selectOption(index: number) {
            const selected = allOptions[index];
            if (selected.isExplanation) {
              optionIndex = index;
              explanationIndex = 0;
              selectedExplanationModes.clear();
              for (const mode of EXPLANATION_MODES) {
                if (mode !== "custom") selectedExplanationModes.add(mode);
              }
              explanationMenu = true;
              refresh();
              return;
            }
            if (selected.isOther) {
              optionIndex = index;
              editorPurpose = "answer";
              editMode = true;
              refresh();
              return;
            }
            finish({
              kind: "selected",
              answer: selected.label,
              index: index + 1,
            });
          }

          function toggleDecision(index: number) {
            if (index < 0 || index >= params.options.length) return;
            optionIndex = index;
            if (selectedDecisionIndices.has(index)) {
              selectedDecisionIndices.delete(index);
            } else {
              selectedDecisionIndices.add(index);
            }
            refresh();
          }

          function submitDecisions() {
            const indices = [...selectedDecisionIndices]
              .sort((left, right) => left - right)
              .map((index) => index + 1);
            if (indices.length === 0) return;
            finish({
              kind: "selected-many",
              answers: indices.map((index) => params.options[index - 1].label),
              indices,
            });
          }

          function toggleExplanation(index: number) {
            const mode = explanationMenuOptions[index].explanationMode;
            if (!mode) return;
            explanationIndex = index;
            if (mode === "custom") {
              editorPurpose = "explanation";
              editMode = true;
              refresh();
              return;
            }
            if (selectedExplanationModes.has(mode)) {
              selectedExplanationModes.delete(mode);
            } else {
              selectedExplanationModes.add(mode);
            }
            refresh();
          }

          function submitExplanation() {
            const modes = EXPLANATION_MODES.filter((mode) =>
              selectedExplanationModes.has(mode),
            );
            if (modes.length > 0) {
              finish({ kind: "explanation", modes });
              return;
            }
            const mode =
              explanationMenuOptions[explanationIndex].explanationMode;
            if (mode === "custom") {
              toggleExplanation(explanationIndex);
              return;
            }
            if (mode) finish({ kind: "explanation", modes: [mode] });
          }

          function handleInput(data: string) {
            if (expanded) {
              if (data.toLowerCase() === "e" || matchesKey(data, Key.escape)) {
                expanded = false;
                scrollOffset = 0;
                refresh();
                return;
              }
              if (matchesKey(data, Key.up)) {
                scrollOffset = Math.max(0, scrollOffset - 1);
                refresh();
                return;
              }
              if (matchesKey(data, Key.down)) {
                scrollOffset += 1;
                refresh();
                return;
              }
              const pageSize = Math.max(1, tui.terminal.rows - 10);
              if (matchesKey(data, Key.pageUp)) {
                scrollOffset = Math.max(0, scrollOffset - pageSize);
                refresh();
                return;
              }
              if (matchesKey(data, Key.pageDown)) {
                scrollOffset += pageSize;
                refresh();
              }
              return;
            }

            if (editMode) {
              if (matchesKey(data, Key.escape)) {
                editMode = false;
                editor.setText("");
                refresh();
                return;
              }
              editor.handleInput(data);
              refresh();
              return;
            }

            if (explanationMenu) {
              if (data.toLowerCase() === "e" && hasExplanationDetails) {
                expanded = true;
                scrollOffset = 0;
                refresh();
                return;
              }
              if (matchesKey(data, Key.up)) {
                explanationIndex =
                  (explanationIndex - 1 + explanationMenuOptions.length) %
                  explanationMenuOptions.length;
                refresh();
                return;
              }
              if (matchesKey(data, Key.down)) {
                explanationIndex =
                  (explanationIndex + 1) % explanationMenuOptions.length;
                refresh();
                return;
              }
              if (
                data.length === 1 &&
                data >= "1" &&
                data <= String(explanationMenuOptions.length)
              ) {
                toggleExplanation(Number(data) - 1);
                return;
              }
              if (data === " ") {
                toggleExplanation(explanationIndex);
                return;
              }
              if (matchesKey(data, Key.enter)) {
                submitExplanation();
                return;
              }
              if (matchesKey(data, Key.escape)) {
                explanationMenu = false;
                explanationIndex = 0;
                refresh();
              }
              return;
            }

            if (data.toLowerCase() === "e" && hasDetails) {
              expanded = true;
              scrollOffset = 0;
              refresh();
              return;
            }

            if (matchesKey(data, Key.up)) {
              optionIndex =
                (optionIndex - 1 + allOptions.length) % allOptions.length;
              refresh();
              return;
            }
            if (matchesKey(data, Key.down)) {
              optionIndex = (optionIndex + 1) % allOptions.length;
              refresh();
              return;
            }

            if (
              data.length === 1 &&
              data >= "1" &&
              data <= String(allOptions.length)
            ) {
              const index = Number(data) - 1;
              if (params.multiSelect && index < params.options.length) {
                toggleDecision(index);
              } else {
                selectOption(index);
              }
              return;
            }

            if (
              params.multiSelect &&
              data === " " &&
              optionIndex < params.options.length
            ) {
              toggleDecision(optionIndex);
              return;
            }

            if (matchesKey(data, Key.enter)) {
              if (params.multiSelect && optionIndex < params.options.length) {
                submitDecisions();
              } else {
                selectOption(optionIndex);
              }
              return;
            }

            if (matchesKey(data, Key.escape)) {
              finish(null);
            }
          }

          function render(width: number): string[] {
            const rows = tui.terminal.rows;
            if (cachedLines && cachedWidth === width && cachedRows === rows)
              return cachedLines;
            cachedWidth = width;
            cachedRows = rows;
            const activeExplanationOptions = explanationMenuOptions.map(
              (option) =>
                option.explanationMode === "custom"
                  ? option
                  : {
                      ...option,
                      isChecked: selectedExplanationModes.has(
                        option.explanationMode!,
                      ),
                    },
            );
            const activeParams: AskUserInput = explanationMenu
              ? {
                  question: explanation.question,
                  options: activeExplanationOptions.map(
                    ({ label, description, details }) => ({
                      label,
                      description,
                      details,
                    }),
                  ),
                }
              : params;
            const activeDecisionOptions = params.multiSelect
              ? allOptions.map((option, index) =>
                  index < params.options.length
                    ? {
                        ...option,
                        isChecked: selectedDecisionIndices.has(index),
                      }
                    : option,
                )
              : allOptions;
            cachedLines = renderAskUserLayout({
              params: activeParams,
              allOptions: explanationMenu
                ? activeExplanationOptions
                : activeDecisionOptions,
              optionIndex: explanationMenu ? explanationIndex : optionIndex,
              editMode,
              expanded,
              scrollOffset,
              viewportHeight: Math.max(6, rows - 8),
              width,
              theme,
              markdownTheme,
              multiSelect: explanationMenu || Boolean(params.multiSelect),
              editorLines: editMode
                ? editor.render(Math.max(1, width - 5))
                : [],
            });
            return cachedLines;
          }

          return {
            render,
            invalidate: () => {
              cachedLines = undefined;
              cachedWidth = undefined;
              cachedRows = undefined;
            },
            handleInput,
            dispose: () => {
              uiSignal.removeEventListener("abort", cancel);
            },
          };
        });

      const uiSignal = signal ?? new AbortController().signal;
      let cancelled = false;
      const result = await new Promise<SelectionResult>((resolve, reject) => {
        let settled = false;
        const finish = (value: SelectionResult) => {
          if (settled) return;
          settled = true;
          uiSignal.removeEventListener("abort", cancel);
          resolve(value);
        };
        const cancel = () => {
          cancelled = true;
          finish(null);
        };

        uiSignal.addEventListener("abort", cancel, { once: true });
        if (uiSignal.aborted) {
          cancel();
        } else {
          void showQuestion(uiSignal).then(finish, (error) => {
            if (settled) return;
            settled = true;
            uiSignal.removeEventListener("abort", cancel);
            reject(error);
          });
        }
      });

      if (cancelled) {
        return reply(buildAskUserResultMessage({ kind: "cancelled" }));
      }

      if (!result) {
        return reply(buildAskUserResultMessage({ kind: "dismissed" }));
      }

      if (result.kind === "custom") {
        return reply(
          buildAskUserResultMessage({
            kind: "custom",
            answer: result.answer,
          }),
          {
            answer: result.answer,
            wasCustom: true,
            cancelled: false,
          },
        );
      }

      if (result.kind === "explanation") {
        return reply(
          buildAskUserResultMessage({
            kind: "explanation",
            modes: result.modes,
            request: result.request,
          }),
          {
            cancelled: false,
            explanationModes: result.modes,
            explanationRequest: result.request,
          },
        );
      }

      if (result.kind === "selected-many") {
        return reply(
          buildAskUserResultMessage({
            kind: "selected-many",
            answers: result.answers,
            indices: result.indices,
          }),
          {
            answers: result.answers,
            indices: result.indices,
            cancelled: false,
          },
        );
      }

      return reply(
        buildAskUserResultMessage({
          kind: "selected",
          answer: result.answer,
          index: result.index,
        }),
        { answer: result.answer, cancelled: false },
      );
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("ask_user "));
      text += theme.fg(
        "muted",
        typeof args.question === "string" ? args.question : "",
      );
      const opts = Array.isArray(args.options)
        ? (args.options as DisplayOption[])
        : [];
      if (opts.length > 0) {
        const numbered = opts.map((o, i) => `${i + 1}. ${o.label}`);
        text += `\n${theme.fg("dim", `  ${numbered.join("  ")}`)}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as AskUserDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }

      if (details.explanationRequested && details.explanationModes?.length) {
        const request = details.explanationRequest
          ? `: ${details.explanationRequest}`
          : "";
        return new Text(
          theme.fg("accent", "? ") +
            theme.fg(
              "muted",
              `explanation requested (${details.explanationModes.join(", ")})${request}`,
            ),
          0,
          0,
        );
      }

      if (details.answers?.length) {
        const display = details.answers
          .map(
            (answer, index) => `${details.indices?.[index] ?? "?"}. ${answer}`,
          )
          .join(", ");
        return new Text(
          theme.fg("success", "✓ ") + theme.fg("accent", display),
          0,
          0,
        );
      }

      if (details.cancelled || details.answer === null) {
        return new Text(theme.fg("warning", "✗ dismissed"), 0, 0);
      }

      if (details.wasCustom) {
        return new Text(
          theme.fg("success", "✓ ") +
            theme.fg("muted", "(wrote) ") +
            theme.fg("accent", details.answer),
          0,
          0,
        );
      }

      const idx = details.options.indexOf(details.answer) + 1;
      const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
      return new Text(
        theme.fg("success", "✓ ") + theme.fg("accent", display),
        0,
        0,
      );
    },
  });
}
