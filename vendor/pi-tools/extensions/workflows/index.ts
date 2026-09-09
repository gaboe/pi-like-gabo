/**
 * workflows: model-authored multi-agent orchestration.
 *
 * A `workflow` tool that runs a JavaScript orchestration script written inline
 * by the model. The script executes ordered phases, fanning work out to
 * isolated subagents:
 *
 *   export const meta = { name, description, phases: [{ title, detail? }] }
 *   phase(title)                                  // mark runtime phase progression
 *   await agent(prompt, { label?, phase?, cwd?, schema?, model?, provider?, effort? })
 *   await parallel([() => agent(...), ...], { concurrency? })
 *   args                                          // parsed JSON args passed with the tool call
 *
 * `agent()` always resolves to `{ ok, output, structured?, error? }` — it
 * never throws into the script. Scripts branch on `ok` explicitly.
 *
 * Runs are blocking by default (live progress in the tool block). Pass
 * `background: true` to return immediately and get a follow-up message when
 * the run finishes. Run artifacts (script, args, statuses, result) are saved
 * under `~/.pi/agent/workflows/<runId>/` for inspection; result and bounded
 * transcripts use separate artifacts, and there is no resume.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  getAgentDir,
  getMarkdownTheme,
  keyHint,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { formatActivityStatus } from "../shared/activity-status.ts";
import {
  createWorkflowPersistence,
  finalizeWorkflowPersistence,
  persistWorkflowJson,
} from "./artifacts.ts";
import {
  createWorkflowJournal,
  recoverInterruptedWorkflow,
  refuseWorkflowResume,
} from "./journal.ts";
import { classifyRetry, pausedProviderMetadata } from "./retry.ts";
import { CHILD_COST_CHANNEL } from "../shared/dashboard-state.ts";
import { RunController } from "./controller.ts";
import { sessionWorkflowRunIds, showWorkflowDashboard } from "./dashboard.ts";
import {
  extractMeta,
  prepareWorkflowScript,
  type WorkflowMeta,
} from "./meta.ts";
import {
  agentContext,
  aggregateUsage,
  countStates,
  emptyUsage,
  formatElapsed,
  formatUsage,
  phaseGroups,
  resultJson,
  stateSquare,
  statusColor,
  statusWord,
  SQUARE,
  type AgentRecord,
  type AgentUsage,
  type TranscriptEntry,
  type WorkflowDetails,
} from "./model.ts";
import {
  buildBackgroundWorkflowFollowUp,
  buildBackgroundWorkflowLaunchResult,
  buildWorkflowAgentPrompt,
  buildWorkflowResultMessage,
  WORKFLOW_PARAMETER_DESCRIPTIONS,
  WORKFLOW_PROMPT_GUIDELINES,
  WORKFLOW_PROMPT_SNIPPET,
  WORKFLOW_TOOL_DESCRIPTION,
} from "./prompt.ts";
import {
  createWorkflowResources,
  DEFAULT_AGENT_MAX_TURNS,
  MAX_AGENT_MAX_TURNS,
  mergeContinuationTranscript,
  runAgent,
  resolveWorkflowAgentCwd,
  runBoundedAgentAttempts,
  supportsPartialStatusSchema,
  supportsSemanticStatusSchema,
  type ThinkingLevel,
  type WorkflowModel,
} from "./runner.ts";
import { runWorkflowSandbox } from "./sandbox.ts";
import { safeStringify, writeFileAtomic } from "./serialization.ts";
import {
  categorizeTelemetryError,
  emitTelemetry,
} from "../../../../extensions/telemetry/protocol.ts";
import {
  FLEET_SETTLED_LINGER_MS,
  onFleetOpen,
  onFleetQuery,
  publishFleetState,
  type FleetStatus,
  type WorkflowAgentFleetItem,
  type WorkflowRunFleetItem,
} from "../shared/fleet-protocol.ts";
import {
  AUTOMATION_PAUSE_CHANNEL,
  type AutomationPauseRequest,
} from "../shared/automation-pause-protocol.ts";

const PREVIEW_LENGTH = 200;
const EMIT_INTERVAL_MS = 120;

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** What `agent()` resolves to inside the script. */
interface ScriptAgentResult {
  ok: boolean;
  output: string;
  structured?: unknown;
  error?: string;
}

interface AgentCallOptions {
  label?: unknown;
  phase?: unknown;
  schema?: unknown;
  model?: unknown;
  provider?: unknown;
  effort?: unknown;
  timeoutMs?: unknown;
  maxTurns?: unknown;
  maxContinuations?: unknown;
  cwd?: unknown;
}

const WorkflowParams = Type.Object({
  script: Type.String({
    description: WORKFLOW_PARAMETER_DESCRIPTIONS.script,
  }),
  args: Type.Optional(
    Type.String({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.args,
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.background,
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1_000,
      maximum: 24 * 60 * 60 * 1_000,
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.timeoutMs,
    }),
  ),
});

type WorkflowInput = Static<typeof WorkflowParams>;

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    16 * 1024,
  );
}

function semanticFailureStatus(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const status = (result as { status?: unknown }).status;
  if (typeof status !== "string") return undefined;
  return ["blocked", "failed", "partial", "verification-blocked"].includes(
    status.toLowerCase(),
  )
    ? status
    : undefined;
}

function addUsage(left: AgentUsage, right: AgentUsage): AgentUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    cost: left.cost + right.cost,
    turns: left.turns + right.turns,
    contextTokens: right.contextTokens ?? left.contextTokens,
  };
}

function summaryLine(details: WorkflowDetails): string {
  const { done, failed } = countStates(details);
  const settled = done + failed;
  return `workflow ${details.name ?? details.runId}: ${settled}/${details.agents.length} agents${
    details.currentPhase ? ` · ${details.currentPhase}` : ""
  }`;
}

function writeRunFile(runDir: string, name: string, content: string) {
  writeFileAtomic(path.join(runDir, name), content);
}

function compactToolDetails(details: WorkflowDetails): WorkflowDetails {
  return {
    ...details,
    ...(details.result !== undefined
      ? {
          result: JSON.parse(
            safeStringify(details.result, { maxBytes: 64 * 1024 }),
          ),
        }
      : {}),
    agents: details.agents.map((agent) => ({ ...agent, transcript: [] })),
  };
}

interface RunSummary {
  runId: string;
  name?: string;
  status: string;
  done: number;
  total: number;
  startedAt: number;
  active: boolean;
}

function listRuns(
  activeRuns: Map<string, WorkflowDetails>,
  sessionId: string,
  referencedRunIds: ReadonlySet<string>,
): RunSummary[] {
  const base = path.join(getAgentDir(), "workflows");
  let names: string[] = [];
  try {
    names = fs.readdirSync(base).filter((name) => name.startsWith("wf_"));
  } catch {
    // No runs yet.
  }
  const summaries: RunSummary[] = [];
  for (const runId of names) {
    const live = activeRuns.get(runId);
    if (live) {
      const { done, failed } = countStates(live);
      summaries.push({
        runId,
        name: live.name,
        status: live.status,
        done: done + failed,
        total: live.agents.length,
        startedAt: live.startedAt,
        active: true,
      });
      continue;
    }
    try {
      recoverInterruptedWorkflow(path.join(base, runId), false);
      const parsed = JSON.parse(
        fs.readFileSync(path.join(base, runId, "workflow.json"), "utf8"),
      ) as Partial<WorkflowDetails>;
      if (parsed.sessionId !== sessionId && !referencedRunIds.has(runId)) {
        continue;
      }
      const agents = parsed.agents ?? [];
      summaries.push({
        runId,
        name: parsed.name,
        status:
          parsed.status === "running"
            ? "aborted"
            : (parsed.status ?? "unknown"),
        done: agents.filter((agent) => agent.state !== "running").length,
        total: agents.length,
        startedAt: parsed.startedAt ?? 0,
        active: false,
      });
    } catch {
      // Ignore unreadable artifacts because their session cannot be verified.
    }
  }
  return summaries.sort((a, b) => b.startedAt - a.startedAt);
}

function runDetailText(
  run: RunSummary,
  activeRuns: Map<string, WorkflowDetails>,
): string {
  const runDir = path.join(getAgentDir(), "workflows", run.runId);
  const live = activeRuns.get(run.runId);
  if (live) return buildWorkflowResultMessage(live, runDir);
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(runDir, "workflow.json"), "utf8"),
    ) as WorkflowDetails;
    return buildWorkflowResultMessage(parsed, runDir);
  } catch {
    return `Run ${run.runId} — ${run.status}`;
  }
}

export default function workflows(pi: ExtensionAPI) {
  /** Live background runs, for /workflows and shutdown cleanup. */
  const activeRuns = new Map<
    string,
    {
      details: WorkflowDetails;
      controller: RunController;
      completion?: Promise<void>;
    }
  >();
  pi.events.on(AUTOMATION_PAUSE_CHANNEL, (value) => {
    const request = value as AutomationPauseRequest | undefined;
    if (!request || request.reason !== "double-escape") return;
    const runs = [...activeRuns.values()].filter(
      (run) => !run.controller.signal.aborted,
    );
    if (runs.length === 0) return;
    request.acknowledge("workflows", runs.length);
    for (const run of runs) run.controller.abort("Paused by double Escape");
  });

  const activeDetails = () =>
    new Map(
      [...activeRuns].map(([runId, run]) => [runId, run.details] as const),
    );

  /** Finished counts remain visible until the dashboard acknowledges them. */
  let lastUi: ExtensionContext["ui"] | undefined;
  let lastCtx: ExtensionContext | undefined;
  let stopFleetQuery: (() => void) | undefined;
  let stopFleetOpen: (() => void) | undefined;
  let fleetOpening = false;
  let fleetActive = false;
  const recentFleetRuns = new Map<
    string,
    {
      settledAt: number;
      items: Array<WorkflowRunFleetItem | WorkflowAgentFleetItem>;
    }
  >();
  let completedRuns = 0;
  let failedRuns = 0;
  const updateIndicator = () => {
    const ui = lastUi;
    if (!ui) return;
    try {
      const running = activeRuns.size;
      if (running === 0 && completedRuns === 0 && failedRuns === 0) {
        ui.setStatus("workflows", undefined);
        return;
      }
      ui.setStatus(
        "workflows",
        formatActivityStatus(ui.theme, "workflows", {
          running,
          done: completedRuns,
          failed: failedRuns,
        }),
      );
    } catch {
      // UI may be unavailable.
    }
  };

  const recordSettledRun = (status: WorkflowDetails["status"]) => {
    if (status === "completed") completedRuns += 1;
    else failedRuns += 1;
  };

  const fleetStatus = (status: WorkflowDetails["status"]): FleetStatus =>
    status === "completed"
      ? "done"
      : status === "running"
        ? "running"
        : status === "paused"
          ? "paused"
          : status === "aborted"
            ? "aborted"
            : "error";

  const workflowFleetItems = (
    details: WorkflowDetails,
  ): Array<WorkflowRunFleetItem | WorkflowAgentFleetItem> => {
    const usage = aggregateUsage(details.agents);
    const run: WorkflowRunFleetItem = {
      source: "workflows",
      kind: "workflow-run",
      id: details.runId,
      title: details.name ?? details.runId,
      status: fleetStatus(details.status),
      startedAt: details.startedAt,
      settledAt: details.finishedAt,
      detail: details.currentPhase ?? details.description,
      tokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
      turns: usage.turns,
      ...(details.paused ? { quotaState: details.paused.reason } : {}),
      ...(details.agents.some((agent) => (agent.attempts ?? 1) > 1)
        ? { retryState: "bounded retries exhausted" }
        : {}),
    };
    return [
      run,
      ...details.agents.map((agent): WorkflowAgentFleetItem => ({
        source: "workflows",
        kind: "workflow-agent",
        id: `${details.runId}:${agent.index}`,
        parentId: details.runId,
        agentIndex: agent.index,
        title: agent.label,
        status:
          agent.state === "done"
            ? "done"
            : agent.state === "error"
              ? "error"
              : "running",
        startedAt: agent.startedAt,
        settledAt: agent.finishedAt,
        detail: [
          agent.phase,
          agent.model,
          agent.effort ? `${agent.effort} effort` : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
        tokens:
          agent.usage.input +
          agent.usage.output +
          agent.usage.cacheRead +
          agent.usage.cacheWrite,
        turns: agent.usage.turns,
        maxTurns: agent.maxTurns,
        ...((agent.attempts ?? 1) > 1
          ? { retryState: `${agent.attempts} attempts` }
          : {}),
        ...(agent.providerError?.code
          ? { quotaState: agent.providerError.code }
          : {}),
      })),
    ];
  };

  const publishFleet = () => {
    if (!fleetActive) return;
    const now = Date.now();
    for (const [runId, recent] of recentFleetRuns) {
      if (now - recent.settledAt >= FLEET_SETTLED_LINGER_MS) {
        recentFleetRuns.delete(runId);
      }
    }
    publishFleetState(pi.events, {
      source: "workflows",
      items: [
        ...[...activeRuns.values()].flatMap((run) =>
          workflowFleetItems(run.details),
        ),
        ...[...recentFleetRuns.values()].flatMap((run) => run.items),
      ],
    });
  };

  const rememberFleetRun = (details: WorkflowDetails) => {
    if (!fleetActive || !details.finishedAt) return;
    recentFleetRuns.set(details.runId, {
      settledAt: details.finishedAt,
      items: workflowFleetItems(details),
    });
  };

  pi.on("session_start", (_event, ctx) => {
    fleetActive = true;
    lastCtx = ctx;
    if (ctx.hasUI) lastUi = ctx.ui;
    stopFleetQuery ??= onFleetQuery(pi.events, publishFleet);
    stopFleetOpen ??= onFleetOpen(pi.events, (request) => {
      if (
        request.source !== "workflows" ||
        fleetOpening ||
        lastCtx?.mode !== "tui"
      ) {
        return;
      }
      const runId =
        request.kind === "workflow-agent" ? request.parentId : request.id;
      const agentIndex =
        request.kind === "workflow-agent" ? request.agentIndex : undefined;
      fleetOpening = true;
      void showWorkflowDashboard(
        lastCtx,
        activeDetails,
        runId,
        agentIndex,
      ).finally(() => {
        fleetOpening = false;
      });
    });
    updateIndicator();
  });

  pi.on("session_shutdown", async () => {
    fleetActive = false;
    fleetOpening = false;
    publishFleetState(pi.events, { source: "workflows", items: [] });
    stopFleetQuery?.();
    stopFleetQuery = undefined;
    stopFleetOpen?.();
    stopFleetOpen = undefined;
    recentFleetRuns.clear();
    const runs = [...activeRuns.values()];
    for (const run of runs) run.controller.abort("Session is shutting down");
    await Promise.all(
      runs.map((run) => run.controller.settle({ abort: true })),
    );
    const completions = runs
      .map((run) => run.completion)
      .filter(
        (completion): completion is Promise<void> => completion !== undefined,
      );
    if (completions.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 8_000);
      });
      await Promise.race([Promise.allSettled(completions), timeout]);
      if (timer) clearTimeout(timer);
    }
    lastUi?.setStatus("workflows", undefined);
    lastUi = undefined;
    lastCtx = undefined;
  });

  pi.registerCommand("workflows", {
    description:
      "List workflow runs (`/workflows <runId>` for one run's detail)",
    handler: async (rawArgs, ctx) => {
      const arg = rawArgs.trim();
      if (arg.startsWith("resume ")) {
        const runId = arg.slice(7).trim();
        ctx.ui.notify(
          runId
            ? refuseWorkflowResume(runId)
            : "Usage: /workflows resume <runId>",
          "warning",
        );
        return;
      }
      if (ctx.mode === "tui") {
        lastUi = ctx.ui;
        await showWorkflowDashboard(ctx, activeDetails, arg || undefined);
        // Opening the dashboard acknowledges finished runs.
        completedRuns = 0;
        failedRuns = 0;
        updateIndicator();
        return;
      }
      // Non-TUI fallback: plain text listing.
      const runs = listRuns(
        activeDetails(),
        ctx.sessionManager.getSessionId(),
        sessionWorkflowRunIds(ctx),
      );
      if (runs.length === 0) {
        ctx.ui.notify("No workflow runs yet.", "info");
        return;
      }
      if (arg) {
        const run = runs.find((r) => r.runId === arg || r.runId.endsWith(arg));
        ctx.ui.notify(
          run
            ? runDetailText(run, activeDetails())
            : `No workflow run matching "${arg}".`,
          run ? "info" : "warning",
        );
        return;
      }
      const labels = runs.map(
        (r) =>
          `${r.active ? "* " : "  "}${r.runId}  ${r.status}  ${r.name ?? ""}  ${r.done}/${r.total}`,
      );
      if (!ctx.hasUI) {
        ctx.ui.notify(labels.join("\n"), "info");
        return;
      }
      const choice = await ctx.ui.select("Workflow runs", labels);
      if (!choice) return;
      const run = runs[labels.indexOf(choice)];
      if (run) ctx.ui.notify(runDetailText(run, activeDetails()), "info");
    },
  });

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: WORKFLOW_TOOL_DESCRIPTION,
    promptSnippet: WORKFLOW_PROMPT_SNIPPET,
    promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
    parameters: WorkflowParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let prepared: ReturnType<typeof prepareWorkflowScript>;
      try {
        prepared = prepareWorkflowScript(params.script);
      } catch (error) {
        throw new Error(`Workflow script failed to parse: ${errorText(error)}`);
      }

      let args: unknown;
      if (params.args !== undefined) {
        try {
          args = JSON.parse(params.args);
        } catch {
          args = params.args;
        }
      }

      const meta = prepared.meta;
      const runId = `wf_${randomBytes(6).toString("hex")}`;
      const runDir = path.join(getAgentDir(), "workflows", runId);
      const background = (params.background ?? false) && ctx.hasUI;

      const details: WorkflowDetails = {
        runId,
        sessionId: ctx.sessionManager.getSessionId(),
        name: meta.name,
        description: meta.description,
        background,
        status: "running",
        startedAt: Date.now(),
        phases: [...meta.phases],
        agents: [],
      };

      writeRunFile(runDir, "script.js", params.script);
      if (params.args !== undefined)
        writeRunFile(runDir, "args.json", params.args);
      persistWorkflowJson(runDir, details);
      const persistence = createWorkflowPersistence(runDir, details);
      const journal = createWorkflowJournal(runDir, runId);
      journal.event("start");

      // Background runs survive Esc on the parent turn, but all runs are
      // aborted and settled during session shutdown.
      const controller = new RunController(background ? undefined : signal);
      let workflowDeadline: ReturnType<typeof setTimeout> | undefined;
      if (params.timeoutMs !== undefined) {
        workflowDeadline = setTimeout(
          () =>
            controller.abort(
              `Workflow exceeded its ${params.timeoutMs}ms deadline`,
            ),
          params.timeoutMs,
        );
      }

      // Each concurrent child gets its own extension runtime. All children use
      // the parent cwd and live trust decision.
      const projectTrusted = ctx.isProjectTrusted();
      const getResources = (structured: boolean, cwd: string) =>
        createWorkflowResources(
          cwd,
          structured ? "structured" : "plain",
          projectTrusted,
        );
      emitTelemetry(pi.events, {
        type: "workflow_run",
        phase: "start",
        status: "running",
        durationMs: 0,
      });

      // Throttled progress: tool-block updates when blocking. Background
      // runs are covered by the below-editor indicator and /workflows.
      let emitTimer: ReturnType<typeof setTimeout> | undefined;
      let lastEmit = 0;
      const flush = () => {
        emitTimer = undefined;
        if (!controller.isCurrent(controller.captureGeneration())) return;
        lastEmit = Date.now();
        for (const agent of details.agents) {
          pi.events.emit(CHILD_COST_CHANNEL, {
            key: `workflow:${runId}:${agent.index}`,
            cost: agent.usage.cost,
            settled: agent.state !== "running",
          });
        }
        publishFleet();
        if (background) return;
        onUpdate?.({
          content: [{ type: "text", text: summaryLine(details) }],
          details: compactToolDetails(details),
        });
      };
      const emit = (checkpoint = true) => {
        if (!controller.isCurrent(controller.captureGeneration())) return;
        if (checkpoint) persistence.checkpoint();
        if (emitTimer) return;
        emitTimer = setTimeout(
          flush,
          Math.max(0, EMIT_INTERVAL_MS - (Date.now() - lastEmit)),
        );
      };
      const flushNow = () => {
        if (emitTimer) clearTimeout(emitTimer);
        flush();
      };

      const phaseFn = (title: unknown) => {
        const generation = controller.captureGeneration();
        if (!controller.isCurrent(generation)) return;
        const text = String(title);
        details.currentPhase = text;
        if (!details.phases.some((p) => p.title === text))
          details.phases.push({ title: text });
        journal.event("phase", { phase: text });
        emit();
      };

      let agentCounter = 0;
      const agentFn = async (
        promptValue: unknown,
        optsValue: unknown = {},
        invocationSignal?: AbortSignal,
      ): Promise<ScriptAgentResult> => {
        const generation = controller.captureGeneration();
        if (!controller.isCurrent(generation))
          return { ok: false, output: "", error: "Workflow is settling" };
        const index = ++agentCounter;
        const opts: AgentCallOptions =
          optsValue && typeof optsValue === "object"
            ? (optsValue as AgentCallOptions)
            : {};
        const label =
          typeof opts.label === "string" && opts.label.trim()
            ? opts.label.trim().slice(0, 160)
            : `agent-${index}`;

        const record: AgentRecord = {
          index,
          label,
          phase:
            typeof opts.phase === "string"
              ? opts.phase.slice(0, 160)
              : details.currentPhase,
          state: "running",
          model: ctx.model?.id,
          contextWindow: ctx.model?.contextWindow,
          startedAt: Date.now(),
          preview: "",
          usage: emptyUsage(),
          maxTurns: DEFAULT_AGENT_MAX_TURNS,
          maxContinuations: 0,
          continuationsUsed: 0,
          transcript: [],
        };
        details.agents.push(record);
        journal.event("call-start", { call: index, phase: record.phase });
        persistence.checkpoint({ immediate: true });
        emit(false);

        const fail = (error: string): ScriptAgentResult => {
          record.state = "error";
          record.error = error;
          record.finishedAt = Date.now();
          emit();
          return { ok: false, output: "", error };
        };

        const prompt = buildWorkflowAgentPrompt(
          typeof promptValue === "string"
            ? promptValue
            : String(promptValue ?? ""),
        );
        if (!prompt.trim())
          return fail("agent() requires a non-empty prompt string");
        if (controller.signal.aborted)
          return fail("Workflow was aborted before this agent started");

        let agentCwd: string;
        try {
          agentCwd = resolveWorkflowAgentCwd(ctx.cwd, opts.cwd);
        } catch (error) {
          return fail(`agent "${label}": ${errorText(error)}`);
        }
        record.cwd = agentCwd;

        const maxTurns =
          opts.maxTurns === undefined
            ? DEFAULT_AGENT_MAX_TURNS
            : Number(opts.maxTurns);
        if (
          !Number.isInteger(maxTurns) ||
          maxTurns < 1 ||
          maxTurns > MAX_AGENT_MAX_TURNS
        ) {
          return fail(
            `agent "${label}": maxTurns must be an integer from 1 to ${MAX_AGENT_MAX_TURNS}`,
          );
        }
        const maxContinuations =
          opts.maxContinuations === undefined
            ? 0
            : Number(opts.maxContinuations);
        if (
          !Number.isInteger(maxContinuations) ||
          maxContinuations < 0 ||
          maxContinuations > 2
        ) {
          return fail(
            `agent "${label}": maxContinuations must be an integer from 0 to 2`,
          );
        }
        const semanticPhase = `${label} ${record.phase ?? ""}`;
        if (
          /\b(?:audit|review|verification|verify)\b/i.test(semanticPhase) &&
          !supportsSemanticStatusSchema(opts.schema)
        ) {
          return fail(
            `agent "${label}": audit/review/verification agents require a structured status schema with "done"/"passed" and "blocked" or "failed"`,
          );
        }
        if (maxContinuations > 0 && !supportsPartialStatusSchema(opts.schema)) {
          return fail(
            `agent "${label}": maxContinuations requires a schema whose status enum includes "partial"`,
          );
        }
        record.maxContinuations = maxContinuations;
        record.maxTurns = maxTurns;
        emitTelemetry(pi.events, {
          type: "workflow_agent",
          agentIndex: record.index,
          phase: "start",
          status: "running",
          turns: 0,
          maxTurns: record.maxTurns,
          durationMs: 0,
        });

        let timeout: ReturnType<typeof setTimeout> | undefined;
        let agentSignal = invocationSignal;
        if (opts.timeoutMs !== undefined) {
          const timeoutMs = Number(opts.timeoutMs);
          if (
            !Number.isInteger(timeoutMs) ||
            timeoutMs < 1_000 ||
            timeoutMs > 24 * 60 * 60 * 1_000
          ) {
            return fail(
              `agent "${label}": timeoutMs must be an integer from 1000 to 86400000`,
            );
          }
          const deadline = new AbortController();
          timeout = setTimeout(
            () =>
              deadline.abort(
                new Error(
                  `Agent "${label}" exceeded its ${timeoutMs}ms deadline`,
                ),
              ),
            timeoutMs,
          );
          agentSignal = invocationSignal
            ? AbortSignal.any([invocationSignal, deadline.signal])
            : deadline.signal;
        }

        return controller
          .schedule(async (runSignal) => {
            if (!controller.isCurrent(generation))
              return { ok: false, output: "", error: "Workflow is settling" };
            // Model/provider resolution: default to the parent session's model.
            let model: WorkflowModel | undefined = ctx.model;
            if (opts.model !== undefined || opts.provider !== undefined) {
              const modelOpt =
                typeof opts.model === "string" ? opts.model : undefined;
              const providerOpt =
                typeof opts.provider === "string" ? opts.provider : undefined;
              if (!modelOpt)
                return fail(
                  `agent "${label}": \`provider\` requires \`model\` as well`,
                );
              let resolved: WorkflowModel | undefined;
              if (providerOpt) {
                resolved = ctx.modelRegistry.find(providerOpt, modelOpt);
              } else {
                const slash = modelOpt.indexOf("/");
                if (slash > 0) {
                  resolved = ctx.modelRegistry.find(
                    modelOpt.slice(0, slash),
                    modelOpt.slice(slash + 1),
                  );
                }
                resolved ??= ctx.modelRegistry
                  .getAll()
                  .find((m) => m.id === modelOpt);
              }
              if (!resolved) {
                const requested = providerOpt
                  ? `${providerOpt}/${modelOpt}`
                  : modelOpt;
                return fail(
                  `agent "${label}": unknown model "${requested}" (use provider/id)`,
                );
              }
              model = resolved;
            }
            record.model = model?.id;
            record.contextWindow = model?.contextWindow;
            emit();

            // Effort → thinking level; default inherits the parent session.
            let thinkingLevel: ThinkingLevel = pi.getThinkingLevel();
            if (opts.effort !== undefined) {
              const effort = String(opts.effort);
              if (!(THINKING_LEVELS as readonly string[]).includes(effort)) {
                return fail(
                  `agent "${label}": invalid effort "${effort}" (use ${THINKING_LEVELS.join("|")})`,
                );
              }
              thinkingLevel = effort as ThinkingLevel;
            }
            record.effort = thinkingLevel;
            emit(false);

            let priorUsage = emptyUsage();
            let priorTranscript: TranscriptEntry[] = [];
            const attempts = await runBoundedAgentAttempts({
              prompt,
              maxContinuations,
              signal: runSignal,
              reserveContinuation: () => {
                controller.reserveCall();
                record.continuationsUsed = (record.continuationsUsed ?? 0) + 1;
                record.preview = `continuing attempt ${record.continuationsUsed + 1}/${maxContinuations + 1}`;
                persistence.checkpoint({ immediate: true });
                emit(false);
              },
              run: async (attemptPrompt, attempt) => {
                const resources = await getResources(
                  opts.schema !== undefined,
                  agentCwd,
                );
                return runAgent({
                  prompt: attemptPrompt,
                  schema: opts.schema,
                  model,
                  thinkingLevel,
                  cwd: agentCwd,
                  loader: resources.loader,
                  settingsManager: resources.settingsManager,
                  modelRegistry: ctx.modelRegistry,
                  signal: runSignal,
                  maxTurns,
                  onProgress: (progress) => {
                    if (!controller.isCurrent(generation)) return;
                    record.preview = progress.preview.slice(0, PREVIEW_LENGTH);
                    record.usage = addUsage(priorUsage, progress.usage);
                    record.model = progress.model ?? record.model;
                    record.contextWindow =
                      progress.contextWindow ?? record.contextWindow;
                    record.transcript = mergeContinuationTranscript(
                      priorTranscript,
                      progress.transcript,
                      attempt,
                    );
                    emit();
                  },
                });
              },
              onAttempt: (attemptOutcome, attempt) => {
                if (!controller.isCurrent(generation)) return;
                record.usage = addUsage(priorUsage, attemptOutcome.usage);
                record.transcript = mergeContinuationTranscript(
                  priorTranscript,
                  attemptOutcome.transcript,
                  attempt,
                );
                priorUsage = record.usage;
                priorTranscript = record.transcript;
              },
            });
            const outcome = attempts.outcome;
            if (!controller.isCurrent(generation))
              return { ok: false, output: "", error: "Workflow is settling" };

            const outcomeError =
              outcome.aborted && runSignal.reason instanceof Error
                ? runSignal.reason.message
                : outcome.error;
            record.model = outcome.model ?? record.model;
            record.contextWindow =
              outcome.contextWindow ?? record.contextWindow;
            record.preview = (outcome.output || record.preview).slice(
              0,
              PREVIEW_LENGTH,
            );
            record.finishedAt = Date.now();
            record.attempts = attempts.attempts;
            record.providerError = outcome.providerError;
            record.state = outcome.ok ? "done" : "error";
            if (outcome.ok) {
              delete record.error;
            } else {
              record.error = outcomeError ?? "Agent failed";
              const retry = classifyRetry(record.error, outcome.providerError);
              record.retryCategory = retry.category;
              if (retry.category === "quota") {
                details.paused = pausedProviderMetadata(outcome.providerError);
                details.error = "Provider quota paused";
                controller.abort("Provider quota pause");
              }
            }
            journal.event(outcome.ok ? "call-done" : "call-error", {
              call: index,
              phase: record.phase,
              ...(outcome.ok ? {} : { reason: record.error?.slice(0, 512) }),
            });
            emit();

            return {
              ok: outcome.ok,
              output: outcome.output,
              ...(outcome.structured !== undefined
                ? { structured: outcome.structured }
                : {}),
              ...(outcomeError !== undefined ? { error: outcomeError } : {}),
            };
          }, agentSignal)
          .catch((error) =>
            controller.isCurrent(generation)
              ? fail(errorText(error))
              : { ok: false, output: "", error: "Workflow is settling" },
          )
          .finally(() => {
            if (timeout) clearTimeout(timeout);
            if (!controller.isCurrent(generation)) return;
            const category = categorizeTelemetryError(record.error);
            const status =
              record.state === "done"
                ? "completed"
                : category === "aborted"
                  ? "aborted"
                  : "failed";
            emitTelemetry(pi.events, {
              type: "workflow_agent",
              agentIndex: record.index,
              phase: "settle",
              status,
              turns: record.usage.turns,
              maxTurns: record.maxTurns ?? maxTurns,
              durationMs: Math.max(
                0,
                (record.finishedAt ?? Date.now()) - record.startedAt,
              ),
              ...(category ? { errorCategory: category } : {}),
            });
          });
      };

      const runScript = async () => {
        let status: WorkflowDetails["status"] = "completed";
        try {
          details.result = await runWorkflowSandbox({
            source: prepared.source,
            args,
            cwd: ctx.cwd,
            signal: controller.signal,
            onAgent: agentFn,
            onPhase: phaseFn,
          });
          const semanticFailure = semanticFailureStatus(details.result);
          if (semanticFailure) {
            status = "failed";
            details.error = `Workflow returned semantic status "${semanticFailure}"`;
          }
        } catch (error) {
          details.error = errorText(error);
          status = details.paused
            ? "paused"
            : controller.signal.aborted
              ? "aborted"
              : "failed";
          controller.abort("Workflow script failed");
        }

        controller.seal();
        if (emitTimer) clearTimeout(emitTimer);
        emitTimer = undefined;
        const settled = await controller.settle({
          abort: status !== "completed",
        });
        if (!settled) {
          status = "failed";
          details.error = details.error
            ? `${details.error}; agent shutdown deadline exceeded`
            : "Agent shutdown deadline exceeded";
        }
        for (const record of details.agents) {
          if (record.state !== "running") continue;
          record.state = "error";
          record.error =
            record.error ?? "Agent did not settle before run cleanup";
          record.finishedAt = Date.now();
        }
        status = finalizeWorkflowPersistence(
          details,
          status,
          persistence,
          journal,
        );
      };

      // Registered for /workflows visibility and session_shutdown abort;
      // blocking runs are watchable live from the dashboard too.
      const activeRun = { details, controller } as {
        details: WorkflowDetails;
        controller: RunController;
        completion?: Promise<void>;
      };
      activeRuns.set(runId, activeRun);
      publishFleet();
      const completion = runScript().finally(() => {
        if (workflowDeadline) clearTimeout(workflowDeadline);
        const category = categorizeTelemetryError(
          details.error,
          details.status,
        );
        emitTelemetry(pi.events, {
          type: "workflow_run",
          phase: "settle",
          status:
            details.status === "completed"
              ? "completed"
              : details.status === "running"
                ? "running"
                : details.status === "aborted" || details.status === "paused"
                  ? "aborted"
                  : "failed",
          ...(details.status === "paused"
            ? {
                error: `paused:quota:${details.paused?.reason ?? "Provider quota exhausted"}`,
              }
            : {}),
          durationMs: Math.max(
            0,
            (details.finishedAt ?? Date.now()) - details.startedAt,
          ),
          ...(category ? { errorCategory: category } : {}),
        });
      });
      activeRun.completion = completion;
      if (ctx.hasUI) lastUi = ctx.ui;
      updateIndicator();

      if (background) {
        void completion
          .catch((error) => {
            details.status = "failed";
            details.finishedAt = Date.now();
            details.error = details.error ?? errorText(error);
          })
          .finally(() => {
            rememberFleetRun(details);
            activeRuns.delete(runId);
            recordSettledRun(details.status);
            updateIndicator();
            publishFleet();
            try {
              pi.sendUserMessage(
                buildBackgroundWorkflowFollowUp({
                  runId,
                  status: details.status,
                  result: buildWorkflowResultMessage(details, runDir),
                }),
                { deliverAs: "followUp" },
              );
            } catch {
              // Session may be shutting down.
            }
          });
        return {
          content: [
            {
              type: "text",
              text: buildBackgroundWorkflowLaunchResult({
                runId,
                name: details.name,
                runDir,
              }),
            },
          ],
          details: compactToolDetails(details),
        };
      }

      try {
        await completion;
      } finally {
        rememberFleetRun(details);
        activeRuns.delete(runId);
        recordSettledRun(details.status);
        updateIndicator();
        publishFleet();
      }
      if (details.status !== "completed") {
        // Pi marks tool failures only when execute throws; returning isError is
        // ignored by the extension API.
        throw new Error(buildWorkflowResultMessage(details, runDir));
      }
      return {
        content: [
          {
            type: "text",
            text: buildWorkflowResultMessage(details, runDir),
          },
        ],
        details: compactToolDetails(details),
      };
    },

    renderCall(args: Partial<WorkflowInput>, theme) {
      const meta =
        typeof args.script === "string"
          ? extractMeta(args.script)
          : { phases: [] };
      let text =
        theme.fg("toolTitle", theme.bold("workflow ")) +
        theme.fg("accent", (meta as WorkflowMeta).name ?? "(script)");
      if (args.background) text += theme.fg("dim", " (background)");
      const description = (meta as WorkflowMeta).description;
      if (description) text += `\n  ${theme.fg("dim", description)}`;
      for (const phase of meta.phases.slice(0, 8)) {
        text += `\n  ${theme.fg("dim", SQUARE)} ${theme.fg("accent", phase.title)}${
          phase.detail ? theme.fg("dim", ` — ${phase.detail}`) : ""
        }`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as WorkflowDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(
          first?.type === "text" ? first.text : "(no output)",
          0,
          0,
        );
      }

      const { done, failed } = countStates(details);
      const settled = done + failed;
      const elapsed = formatElapsed(details.startedAt, details.finishedAt);
      let header =
        `${theme.fg(statusColor(details.status), SQUARE)} ${theme.fg("toolTitle", theme.bold("workflow "))}` +
        `${theme.fg("accent", details.name ?? details.runId)} ` +
        theme.fg(
          "dim",
          `${settled}/${details.agents.length} agents · ${elapsed} · `,
        ) +
        theme.fg(statusColor(details.status), statusWord(details.status));
      if (failed) header += theme.fg("error", ` · ${failed} failed`);
      if (details.background) header += theme.fg("dim", " (background)");
      if (details.status === "running" && details.currentPhase) {
        header += theme.fg("muted", ` · ${details.currentPhase}`);
      }
      const totals = formatUsage(aggregateUsage(details.agents));

      if (!expanded) {
        let text = header;
        for (const agent of details.agents) {
          const context = agentContext(agent);
          text += `\n  ${stateSquare(agent.state, theme)} ${theme.fg("accent", agent.label)}${
            agent.phase ? theme.fg("dim", ` (${agent.phase})`) : ""
          }${theme.fg(
            "dim",
            `${context ? ` · ${context}` : ""} · ${formatElapsed(agent.startedAt, agent.finishedAt)}`,
          )}`;
        }
        if (totals) text += `\n  ${theme.fg("dim", `Total: ${totals}`)}`;
        if (details.error)
          text += `\n  ${theme.fg("error", `Error: ${details.error}`)}`;
        text += `\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
        return new Text(text, 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(header, 0, 0));
      if (details.description) {
        container.addChild(
          new Text(theme.fg("dim", details.description), 0, 0),
        );
      }

      for (const group of phaseGroups(details)) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg("muted", `─── ${group.title} ───`), 0, 0),
        );
        for (const agent of group.agents) {
          const usage = formatUsage(
            agent.usage,
            agent.model,
            agent.maxTurns,
            agent.maxContinuations,
          );
          const context = agentContext(agent);
          let line = `${stateSquare(agent.state, theme)} ${theme.fg("accent", agent.label)} ${theme.fg(
            "dim",
            [context, formatElapsed(agent.startedAt, agent.finishedAt)]
              .filter(Boolean)
              .join(" · "),
          )}`;
          if (usage) line += ` ${theme.fg("dim", usage)}`;
          container.addChild(new Text(line, 0, 0));
          if (agent.error) {
            container.addChild(
              new Text(`  ${theme.fg("error", agent.error)}`, 0, 0),
            );
          } else if (agent.preview) {
            const preview = agent.preview.split("\n").slice(0, 2).join(" ");
            container.addChild(new Text(`  ${theme.fg("dim", preview)}`, 0, 0));
          }
        }
      }

      if (details.error) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg("error", `Error: ${details.error}`), 0, 0),
        );
      }

      if (details.result !== undefined) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── result ───"), 0, 0));
        container.addChild(
          new Markdown(
            `\`\`\`json\n${resultJson(details.result)}\n\`\`\``,
            0,
            0,
            getMarkdownTheme(),
          ),
        );
      }

      if (totals) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", `Total: ${totals}`), 0, 0));
      }
      return container;
    },
  });
}
