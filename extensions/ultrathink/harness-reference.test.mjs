import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = (path) =>
  readFileSync(
    fileURLToPath(new URL(`../../${path}`, import.meta.url)),
    "utf8",
  );

for (const name of ["orchestrator", "whats-next"]) {
  test(`${name} keeps portable policy neutral and host details in its reference`, () => {
    const skill = root(`skills/${name}/SKILL.md`);
    const reference = root(`skills/${name}/references/harnesses.md`);

    assert.match(skill, /references\/harnesses\.md/);
    assert.match(skill, /native worker|native reviewer/);
    assert.doesNotMatch(
      skill,
      /`delegate`|subagent_|`jobs`|`todo|ask_user|Luna|Sol|pi-orchestration|Pi tools|\bPi\b/,
    );
    assert.match(reference, /## Pi/);
    assert.match(reference, /## Codex/);
    assert.match(reference, /## Claude Code/);
  });
}

test("ultrathink uses the orchestrator delegation contract", () => {
  const skill = root("skills/ultrathink/SKILL.md");
  assert.match(skill, /`orchestrator` skill owns the delegation contract/);
  assert.match(
    skill,
    /Load it before the first spawn, including its harness mappings/,
  );
  assert.doesNotMatch(skill, /references\/harnesses\.md/);
});

test("orchestrator roles stay harness-neutral", () => {
  const roles = root("skills/orchestrator/roles.md");
  assert.match(roles, /Model class/);
  assert.match(roles, /Relative budget/);
  assert.doesNotMatch(
    roles,
    /`delegate`|subagent_|`jobs`|`todo|ask_user|Luna|Sol|\bPi\b/,
  );
});

test("Pi references preserve exact local routing and selector rejection", () => {
  const orchestrator = root("skills/orchestrator/references/harnesses.md");
  const whatsNext = root("skills/whats-next/references/harnesses.md");

  assert.match(orchestrator, /subagent_spawn/);
  assert.match(orchestrator, /Model: use Luna/);
  assert.match(orchestrator, /Effort: choose independently/);
  assert.match(whatsNext, /tool-free Luna child/);
  for (const reference of [orchestrator, whatsNext]) {
    assert.match(reference, /no `harness` selector/);
    assert.match(reference, /harness: "codex"/);
    assert.match(reference, /codex exec/);
    assert.match(reference, /harness: "claude"/);
    assert.match(reference, /claude -p/);
  }
});

test("current Pi runtime rejects unsupported harness selectors", () => {
  const source = root("vendor/pi-tools/extensions/subagents/index.ts");
  assert.match(source, /additionalProperties: false/);
  assert.match(
    source,
    /for \(const selector of \["harness", "agent", "backend"\]\)/,
  );
  assert.match(source, /Pi subagents are always in-process/);
});
