/** Model-facing schema descriptions for the ask_user question and answer options. */
export const ASK_USER_PARAMETER_DESCRIPTIONS = {
  multiSelect:
    "Allow the user to select one or more compatible options. Omit or set false for the existing single-choice behavior",
  optionLabel: "Short display label for this option",
  optionDescription: "Optional one-line description shown below the label",
  optionDetails:
    "Optional Markdown proposal shown for this option while it is highlighted. Use for material trade-offs, flow, code, or diff details that do not fit the one-line description",
  explanation:
    "Optional localized copy for the always-present deeper-explanation flow. Populate it in the language the user is currently using",
  explanationLabel:
    "Localized label for requesting a deeper or clearer explanation",
  explanationQuestion:
    "Localized submenu question asking what kind of explanation the user needs",
  answerLabel: "Localized label for writing a custom decision answer",
  explanationMode:
    "Localized explanation mode label, description, and optional Markdown preview",
  context:
    "Optional concise decision background: current state, why the choice is needed now, and important constraints or unknowns",
  considerations:
    "Optional 1-5 material facts or trade-offs the user needs before choosing",
  recommendation:
    "Optional recommended option and the decisive reason. This informs the user but never implies approval",
  approvalScope:
    "Optional exact action this answer authorizes and important follow-up actions it does not authorize",
  question: "The focused decision question to ask after the context",
  options:
    "Between 2 and 5 answer options. A free-form 'write my own answer' option is always appended automatically - never include one yourself.",
};

/** Describes the ask_user tool's question shape and dismissible free-form fallback. */
export const ASK_USER_TOOL_DESCRIPTION =
  "Ask the user one contextual multiple-choice question (2-5 options), optionally allowing multiple selections. For non-trivial decisions, include background, material considerations, recommendation, and exact approval scope. Deeper-explanation and free-form options are appended automatically; neither implies approval.";

/** Adds ask_user's multiple-choice capability to the model's available-tools prompt. */
export const ASK_USER_PROMPT_SNIPPET =
  "Ask the user a contextual single- or multi-select question (2-5 options plus a free-form answer)";

/** Guides the model to use ask_user for enumerable answers and one question at a time. */
export const ASK_USER_PROMPT_GUIDELINES = [
  "When asking the user a question whose likely answers can be enumerated, use the ask_user tool instead of asking in plain text.",
  "Ask one question per ask_user call; ask follow-up questions in subsequent calls.",
  "Set multiSelect only when multiple listed options can be chosen together; keep the default single-select behavior for mutually exclusive decisions.",
  "For non-trivial decisions, populate context, considerations, and recommendation with enough evidence to decide without reconstructing prior conversation.",
  "For approvals, external mutations, replies, or irreversible actions, populate approvalScope with the exact authorized action and excluded follow-up actions.",
  "A recommendation is not approval. Keep options materially different and describe each option's immediate consequence.",
  "When a complex option needs a concrete proposal, code/diff, flow, or deeper trade-offs, put that Markdown in the option's details field so it follows keyboard selection.",
  "Populate explanation copy in the language the user is currently using. Deeper-explanation modes are always multi-select; cover every requested mode. The request must never be treated as an answer, approval, dismissal, or authorization.",
  "After an explanation request, explain in all requested styles, preserve the original approval scope, and ask the same decision again before acting.",
];

/** Builds the behavioral tool-result message returned to the parent model for an ask_user outcome. */
export function buildAskUserResultMessage(
  outcome:
    | { kind: "no-ui" }
    | { kind: "cancelled" }
    | { kind: "dismissed" }
    | { kind: "custom"; answer: string }
    | { kind: "selected-many"; answers: string[]; indices: number[] }
    | {
        kind: "explanation";
        modes: ("rationale" | "flow" | "code" | "alternatives" | "custom")[];
        request?: string;
      }
    | { kind: "selected"; answer: string; index: number | undefined },
) {
  switch (outcome.kind) {
    case "no-ui":
      return "No interactive UI is available, so the question could not be shown. Ask the user in plain text instead.";
    case "cancelled":
      return "Cancelled";
    case "dismissed":
      return "User dismissed the question without answering. Do not assume an answer; proceed accordingly or ask differently.";
    case "custom":
      return `User wrote their own answer: ${outcome.answer}`;
    case "explanation":
      return `User requested deeper explanation modes (${outcome.modes.join(", ")})${outcome.request ? `: ${outcome.request}` : "."} Cover every requested mode in the language the user is using, preserve the original approval scope, then call ask_user again with the same decision. This request is not an answer, approval, dismissal, or authorization.`;
    case "selected":
      return `User selected option ${outcome.index}: ${outcome.answer}`;
    case "selected-many":
      return `User selected options ${outcome.indices.join(", ")}: ${outcome.answers.join(", ")}`;
  }
}
