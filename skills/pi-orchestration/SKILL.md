---
name: pi-orchestration
description: Coordinates Pi TODOs, jobs, background terminals, workflows, subagents, and grill-me. Use for multi-step work, monitored long-running work, parallel workflow execution, architectural grilling, or their combination.
---

# Pi orchestration

Read `../../docs/orchestration-domain.md` and ADR 0001 for canonical behavior. Use smallest combination that fits.

## Roles and package flow

- **Preparation Analyst**: read-only; produce evidence-backed Preparation Dossier. One repair/retry; then `preparation_failed`, never guessed implementation.
- **TODO Classifier**: classify raw TODO and prepared dossier. Raw result is provisional; classifier gets one retry, then structural fallback is recorded. Step count alone never activates orchestration.
- **Orchestrator**: owns Work Plan, direct assignment, approvals, semantic gates, integration, Git history, and external mutations.
- **Package Worker**: owns one maximal coherent Work Package, checks, review/fix, and final handoff. Implementation workers set `output_contract: 'package_handoff'`, `todo_id`, and `todo_token` copied from current TODO dossier `metadata.preparation.token`; scouts omit all three.

Mode is `direct`, `provisional`, or `sticky`. Derive provisional aggregate mode from unresolved current-generation classifications. Execution makes it sticky until packages/workers/jobs settle. `/orchestrator on|off|auto` is session override; off/global kill switch stops new assignment, cancels owned workers cooperatively, and preserves unfinished packages as `interrupted`.

Use self-contained worker prompt for simple work. For complex or multi-package work, Orchestrator alone writes `scratchpad/<topic>-plan.md`; plan file is not an approval gate.

Every package prompt starts with:

```md
Outcome:
Worktree/ref:
Owns:
Depends on:
Stale if:
Done when/checks:
Permissions/budget:
Can parallelize with: # optional
```

Assign each ready maximal non-conflicting package directly. No Dispatcher, adaptive queue, or file-sized microtasks. Formal checkpoints only: initial plan acceptance/parallel start, then final completion review. Parent retains approvals and all external/history mutation.

Mechanical Handoff Gate validates required `package_handoff` form and local invariants; invalid first handoff returns exact errors to same worker's finalization turn; second is `failed: invalid_handoff`. Orchestrator Gate validates semantic truth/quality; weak evidence returns precise correction to same worker. Replace worker only for budget exhaustion, repeated failure, unavailable context, or trust concern.

On reload/manager failure, live packages become `interrupted`; never accept or blindly respawn. Replacement inspects current diff/worktree first.

## Component map

- `todo`: durable work state, dependencies, questions, and job waits.
- `jobs`: bounded command/WebSocket/HTTP monitoring with wake/completion/failure conditions.
- Background terminals: simple long-lived local processes without conditions.
- `workflow`: explicit multi-agent fan-out only when user says `workflow` or `ultracode`.
- `subagent`: one bounded delegated task.
- `grill-me`: consequential architecture or rollout decisions.

## Jobs and concurrency

Use `jobs` when command likely exceeds 30 seconds and independent work exists, external state would otherwise be checked twice, or event outcome controls next work. After start, TODO becomes `waiting:jobs`; wake resumes it but never completes it automatically. Do not poll; stop monitor when no longer needed.

Before waiting, scan TODO graph. Start safe independent work up to four-worker cap. Concrete write sets, worktrees/refs, external mutations, and freshness are conflicts. Read-only discovery/review and pinned-snapshot verification can overlap. Never parallelize same files, worktree/ref, external state, or work whose premise is being rewritten. One driver TODO may own parallel workers.

Use workflow only on explicit request. Set child `cwd` to trusted checkout/worktree. Pi-only routing: `openai-codex/gpt-5.6-luna` for focused scouts/verifiers, `openai-codex/gpt-5.6-terra` for implementation, and `openai-codex/gpt-5.6-sol` for review/planning. Use Sol high for security, concurrency, money, migrations, or other irreversible risk; use xhigh only when a genuinely difficult problem justifies it. Estimate orientation, edits, focused verification, and handoff before assigning `max_turns`: 8–12 narrow scouts, 16–24 broad review/planning, 24–32 focused implementation, 32–48 one cohesive multi-file/root-cause package. Reserve final two turns; keep trivial work small rather than over-fanning out. A worker may settle before reserve with exact `budget_request` only for bounded remaining work. Parent may approve it once through `subagent_send`, up to 48 total turns. Parent runs long checks as jobs.

## Safety

Only parent may commit, merge, switch/reset/clean history, deploy, push images, change clusters/secrets, trigger production jobs, modify Gmail, or make other approved external mutations. Timeout grants no fallback mutation.

Pi-only v1: a root Pi Package Worker with `output_contract: 'package_handoff'` may use injected `package_worker_spawn` for one depth-one `reviewer`, `verifier`, or `finding-fixer`. It routes through parent manager, shares `MAX_RUNNING = 4` and package turn budget, and cascade-cancels with root. Reviewer/verifier are read-only; finding-fixer may edit only non-Git-administration files inside cwd. Every nested shell is limited to `rg` and safe `find`; root Package Worker runs checks. Nested workers have no orchestration, TODO, ask-user, jobs, or background tools. Never nest from correction turn or depth one; never auto-respawn. Pi nested workers cannot nest; use root-level review for additional separation.

Complete TODO only after checks pass. When all visible TODOs complete, perform final review; create missing TODOs or archive completed batch with `todo clear`. Never clear unresolved work.
