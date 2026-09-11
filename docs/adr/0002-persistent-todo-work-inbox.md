# ADR 0002: Persistent TODO work inbox and seven-state lifecycle

- Status: Accepted
- Date: 2026-08-22
- Scope: in-place refactor of the local Pi TODO and orchestration extensions
- Related: [product requirements](../todo-orchestrator-product-requirements.md), [ADR 0001](0001-automatic-orchestrator-mode.md), [domain glossary](../orchestration-domain.md)

## Context

The current TODO implementation contains persistence, preparation, scheduling, worker ownership, waits, and completion review, but their visible lifecycle and recovery rules are spread across compatibility fields and operational substates. That makes preparation look like approval, lets queue behavior depend on continuation prompts, and leaves duplicate, dependency, and verification semantics implicit.

The approved product is a persistent inbox with asynchronous preparation, an idle execution queue, independent verification, and automatic internal recovery. It must be delivered without creating a second authoritative store or an offline daemon.

## Decision

1. Define exactly seven public states: `preparing`, `ready`, `in_progress`, `waiting`, `verifying`, `completed`, and `failed`. Preserve existing persisted statuses and replay compatibility through one canonical derived lifecycle adapter during migration; do not expose technical substates as public states.
2. Keep `/todo add` append-only. It enqueues bounded asynchronous preparation. Preparation emits evidence and becomes ready without a permission checkpoint.
3. Let one execution coordinator claim safe ready work whenever idle, freely reprioritizing multiple ready tasks from context and explicit instructions. Parent execution versus Package Worker delegation is a runtime choice, not a user approval step.
4. Make Package Worker scope maximal and coherent: analysis, implementation, tests, checks, review/fix loop, and handoff belong to one worker. The parent remains the semantic and external-mutation gate.
5. Persist duplicate source items and their `merged into #N` identity. Shared execution and verification settle every linked source item with shared result/evidence.
6. Propagate failed prerequisites transitively while allowing independent branches to continue.
7. Bound executor/verifier correction exchanges at three. The third unresolved exchange fails the task. Persist verifier findings, evidence, and rationale, including parent challenges or skips supported by persuasive evidence or a prior user message.
8. Reconcile durable ownership after restart/reload. Automatically recover safe work; inspect current workspace state before resuming interrupted mutation. Edits and cancellation enter through the main prompt.
9. Treat completion review as requirement-completeness verification, not code review. Approve when result and concrete evidence plausibly satisfy every explicit requirement. Reject only a concrete material omission, contradiction, missing mandatory check, or plainly premature closure. Workspace diffs are supporting context rather than a mandatory proof boundary; committed work, external-worktree evidence, baseline restoration, or an incomplete bounded overlay are not rejection reasons by themselves.
10. Recover internal verifier failures automatically. Do not present Retry/Revise for an operational failure.
11. Refactor the current implementation in place. The existing replay/state store remains the only authoritative store; new components communicate through canonical task identity and lifecycle events.

## Consequences

Positive:

- Users see one compact lifecycle and do not manage internal orchestration.
- Preparation and execution can progress independently.
- Verification, duplicate identity, dependency failure, and reload recovery become testable contracts.
- Existing replay compatibility can be migrated incrementally.

Costs:

- A lifecycle adapter and migration period are required while old statuses remain persisted.
- Reprioritization needs deterministic safety checks even though order is agent-owned.
- Duplicate linking and shared evidence add bounded persisted metadata.

## Rejected alternatives

- A passive checklist: it cannot prepare asynchronously, wake on events, delegate packages, or verify completion.
- A second inbox/queue store: it would create divergent replay and ownership truth.
- Fixed FIFO or mandatory user priority: it conflicts with context-driven reprioritization and was explicitly deferred.
- Retry/Revise modal for internal failures: internal operational recovery is the product’s responsibility.
- Offline daemon: persistence supports later recovery; cross-process unattended execution is a separate product.
