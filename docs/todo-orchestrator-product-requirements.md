# Persistent TODO work inbox

- Status: Approved product requirements
- Date: 2026-08-22
- Scope: local Pi TODO and orchestration extensions
- Related: [ADR 0001](adr/0001-automatic-orchestrator-mode.md), [ADR 0002](adr/0002-persistent-todo-work-inbox.md), [orchestration domain](orchestration-domain.md)

## Goal

Make TODO a persistent work inbox. A user may add work continuously while Pi prepares, executes, verifies, and completes actionable items without repeated continue prompts. Completion requires concrete evidence and independent evaluation; internal orchestration mechanics are never permission prompts.

## Public lifecycle

The public lifecycle has exactly seven states:

`preparing` → `ready` → `in_progress` → `verifying` → `completed`

`waiting` may be entered from actionable or verification work when a real user decision or external event is required. Any non-terminal state may become `failed` after an unrecoverable bounded failure. Technical substates such as preparation progress, cancellation, interruption, review reason, and wait kind remain details, not additional public states.

`waiting` must identify its reason internally (`user` or `jobs`) and resume only from the correlated answer/event. A task waiting for one job must not be rerun or awakened by unrelated jobs.

## Inbox and execution

- `/todo add` only appends a new item. It does not edit, reorder, cancel, or replace an existing item.
- Adding starts bounded asynchronous preparation. Preparation is read-only evidence gathering and never blocks the active execution queue.
- Preparation becomes `ready` when safe execution facts are sufficient. Candidate questions do not create a prompt; only a real unresolved decision enters `waiting`.
- When the idle execution queue has safe ready work, it claims work automatically. Independent ready work continues while another item waits.
- With multiple ready tasks, the agent freely reprioritizes based on current context, dependencies, conflicts, freshness, and explicit instructions. There is no fixed FIFO or starvation promise in this version.
- The agent chooses parent execution or delegation from current context and explicit user instructions. It must not delegate merely because a task is large by step count.
- A delegated package is maximal and coherent. The Package Worker owns analysis, implementation, tests, checks, review/fix iterations, and handoff. The parent retains user communication, semantic acceptance, integration, Git history, and external mutations.
- Safe recovery after restart, reload, compaction, and session resume reconstructs durable state, invalidates stale runtime authority, and resumes or requeues only work supported by current evidence. Interrupted mutating work receives recovery analysis against the current workspace first.

## Identity, duplicates, and dependencies

- The current in-place refactor keeps one authoritative TODO store. Components share task identity and lifecycle events; no second authoritative store or shadow queue is introduced.
- Duplicate or materially identical source items persist. One source owns execution; every other source records `merged into #N`. Shared verification settles every linked source item with the same result and evidence.
- A failed prerequisite transitively fails every dependent. Independent branches continue.
- Edits and cancellation come through the main prompt and the normal durable lifecycle commands. Internal workers cannot turn these operations into permission dialogs.

## Verification and failure

1. An executor submits a result and concrete evidence.
2. Deterministic checks validate lifecycle identity and evidence shape.
3. An independent read-only verifier evaluates whether the evidence supports the requested outcome.

The executor and verifier may exchange corrective feedback at most three times. After the third unresolved exchange, the item becomes `failed`; independent queue work continues. The parent may challenge or skip a finding only with persuasive evidence or an explicit prior user message. The finding, evidence, and rationale remain persisted and user-visible.

Operational reviewer failures recover automatically with bounded retry, recovery analysis, or actionable diagnostic work. They must not open a Retry/Revise modal. Retry/Revise is not a user-facing control for internal failures.

## Controls and boundaries

The queue continues actionable work until items are completed, deleted, or waiting for a real user decision/event. Closing Pi pauses execution safely; reopening resumes from durable state. A separate daemon for execution after Pi exits is out of scope. Git publication, merge, deploy, and other external mutations retain their own authorization.

## Acceptance scenarios

- Add several items while one runs; all prepare independently and execute without another continue prompt.
- Reprioritize several ready items while preserving dependency and write-set safety.
- Wait for one job while independent siblings complete; only the matching event wakes the waiter.
- Surface a genuine ambiguity as `waiting`, but keep preparation candidate questions internal.
- Reject completion without evidence and recover internal verifier failure without a modal.
- Preserve duplicate source items, merged-into identity, and shared verification evidence.
- Fail all transitive dependents of a failed prerequisite while independent branches continue.
- Challenge a verifier finding while preserving finding/evidence/rationale.
- Reload during active preparation or mutation and resume only after safe recovery analysis.
- Edit or cancel through the main prompt; never through an internal Retry/Revise dialog.
