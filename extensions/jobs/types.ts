export type JobKind = "command" | "websocket" | "poll";
export type JobStatus =
  "starting" | "running" | "completed" | "failed" | "stopped" | "interrupted";
export type ConditionAction = "wake" | "complete" | "failure";

export interface RegexCondition {
  type: "regex";
  expression: string;
  flags?: string;
  action: ConditionAction;
}

export interface JsonPathCondition {
  type: "jsonpath";
  expression: string;
  operator?:
    | "exists"
    | "equals"
    | "notEquals"
    | "in"
    | "matches"
    | "greaterThan"
    | "lessThan";
  value?: unknown;
  action: ConditionAction;
}

export type JobCondition = RegexCondition | JsonPathCondition;

interface DefinitionBase {
  title: string;
  conditions: JobCondition[];
  timeoutMs?: number;
  deadline?: number;
  dedupeJsonPath?: string;
}

export interface CommandDefinition extends DefinitionBase {
  kind: "command";
  command: string;
  cwd: string;
  restartPolicy: "never" | "idempotent";
}

export interface NetworkDefinition extends DefinitionBase {
  kind: "websocket" | "poll";
  url: string;
  intervalMs?: number;
  resumeQuery?: string;
  cursorJsonPath?: string;
  binary: "reject" | "base64";
  maxFrameBytes: number;
}

export type JobDefinition = CommandDefinition | NetworkDefinition;

export interface JobEvent {
  sequence: number;
  at: number;
  source: "stdout" | "stderr" | "websocket" | "poll" | "system";
  data: string;
  bytes: number;
  binary?: boolean;
  oversize?: boolean;
}

export interface JobRecord {
  id: string;
  definition: JobDefinition;
  status: JobStatus;
  createdAt: number;
  incarnation: string;
  updatedAt: number;
  startedAt?: number;
  settledAt?: number;
  attempt: number;
  error?: string;
  backendId?: string;
  approvedEndpoint?: string;
  approvedAddresses?: string[];
  approvedRestricted?: string[];
  cursor?: string;
  events: JobEvent[];
  eventBytes: number;
  droppedEvents: number;
  droppedBytes: number;
  duplicateEvents: number;
  recentDedupeKeys: string[];
  logPath: string;
}

export type JobLifecycleType =
  | "created"
  | "started"
  | "restarted"
  | "wake"
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted"
  | "deleted";

export interface JobLifecycleEvent {
  type: JobLifecycleType;
  jobId: string;
  title: string;
  kind: JobKind;
  status: JobStatus;
  at: number;
  attempt: number;
  createdAt: number;
  incarnation: string;
  durationMs: number;
  settledAt?: number;
  error?: string;
  reason?: string;
  event?: JobEvent;
}

export interface JobStateEvent {
  id: string;
  status: "running" | "wake" | "succeeded" | "failed" | "killed" | "timed_out";
  waitToken?: string;
  waitRegisteredAt?: number;
  waitGeneration?: number;
  waitIncarnation?: string;
  settledAt?: number;
  error?: string;
}

export interface PersistedScope {
  version: 1;
  sessionId: string;
  cwd: string;
  jobs: JobRecord[];
}

export interface NetworkApproval {
  endpoint: string;
  hostname: string;
  addresses: string[];
  restricted: string[];
}

export interface JobManagerHooks {
  onLifecycle(event: JobLifecycleEvent): void;
  approveNetwork(request: NetworkApproval): Promise<boolean>;
}
