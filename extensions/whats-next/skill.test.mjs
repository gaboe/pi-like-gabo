import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = (path) =>
  readFileSync(
    fileURLToPath(new URL(`../../${path}`, import.meta.url)),
    "utf8",
  );

test("packages portable whats-next skill with completion and approval guards", () => {
  const pkg = JSON.parse(root("package.json"));
  const skill = root("skills/whats-next/SKILL.md");

  assert.ok(pkg.pi.skills.includes("./skills/whats-next"));
  assert.match(skill, /Re-read them after independent review/);
  assert.match(skill, /Fail closed/);
  assert.match(skill, /references\/harnesses\.md/);
  assert.doesNotMatch(skill, /Terra|ask_user|On Pi|Pi:/);
  assert.match(
    root("skills/whats-next/references/harnesses.md"),
    /tool-free Terra child/,
  );
  assert.match(skill, /exactly one explanatory multi-select/);
  assert.match(skill, /After selection, start its authorized work immediately/);
  assert.match(skill, /never require a repeated confirmation/);
  assert.match(skill, /exact stated scope/);

  const extension = root("extensions/whats-next/index.ts");
  assert.match(
    extension,
    /selecting an option authorizes its exact stated scope/,
  );
  assert.match(
    extension,
    /do not ask them to repeat, confirm, or send a follow-up message/,
  );
});
