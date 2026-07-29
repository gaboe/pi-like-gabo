import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GuidanceFields {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

interface TodoConfig {
	guidance?: GuidanceFields;
	orchestrator?: { enabled?: boolean };
}

export function loadConfig(): TodoConfig {
	try {
		const value: unknown = JSON.parse(readFileSync(join(homedir(), ".config", "rpiv-todo", "config.json"), "utf8"));
		return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as TodoConfig) : {};
	} catch {
		return {};
	}
}

export function orchestratorEnabled(value: unknown): boolean {
	return Boolean(value && typeof value === "object" && (value as { orchestrator?: { enabled?: unknown } }).orchestrator?.enabled === true);
}

export function validateGuidanceFields(value: unknown): GuidanceFields {
	if (!value || typeof value !== "object") return {};
	const input = value as Record<string, unknown>;
	return {
		...(typeof input.promptSnippet === "string" && input.promptSnippet.trim()
			? { promptSnippet: input.promptSnippet }
			: {}),
		...(Array.isArray(input.promptGuidelines) &&
		input.promptGuidelines.length > 0 &&
		input.promptGuidelines.every((item) => typeof item === "string" && item.trim())
			? { promptGuidelines: input.promptGuidelines as string[] }
			: {}),
	};
}
