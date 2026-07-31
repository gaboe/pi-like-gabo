import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getBackgroundSubagentService } from "../../vendor/pi-tools/extensions/shared/background-subagent-protocol.js";
import type { Task } from "./tool/types.js";

export type OrchestratorSetting = "on" | "off" | "auto";
export type OrchestratorMode = "direct" | "provisional" | "sticky";
export interface OrchestratorClassification { requiresOrchestration: boolean; signals: string[]; fallback?: string }

const SIGNALS: Array<[RegExp, string]> = [
  [/\b(?:orchestrat|delegate|work package|package worker|parallel package)\b/i, "explicit delegation"],
  [/\b(?:plan|worktree|reload|handoff|multi[- ]repo)\b/i, "durable coordination"],
  [/\b(?:parallel|independent)\b/i, "independent work"],
  [/\b(?:implement|migrate|refactor|audit)\b[\s\S]{0,160}\b(?:and|plus)\b/i, "broad autonomous outcome"],
];

export function classifyOrchestration(raw: string, prepared?: Record<string, unknown>): OrchestratorClassification {
  const text = [raw, ...(prepared ? [JSON.stringify({ affectedPaths: prepared.affectedPaths, steps: prepared.steps, risks: prepared.risks })] : [])].join("\n");
  const signals = SIGNALS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  if (Array.isArray(prepared?.affectedPaths) && prepared.affectedPaths.length > 2) signals.push("multi-path dossier");
  return { requiresOrchestration: signals.length > 0, signals: [...new Set(signals)] };
}

function parsedClassification(text: string): OrchestratorClassification | undefined {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    const value = JSON.parse(match[0]);
    if (!value || typeof value !== "object" || typeof value.requiresOrchestration !== "boolean" || !Array.isArray(value.signals) || !(value.signals as unknown[]).every((x) => typeof x === "string" && x.length <= 120)) return undefined;
    return { requiresOrchestration: value.requiresOrchestration, signals: [...new Set(value.signals as string[])].slice(0, 6) };
  } catch { return undefined; }
}

export async function requestOrchestratorClassification(
  ctx: ExtensionCommandContext,
  raw: string,
  prepared?: Record<string, unknown>,
  onSpawn?: (id: string) => void,
): Promise<OrchestratorClassification> {
  const service = getBackgroundSubagentService();
  if (!service) throw new Error("background subagent service unavailable");
  const result = await service.run({
    title: "Classify TODO",
    cwd: ctx.cwd,
    model: "openai-codex/gpt-5.6-luna", reasoningEffort: "low", maxTurns: 1, timeoutMs: 20_000, allowedTools: [], noExtensions: true,
    onSpawn,
    parent: { parentCwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(), inheritedModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined, inheritedThinkingLevel: "low", modelRegistry: ctx.modelRegistry },
    prompt: `Return JSON only: {"requiresOrchestration":boolean,"signals":string[]}. Label true only for explicit delegation/plan, independent safe packages, broad autonomous package, multi-worktree/repo, durable handoff, or long-running coordination. Step count alone is never signal. No tools.\nTODO:\n${raw.slice(0, 4000)}\nPrepared dossier (optional):\n${JSON.stringify(prepared ?? {}).slice(0, 4000)}`,
  });
  const parsed = result.status === "done" ? parsedClassification(result.output) : undefined;
  if (!parsed) throw new Error(result.error ?? "invalid TODO classifier result");
  return parsed;
}

export function aggregateOrchestratorMode(tasks: readonly Task[], setting: OrchestratorSetting, sticky = false): OrchestratorMode {
  if (setting === "off") return "direct";
  const unresolved = tasks.filter((task) => task.status !== "completed" && task.status !== "deleted");
  if (sticky || unresolved.some((task) => (task.metadata?.orchestrator as { mode?: unknown } | undefined)?.mode === "sticky")) return "sticky";
  if (setting === "on") return "provisional";
  return unresolved.some((task) => ((task.metadata?.orchestrator as OrchestratorClassification | undefined)?.requiresOrchestration || (task.metadata?.orchestrator as { mode?: unknown } | undefined)?.mode === "provisional")) ? "provisional" : "direct";
}

export function modeFor(setting: OrchestratorSetting, classification: OrchestratorClassification, prior?: OrchestratorMode): OrchestratorMode {
  if (setting === "off") return "direct";
  if (prior === "sticky") return "sticky";
  return setting === "on" || classification.requiresOrchestration ? "provisional" : "direct";
}

export function markOrchestrator(task: Task, setting: OrchestratorSetting, classification: OrchestratorClassification, phase: "raw" | "prepared", prior?: OrchestratorMode): Task {
  const mode = modeFor(setting, classification, prior);
  return { ...task, metadata: { ...task.metadata, orchestrator: { mode, phase, requiresOrchestration: classification.requiresOrchestration, signals: classification.signals, fallback: classification.fallback } } };
}
export function stickyOrchestrator(task: Task): Task {
  if (task.status === "completed" || task.status === "deleted") return task;
  const prior = task.metadata?.orchestrator as Record<string, unknown> | undefined;
  return prior?.mode !== "provisional" ? task : { ...task, metadata: { ...task.metadata, orchestrator: { ...prior, mode: "sticky", startedAt: "execution" } } };
}
export function orchestratorStatus(tasks: readonly Task[], setting: OrchestratorSetting, sticky = false): string { return `orchestrator ${setting}/${aggregateOrchestratorMode(tasks, setting, sticky)}`; }

export function orchestratorFooterStatus(tasks: readonly Task[], setting: OrchestratorSetting, sticky = false): string | undefined {
  const mode = aggregateOrchestratorMode(tasks, setting, sticky);
  return mode === "direct" ? undefined : `orchestrator: ${mode}`;
}
export const ORCHESTRATOR_GUIDANCE = "Orchestrator mode: Preparation Analyst produces dossier; TODO Classifier is provisional until execution makes aggregate mode sticky. Use a self-contained prompt for simple work or an Orchestrator-only scratchpad plan for complex packages. Give each maximal package its mandatory header and assign it directly. Prefer non-blocking background subagent spawns; after conflict checks, fill safe independent worker capacity and continue other TODOs. When only background work remains, end the turn and rely on completion delivery. Use subagent_wait only for already-settled collection, non-interactive execution, or a concrete dependency/result-freshness gate; do not blanket-ban waiting when a concrete dependency exists. Only initial start and final review are formal checkpoints. Package Workers use output_contract:'package_handoff' plus todo_id and todo_token from current TODO metadata.preparation.token; ordinary scouts omit all three. Mechanical Gate validates form, Orchestrator Gate validates meaning, and both corrections return to same worker. Reloaded interrupted work starts with diff/worktree inspection. Parent owns approvals, semantic acceptance, integration, Git, and external mutations; never add a Dispatcher.";
