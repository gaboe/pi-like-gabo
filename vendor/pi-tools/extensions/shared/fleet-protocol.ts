export const FLEET_QUERY_CHANNEL = "fleet:query:v1";
export const FLEET_STATE_CHANNEL = "fleet:state:v1";
export const FLEET_OPEN_CHANNEL = "fleet:open:v1";
export const FLEET_SETTLED_LINGER_MS = 4_000;

export type FleetStatus = "running" | "done" | "error" | "aborted";

interface FleetItemBase {
  id: string;
  title: string;
  status: FleetStatus;
  startedAt: number;
  settledAt?: number;
  detail?: string;
  tokens?: number;
  turns?: number;
  maxTurns?: number;
}

export interface SubagentFleetItem extends FleetItemBase {
  source: "subagents";
  kind: "subagent";
  parentId?: string;
  depth?: 0 | 1;
  role?: "package-worker" | "reviewer" | "verifier" | "finding-fixer";
}

export interface JobFleetItem extends FleetItemBase {
  source: "jobs";
  kind: "job";
}

export interface WorkflowRunFleetItem extends FleetItemBase {
  source: "workflows";
  kind: "workflow-run";
}

export interface WorkflowAgentFleetItem extends FleetItemBase {
  source: "workflows";
  kind: "workflow-agent";
  parentId: string;
  agentIndex: number;
}

export type FleetItem =
  | SubagentFleetItem
  | JobFleetItem
  | WorkflowRunFleetItem
  | WorkflowAgentFleetItem;

export type FleetState =
  | { source: "subagents"; items: SubagentFleetItem[] }
  | { source: "jobs"; items: JobFleetItem[] }
  | {
      source: "workflows";
      items: Array<WorkflowRunFleetItem | WorkflowAgentFleetItem>;
    };

export type FleetOpenRequest =
  | Pick<SubagentFleetItem, "source" | "kind" | "id">
  | Pick<JobFleetItem, "source" | "kind" | "id">
  | Pick<WorkflowRunFleetItem, "source" | "kind" | "id">
  | Pick<
      WorkflowAgentFleetItem,
      "source" | "kind" | "id" | "parentId" | "agentIndex"
    >;

export interface FleetEventBus {
  on(channel: string, listener: (value: unknown) => void): () => void;
  emit(channel: string, value: unknown): unknown;
}

export function onFleetQuery(
  bus: FleetEventBus,
  listener: () => void,
): () => void {
  return bus.on(FLEET_QUERY_CHANNEL, listener);
}

export function queryFleet(bus: FleetEventBus): void {
  bus.emit(FLEET_QUERY_CHANNEL, undefined);
}

export function onFleetState(
  bus: FleetEventBus,
  listener: (state: FleetState) => void,
): () => void {
  return bus.on(FLEET_STATE_CHANNEL, (value) => listener(value as FleetState));
}

export function publishFleetState(bus: FleetEventBus, state: FleetState): void {
  bus.emit(FLEET_STATE_CHANNEL, state);
}

export function onFleetOpen(
  bus: FleetEventBus,
  listener: (request: FleetOpenRequest) => void,
): () => void {
  return bus.on(FLEET_OPEN_CHANNEL, (value) =>
    listener(value as FleetOpenRequest),
  );
}

export function openFleetItem(
  bus: FleetEventBus,
  request: FleetOpenRequest,
): void {
  bus.emit(FLEET_OPEN_CHANNEL, request);
}
