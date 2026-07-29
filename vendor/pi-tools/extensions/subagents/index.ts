/**
 * Subagents — spawn Pi-only in-process subagents
 * (Pi in-process sessions) unified behind a single Effect service interface.
 *
 * Tools (for the parent LLM):
 * - subagent_spawn: fire-and-forget Pi spawn (prompt, title, working_dir,
 *   model, reasoning_effort). Max 4 running at once.
 * - subagent_send: steer or continue one existing subagent.
 * - subagent_wait: block until the listed subagents settle, return results.
 * - subagent_cancel: stop one or more running subagents.
 * - subagent_check: peek at a subagent's status and recent activity.
 * - subagent_list: list all subagents.
 *
 * Unawaited subagents queue their result as a follow-up message when they
 * settle. `/subagents` opens a picker + full interactive takeover view.
 *
 * Architecture: Effect v4 generators throughout (Pi backend -> manager ->
 * runtime); this file is the async boundary where tool handlers run effects
 * against one shared ManagedRuntime. Pi backend runs in-process SDK sessions.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  BashOperations,
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  createLocalBashOperations,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getAgentDir,
  getMarkdownTheme,
  ProjectTrustStore,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  DEFAULT_SUBAGENT_TURNS,
  formatElapsed,
  latestText,
  MAX_SUBAGENT_TURNS,
  MIN_SUBAGENT_TURNS,
  REASONING_EFFORTS,
  type SubagentSnapshot,
} from "./src/domain.ts";
import {
  formatActivityStatus,
  formatContextUtilization,
} from "./src/format.ts";
import {
  SubagentManager,
  type SubagentManagerShape,
  type SubagentReadModel,
} from "./src/manager.ts";
import {
  buildSubagentResultMessage,
  buildSubagentSpawnResult,
  SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CANCEL_TOOL_DESCRIPTION,
  SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CHECK_TOOL_DESCRIPTION,
  SUBAGENT_LIST_TOOL_DESCRIPTION,
  SUBAGENT_SEND_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SEND_PROMPT_GUIDELINES,
  SUBAGENT_SEND_PROMPT_SNIPPET,
  SUBAGENT_SEND_TOOL_DESCRIPTION,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_SNIPPET,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
  SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS,
  SUBAGENT_WAIT_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";
import {
  createSubagentRuntime,
  runTool,
  type SubagentRuntime,
} from "./src/runtime.ts";
import { openSubagentPicker, openSubagentTakeover } from "./src/ui/takeover.ts";
import {
  onFleetOpen,
  onFleetQuery,
  publishFleetState,
  type SubagentFleetItem,
} from "../shared/fleet-protocol.ts";
import {
  registerBackgroundSubagentService,
  type BackgroundSubagentService,
} from "../shared/background-subagent-protocol.ts";
import { CHILD_COST_CHANNEL } from "../shared/dashboard-state.ts";
import {
  currentDelegationState,
  MAX_TODO_TOKEN_LENGTH,
  SUBAGENT_DELEGATION_STATE_CHANNEL,
  SUBAGENT_WAIT_STATE_CHANNEL,
  validatePackageOwnership,
  type SubagentWaitState,
} from "../shared/subagent-wait-protocol.ts";
import {
  AUTOMATION_PAUSE_CHANNEL,
  type AutomationPauseRequest,
} from "../shared/automation-pause-protocol.ts";
import {
  acquirePackageAssignmentLeaseAsync,
  packageAssignmentError,
  type PackageAssignmentRequest,
} from "../shared/assignment-gate-protocol.ts";
import { resolveWorkspaceMutationPath } from "../shared/resolve-to-cwd.ts";
import {
  beginGlobalShellExecution,
  beginWorkspaceToolExecution,
  type WorkspaceActivity,
} from "../shared/workspace-mutation-lease.ts";

const SUBAGENT_OUTPUT_MAX_BYTES = 24 * 1024;
export const SUBAGENT_SEND_ID_MAX_LENGTH = 64;
export const SUBAGENT_SEND_MESSAGE_MAX_LENGTH = 16 * 1024;
const WAIT_OUTPUT_MAX_BYTES = 48 * 1024;
const WAIT_PER_AGENT_MAX_BYTES = 16 * 1024;
const PACKAGE_HANDOFF_INSTRUCTIONS = `\n\nFinal response must be one JSON object: {"status":"done|partial|blocked|failed","acceptance":[{"criterion":"...","passed":true,"evidence":["..."]}],"changed_paths":["..."],"checks":[{"name":"...","result":"..."}],"review":"...","remaining_work":["..."],"risks":["..."],"budget_request":{"additional_turns":4,"reason":"..."}}. Omit budget_request unless status is partial and bounded remaining work needs one explicitly approved extension. Request the exact additional turns needed; total max_turns cannot exceed 48. For done, every acceptance item must pass and have evidence. Semantic quality and extension approval remain parent-owned.`;

export function validateSubagentAssignment(
  outputContract: unknown,
  todoId: unknown,
  todoToken: unknown,
): string | undefined {
  const ownershipError = validatePackageOwnership(
    outputContract,
    todoId,
    todoToken,
  );
  if (ownershipError || outputContract !== "package_handoff")
    return ownershipError;
  return packageAssignmentError({
    todoId: todoId as number,
    todoToken: todoToken as string,
  });
}

export async function spawnPackageAssignment<
  Manager,
  Snapshot extends { id: string },
>(
  request: PackageAssignmentRequest,
  callbacks: {
    getManager(): Promise<Manager>;
    spawn(manager: Manager, signal?: AbortSignal): Promise<Snapshot>;
    start?(
      manager: Manager,
      id: string,
      signal?: AbortSignal,
    ): Promise<unknown>;
    reject?(manager: Manager, id: string, reason: string): Promise<unknown>;
    cancel(manager: Manager, id: string): Promise<unknown>;
    onPending?(): void;
    onRelease?(): void;
    onRejected?(snapshot: Snapshot, manager: Manager): void;
    onAccepted?(snapshot: Snapshot, manager: Manager): void;
    onCallbackError?(error: unknown): void;
  },
  signal?: AbortSignal,
): Promise<Snapshot> {
  const lease = await acquirePackageAssignmentLeaseAsync(request, signal);
  if (typeof lease === "string") throw new Error(lease);
  let pending = false;
  const report = (error: unknown) => {
    try {
      callbacks.onCallbackError?.(error);
    } catch {}
  };
  const observe = (callback: (() => void) | undefined) => {
    try {
      callback?.();
    } catch (error) {
      report(error);
    }
  };
  const release = () => {
    if (!pending) return;
    pending = false;
    observe(callbacks.onRelease);
  };
  const aborted = () =>
    signal?.aborted
      ? "package_handoff assignment acquisition was aborted."
      : undefined;
  try {
    if (aborted()) throw new Error(aborted());
    pending = true;
    observe(callbacks.onPending);
    if (aborted()) throw new Error(aborted());
    const manager = await callbacks.getManager();
    const beforeSpawnError = aborted() ?? lease.validate();
    if (beforeSpawnError) throw new Error(beforeSpawnError);
    const snapshot = await callbacks.spawn(manager, signal);
    const error = aborted() ?? lease.validate();
    const authorizationError = error ? undefined : lease.authorize(snapshot.id);
    const rejection = error ?? authorizationError ?? aborted();
    if (rejection) {
      observe(() => callbacks.onRejected?.(snapshot, manager));
      try {
        await callbacks.reject?.(manager, snapshot.id, rejection);
      } catch (callbackError) {
        report(callbackError);
      }
      try {
        await callbacks.cancel(manager, snapshot.id);
      } catch (cancelError) {
        report(cancelError);
      }
      throw new Error(rejection);
    }
    const beforeStartError = aborted();
    if (beforeStartError) {
      observe(() => callbacks.onRejected?.(snapshot, manager));
      try {
        await callbacks.reject?.(manager, snapshot.id, beforeStartError);
      } catch (callbackError) {
        report(callbackError);
      }
      try {
        await callbacks.cancel(manager, snapshot.id);
      } catch (cancelError) {
        report(cancelError);
      }
      throw new Error(beforeStartError);
    }
    try {
      await callbacks.start?.(manager, snapshot.id, signal);
    } catch (startError) {
      observe(() => callbacks.onRejected?.(snapshot, manager));
      try {
        await callbacks.reject?.(
          manager,
          snapshot.id,
          startError instanceof Error ? startError.message : String(startError),
        );
      } catch (callbackError) {
        report(callbackError);
      }
      try {
        await callbacks.cancel(manager, snapshot.id);
      } catch (cancelError) {
        report(cancelError);
      }
      throw startError;
    }
    const afterStartError = aborted();
    if (afterStartError) {
      observe(() => callbacks.onRejected?.(snapshot, manager));
      try {
        await callbacks.reject?.(manager, snapshot.id, afterStartError);
      } catch (callbackError) {
        report(callbackError);
      }
      try {
        await callbacks.cancel(manager, snapshot.id);
      } catch (cancelError) {
        report(cancelError);
      }
      throw new Error(afterStartError);
    }
    release();
    observe(() => callbacks.onAccepted?.(snapshot, manager));
    return snapshot;
  } finally {
    lease.close();
    release();
  }
}

const BLOCKED_USER_BASH_RESULT = {
  output: "Shell execution blocked by an active workspace mutation lease.",
  exitCode: 1,
  cancelled: false,
  truncated: false,
} satisfies NonNullable<UserBashEventResult["result"]>;

export function createParentUserBashGuard(local: BashOperations) {
  const pending = new Set<() => void>();
  return {
    begin() {
      let activity: WorkspaceActivity;
      try {
        activity = beginGlobalShellExecution();
      } catch {
        return { result: BLOCKED_USER_BASH_RESULT };
      }
      let active = true;
      const close = () => {
        if (!active) return;
        active = false;
        pending.delete(close);
        activity.close();
      };
      pending.add(close);
      return {
        operations: {
          async exec(command, cwd, options) {
            try {
              return await local.exec(command, cwd, options);
            } finally {
              close();
            }
          },
        } satisfies BashOperations,
      };
    },
    close() {
      for (const close of pending) close();
    },
  };
}

export function createParentWorkspaceMutationGuard(workspaceRoot: string) {
  const active = new Map<string, WorkspaceActivity>();
  return {
    start(toolCallId: string, toolName: string, input?: unknown) {
      if (!["write", "edit", "bash"].includes(toolName)) return undefined;
      try {
        const target = (input as { path?: unknown } | undefined)?.path;
        const activity =
          toolName === "bash"
            ? beginGlobalShellExecution()
            : beginWorkspaceToolExecution(
                resolveWorkspaceMutationPath(target, workspaceRoot),
              );
        active.get(toolCallId)?.close();
        active.set(toolCallId, activity);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    end(toolCallId: string) {
      active.get(toolCallId)?.close();
      active.delete(toolCallId);
    },
    close() {
      for (const activity of active.values()) activity.close();
      active.clear();
    },
  };
}

export function backgroundProgressStage(snap: SubagentSnapshot): string {
  const tool = snap.liveTools.at(-1)?.name;
  if (tool) {
    if (
      [
        "web_search",
        "fetch_content",
        "get_search_content",
        "search",
        "scrape",
        "crawl",
      ].includes(tool)
    )
      return "researching sources";
    if (["read", "bash", "rg", "fd"].includes(tool))
      return "inspecting repository";
    return `using ${tool}`;
  }
  if (snap.liveAssistant?.text.trim() || snap.turns > 0)
    return "synthesizing findings";
  return "starting analyst";
}

export function backgroundProgressSubject(
  snap: SubagentSnapshot,
): string | undefined {
  const normalized = (text: string, complete: boolean) => {
    const match = complete
      ? /(?:^|\n)TITLE:\s*([^\n]{4,})\s*(?:\n|$)/i.exec(text)
      : /(?:^|\n)TITLE:\s*([^\n]{4,})\s*\n/i.exec(text);
    if (!match) return undefined;
    const title = match[1]
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return Array.from(title).slice(0, 100).join("");
  };
  const live = snap.liveAssistant?.text;
  if (live) {
    const subject = normalized(live, false);
    if (subject) return subject;
  }
  for (const item of [...snap.transcript].reverse()) {
    if (item.kind !== "assistant") continue;
    const text = item.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const subject = normalized(text, true);
    if (subject) return subject;
  }
  return undefined;
}

export function shouldReportBackgroundProgress(
  lastStage: string,
  lastAt: number,
  stage: string,
  now: number,
  force = false,
): boolean {
  return force || stage !== lastStage || now - lastAt >= 60_000;
}

function describeSubagent(snap: SubagentSnapshot) {
  const details = [
    `${snap.backend}: ${snap.meta.modelLabel ?? "?"}`,
    formatContextUtilization(snap.usage),
    formatElapsed(snap),
    snap.cwd,
  ].filter(Boolean);
  return `${snap.id} [${snap.status}] "${snap.title}" (${details.join(", ")})`;
}

function truncatedOutput(
  snap: SubagentSnapshot,
  maxBytes = SUBAGENT_OUTPUT_MAX_BYTES,
): string {
  const output = snap.finalText || "(no output)";
  const truncation = truncateHead(output, {
    maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
    maxLines: Math.min(600, DEFAULT_MAX_LINES),
  });
  let text = truncation.content;
  if (truncation.truncated) {
    text += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} shown. Full transcript in session file: ${snap.meta.sessionFilePath ?? "?"}]`;
  }
  return text;
}

/**
 * Same-directory children inherit the live parent decision. An alternate cwd
 * is trusted only when pi's persisted trust store explicitly trusts it (or a
 * containing directory); unreadable/invalid trust data fails closed.
 */
export function deferredInteractiveWaitResult(
  mode: string | undefined,
  ids: readonly string[],
  statusOf: (id: string) => string | undefined,
) {
  if (mode !== "tui") return undefined;
  const pending = ids.filter((id) => statusOf(id) === "running");
  if (pending.length === 0) return undefined;
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Still waiting for ${pending.join(", ")}. ` +
          "End this turn instead of blocking; the results will arrive automatically, and the user can keep prompting or add TODOs meanwhile.",
      },
    ],
    details: { pending, deferred: true },
    terminate: true,
  };
}

function resolveChildProjectTrust(options: {
  parentCwd: string;
  childCwd: string;
  parentTrusted: boolean;
}) {
  if (path.resolve(options.childCwd) === path.resolve(options.parentCwd)) {
    return options.parentTrusted;
  }
  try {
    const trustStore = new ProjectTrustStore(getAgentDir());
    return trustStore.get(options.childCwd) === true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  let runtime: SubagentRuntime | undefined;
  let managerPromise: Promise<SubagentManagerShape> | undefined;
  let sessionContext: ExtensionContext | undefined;
  let ui: ExtensionUIContext | undefined;
  let unsubStatus: (() => void) | undefined;
  let fleetView: SubagentReadModel | undefined;
  let stopFleetQuery: (() => void) | undefined;
  let stopFleetOpen: (() => void) | undefined;
  let fleetOpening = false;
  let sessionGeneration = 0;
  let unregisterBackgroundService: (() => void) | undefined;
  let parentMutationGuard:
    ReturnType<typeof createParentWorkspaceMutationGuard> | undefined;
  let parentUserBashGuard:
    ReturnType<typeof createParentUserBashGuard> | undefined;
  const localUserBashOperations = createLocalBashOperations();
  const resultDelivery = createDeferredResultDelivery<SubagentSnapshot>();
  const deferredWaitIds = new Set<string>();
  const isSnapshotVisible = (snap: SubagentSnapshot | undefined) =>
    !!snap && snap.pendingStart !== true;
  const visibleSnapshots = (view: SubagentReadModel | undefined = fleetView) =>
    (view?.list() ?? []).filter(isSnapshotVisible);

  const publishWaitState = () => {
    pi.events.emit(SUBAGENT_WAIT_STATE_CHANNEL, {
      ids: [...deferredWaitIds],
    } satisfies SubagentWaitState);
  };

  const publishDelegationState = (
    view: SubagentReadModel | undefined = fleetView,
  ) => {
    pi.events.emit(
      SUBAGENT_DELEGATION_STATE_CHANNEL,
      currentDelegationState(visibleSnapshots(view)),
    );
  };

  const getRuntime = () => (runtime ??= createSubagentRuntime());

  /** Resolve the manager service once per runtime and wire the extension hooks. */
  const getManager = () => {
    managerPromise ??= getRuntime()
      .runPromise(SubagentManager)
      .then((manager) => {
        manager.view.setOnSettled(onSettled);
        fleetView = manager.view;
        unsubStatus?.();
        unsubStatus = manager.view.subscribe(() => {
          updateStatus(manager.view);
          publishFleet();
          publishCosts(manager);
          publishDelegationState(manager.view);
        });
        updateStatus(manager.view);
        publishFleet();
        publishCosts(manager);
        publishDelegationState(manager.view);
        return manager;
      });
    return managerPromise;
  };

  pi.events.on(AUTOMATION_PAUSE_CHANNEL, (value) => {
    const request = value as AutomationPauseRequest | undefined;
    if (!request || request.reason !== "double-escape") return;
    const ids = (fleetView?.list() ?? [])
      .filter((snap) => snap.status === "running")
      .map((snap) => snap.id);
    if (ids.length === 0) return;
    request.acknowledge("subagents", ids.length);
    void getManager()
      .then((manager) => runTool(getRuntime(), manager.cancel(ids)))
      .catch((error) => console.error("subagents: global pause failed", error));
  });

  const backgroundService: BackgroundSubagentService = {
    async run(request) {
      const manager = await getManager();
      const snap = await runTool(
        getRuntime(),
        manager.spawn("pi", {
          prompt: request.prompt,
          title: request.title,
          cwd: path.resolve(request.cwd),
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          maxTurns: request.maxTurns,
          allowedTools: request.allowedTools,
          readOnlyBash: request.readOnlyBash,
          noExtensions: request.noExtensions,
          suppressResultDelivery: true,
          parent: request.parent,
        }),
      );
      try {
        request.onSpawn?.(snap.id);
      } catch {}
      let lastProgressAt = 0;
      let lastProgressKey = "";
      const reportProgress = (force = false) => {
        if (!request.onProgress) return;
        const current = manager.view.get(snap.id);
        if (!current) return;
        const stage = backgroundProgressStage(current);
        const subject = backgroundProgressSubject(current);
        const progressKey = `${stage}\0${subject ?? ""}`;
        const now = Date.now();
        if (
          !shouldReportBackgroundProgress(
            lastProgressKey,
            lastProgressAt,
            progressKey,
            now,
            force,
          )
        )
          return;
        lastProgressAt = now;
        lastProgressKey = progressKey;
        try {
          request.onProgress({
            id: snap.id,
            stage,
            ...(subject ? { subject } : {}),
            at: now,
          });
        } catch {}
      };
      reportProgress(true);
      const stopProgress = manager.view.subscribe(() => reportProgress());
      const progressHeartbeat = setInterval(() => reportProgress(true), 60_000);
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wait = runTool(getRuntime(), manager.waitFor([snap.id]));
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(
          () => {
            timedOut = true;
            void runTool(getRuntime(), manager.cancel([snap.id])).finally(
              resolve,
            );
          },
          Math.max(1_000, Math.min(request.timeoutMs ?? 120_000, 600_000)),
        );
      });
      try {
        await Promise.race([wait, timeout]);
        if (timedOut) await wait;
      } finally {
        if (timer) clearTimeout(timer);
        clearInterval(progressHeartbeat);
        stopProgress();
      }
      const settled = await runTool(getRuntime(), manager.get(snap.id));
      if (!settled)
        return {
          id: snap.id,
          status: "error",
          output: "",
          error: "Subagent result disappeared",
        };
      return {
        id: settled.id,
        status: timedOut
          ? "error"
          : settled.status === "done"
            ? "done"
            : "error",
        output: settled.finalText,
        ...(timedOut
          ? { error: "Background subagent timed out" }
          : settled.errorText
            ? { error: settled.errorText }
            : {}),
      };
    },
    async cancel(ids) {
      const bounded = [...new Set(ids)].slice(0, 64);
      if (bounded.length)
        await runTool(getRuntime(), (await getManager()).cancel(bounded));
    },
  };

  const publishCosts = (manager: SubagentManagerShape) => {
    for (const snap of visibleSnapshots(manager.view)) {
      if (snap.usage.cost === undefined) continue;
      pi.events.emit(CHILD_COST_CHANNEL, {
        key: `subagent:${snap.id}`,
        cost: snap.usage.cost,
        settled: snap.status !== "running",
      });
    }
  };

  const updateStatus = (view: SubagentReadModel) => {
    if (!ui) return;
    const subs = visibleSnapshots(view);
    if (subs.length === 0) {
      ui.setStatus("subagents", undefined);
      return;
    }
    const running = subs.filter((snap) => snap.status === "running").length;
    const failed = subs.filter((snap) => snap.status === "error").length;
    const done = subs.length - running - failed;
    ui.setStatus(
      "subagents",
      formatActivityStatus(ui.theme, {
        running,
        done,
        failed,
        waiting: running > 0 && sessionContext?.isIdle() === true,
      }),
    );
  };

  const publishFleet = () => {
    const items: SubagentFleetItem[] = visibleSnapshots().map((snap) => ({
      source: "subagents",
      kind: "subagent",
      id: snap.id,
      title: snap.title,
      status: snap.status,
      startedAt: snap.createdAt,
      settledAt: snap.settledAt,
      detail: [
        snap.backend,
        snap.meta.modelLabel,
        snap.reasoningEffort ? `${snap.reasoningEffort} effort` : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
      tokens: snap.usage.tokens,
      turns: snap.turns,
      maxTurns: snap.maxTurns,
      parentId: snap.lineage?.parentId,
      depth: snap.lineage?.depth,
      role: snap.lineage?.role,
    }));
    publishFleetState(pi.events, { source: "subagents", items });
  };

  const deliverResult = (snap: SubagentSnapshot) => {
    pi.sendMessage(
      {
        customType: "subagent-result",
        content: buildSubagentResultMessage({
          id: snap.id,
          title: snap.title,
          status: snap.status,
          errorText: snap.errorText,
          output: truncatedOutput(snap),
        }),
        display: true,
        details: { id: snap.id, title: snap.title, status: snap.status },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const flushResults = () => {
    for (const snap of resultDelivery.drain()) deliverResult(snap);
  };

  const onSettled = (snap: SubagentSnapshot, consumed: boolean) => {
    if (!isSnapshotVisible(snap)) return;
    if (deferredWaitIds.delete(snap.id)) publishWaitState();
    if (consumed) {
      resultDelivery.consume([snap.id]);
      return;
    }
    // Keep the result retractable while the parent is working. A later
    // subagent_wait can consume it before agent_settled flushes follow-ups.
    // Defer a copy: the live snapshot keeps mutating if the subagent is
    // restarted before the deferred result flushes.
    resultDelivery.defer({ ...snap, meta: { ...snap.meta } });
    if (sessionContext?.isIdle()) flushResults();
  };

  pi.on("session_start", (_event, ctx) => {
    sessionGeneration++;
    sessionContext = ctx;
    parentMutationGuard?.close();
    parentMutationGuard = createParentWorkspaceMutationGuard(ctx.cwd);
    parentUserBashGuard?.close();
    parentUserBashGuard = createParentUserBashGuard(localUserBashOperations);
    publishWaitState();
    publishDelegationState();
    unregisterBackgroundService?.();
    unregisterBackgroundService =
      registerBackgroundSubagentService(backgroundService);
    if (ctx.hasUI) ui = ctx.ui;
    stopFleetQuery ??= onFleetQuery(pi.events, publishFleet);
    stopFleetOpen ??= onFleetOpen(pi.events, (request) => {
      const view = fleetView;
      if (
        request.source !== "subagents" ||
        request.kind !== "subagent" ||
        fleetOpening ||
        ctx.mode !== "tui" ||
        !view ||
        !isSnapshotVisible(view.get(request.id))
      ) {
        return;
      }
      fleetOpening = true;
      void openSubagentTakeover(ctx, view, request.id).finally(() => {
        fleetOpening = false;
      });
    });
  });

  pi.on("tool_call", (event) => {
    const error = parentMutationGuard?.start(
      event.toolCallId,
      event.toolName,
      event.input,
    );
    return error ? { block: true, reason: error } : undefined;
  });

  pi.on("user_bash", () => parentUserBashGuard?.begin());

  pi.on("tool_execution_end", (event) => {
    parentMutationGuard?.end(event.toolCallId);
  });

  pi.on("agent_start", () => {
    if (fleetView) updateStatus(fleetView);
  });

  pi.on("agent_settled", () => {
    flushResults();
    if (fleetView) updateStatus(fleetView);
  });

  pi.on("session_shutdown", async () => {
    const generation = sessionGeneration;
    const closingRuntime = runtime;
    const closingManager = managerPromise;
    const closingView = fleetView;
    sessionContext = undefined;
    ui = undefined;
    parentMutationGuard?.close();
    parentMutationGuard = undefined;
    parentUserBashGuard?.close();
    parentUserBashGuard = undefined;
    unregisterBackgroundService?.();
    unregisterBackgroundService = undefined;
    resultDelivery.clear();

    await closingRuntime?.dispose();
    if (
      generation !== sessionGeneration ||
      runtime !== closingRuntime ||
      managerPromise !== closingManager ||
      fleetView !== closingView
    )
      return;

    deferredWaitIds.clear();
    publishWaitState();
    publishFleetState(pi.events, { source: "subagents", items: [] });
    publishDelegationState(closingView);
    unsubStatus?.();
    unsubStatus = undefined;
    stopFleetQuery?.();
    stopFleetQuery = undefined;
    stopFleetOpen?.();
    stopFleetOpen = undefined;
    fleetOpening = false;
    fleetView = undefined;
    runtime = undefined;
    managerPromise = undefined;
  });

  // --- Tools -------------------------------------------------------------

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    promptSnippet: SUBAGENT_SPAWN_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_SPAWN_PROMPT_GUIDELINES,
    parameters: Type.Object(
      {
        prompt: Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
        }),
        name: Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.name,
        }),
        working_dir: Type.Optional(
          Type.String({
            description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.workingDir,
          }),
        ),
        model: Type.Optional(
          Type.String({
            description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.model,
          }),
        ),
        reasoning_effort: Type.Optional(
          StringEnum(REASONING_EFFORTS, {
            description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
          }),
        ),
        max_turns: Type.Optional(
          Type.Integer({
            minimum: MIN_SUBAGENT_TURNS,
            maximum: MAX_SUBAGENT_TURNS,
            description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.maxTurns,
          }),
        ),
        output_contract: Type.Optional(
          Type.Literal("package_handoff", {
            description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.outputContract,
          }),
        ),
        todo_id: Type.Optional(
          Type.Integer({
            minimum: 1,
            description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.todoId,
          }),
        ),
        todo_token: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: MAX_TODO_TOKEN_LENGTH,
            description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.todoToken,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      for (const selector of ["harness", "agent", "backend"])
        if (Object.hasOwn(params, selector))
          throw new Error(
            `Legacy external selector "${selector}" is not supported; Pi subagents are always in-process.`,
          );
      const assignmentError = validateSubagentAssignment(
        params.output_contract,
        params.todo_id,
        params.todo_token,
      );
      if (assignmentError) throw new Error(assignmentError);
      const backend = "pi";
      const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`working_dir is not a directory: ${cwd}`);
      }

      const title = params.name.trim().slice(0, 160) || "subagent";
      const spawn = (
        manager: SubagentManagerShape,
        paused = false,
        spawnSignal?: AbortSignal,
      ) =>
        runTool(
          getRuntime(),
          (paused ? manager.prepare : manager.spawn)(backend, {
            prompt:
              params.output_contract === "package_handoff"
                ? `${params.prompt}${PACKAGE_HANDOFF_INSTRUCTIONS}`
                : params.prompt,
            title,
            cwd,
            model: params.model,
            reasoningEffort: params.reasoning_effort,
            maxTurns: params.max_turns ?? DEFAULT_SUBAGENT_TURNS,
            outputContract: params.output_contract,
            todoId: params.todo_id,
            todoToken: params.todo_token,
            validateAuthority:
              params.output_contract === "package_handoff"
                ? () =>
                    packageAssignmentError({
                      todoId: params.todo_id!,
                      todoToken: params.todo_token!,
                    })
                : undefined,
            parent: {
              parentCwd: ctx.cwd,
              projectTrusted: resolveChildProjectTrust({
                parentCwd: ctx.cwd,
                childCwd: cwd,
                parentTrusted: ctx.isProjectTrusted(),
              }),
              inheritedModel: ctx.model
                ? { provider: ctx.model.provider, id: ctx.model.id }
                : undefined,
              inheritedThinkingLevel: pi.getThinkingLevel(),
              modelRegistry: ctx.modelRegistry,
            },
          }),
          spawnSignal ? { signal: spawnSignal } : undefined,
        );
      let manager: SubagentManagerShape;
      let snap: SubagentSnapshot;
      if (params.output_contract === "package_handoff") {
        const request = {
          todoId: params.todo_id!,
          todoToken: params.todo_token!,
        };
        snap = await spawnPackageAssignment(
          request,
          {
            getManager,
            spawn: (current, startSignal) => spawn(current, true, startSignal),
            start: (current, id, startSignal) =>
              runTool(getRuntime(), current.start(id, startSignal), {
                signal: startSignal,
                interruptMessage:
                  "package_handoff assignment acquisition was aborted.",
              }),
            reject: (current, id, reason) =>
              runTool(getRuntime(), current.reject(id, reason)),
            cancel: (current, id) =>
              runTool(getRuntime(), current.cancel([id])),
            onAccepted(_accepted, current) {
              updateStatus(current.view);
              publishFleet();
              publishCosts(current);
              publishDelegationState(current.view);
            },
            onCallbackError(error) {
              console.error(
                "subagents: package assignment observer failed",
                error,
              );
            },
          },
          signal,
        );
        manager = await getManager();
      } else {
        manager = await getManager();
        snap = await spawn(manager);
        publishDelegationState(manager.view);
      }

      return {
        content: [
          {
            type: "text",
            text: buildSubagentSpawnResult({
              id: snap.id,
              title: snap.title,
              backend,
              modelLabel: snap.meta.modelLabel ?? "?",
              cwd,
            }),
          },
        ],
        details: {
          id: snap.id,
          title: snap.title,
          cwd,
          backend,
          model: snap.meta.modelLabel,
          output_contract: params.output_contract,
          todo_id: params.todo_id,
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_send",
    label: "Send to Subagent",
    description: SUBAGENT_SEND_TOOL_DESCRIPTION,
    promptSnippet: SUBAGENT_SEND_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_SEND_PROMPT_GUIDELINES,
    parameters: Type.Object({
      id: Type.String({
        minLength: 1,
        maxLength: SUBAGENT_SEND_ID_MAX_LENGTH,
        description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.id,
      }),
      message: Type.String({
        minLength: 1,
        maxLength: SUBAGENT_SEND_MESSAGE_MAX_LENGTH,
        description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.message,
      }),
      additional_turns: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_SUBAGENT_TURNS,
          description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.additionalTurns,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const id = params.id.trim();
      if (!id || !params.message.trim())
        throw new Error(
          `Rejected ${id || "subagent"}: id and message must be nonblank.`,
        );
      if (
        Buffer.byteLength(id) > SUBAGENT_SEND_ID_MAX_LENGTH ||
        Buffer.byteLength(params.message) > SUBAGENT_SEND_MESSAGE_MAX_LENGTH
      )
        throw new Error(`Rejected ${id}: input exceeds UTF-8 byte limit.`);
      if (signal?.aborted)
        throw new Error(`Rejected ${id}: send request was aborted.`);
      const manager = await getManager();
      if (signal?.aborted)
        throw new Error(`Rejected ${id}: send request was aborted.`);
      try {
        await runTool(
          getRuntime(),
          manager.send(id, params.message, params.additional_turns),
          {
            signal,
            interruptMessage: `Rejected ${id}: send request was aborted.`,
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith(`Rejected ${id}:`)) throw error;
        throw new Error(`Rejected ${id}: ${message}`);
      }
      const snap = manager.view.get(id);
      const extension = params.additional_turns
        ? ` Budget extended by ${params.additional_turns} turns to ${snap?.maxTurns}.`
        : "";
      return {
        content: [{ type: "text", text: `Accepted ${id}.${extension}` }],
        details: {
          id,
          status: "accepted",
          additional_turns: params.additional_turns,
          max_turns: snap?.maxTurns,
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagents",
    description: SUBAGENT_WAIT_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        maxItems: 64,
        description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");
      const known = manager.view.list().map((snap) => snap.id);
      const unknown = ids.filter((id) => !manager.view.get(id));
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      const deferred = deferredInteractiveWaitResult(
        ctx?.mode,
        ids,
        (id) => manager.view.get(id)?.status,
      );
      if (deferred) {
        for (const id of deferred.details.pending) deferredWaitIds.add(id);
        publishWaitState();
        return deferred;
      }

      await runTool(
        getRuntime(),
        manager.waitFor(ids, (pending) => {
          onUpdate?.({
            content: [
              { type: "text", text: `Waiting for ${pending.join(", ")}...` },
            ],
            details: { pending },
          });
        }),
        { signal, interruptMessage: "Wait aborted. Subagents keep running." },
      );

      // Settlement may have happened before this wait began. Remove any
      // deferred automatic delivery now that the tool is returning the result.
      resultDelivery.consume(ids);
      let waitStateChanged = false;
      for (const id of ids)
        waitStateChanged = deferredWaitIds.delete(id) || waitStateChanged;
      if (waitStateChanged) publishWaitState();

      const sections: string[] = [];
      let remainingBytes = WAIT_OUTPUT_MAX_BYTES;
      for (const id of ids) {
        const snap = manager.view.get(id);
        if (!snap) {
          sections.push(`## ${id}\n\n(no longer tracked)`);
          continue;
        }
        const verb = snap.status === "error" ? "failed" : "finished";
        let section = `## ${snap.id} "${snap.title}" ${verb}`;
        if (snap.errorText) section += `\nError: ${snap.errorText}`;
        const headerBytes = Buffer.byteLength(section, "utf8") + 2;
        const outputBudget = Math.max(
          512,
          Math.min(WAIT_PER_AGENT_MAX_BYTES, remainingBytes - headerBytes),
        );
        section += `\n\n${truncatedOutput(snap, outputBudget)}`;
        const sectionBytes = Buffer.byteLength(section, "utf8");
        if (sectionBytes > remainingBytes) {
          sections.push(
            `## ${snap.id} "${snap.title}"\n\n[omitted: total wait output limit reached]`,
          );
          break;
        }
        sections.push(section);
        remainingBytes -= sectionBytes;
      }

      const combined = sections.join("\n\n---\n\n");
      const bounded = truncateHead(combined, {
        maxBytes: WAIT_OUTPUT_MAX_BYTES - 128,
        maxLines: DEFAULT_MAX_LINES,
      });
      const text = bounded.truncated
        ? `${bounded.content}\n\n[wait output truncated at the total output limit]`
        : bounded.content;
      return {
        content: [{ type: "text", text }],
        details: {
          results: ids.map((id) => {
            const snap = manager.view.get(id);
            return { id, title: snap?.title, status: snap?.status };
          }),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Subagents",
    description: SUBAGENT_CANCEL_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");

      const known = manager.view.list().map((snap) => snap.id);
      const unknown = ids.filter((id) => !manager.view.get(id));
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      const report = await runTool(getRuntime(), manager.cancel(ids), {
        signal,
        interruptMessage: "Subagent cancellation aborted.",
      });

      const lines = report.map((entry) =>
        entry.cancelled
          ? `Cancelled ${entry.id} "${entry.title}".`
          : `${entry.id} "${entry.title}" was already ${entry.status}.`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          results: report.map((entry) => ({
            id: entry.id,
            title: entry.title,
            status: entry.status,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_check",
    label: "Check Subagent",
    description: SUBAGENT_CHECK_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS.id,
      }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      if (!snap) {
        const known = manager.view.list().map((s) => s.id);
        throw new Error(
          `Unknown subagent id "${params.id}". Known: ${known.join(", ") || "none"}.`,
        );
      }

      let text = `${describeSubagent(snap)}\nTurns: ${snap.turns}`;
      if (snap.errorText) text += `\nError: ${snap.errorText}`;

      const output = latestText(snap);
      if (output) {
        const preview = truncateHead(output, { maxBytes: 2048, maxLines: 20 });
        text += `\n\nLatest output:\n${preview.content}`;
        if (preview.truncated) text += "\n[...]";
      } else if (snap.status === "running") {
        text += "\n\n(no text output yet)";
      }

      return {
        content: [{ type: "text", text }],
        details: { id: snap.id, status: snap.status, turns: snap.turns },
      };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: SUBAGENT_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      const manager = await getManager();
      const subs = manager.view.list();
      const text =
        subs.length === 0
          ? "No subagents."
          : subs.map((snap) => describeSubagent(snap)).join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          subagents: subs.map((snap) => ({
            id: snap.id,
            title: snap.title,
            backend: snap.backend,
            status: snap.status,
          })),
        },
      };
    },
  });

  // --- Result message rendering ------------------------------------------

  pi.registerMessageRenderer(
    "subagent-result",
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
        id?: string;
        title?: string;
        status?: string;
      };
      const failed = details.status === "error";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`subagent ${details.id ?? "?"}`)) +
        theme.fg(
          "muted",
          ` · ${details.title ?? ""} · ${failed ? "failed" : "finished"}`,
        );

      const content =
        typeof message.content === "string" ? message.content : "";
      // Remove only the summary line. The following Error line (when present)
      // is part of the actual result and must remain visible.
      const body = content.split("\n").slice(1).join("\n").trim();

      if (expanded) {
        const md = new Markdown(`${body}`, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const previewLines = body.split("\n").slice(0, 8);
      let text = header;
      for (const line of previewLines)
        text += `\n${theme.fg("toolOutput", line)}`;
      if (body.split("\n").length > 8)
        text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
    },
  );

  // --- Command ------------------------------------------------------------

  pi.registerCommand("subagents", {
    description: "List, inspect, and take over subagents",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify(
            "Subagent takeover is only available in the TUI",
            "error",
          );
        return;
      }
      const manager = await getManager();
      if (manager.view.size() === 0) {
        ctx.ui.notify(
          "No subagents yet. The agent spawns them with subagent_spawn.",
          "info",
        );
        return;
      }
      await openSubagentPicker(ctx, manager.view);
    },
  });
}
