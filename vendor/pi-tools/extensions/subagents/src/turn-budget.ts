export interface TurnBudgetRequest {
  readonly additionalTurns: number;
  readonly reason: string;
  readonly remainingWork: ReadonlyArray<string>;
}

export function parseTurnBudgetRequest(
  text: string,
): TurnBudgetRequest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const handoff = value as Record<string, unknown>;
  const request = handoff.budget_request;
  if (
    handoff.status !== "partial" ||
    !request ||
    typeof request !== "object" ||
    Array.isArray(request)
  )
    return undefined;
  const { additional_turns, reason } = request as Record<string, unknown>;
  const remainingWork = handoff.remaining_work;
  if (
    !Number.isInteger(additional_turns) ||
    (additional_turns as number) < 1 ||
    (additional_turns as number) > 48 ||
    typeof reason !== "string" ||
    !reason.trim() ||
    !Array.isArray(remainingWork) ||
    remainingWork.length === 0 ||
    !remainingWork.every((item) => typeof item === "string" && item.trim())
  )
    return undefined;
  return {
    additionalTurns: additional_turns as number,
    reason: reason.trim(),
    remainingWork: remainingWork.map((item) => (item as string).trim()),
  };
}

export function withSubagentTurnBudget(prompt: string, maxTurns: number) {
  return `${prompt}\n\nExecution budget: ${maxTurns} assistant turns total. Every assistant response that uses tools consumes a turn. Complete orientation, implementation, and focused verification by turn ${maxTurns - 2}. Reserve the final two turns for a concise verified handoff. If bounded remaining work would finish with more turns, stop before the reserve and return one JSON object with status \"partial\", budget_request {additional_turns, reason}, and non-empty remaining_work. Request the exact additional turns needed; only the orchestrator may approve one extension, and total max_turns cannot exceed 48. Otherwise report the best verified partial handoff. Do not wait by polling or sleeping.`;
}

export function turnBudgetFinalizationWarning(maxTurns: number) {
  return `Turn budget warning: ${maxTurns - 3} of ${maxTurns} assistant turns are used. One tool-capable turn remains. Stop expanding scope. If bounded remaining work justifies continuation, return status partial with budget_request {additional_turns, reason} and non-empty remaining_work; otherwise return the best verified handoff available.`;
}
