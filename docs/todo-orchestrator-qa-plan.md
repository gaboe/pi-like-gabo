# TODO orchestrator QA plan

## Test strategy

Use the narrowest runnable test after each TDD step, then the complete TODO test glob and repository checks. Acceptance tests must assert user-visible lifecycle and durable evidence; pure reducer tests cover validation and migration; scheduler tests cover ownership, wakeups, reprioritization, and recovery. Do not weaken existing assertions or duplicate broad suites.

## Coverage matrix

| Area | Focus | Required evidence |
| --- | --- | --- |
| Lifecycle | exactly `preparing`, `ready`, `in_progress`, `waiting`, `verifying`, `completed`, `failed` | public-state assertion; legacy mapping |
| Add/preparation | add appends only; preparation is asynchronous; candidate questions do not prompt | state identity; ready transition; no user wait |
| Queue | idle queue claims ready work; multiple ready tasks can be reprioritized; siblings continue while one waits | selected IDs/order; matching wake event |
| Ownership | parent/Package Worker chosen from context and explicit instructions; one maximal package owns analysis through handoff | assignment and package-contract assertions |
| Duplicates | source rows persist; `merged into #N`; shared verification result/evidence | replay round trip; all linked rows settle |
| Dependencies | failed prerequisite transitively fails dependents; independent branch continues | graph outcome assertion |
| Verification | evidence required; max three correction exchanges; unresolved third exchange fails | exchange count and terminal state |
| Findings | parent challenge/skip requires persuasive evidence or prior user message and preserves finding/evidence/rationale | persisted record assertion |
| Recovery | restart/reload recovers only safe work and invalidates stale mutation authority | replay/reconciliation assertion |
| Controls | edits/cancellation use main prompt; internal failures never show Retry/Revise | command path and emitted-message assertion |
| Storage | in-place refactor has one authoritative store | import/replay identity or source-level invariant |

## Receipts

Phase 1 baseline:

```sh
node --import tsx --test extensions/todo/orchestrator.test.mjs extensions/todo/state/state.test.mjs extensions/todo/reorder.test.mjs extensions/todo/reflection-interruption.test.mjs
```

Expected baseline: all existing focused tests pass. Phase 1 acceptance tests intentionally include red contracts for behavior not yet implemented; report those failures by test name and missing contract, never as implementation completion.

After each implementation slice:

```sh
node --import tsx --test extensions/todo/todo-orchestrator-acceptance.test.mjs
node --import tsx --test 'extensions/**/*.test.mjs'
npm run typecheck
```

Before handoff, run the full repository check only if unrelated dirty-worktree changes do not contaminate its result. Record command, pass/fail count, and the decisive failure line for any red result.

## Recovery and regression matrix

Run each scenario once cold and once after replay/reload: add three tasks during active work; one matching job wait plus an independent sibling; candidate versus genuine preparation question; duplicate merge; transitive prerequisite failure; verifier rejection and three-exchange exhaustion; parent challenge; interrupted worker with dirty workspace; edit/cancel from the main prompt; internal reviewer failure. Verify no duplicate continuation, no stale worker authority, no approval prompt, no Retry/Revise modal, and no lost evidence.
