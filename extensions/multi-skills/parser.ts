/**
 * multi-skills — Parser
 *
 * Parses `$skill_name` references from user input text.
 * Supports:
 *   - $skill_name (standalone)
 *   - Multi-skill: "Apply $skillA and $skillB together"
 *   - Escaped: \$skill → literal, non-invoking text
 */

/** Regex pattern for $skill_name references */
// Matches $ followed by a lowercase skill name (letters, digits, underscores, hyphens)
// Not preceded by \ (escape). Skill names are lowercase by Pi/Agent Skills convention,
// so uppercase shell variables like $PATH and $HOME are left alone.
const SKILL_REF_RE = /(?<!\\)\$([a-z][a-z0-9_-]*)(?![A-Za-z0-9_-])/g;

interface TextRange {
  start: number;
  end: number;
}

/** Find common Markdown code forms so pasted examples never invoke skills. */
function findCodeRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  const lines = [...text.matchAll(/.*(?:\n|$)/g)].filter((match) => match[0]);

  // Fenced blocks (` or ~), including unclosed fences.
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const opening = line[0].match(/^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/);
    if (!opening) continue;

    const marker = opening[1][0];
    const minimumLength = opening[1].length;
    let end = text.length;
    for (
      let closingIndex = lineIndex + 1;
      closingIndex < lines.length;
      closingIndex++
    ) {
      const closingText = lines[closingIndex][0].replace(/\n$/, "");
      const closing = closingText.match(/^ {0,3}(`+|~+)\s*$/);
      if (
        closing &&
        closing[1][0] === marker &&
        closing[1].length >= minimumLength
      ) {
        end = (lines[closingIndex].index ?? 0) + lines[closingIndex][0].length;
        lineIndex = closingIndex;
        break;
      }
    }
    ranges.push({ start: line.index ?? 0, end });
  }

  ranges.sort((a, b) => a.start - b.start);

  // Four-space/tab-indented code lines outside fenced blocks.
  for (const line of lines) {
    if (/^(?: {4}|\t)/.test(line[0]) && !isInRange(line.index ?? 0, ranges)) {
      ranges.push({
        start: line.index ?? 0,
        end: (line.index ?? 0) + line[0].length,
      });
    }
  }

  ranges.sort((a, b) => a.start - b.start);

  // Inline backtick spans. Unmatched and escaped backticks are literal text.
  for (let index = 0; index < text.length;) {
    if (
      text[index] !== "`" ||
      isEscaped(text, index) ||
      isInRange(index, ranges)
    ) {
      index++;
      continue;
    }

    let runEnd = index + 1;
    while (text[runEnd] === "`") runEnd++;
    const delimiter = text.slice(index, runEnd);
    let closing = text.indexOf(delimiter, runEnd);
    while (closing !== -1 && isEscaped(text, closing)) {
      closing = text.indexOf(delimiter, closing + delimiter.length);
    }
    if (closing === -1) {
      index = runEnd;
      continue;
    }

    const end = closing + delimiter.length;
    ranges.push({ start: index, end });
    index = end;
  }

  return ranges.sort((a, b) => a.start - b.start);
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}

function isInRange(index: number, ranges: TextRange[]): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = ranges[middle];
    if (index < range.start) high = middle - 1;
    else if (index >= range.end) low = middle + 1;
    else return true;
  }
  return false;
}

export interface ParsedRef {
  raw: string; // Full match including $, e.g. "$skillA"
  name: string; // Skill name without $, e.g. "skillA"
  index: number; // Position in original text
}

/**
 * Parse all $skill_name references from text.
 * Returns deduplicated list preserving first-occurrence order.
 */
export function parseSkillRefs(text: string): ParsedRef[] {
  const refs: ParsedRef[] = [];

  SKILL_REF_RE.lastIndex = 0;
  const codeRanges = findCodeRanges(text);

  let match: RegExpExecArray | null;
  while ((match = SKILL_REF_RE.exec(text)) !== null) {
    if (isInRange(match.index, codeRanges)) continue;
    refs.push({
      raw: match[0],
      name: match[1].toLowerCase(),
      index: match.index,
    });
  }

  // Deduplicate by name while preserving order
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (seen.has(ref.name)) return false;
    seen.add(ref.name);
    return true;
  });
}

/**
 * Replacement entry for replaceSkillRefs.
 */
export interface SkillReplacement {
  name: string;
  marker: string;
}

/**
 * Replace selected $skill_name references outside Markdown code while
 * preserving every unrelated byte of the original prompt.
 */
export function replaceSkillRefs(
  text: string,
  replacements: SkillReplacement[],
): string {
  const markers = new Map(
    replacements.map(({ name, marker }) => [name, marker]),
  );
  const codeRanges = findCodeRanges(text);
  const parts: string[] = [];
  let lastIndex = 0;

  SKILL_REF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SKILL_REF_RE.exec(text)) !== null) {
    if (isInRange(match.index, codeRanges)) continue;
    const marker = markers.get(match[1].toLowerCase());
    if (marker === undefined) continue;

    parts.push(text.slice(lastIndex, match.index), marker);
    lastIndex = match.index + match[0].length;
  }

  parts.push(text.slice(lastIndex));
  return parts.join("");
}

/**
 * Quick check whether text contains any $skill references.
 */
export function hasSkillRefs(text: string): boolean {
  SKILL_REF_RE.lastIndex = 0;
  return SKILL_REF_RE.test(text);
}
