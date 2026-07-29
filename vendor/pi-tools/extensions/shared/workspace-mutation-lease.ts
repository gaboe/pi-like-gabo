import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const REGISTRY_KEY = Symbol.for("my-pi-setup.workspace-mutation-lease.v1");

export interface WorkspaceMutationOwner {
  readonly __workspaceMutationOwner: unique symbol;
}

export interface WorkspaceMutationLease {
  readonly owner: WorkspaceMutationOwner;
  close(): void;
}

export interface WorkspaceActivity {
  close(): void;
}

interface LeaseRecord {
  readonly root: string;
  readonly generation: number;
}

interface WorkerRecord {
  readonly root: string;
  readonly owner?: WorkspaceMutationOwner;
}

interface ToolRecord {
  readonly root: string;
  readonly owner?: WorkspaceMutationOwner;
}

interface RegistryState {
  generation: number;
  leases: Map<WorkspaceMutationOwner, LeaseRecord>;
  workers: Map<WorkspaceActivity, WorkerRecord>;
  tools: Map<WorkspaceActivity, ToolRecord>;
  shells: Set<WorkspaceActivity>;
  unconstrainedWorkers: Set<WorkspaceActivity>;
  shellTainted: boolean;
  unconstrainedWorkerTainted: boolean;
  taints?: Set<string>;
}

const globalRegistry = globalThis as typeof globalThis & {
  [REGISTRY_KEY]?: RegistryState;
};

function state() {
  const current: RegistryState = (globalRegistry[REGISTRY_KEY] ??= {
    generation: 0,
    leases: new Map(),
    workers: new Map(),
    tools: new Map(),
    shells: new Set(),
    unconstrainedWorkers: new Set(),
    shellTainted: false,
    unconstrainedWorkerTainted: false,
  });
  current.shells ??= new Set();
  current.unconstrainedWorkers ??= new Set();
  current.shellTainted ??= (current.taints?.size ?? 0) > 0;
  current.unconstrainedWorkerTainted ??= false;
  return current;
}

function isInside(root: string, target: string) {
  const fromRoot = relative(root, target);
  return (
    fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
  );
}

export function canonicalWorkspaceRoot(input: string) {
  const absolute = resolve(input);
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing)
      throw new Error("Workspace root has no existing canonical prefix.");
    existing = parent;
  }
  return resolve(realpathSync(existing), relative(existing, absolute));
}

export function workspaceRootsOverlap(first: string, second: string) {
  return isInside(first, second) || isInside(second, first);
}

function ownsOverlappingLease(
  owner: WorkspaceMutationOwner | undefined,
  root: string,
) {
  if (!owner) return false;
  const lease = state().leases.get(owner);
  return !!lease && workspaceRootsOverlap(lease.root, root);
}

function leaseConflict(root: string, owner?: WorkspaceMutationOwner) {
  for (const [currentOwner, lease] of state().leases) {
    if (currentOwner !== owner && workspaceRootsOverlap(lease.root, root))
      return true;
  }
  return false;
}

export function mutationLeaseConflict(
  workspaceRoot: string,
  owner?: WorkspaceMutationOwner,
) {
  const root = canonicalWorkspaceRoot(workspaceRoot);
  if (owner && !ownsOverlappingLease(owner, root))
    return "Workspace mutation lease owner is invalid or expired.";
  return leaseConflict(root, owner)
    ? "Workspace mutation is blocked by an active exclusive lease."
    : undefined;
}

export function assertWorkspaceMutationLease(
  owner: WorkspaceMutationOwner,
  workspaceRoot: string,
) {
  const root = canonicalWorkspaceRoot(workspaceRoot);
  if (!ownsOverlappingLease(owner, root))
    throw new Error("Workspace mutation lease owner is invalid or expired.");
}

export function beginGlobalShellExecution(): WorkspaceActivity {
  const current = state();
  if (current.leases.size > 0)
    throw new Error("Shell execution is blocked by an active exclusive lease.");
  const activity = { close: () => {} } as WorkspaceActivity;
  let active = true;
  activity.close = () => {
    if (!active) return;
    active = false;
    current.shells.delete(activity);
  };
  current.shells.add(activity);
  current.shellTainted = true;
  return activity;
}

export function beginWorkspaceToolExecution(
  workspaceRoot: string,
  owner?: WorkspaceMutationOwner,
): WorkspaceActivity {
  const root = canonicalWorkspaceRoot(workspaceRoot);
  const conflict = mutationLeaseConflict(root, owner);
  if (conflict) throw new Error(conflict);
  const activity = { close: () => {} } as WorkspaceActivity;
  let active = true;
  activity.close = () => {
    if (!active) return;
    active = false;
    state().tools.delete(activity);
  };
  state().tools.set(activity, { root, owner });
  return activity;
}

export function registerUnconstrainedWorkspaceWorker(): WorkspaceActivity {
  const current = state();
  if (current.leases.size > 0)
    throw new Error(
      "Unconstrained worker is blocked by an active exclusive lease.",
    );
  const activity = { close: () => {} } as WorkspaceActivity;
  let active = true;
  activity.close = () => {
    if (!active) return;
    active = false;
    current.unconstrainedWorkers.delete(activity);
  };
  current.unconstrainedWorkers.add(activity);
  current.unconstrainedWorkerTainted = true;
  return activity;
}

export function registerManagedWorkspaceWorker(
  workspaceRoot: string,
  owner?: WorkspaceMutationOwner,
): WorkspaceActivity {
  const root = canonicalWorkspaceRoot(workspaceRoot);
  const conflict = mutationLeaseConflict(root, owner);
  if (conflict) throw new Error(conflict);
  const activity = { close: () => {} } as WorkspaceActivity;
  let active = true;
  activity.close = () => {
    if (!active) return;
    active = false;
    state().workers.delete(activity);
  };
  state().workers.set(activity, { root, owner });
  return activity;
}

export function acquireWorkspaceMutationLease(
  workspaceRoot: string,
  exemptWorker?: WorkspaceActivity,
): WorkspaceMutationLease {
  const root = canonicalWorkspaceRoot(workspaceRoot);
  const current = state();
  if (current.shells.size > 0)
    throw new Error(
      "Workspace mutation lease refused because a shell is executing.",
    );
  if (current.unconstrainedWorkers.size > 0)
    throw new Error(
      "Workspace mutation lease refused because an unconstrained worker is live.",
    );
  if (current.shellTainted)
    throw new Error(
      "Workspace mutation lease refused because observed shell execution may have retained descendants.",
    );
  if (current.unconstrainedWorkerTainted)
    throw new Error(
      "Workspace mutation lease refused because an observed unconstrained worker may have retained descendants.",
    );
  if (leaseConflict(root))
    throw new Error("Workspace mutation lease overlaps an active lease.");
  for (const [worker, record] of current.workers) {
    if (worker !== exemptWorker && workspaceRootsOverlap(record.root, root))
      throw new Error(
        "Workspace mutation lease refused because an overlapping managed worker is live.",
      );
  }
  for (const record of current.tools.values()) {
    if (workspaceRootsOverlap(record.root, root))
      throw new Error(
        "Workspace mutation lease refused because an overlapping tool is executing.",
      );
  }

  const owner = Object.freeze({}) as WorkspaceMutationOwner;
  const generation = ++current.generation;
  current.leases.set(owner, { root, generation });
  let active = true;
  return {
    owner,
    close() {
      if (!active) return;
      active = false;
      const lease = current.leases.get(owner);
      if (lease?.generation === generation) current.leases.delete(owner);
    },
  };
}

export function resetWorkspaceMutationRegistryForTests() {
  const current = state();
  current.generation++;
  current.leases.clear();
  current.workers.clear();
  current.tools.clear();
  current.shells.clear();
  current.unconstrainedWorkers.clear();
  current.shellTainted = false;
  current.unconstrainedWorkerTainted = false;
}
