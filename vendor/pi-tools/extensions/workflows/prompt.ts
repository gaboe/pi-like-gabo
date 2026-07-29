import {
  countStates,
  formatElapsed,
  resultJson,
  shortenHome,
  type WorkflowDetails,
} from "./model.ts";

/** Model-facing schema descriptions for workflow source, arguments, and background mode. */
export const WORKFLOW_PARAMETER_DESCRIPTIONS = {
  script:
    "JavaScript workflow script. May start with `export const meta = {...}`, then use phase(), agent(), parallel(), args, and a final `return`.",
  args: "Optional JSON string exposed to the script as `args` (parsed when valid JSON, otherwise passed through as the raw string).",
  background:
    "Run in the background: the tool returns a run id immediately and you receive a follow-up message when the workflow finishes. Defaults to false (blocking with live progress).",
  timeoutMs:
    "Hard wall-clock deadline for the whole workflow in milliseconds (1 second to 24 hours). The deadline never resets and children cannot extend it.",
};

/** Defines the workflow DSL, constraints, reliability guidance, and model-authored task examples. */
export const WORKFLOW_TOOL_DESCRIPTION = [
  "The workflow tool is only to be called when the user says 'ultracode' or specifically requests a workflow run.",
  "Run a multi-agent workflow from a JavaScript orchestration script you write inline. Use this when a task benefits from fanning work out across several isolated subagents in ordered phases (research fan-out, per-file review, verify-then-synthesize pipelines).",
  "The script runs as an async function body with these primitives:",
  "• export const meta = { name, description, phases: [{ title, detail? }] } — metadata for the progress UI. Declare all phases up front.",
  "• phase(title) — mark the current phase at runtime (use titles from meta.phases).",
  "• await agent(prompt, { label?, phase?, cwd?, schema?, model?, provider?, effort?, timeoutMs?, maxTurns?, maxContinuations? }) — run ONE logical subagent task in isolated sessions and wait for it. `cwd` selects the child worktree; it must be inside the trusted root or a Git worktree whose gitdir belongs to a repository under that root. Always resolves to { ok, output, structured?, error? }. Check `ok` before using the result. When you pass a JSON `schema`, `structured` holds the validated object on success. `model`/`provider` override the session model; `effort` sets the thinking level (off|minimal|low|medium|high|xhigh|max). `timeoutMs` is one hard deadline across every attempt. `maxTurns` is the total per-attempt budget (default 12, range 1–12), not the usable work budget. Usable work turns are `max(0, maxTurns - 2)` because the final two turns are reserved for handoff and non-finalization tools are blocked. For example, `maxTurns: 4` provides 2 work turns plus 2 handoff turns. Use `maxTurns: 1` only for completion-only/no-tool work; `maxTurns: 2` provides no tool-capable work turns. `maxContinuations` allows 0–2 fresh bounded attempts in the same local worktree only after a turn-limit failure or structured `{ status: 'partial' }`; default 0. Continuations consume the global 32-call budget. Children receive local file tools, network-isolated shell verification on supported hosts, read-only web tools, settings, skills, and AGENTS.md context. Other extension capabilities fail closed; children cannot recursively orchestrate or ask the user.",
  "• await parallel([() => agent(...), () => agent(...)], { concurrency? }) — run zero-argument agent thunks concurrently and return results in order. Concurrency is globally capped at 4 for the run.",
  "• args — the parsed value of the `args` tool parameter (or undefined).",
  "Workflow JavaScript runs in a restricted, killable child with no imports, eval, timers, filesystem, network, or process APIs. A run may make at most 32 agent calls including continuations. Before writing the script, estimate model/tool cycles for each child: repository orientation, edits, each focused check, and final report. Set the explicit total `maxTurns` to estimated work turns plus the two-turn reserve; never increase a caller's cap automatically. If work exceeds 10 tool-capable turns, split implementation and verification into sequential agents; leave commits and branch/history operations to the parent. Each agent must emit its first assistant response event within 45 seconds. Each individual child tool call is capped at 3 minutes; larger requested timeouts fail immediately. Never bundle formatting, full build, and tests into one child shell call. Return long-running verification commands to the parent for job monitoring. Use map/filter/if/await/template strings to orchestrate, and `return` a JSON-serializable aggregate.",
  "Set each child's `cwd` explicitly when the workflow targets a different trusted worktree; do not merely embed an absolute path in the prompt. Pass a `schema` to agent() whenever a later step branches on the result. Audit, review, and verification agents must use a status schema containing `done`/`passed` plus `blocked` or `failed`; plain `.ok` means the model call completed, not that the reviewed implementation passed. Route small read-only or mechanical tasks to `model: 'openai-codex/gpt-5.6-luna'` only when they need at most 4 tool-capable work turns, touch at most 3 files, have deterministic verification, and involve no domain modeling, security, money, database/migration, concurrency, or production decisions. Size `maxTurns` explicitly as work turns plus 2 (`4` work turns require `maxTurns: 6`); otherwise split or rescope instead of silently growing the cap. Escalate ambiguity or failed verification to the inherited stronger model. For resumable local work, include `status: done|partial|blocked|failed`, use `maxContinuations: 1`, and reserve `blocked` for a real prerequisite or contradiction. A continuation verifies the shared worktree diff before proceeding; it never grants external mutation permission. Artifacts are saved under ~/.pi/agent/workflows/<runId>/ for inspection.",
  "Safety boundary: workflow children investigate, prepare worktree-local patches, and verify. They must not commit, merge, switch/reset/clean branches or history, deploy, push images, change clusters/secrets, trigger production jobs, or mutate external systems. Return the exact proposed external action to the parent; the parent names a bounded scope, gets explicit user approval, executes that action, then may launch a new read-only verification workflow. A strategy choice is not production approval.",
  "Example:",
  "export const meta = { name: 'reliability-review', description: 'Review modules for reliability risks, then report', phases: [{ title: 'Scan' }, { title: 'Report' }] }",
  "const FINDINGS = { type: 'object', properties: { issues: { type: 'array', items: { type: 'string' } }, ok: { type: 'boolean' } }, required: ['issues', 'ok'] }",
  "phase('Scan')",
  "const scans = await parallel(args.files.map((f) => () => agent(`Review ${f} for correctness and reliability risks.`, { label: `scan:${f}`, phase: 'Scan', schema: FINDINGS })))",
  "const findings = scans.filter((r) => r.ok).map((r) => r.structured)",
  "phase('Report')",
  "const report = await agent(`Summarize these findings: ${JSON.stringify(findings)}`, { label: 'report', phase: 'Report' })",
  "return { findings, report: report.ok ? report.output : report.error }",
].join("\n");

/** Adds workflow orchestration primitives and background execution to the model's tool prompt. */
export const WORKFLOW_PROMPT_SNIPPET =
  "Orchestrate isolated subagents from an inline JS script: phase()/agent()/parallel() with structured outputs and optional background execution";

/** Guides the model on appropriate workflow fan-out and mandatory agent result checks. */
export const WORKFLOW_PROMPT_GUIDELINES = [
  "Use workflow when a task needs several subagents with phase dependencies or dynamic fan-out; keep single small delegations in the main session.",
  "In workflow scripts, agent() never throws — always check `.ok` before using its result. `.ok` reports model-call completion, not semantic approval; audit/review/verification agents require a structured status schema and the script must branch on `structured.status`.",
  "Keep workflow children read-only for external systems. Production/external mutations require a separate parent action after the user approves an exact scope; use a later workflow only to verify.",
  "`maxTurns` is total turns, not work turns. Its final two turns are reserved for handoff, so usable work is `max(0, maxTurns - 2)`: `maxTurns: 4` gives 2 tool-capable work turns, `maxTurns: 2` gives none, and `maxTurns: 1` is only for completion-only/no-tool tasks.",
  "Estimate child model/tool cycles before writing the workflow, then set explicit `maxTurns` to work turns plus 2. Never increase caps automatically. Split any task needing more than 10 tool-capable turns; keep implementation and verification separately bounded, and return commits plus branch/history operations to the parent.",
  "Use `openai-codex/gpt-5.6-luna` for bounded low-risk read-only/mechanical agents (≤4 tool-capable work turns, explicitly budgeted as work turns + 2; ≤3 files; deterministic check). Never use it for domain/security/money/database/migration/concurrency/production decisions; escalate on ambiguity or failed checks.",
  "Set every workflow child's model and effort explicitly: Luna low for focused scouts/verifiers, Luna medium for broad exploration, Terra low for bounded or multi-file implementation and root-cause fixes, Sol low for routine review, and Sol medium for planning or complex synthesis.",
  "Use Sol high only for security, concurrency, money, migration, or comparable irreversible risk. Use xhigh only for genuinely difficult problems with justification; never choose max automatically. A failed check normally stays at the same tier for a concrete fix.",
  "Use `maxContinuations: 1` only for resumable local work with a schema supporting `status: partial`; continuation attempts share the worktree and the original deadline.",
  "Workflow child tool calls cannot exceed 3 minutes. Return longer checks to the parent for job monitoring instead of requesting a larger child timeout.",
  "Set a hard workflow timeout and bounded per-agent deadlines; limits do not authorize fallback actions outside the approved scope.",
];

/** Marks and forwards a workflow script's agent() task as an isolated child-model prompt. */
export function buildWorkflowAgentPrompt(prompt: string) {
  return prompt;
}

/** Instructs structured workflow children to terminate with exactly one structured_output call. */
export const STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION =
  "When your task is complete, call the `structured_output` tool exactly once as your final action, with fields matching the required schema. Do not write any other text after it.";

/** Describes the terminating structured_output tool and its final-action contract. */
export const STRUCTURED_OUTPUT_TOOL_DESCRIPTION =
  "Return your final result as structured data matching the required schema. Call this exactly once, as your last action; do not write any other text after it.";

/** Builds the workflow completion report returned to the parent model. */
export function buildWorkflowResultMessage(
  details: WorkflowDetails,
  runDir: string,
) {
  const { done, failed } = countStates(details);
  const elapsed = formatElapsed(details.startedAt, details.finishedAt);
  const lines = [
    `Workflow ${details.name ? `"${details.name}"` : details.runId} ${details.status} — ` +
      `${done}/${details.agents.length} agents ok${failed ? `, ${failed} failed` : ""} ` +
      `across ${details.phases.length} phase(s) in ${elapsed}.`,
    `Run dir: ${shortenHome(runDir)}`,
  ];
  if (details.error) lines.push(`Error: ${details.error}`);
  if (details.agents.length > 0) {
    lines.push("", "Agents:");
    for (const agent of details.agents) {
      const status =
        agent.state === "done"
          ? "ok"
          : agent.state === "error"
            ? "FAILED"
            : "running";
      lines.push(
        `- [${agent.label}]${agent.phase ? ` (${agent.phase})` : ""} ${status}` +
          (agent.error ? ` — ${agent.error}` : ""),
      );
    }
  }
  if (details.result !== undefined)
    lines.push("", "Result:", resultJson(details.result));
  return lines.join("\n");
}

/** Builds the follow-up user message that delivers a settled background workflow to the parent model. */
export function buildBackgroundWorkflowFollowUp(options: {
  runId: string;
  status: WorkflowDetails["status"];
  result: string;
}) {
  return `[Background workflow ${options.runId} ${options.status}]\n\n${options.result}`;
}

/** Builds the background-launch result and tells the parent model where progress and artifacts appear. */
export function buildBackgroundWorkflowLaunchResult(options: {
  runId: string;
  name?: string;
  runDir: string;
}) {
  return [
    `Workflow ${options.name ? `"${options.name}"` : options.runId} launched in background (run ${options.runId}).`,
    `Artifacts: ${shortenHome(options.runDir)}`,
    "You'll receive a follow-up message when it finishes; /workflows shows progress.",
  ].join("\n");
}
