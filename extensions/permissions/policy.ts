import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import path from "node:path";

export const PERMISSION_MODE = "observe-only" as const;
export const AUDIT_EVENT_LIMIT = 100;

export type ToolCategory =
  | "read"
  | "local-write"
  | "process"
  | "network"
  | "external"
  | "orchestration"
  | "unknown";

const TOOLS: Record<Exclude<ToolCategory, "unknown">, ReadonlySet<string>> = {
  read: new Set(["read", "grep", "find", "ls", "fd", "rg"]),
  "local-write": new Set(["write", "edit"]),
  process: new Set([
    "bash",
    "bg_start",
    "bg_status",
    "bg_wait",
    "bg_kill",
    "bg_list",
  ]),
  network: new Set([
    "web_search",
    "source_check",
    "fetch_content",
    "search",
    "crawl",
    "scrape",
  ]),
  external: new Set(["ask_user"]),
  orchestration: new Set(["jobs", "todo", "workflow", "package_worker_spawn"]),
};

export function classifyTool(toolName: string): ToolCategory {
  for (const [category, names] of Object.entries(TOOLS) as [
    Exclude<ToolCategory, "unknown">,
    ReadonlySet<string>,
  ][]) {
    if (names.has(toolName)) return category;
  }
  if (toolName.startsWith("subagent_") || toolName.startsWith("workflow_"))
    return "orchestration";
  return "unknown";
}

export type Containment = "inside" | "same" | "outside" | "unknown";

export interface CanonicalPathAnalysis {
  requestedPath: string;
  canonicalPath: string;
  canonicalRoot: string;
  existingAncestor: string;
  targetExists: boolean;
  containment: Containment;
  escaped: boolean;
}

function localPath(requestedPath: string): string {
  if (requestedPath.startsWith("file:")) return fileURLToPath(requestedPath);
  if (requestedPath === "~") return homedir();
  if (requestedPath.startsWith("~/"))
    return path.join(homedir(), requestedPath.slice(2));
  return requestedPath;
}

function canonicalizeWithExistingAncestor(
  requestedPath: string,
  cwd: string,
):
  | {
      canonicalPath: string;
      existingAncestor: string;
      targetExists: boolean;
    }
  | undefined {
  const absolute = path.resolve(cwd, localPath(requestedPath));
  const root = path.parse(absolute).root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let canonicalPath = root;
  let existingAncestor = root;

  for (let index = 0; index < parts.length; index += 1) {
    const candidate = path.join(canonicalPath, parts[index]);
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      return {
        canonicalPath: path.resolve(canonicalPath, ...parts.slice(index)),
        existingAncestor,
        targetExists: false,
      };
    }
    if (stat.isSymbolicLink()) {
      try {
        readlinkSync(candidate);
        canonicalPath = realpathSync.native(candidate);
      } catch {
        return undefined;
      }
    } else {
      canonicalPath = candidate;
    }
    existingAncestor = canonicalPath;
  }
  return { canonicalPath, existingAncestor, targetExists: true };
}

export function analyzePath(
  requestedPath: string,
  root: string,
  cwd = root,
): CanonicalPathAnalysis {
  try {
    const target = canonicalizeWithExistingAncestor(requestedPath, cwd);
    const canonicalRoot = canonicalizeWithExistingAncestor(root, cwd);
    if (!target || !canonicalRoot) throw new Error("canonical path unresolved");
    const relative = path.relative(
      canonicalRoot.canonicalPath,
      target.canonicalPath,
    );
    const containment: Containment =
      relative === ""
        ? "same"
        : relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          ? "outside"
          : "inside";

    return {
      requestedPath,
      canonicalPath: target.canonicalPath,
      canonicalRoot: canonicalRoot.canonicalPath,
      existingAncestor: target.existingAncestor,
      targetExists: target.targetExists,
      containment,
      escaped: containment === "outside",
    };
  } catch {
    return {
      requestedPath,
      canonicalPath: "unresolved",
      canonicalRoot: "unresolved",
      existingAncestor: "unresolved",
      targetExists: false,
      containment: "unknown",
      escaped: false,
    };
  }
}

export interface PermissionAuditEvent {
  version: 1;
  mode: typeof PERMISSION_MODE;
  decision: "observe";
  toolName: string;
  category: ToolCategory;
  paths: Array<{
    field: "path" | "filePath" | "target";
    targetExists: boolean;
    containment: Containment;
  }>;
}

const PATH_FIELDS = ["path", "filePath", "target"] as const;

export function createAuditEvent(
  toolName: string,
  input: Record<string, unknown>,
  root: string,
): PermissionAuditEvent {
  const paths: PermissionAuditEvent["paths"] = [];
  for (const field of PATH_FIELDS) {
    const value = input[field];
    if (typeof value !== "string" || !value) continue;
    try {
      const result = analyzePath(value, root);
      paths.push({
        field,
        targetExists: result.targetExists,
        containment: result.containment,
      });
    } catch {
      paths.push({ field, targetExists: false, containment: "unknown" });
    }
  }

  return {
    version: 1,
    mode: PERMISSION_MODE,
    decision: "observe",
    toolName: toolName.replace(/[^A-Za-z0-9_:-]/g, "?").slice(0, 80),
    category: classifyTool(toolName),
    paths,
  };
}

export function createBoundedAuditRecorder(
  emit: (event: PermissionAuditEvent) => void,
  limit = AUDIT_EVENT_LIMIT,
): {
  record(event: PermissionAuditEvent): void;
  snapshot(): PermissionAuditEvent[];
  reset(): void;
} {
  const events: PermissionAuditEvent[] = [];
  return {
    record(event) {
      events.push(event);
      if (events.length > limit) events.splice(0, events.length - limit);
      emit(event);
    },
    snapshot: () =>
      events.map((event) => ({
        ...event,
        paths: event.paths.map((item) => ({ ...item })),
      })),
    reset: () => {
      events.length = 0;
    },
  };
}

export function observeToolCall(
  event: { toolName: string; input: Record<string, unknown> },
  root: string,
  record: (event: PermissionAuditEvent) => void,
): void {
  record(createAuditEvent(event.toolName, event.input, root));
}
