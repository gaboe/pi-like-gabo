/**
 * multi-skills — Skill resolver
 *
 * Builds the $skill registry from Pi's already-loaded skill commands instead of
 * re-scanning skill directories. This keeps inline skill invocation aligned with
 * Pi's trust model, settings, package filters, collisions, and CLI-provided
 * skills.
 */

import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SkillInfo {
  name: string;
  description: string;
  dir: string;               // Absolute path to skill directory
  skillMdPath: string;       // Absolute path to SKILL.md or flat .md skill file
  scope: "user" | "project" | "temporary";
}

function getSkillName(commandName: string): string | undefined {
  return commandName.startsWith("skill:")
    ? commandName.slice("skill:".length)
    : undefined;
}

function resolveSkillFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;

  try {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      const skillMdPath = join(path, "SKILL.md");
      return existsSync(skillMdPath) ? skillMdPath : undefined;
    }
    if (stat.isFile() && path.endsWith(".md")) {
      return path;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function skillFromCommand(command: SlashCommandInfo): SkillInfo | undefined {
  if (command.source !== "skill") return undefined;

  const name = getSkillName(command.name);
  if (!name) return undefined;

  const skillMdPath = resolveSkillFile(command.sourceInfo.path);
  if (!skillMdPath) return undefined;

  return {
    name,
    description: command.description ?? "",
    dir: command.sourceInfo.baseDir ?? dirname(skillMdPath),
    skillMdPath,
    scope: command.sourceInfo.scope,
  };
}

/**
 * Build the skill registry from Pi's slash command list.
 *
 * Pi has already resolved trust, settings, package filters, explicit CLI skills,
 * validation, and collisions before exposing these commands. We preserve that
 * order and keep the first command for a given skill name.
 */
export function buildSkillRegistry(commands: SlashCommandInfo[]): Map<string, SkillInfo> {
  const registry = new Map<string, SkillInfo>();

  for (const command of commands) {
    const skill = skillFromCommand(command);
    if (skill && !registry.has(skill.name)) {
      registry.set(skill.name, skill);
    }
  }

  return registry;
}

/**
 * Format available skills as a human-readable table for the /skills command.
 */
export function formatSkillTable(registry: Map<string, SkillInfo>): string {
  const rows: string[] = [];
  for (const [name, info] of registry) {
    const desc = info.description.length > 60
      ? info.description.slice(0, 60) + "..."
      : info.description;
    rows.push(`  \$${name.padEnd(28)} ${desc}`);
  }
  return rows.join("\n");
}
