# Worker roles

Choose the narrowest role that can produce independently checkable evidence. Every seed also carries the exact worktree, allowed scope, permissions, budget, forbidden actions, done criteria, and semantic output shape from `SKILL.md`.

## Model and effort routing

Always set both model and effort explicitly. Use the lowest tier that fits; deterministic checks and short feedback loops compensate for lower effort.

| Work                                                                          | Model | Effort   |
| ----------------------------------------------------------------------------- | ----- | -------- |
| Deterministic verifier or command runner                                      | Luna  | `low`    |
| Focused scout                                                                 | Luna  | `low`    |
| Broad repository exploration                                                  | Luna  | `medium` |
| Bounded implementation with checks                                            | Terra | `low`    |
| Multi-file implementation or ambiguous root cause                             | Terra | `low`    |
| Routine review                                                                | Sol   | `low`    |
| Planning, synthesis, or complex implementation                                | Sol   | `medium` |
| Security, concurrency, money, migration, or irreversible-risk analysis        | Sol   | `high`   |
| Critical problem after a documented `high` attempt failed for reasoning depth | Sol   | `xhigh`  |

A failed check is evidence to fix the concrete defect at the same tier, not automatic justification for more reasoning. Escalate one step at a time. Never select `max` automatically; `xhigh` requires evidence that `high` was insufficient.

## Turn-budget sizing

Size `max_turns` by task class, then override only with a written scope reason. Tool-using assistant responses consume turns. Every cap below already includes two final turns reserved for verification summary and handoff.

| Task class | Suggested `max_turns` |
| --- | ---: |
| Deterministic command runner with no discovery | 6 |
| Narrow mechanical scout | 8–12 |
| Broad exploration, routine review, or planning | 16–24 |
| Focused implementation with tests | 24–32 |
| Cohesive multi-file or ambiguous root-cause package | 32–48, with explicit justification |

Estimate orientation, work, and focused verification separately; never choose a cap below their sum plus the reserve. Split discovery, implementation, and independent review when the estimate exceeds 48 or when they do not share one coherent write scope. A large finding list is decomposition input, not justification for a single oversized worker. Do not rely on automatic continuation: the child stops before the reserve and returns verified partial work and exact next steps. If bounded remaining work could finish with more turns, it may include exact `budget_request: { additional_turns, reason }` and non-empty `remaining_work`; the orchestrator may approve that amount once, with total `max_turns` still at most 48.

## scout

**Read-only; short budget.** Locate owners, callers, existing patterns, and likely checks. Return verified paths/symbols, uncertainties, and a proposed minimal scope. Use Luna for deterministic, low-risk work. Never ask a scout to decide domain or security policy.

## implementer

**Write access to an explicit non-overlapping path set.** Apply one bounded change with focused tests. Inspect the current diff first, preserve unrelated work, and return changed files, behavior, checks, and remaining risks. No commit, push, rebase, deployment, or external mutation.

Split implementation by concern rather than giving one worker a long finding list. If a task cannot fit its turn budget, it returns `partial` with exact remaining work.

## reviewer

**Read-only and independent from the implementer.** Review a named diff/scope for correctness and regressions. Use structured semantic status (`passed`/`failed` or `done`/`blocked`) and actionable findings with path/evidence. A successful model call is not a passing review.

Use separate security/domain reviewers only when the risk warrants them; do not fan out duplicate generic reviews.

## verifier

**Read-only except formatter-only changes when explicitly permitted.** Run the smallest faithful deterministic checks and inspect integration boundaries. Keep each child command below the workflow tool limit. Return exact long-running commands to the parent for `jobs` rather than bundling full build, lint, and tests into one child call.

## e2e-verifier

**Runtime/browser interaction; no code changes.** Execute a numbered scenario with isolated session state. Return per-step PASS/FAIL, relevant request status, screenshots/evidence paths, and failure diagnostics. Production or external mutations still require parent approval.

## finding-fixer

**One confirmed review/CI finding.** Re-verify the premise, apply the smallest root-cause fix and regression check, or report that current HEAD already addresses it. Concurrency, framework, security, or domain findings require a strong model and narrow scope.

## cascade-runner

**Specialized local Git worktree role governed by `worktree`.** Operate only through the guarded worktree flow with a pinned branch/old-tip table and range-diff/ancestry proof. Local-only; the parent independently validates and pushes. Never use raw Git operations that bypass branch guards.

## plan-reviewer

**Read-only adversarial review before non-trivial implementation.** Cross-check a written plan against actual code. Return `PLAN-OK` or numbered gaps with evidence and a concrete amendment. Resume the same reviewer after amendments instead of spawning fresh duplicate reviews.

## Typical compositions

- Small fix: implementer → parent gate.
- Risky fix: scout → implementer → reviewer → parent verification job.
- Multi-phase feature: plan-reviewer → scoped implementers → verifier → fresh reviewer.
- PR round: N independent finding-fixers → parent gate → cascade-runner when empirically required → parent push/CI monitor.
