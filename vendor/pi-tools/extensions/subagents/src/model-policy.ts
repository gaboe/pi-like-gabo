export const PI_SUBAGENT_MODELS = [
  "openai-codex/gpt-5.6-luna",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-sol",
] as const;

export function isAllowedOpenAiSubagentModel(identifier: string) {
  return PI_SUBAGENT_MODELS.includes(
    identifier.toLowerCase() as (typeof PI_SUBAGENT_MODELS)[number],
  );
}

export function openAiSubagentModelError(identifier: string | undefined) {
  if (identifier && isAllowedOpenAiSubagentModel(identifier)) return undefined;
  return `Unsupported Pi subagent model "${identifier ?? "default/unknown"}". Use one of: ${PI_SUBAGENT_MODELS.join(", ")}.`;
}
