# TODO orchestrator implementation plan

- Status: Approved sequential in-place TDD plan
- Date: 2026-08-22
- Scope: `extensions/todo` only, with documentation and tests in the approved paths

## Guardrails

- Keep the current replay/state store authoritative. No parallel store, shadow queue, or compatibility fork.
- Preserve existing replay records and migrate old operational states at the existing replay boundary.
- Make the smallest coherent change at each step; delete obsolete approval and Retry/Revise paths after migration coverage exists.
- Keep Git and external mutations outside the TODO coordinator.

## Sequence

### 1. Contract and characterization (this phase)

Add focused acceptance tests for the seven states, append-only add, asynchronous preparation, ready-queue claiming and reprioritization, ownership choice, maximal Package Worker scope, duplicate linking/shared verification, three-exchange failure, challenge persistence, safe recovery, main-prompt edits/cancellation, transitive dependency failure, one store, and automatic internal failure recovery. Characterize existing reducer, wait, evidence, orchestration, and reload behavior. Leave production behavior unchanged.

### 2. Canonical lifecycle adapter

Add the smallest pure adapter around the existing task state, beginning at the acceptance seam `extensions/todo/state/inbox.ts`. Map persisted legacy statuses and metadata to the seven public states; centralize actionable, waiting, verification, and terminal predicates. Migrate legacy preparation approval markers without creating prompts. Make the red lifecycle tests green first.

### 3. Inbox and preparation boundary

Keep creation append-only and move preparation triggering behind an asynchronous queue boundary already owned by the extension runtime. Persist preparation identity, dossier facts, freshness, and ready transition in the existing task metadata/replay path. Candidate questions remain dossier data; only a real unresolved decision enters `waiting`.

### 4. Idle execution coordinator

Extract safe ready selection from the scheduler. Claim one or more non-conflicting tasks when idle, revalidate dependencies/target identity/ownership, and let context plus explicit instructions choose order and parent versus Package Worker execution. Keep independent siblings moving while a task waits.

### 5. Package Worker and duplicate identity

Reuse the existing worker bridge and package handoff structures. Enforce one maximal package owner for analysis, implementation, tests, checks, review/fix, and handoff. Add bounded persisted duplicate links (`merged into #N`) and settle every linked source item through shared verification.

### 6. Dependency and verification outcomes

Propagate a failed prerequisite through the dependency graph transitively. Keep independent branches actionable. Bound executor/verifier correction exchanges at three, persist finding/evidence/rationale, and allow parent challenge/skip only with persuasive evidence or a prior user message.

### 7. Recovery and UX cleanup

Use existing replay reconciliation and worker ownership fencing for automatic restart/reload recovery. Route edits/cancellation through the main prompt lifecycle. Remove internal Retry/Revise modal paths after operational failure recovery is green; retain user waits only for real decisions/events.

### 8. Full verification and cleanup

Run focused acceptance tests, the existing TODO test glob, typecheck, and formatter. Delete obsolete compatibility/approval paths only after replay migration tests cover them. Record exact receipts and leave Git operations to the user.

## Completion gate

The refactor is complete only when every approved acceptance scenario is green, existing replay/state tests remain green, no second authoritative store exists, and the public UI exposes only the seven states plus concise wait/failure details.
