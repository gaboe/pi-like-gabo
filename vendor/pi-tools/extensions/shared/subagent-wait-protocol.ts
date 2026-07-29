export const SUBAGENT_WAIT_STATE_CHANNEL = "subagents:wait-state:v1";
export const SUBAGENT_DELEGATION_STATE_CHANNEL =
  "subagents:delegation-state:v1";
export const MAX_TODO_TOKEN_LENGTH = 256;

export interface SubagentWaitState {
  ids: string[];
}

export interface SubagentDelegation {
  id: string;
  todo_id?: number;
  todo_token?: string;
}

export interface SubagentDelegationState {
  delegations: SubagentDelegation[];
  ids?: string[];
}

interface DelegationSnapshot {
  readonly id: string;
  readonly status: string;
  readonly pendingStart?: boolean;
  readonly outputContract?: string;
  readonly todoId?: number;
  readonly todoToken?: string;
}

export function isTodoToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_TODO_TOKEN_LENGTH
  );
}

export function validatePackageOwnership(
  outputContract: unknown,
  todoId: unknown,
  todoToken: unknown,
): string | undefined {
  if (outputContract !== "package_handoff") {
    return todoId !== undefined || todoToken !== undefined
      ? "todo_id and todo_token require output_contract package_handoff."
      : undefined;
  }
  if (!Number.isInteger(todoId) || Number(todoId) <= 0)
    return "output_contract package_handoff requires a positive todo_id.";
  if (!isTodoToken(todoToken))
    return `output_contract package_handoff requires a nonblank todo_token of at most ${MAX_TODO_TOKEN_LENGTH} characters.`;
  return undefined;
}

export function currentDelegationState(
  snapshots: ReadonlyArray<DelegationSnapshot>,
): SubagentDelegationState {
  return {
    delegations: snapshots
      .filter(
        (snapshot) =>
          snapshot.status === "running" &&
          snapshot.pendingStart !== true &&
          snapshot.outputContract === "package_handoff" &&
          Number.isInteger(snapshot.todoId) &&
          Number(snapshot.todoId) > 0 &&
          isTodoToken(snapshot.todoToken),
      )
      .slice(0, 64)
      .map((snapshot) => ({
        id: snapshot.id,
        todo_id: snapshot.todoId!,
        todo_token: snapshot.todoToken!,
      })),
  };
}
