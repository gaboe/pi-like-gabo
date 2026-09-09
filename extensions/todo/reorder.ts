import type { TaskState } from "./state/state.js";

export const REORDER_MIN_OPEN_TASKS = 3;

export interface TodoReorderSnapshot {
  revision: number;
  candidateIds: number[];
}

function isOpen(status: string): boolean {
  return status !== "completed" && status !== "deleted";
}

export function createTodoReorderSnapshot(
  state: TaskState,
): TodoReorderSnapshot | undefined {
  if (
    state.tasks.filter((task) => isOpen(task.status)).length <
    REORDER_MIN_OPEN_TASKS
  )
    return undefined;
  const candidateIds = state.tasks
    .filter((task) => task.status === "pending")
    .map((task) => task.id);
  return candidateIds.length >= 2
    ? { revision: state.revision, candidateIds }
    : undefined;
}

const MAX_REORDER_RESPONSE_CHARS = 4_096;

export function parseTodoReorder(
  text: string,
  expectedIds: readonly number[],
): number[] | undefined {
  if (text.length > MAX_REORDER_RESPONSE_CHARS) return undefined;
  try {
    const value = JSON.parse(text);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length !== 1 ||
      Object.keys(value)[0] !== "order" ||
      !Array.isArray((value as Record<string, unknown>).order)
    )
      return undefined;
    const order = (value as Record<string, unknown>).order as unknown[];
    if (
      order.length > expectedIds.length ||
      !order.every((id): id is number => Number.isSafeInteger(id))
    )
      return undefined;
    if (
      order.length !== expectedIds.length ||
      new Set(order).size !== order.length
    )
      return undefined;
    const expected = new Set(expectedIds);
    return order.every((id) => expected.has(id)) ? order : undefined;
  } catch {
    return undefined;
  }
}

export function applyTodoReorder(
  state: TaskState,
  expected: TodoReorderSnapshot,
  order: readonly number[],
): TaskState {
  if (state.revision !== expected.revision) return state;
  const current = createTodoReorderSnapshot(state);
  if (!current || current.candidateIds.length !== expected.candidateIds.length)
    return state;
  if (
    current.candidateIds.some(
      (id, index) => id !== expected.candidateIds[index],
    )
  )
    return state;
  if (
    order.length !== expected.candidateIds.length ||
    new Set(order).size !== order.length
  )
    return state;
  const candidates = new Map(
    state.tasks
      .filter((task) => expected.candidateIds.includes(task.id))
      .map((task) => [task.id, task]),
  );
  if (order.some((id) => !candidates.has(id))) return state;
  const positions = new Map(order.map((id, index) => [id, index]));
  for (const id of order) {
    const task = candidates.get(id)!;
    if (
      task.blockedBy?.some(
        (dependency) =>
          positions.has(dependency) &&
          positions.get(dependency)! > positions.get(id)!,
      )
    ) {
      return state;
    }
  }
  if (order.every((id, index) => id === expected.candidateIds[index]))
    return state;
  let index = 0;
  return {
    ...state,
    tasks: state.tasks.map((task) =>
      task.status === "pending" ? candidates.get(order[index++])! : task,
    ),
    revision: state.revision + 1,
  };
}
