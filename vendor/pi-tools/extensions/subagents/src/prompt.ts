/** All model-facing strings for the subagents tools. */

/** Describes Pi-only subagent spawning and fixed concurrency. */
export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Spawn a background Pi subagent: a fully autonomous, headless in-process Pi session with its own context window and normal host permissions. Fire-and-forget: final output is queued back when it settles, or collect it with subagent_wait. Children cannot orchestrate more agents/workflows or ask the user, and cannot see this conversation, so prompts must be self-contained. Only use trusted working directories. Max 4 subagents run at once.";

/** Adds background subagent delegation to the parent model's available-tools prompt. */
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Spawn a background Pi subagent for a self-contained task";

/** Guides the parent model to delegate standalone tasks and avoid unnecessary blocking waits. */
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Use subagent_spawn to delegate self-contained tasks that can run in the background; give it a complete, standalone prompt. Implementation Package Workers must set output_contract: 'package_handoff', todo_id, and todo_token from the current TODO dossier; ordinary scouts omit all three. Batch safe same-TODO Package Worker spawns when useful: their short assignment handshakes queue in FIFO order, then authorized workers run concurrently. Use subagent_send for semantic deficiencies on the same Package Worker; do not spawn a replacement or implement its package in the parent while its TODO incarnation remains current and budget remains. Never downgrade a rejected package to parent writes or an ordinary worker.",
  "Pi subagents accept only exact model tiers: openai-codex/gpt-5.6-luna, openai-codex/gpt-5.6-terra, or openai-codex/gpt-5.6-sol. openai-codex is Pi's provider name, not a Codex CLI harness.",
  "For orchestrated work, choose model and reasoning_effort independently instead of inheriting either from the parent. Use Luna for focused scouts/verifiers, broad exploration, and precisely scoped low-risk implementation with an existing pattern and deterministic check; set Luna effort low for mechanical work, medium for multi-step reasoning, or high only when bounded work is genuinely difficult. Use Terra low for ambiguous root causes, domain decisions, or broad/coupled multi-file implementation, Sol low for routine review, and Sol medium for planning or complex synthesis. Luna, Terra, and Sol are routing tiers, not valid Pi model hints: pass an exact available provider/model-id such as openai-codex/gpt-5.6-terra, never the shorthand luna, terra, or sol.",
  "Size max_turns from the actual work: 8-12 for narrow mechanical scouts, 16-24 for broad review or planning, 24-32 for focused implementation, and 32-48 only for a cohesive multi-file/root-cause package. Estimate orientation, edits, focused verification, and handoff separately; split discovery, implementation, and review when the estimate does not fit with two final turns reserved. Do not lower the default merely because a task sounds simple.",
  "A worker that can finish bounded remaining work with more turns may stop before its reserve and return status partial with budget_request {additional_turns, reason} plus non-empty remaining_work. Assess the evidence and scope yourself; approve the exact request at most once through subagent_send additional_turns, only when total max_turns remains at or below 48. Never extend automatically or revive a hard-limit failure.",
  "Use Sol high only for security, concurrency, money, migration, or comparable irreversible risk. Use xhigh only for genuinely difficult problems with justification; never choose max automatically. Failed checks normally require a concrete fix at the same tier, not more effort.",
  "After subagent_spawn, keep working; results arrive automatically. In interactive mode, if no independent work remains, end the turn and tell the user you are waiting so they can keep prompting or add TODOs. Use subagent_wait only for non-interactive blocking collection or already-settled results.",
];

/** Model-facing schema descriptions for subagent_spawn task and execution options. */
export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  prompt:
    "Task prompt for the subagent. Must be self-contained: include all needed context, file paths, and what to report back.",
  name: "Short human-readable name for this subagent, shown in listings and the UI",
  workingDir:
    "Trusted working directory for the autonomous child (default: current working directory)",
  model:
    "Exact Pi model tier: openai-codex/gpt-5.6-luna, openai-codex/gpt-5.6-terra, or openai-codex/gpt-5.6-sol. Set it explicitly for orchestrated work.",
  reasoningEffort:
    "Pi thinking level. Set it explicitly for orchestrated work; omission inherits the parent and may unintentionally fan out high/xhigh effort.",
  maxTurns:
    "Maximum assistant turns before forced handoff (default 24, range 4-48). Budget orientation, implementation, focused verification, and handoff; reserve the final two turns. Suggested caps: 8-12 narrow scout, 16-24 broad review/planning, 24-32 focused implementation, 32-48 cohesive multi-file work; otherwise split the task.",
  outputContract:
    'Optional final-output contract. Set "package_handoff" only for implementation packages; every status requires evidence for every acceptance criterion, done additionally requires all criteria to pass, and one correction turn is granted.',
  todoId:
    "Owning TODO positive numeric id. Required with todo_token for Package Worker delegation; omit for ordinary scouts.",
  todoToken:
    "Owning TODO incarnation token from current metadata.preparation.token. Required with todo_id for Package Workers; omit for ordinary scouts.",
};

/** Builds the subagent_spawn result that tells the parent model how to continue or inspect the child. */
export function buildSubagentSpawnResult(options: {
  id: string;
  title: string;
  backend: string;
  modelLabel: string;
  cwd: string;
}) {
  return (
    `Spawned subagent ${options.id} "${options.title}" (${options.backend}: ${options.modelLabel}, ${options.cwd}).\n` +
    `It runs in the background and its result will be delivered automatically. ` +
    `Keep working, or end the turn if nothing independent remains so the user can keep prompting or add TODOs. Use subagent_cancel to stop it, subagent_check to peek, and subagent_list to see all.`
  );
}

export const SUBAGENT_SEND_TOOL_DESCRIPTION =
  "Send one bounded message to an existing subagent. Running agents are steered; eligible settled agents continue in the same session. A settled partial worker may receive one explicitly approved budget extension matching its exact request, up to 48 total turns. Package Workers revalidate current TODO ownership and may restart only after a schema-valid handoff.";

export const SUBAGENT_SEND_PROMPT_SNIPPET =
  "Steer or continue one existing subagent in its current session";

export const SUBAGENT_SEND_PROMPT_GUIDELINES = [
  "Use subagent_send to return precise semantic deficiencies to the same Package Worker while its owning TODO incarnation remains current and turn budget remains; do not spawn a replacement or implement the package in the parent.",
  "When a settled worker returned status partial with budget_request {additional_turns, reason} and non-empty remaining_work, independently assess the request before passing the exact requested additional_turns to subagent_send. At most one extension is allowed and total max_turns stays at or below 48. Never extend automatically, alter the requested amount, extend a nested worker, or revive a hard-limit failure.",
];

export const SUBAGENT_SEND_PARAMETER_DESCRIPTIONS = {
  id: "Existing subagent id",
  message:
    "Bounded steering or follow-up message for the same subagent session",
  additionalTurns:
    "Exact one-time turn extension requested by a settled partial worker. Requires a valid budget_request and cannot raise total max_turns above 48.",
};

/** Describes explicit blocking collection of one or more subagent results. */
export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
  "Collect final outputs for listed subagents. In interactive mode, running agents are deferred instead of blocking the user; end the turn and let results arrive automatically. In non-interactive mode this blocks until settlement.";

/** Model-facing schema description for the subagent ids to await. */
export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to wait for, e.g. ["sa-1", "sa-2"]',
};

/** Describes aborting running subagents while retaining their partial transcripts. */
export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
  "Cancel one or more running subagents. This aborts their active work but preserves their partial session transcripts on disk.";

/** Model-facing schema description for the subagent ids to cancel. */
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to cancel, e.g. ["sa-1", "sa-2"]',
};

/** Describes nonblocking inspection of a subagent without consuming its result. */
export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
  "Peek at a subagent's status and recent activity without blocking. Does not consume its result.";

/** Model-facing schema description for the subagent id to inspect. */
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id",
};

/** Describes listing all tracked running and settled subagents. */
export const SUBAGENT_LIST_TOOL_DESCRIPTION =
  "List all Pi subagents (running and finished) with their status.";

/** Builds the child completion/failure wrapper injected into the parent model's context. */
export function buildSubagentResultMessage(options: {
  id: string;
  title: string;
  status: "running" | "done" | "error";
  errorText?: string;
  output: string;
}) {
  const verb = options.status === "error" ? "failed" : "finished";
  let text = `Subagent ${options.id} "${options.title}" ${verb}.`;
  if (options.errorText) text += `\nError: ${options.errorText}`;
  text += `\n\n${options.output}`;
  return text;
}
