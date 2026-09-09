import { readFileSync } from "node:fs";
import { parseSkillRefs, replaceSkillRefs } from "./parser";
import type { SkillInfo } from "./resolver";

export interface SkillLoadFailure {
  skill: SkillInfo;
  error: unknown;
}

export interface ExpansionResult {
  text?: string;
  resolved: SkillInfo[];
  loaded: SkillInfo[];
  unresolved: string[];
  failed: SkillLoadFailure[];
}

interface LoadedSkill {
  skill: SkillInfo;
  body: string;
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  return match ? content.slice(match[0].length) : content;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Prevent skill-controlled text from terminating Pi's compact wrapper early. */
function escapeSkillDelimiter(value: string): string {
  return value.replace(/<\/skill>/g, "<\\/skill>");
}

function buildSkillBlock(loaded: LoadedSkill[]): string {
  if (loaded.length === 1) {
    const { skill, body } = loaded[0];
    return (
      `<skill name="${escapeXmlAttribute(skill.name)}" location="${escapeXmlAttribute(skill.skillMdPath)}">\n` +
      `References are relative to ${escapeSkillDelimiter(skill.dir)}.\n\n` +
      `${escapeSkillDelimiter(body)}\n` +
      `</skill>`
    );
  }

  const names = loaded.map(({ skill }) => skill.name).join(", ");
  const sections = loaded
    .map(
      ({ skill, body }) =>
        `## ${skill.name}\n\n` +
        `References for this skill are relative to ${escapeSkillDelimiter(skill.dir)}.\n\n` +
        escapeSkillDelimiter(body),
    )
    .join("\n\n---\n\n");

  return (
    `<skill name="${escapeXmlAttribute(names)}" location="${escapeXmlAttribute(loaded[0].skill.skillMdPath)}">\n` +
    `This invocation contains multiple skills. Use the relative-path base stated in each section.\n\n` +
    `${sections}\n` +
    `</skill>`
  );
}

/** Expand installed $skill-name references while preserving all unrelated prompt text. */
export function expandSkillReferences(
  text: string,
  registry: Map<string, SkillInfo>,
): ExpansionResult {
  const refs = parseSkillRefs(text);
  const resolved: SkillInfo[] = [];
  const unresolved: string[] = [];

  for (const ref of refs) {
    const skill = registry.get(ref.name);
    if (skill) resolved.push(skill);
    else unresolved.push(ref.name);
  }

  const loaded: LoadedSkill[] = [];
  const failed: SkillLoadFailure[] = [];
  for (const skill of resolved) {
    try {
      const body = stripFrontmatter(
        readFileSync(skill.skillMdPath, "utf-8"),
      ).trim();
      loaded.push({ skill, body });
    } catch (error) {
      failed.push({ skill, error });
    }
  }

  if (loaded.length === 0) {
    return { resolved, loaded: [], unresolved, failed };
  }

  // Preserve each invocation's position and meaning. Unknown or unreadable
  // references remain untouched in the user's prompt.
  const userText = replaceSkillRefs(
    text,
    loaded.map(({ skill }) => ({
      name: skill.name,
      marker: `[skill: ${skill.name}]`,
    })),
  );
  const skillBlock = buildSkillBlock(loaded);

  return {
    text: userText ? `${skillBlock}\n\n${userText}` : skillBlock,
    resolved,
    loaded: loaded.map(({ skill }) => skill),
    unresolved,
    failed,
  };
}
