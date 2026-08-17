---
name: pi-like-gabo-reflect
description: Reflect on the current session and improve the Pi Like Gabo package when its extensions, skills, prompts, or defaults caused friction.
disable-model-invocation: true
---

# Pi Like Gabo Reflect

Turn session friction into a verified improvement to Pi Like Gabo. Unlike a general reflection, this workflow may edit the package code itself when the root cause lives there.

Load `writing-for-agents` before editing agent-facing text.

## 1. Harvest

Walk the current session. Account for every user correction, retry, false stop, reload failure, repeated manual continuation, stale state, and misleading UI message. For each candidate record:

- observed behavior and exact session evidence;
- expected behavior;
- root owner: Pi Like Gabo code, skill/prompt, project code, user preference, or situational noise.

Completion: every user correction and failed/repeated flow is either kept or dismissed with one reason.

## 2. Prove ownership

For each kept Pi Like Gabo lesson:

1. Locate the owning extension, skill, test, or package setting.
2. Trace the lifecycle end to end, including persisted session state and `/reload` when relevant.
3. Reproduce with the smallest deterministic fixture or transcript-shaped test.
4. Read callers before changing shared behavior.

Do not patch Pi Like Gabo for project-specific failures. Route those to project code, docs, or memory.

Completion: root cause names the state transition or invariant that failed; symptom-only diagnoses do not pass.

## 3. Choose disposition

Use exactly one destination per lesson:

- **Code fix** — extension behavior or lifecycle invariant is wrong.
- **Skill/prompt edit** — agent instructions caused repeatable wrong behavior.
- **New skill** — repeatable workflow has no owner and a distinct trigger.
- **Memory** — preference specific to Gabo, not useful to every package user.
- **No-op** — situational or already covered by default behavior.

Prefer deletion, existing helpers, and one shared guard over caller-by-caller patches.

## 4. Apply

Resolve the Pi Like Gabo checkout from this skill's package root, read its `AGENTS.md`, and inspect current worktree changes before editing. Preserve unrelated user work.

Implement the smallest root-cause fix. Maintain these boundaries:

- deterministic state handling before model classification;
- durable waits remain event-driven;
- explicit user decisions remain user-owned;
- successful autonomous work must not be mistaken for inactivity;
- rejected completion with concrete remediation continues autonomously, while unchanged evidence cannot loop;
- external mutations, Git history changes, commits, pushes, and PRs require explicit approval.

For agent-facing documents, keep one source of truth and prune stale instructions while adding the lesson.

## 5. Verify

Leave the smallest check that fails on the original bug. Then run, in order:

1. focused regression tests;
2. typecheck and diff check;
3. diagnostics for edited files;
4. full suite when practical, separating unrelated failures;
5. fresh or synthetic Pi-session dogfood for session, persistence, continuation, review, or reload changes.

For lifecycle bugs, inspect persisted JSONL evidence and verify both immediate behavior and behavior after `/reload`.

Completion: focused regression is green and the original reproduction no longer occurs. A unit test alone is insufficient when a cheap session dogfood exists.

## 6. Report

Return one receipt table:

| Lesson | Root cause | Disposition | Destination | Verification |
| ------ | ---------- | ----------- | ----------- | ------------ |

Then report these exact sections:

- **Before → now** — observed behavior and resulting behavior.
- **Changed paths** — every edited path and the owning lesson.
- **Safety boundaries** — unrelated changes preserved and external/Git actions not taken; list any separately approved action.
- **Verification** — exact commands, results, and original reproduction outcome.
- **Manual step** — when extension, skill, prompt, theme, or context code changed, instruct the user to run `/reload`; include the exact invocation needed afterward. Write `None` when no manual action remains.
- **Remaining risks** — unrelated failures, skipped checks, and unresolved hypotheses, or `None`.

Completion: the receipt contains every section, and **Manual step** explicitly states either the required action or `None`.
