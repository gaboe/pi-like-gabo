# Worker roles

Choose the narrowest role that can produce independently checkable evidence. Every seed also carries the exact worktree, allowed scope, permissions, budget, forbidden actions, done criteria, and semantic output shape from `SKILL.md`.

## Model and effort routing

Identify the active harness before routing. Always set effort explicitly when supported and set model explicitly when the harness exposes a selector. Use only model ids valid for that harness; concrete mappings live in [references/harnesses.md](references/harnesses.md). Use the lowest tier that fits because deterministic checks and short feedback loops compensate for lower effort.

| Work                                                                          | Model class | Effort |
| ----------------------------------------------------------------------------- | ----------- | ------ |
| Deterministic verifier or focused scout                                       | Lowest capable native model | `low` |
| Broad repository exploration                                                  | Native scouting model | `medium` |
| Bounded or multi-file implementation, ambiguous root cause                    | Native implementation model | `low` |
| Routine review                                                                | Native review model | `low` |
| Planning, synthesis, or complex implementation                                | Native reasoning model | `medium` |
| Security, concurrency, money, migration, or irreversible-risk analysis        | Strong native reasoning model | `high` |
| Critical problem after a documented high-effort attempt failed for reasoning depth | Strongest justified native model | Highest justified setting |

A failed check is evidence to fix the concrete defect at the same harness/model tier, not automatic justification for more reasoning. Escalate one step at a time. Never select a maximum setting automatically; the highest setting requires evidence that the prior one was insufficient.

## Turn/time-budget sizing

Use the selected harness's bounded turn or wall-clock budget. Override defaults only with a written scope reason. On turn-budgeted workers, reserve the final two turns for verification summary and handoff.

| Task class | Relative budget |
| --- | --- |
| Deterministic command runner with no discovery | Smallest bounded budget |
| Narrow mechanical scout | Short review budget |
| Broad exploration, routine review, or planning | Medium bounded budget |
| Focused implementation with tests | Implementation budget |
| Cohesive multi-file or ambiguous root-cause package | Largest justified native budget |

Estimate orientation, work, and focused verification separately; never choose a cap below their sum plus the handoff reserve when turns are used. Split discovery, implementation, and independent review when they exceed the harness cap or do not share one coherent write scope. A large finding list is decomposition input, not justification for one oversized worker. Do not rely on automatic continuation: return verified partial work and exact next steps before exhaustion. If the harness supports bounded continuation, the worker may request one exact extension with a reason and non-empty remaining work; approve it at most once within that harness's cap.

## scout

**Read-only; short budget.** Locate owners, callers, existing patterns, and likely checks. Return verified paths/symbols, uncertainties, and a proposed minimal scope. Use the lowest capable native model. Never ask a scout to decide domain or security policy.

## implementer

**Write access to an explicit non-overlapping path set.** Apply one bounded change with focused tests. Inspect the current diff first, preserve unrelated work, and return changed files, behavior, checks, and remaining risks. No commit, push, rebase, deployment, or external mutation.

Split implementation by concern rather than giving one worker a long finding list. If a task cannot fit its turn budget, it returns `partial` with exact remaining work.

## reviewer

**Read-only and independent from the implementer.** Review a named diff/scope for correctness and regressions. Use structured semantic status (`passed`/`failed` or `done`/`blocked`) and actionable findings with path/evidence. A successful model call is not a passing review.

Use separate security/domain reviewers only when the risk warrants them; do not fan out duplicate generic reviews.

## verifier

**Read-only except formatter-only changes when explicitly permitted.** Run the smallest faithful deterministic checks and inspect integration boundaries. Keep each child command below the active harness's tool limit. Return exact long-running commands to the parent for its native bounded monitor rather than bundling full build, lint, and tests into one child call.

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
