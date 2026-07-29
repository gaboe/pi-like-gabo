# ADR 0001: Automatic orchestrator mode with direct package assignment

- Status: Accepted
- Date: 2026-07-21
- Scope: local Pi TODO, subagent, and orchestration extensions
- Glossary: [`../orchestration-domain.md`](../orchestration-domain.md)

## Context

Complex work currently depends on the parent model remembering to adopt an orchestrator role. This can serialize independent work, consume parent context on repository discovery and implementation, create small worker tasks, and accept incomplete handoffs. A fixed larger worker cap would not solve package quality, conflicts, or semantic acceptance.

The desired behavior is automatic but simple: prepare strong evidence, create a durable plan when useful, directly assign maximal coherent packages, and keep the parent responsible for decisions and semantic gates.

## Decision

### 1. Classify at TODO boundaries

A lightweight TODO Classifier runs on raw TODO creation and after background preparation.

- Raw classification is provisional.
- Prepared classification may correct it before execution starts.
- Before execution, mode is derived from all current-generation unresolved TODO classifications, not the last classifier result.
- Starting plan execution or the first Package Worker makes the mode sticky.
- Sticky mode ends only after all orchestration TODOs complete and their workers/jobs settle.
- Classification uses strong structural signals, not a step-count threshold.

One global `orchestrator.enabled` kill switch and `/orchestrator on|off|auto` provide rollback and session control. Manual `off` and the global kill switch override stickiness: they stop new assignment, cooperatively cancel orchestration-owned workers, and preserve unfinished packages as `interrupted` rather than silently completing or discarding them.

### 2. Prepare before planning

The Preparation Analyst must return a verified dossier sufficient for planning without repeated parent discovery. One bounded repair/retry is allowed. A second failure becomes `preparation_failed`; the Orchestrator may assign fresh preparation or escalate, but must not implement from guessed facts.

Classifier failure also gets one retry. If prepared classification still fails, the top-level Orchestrator applies the documented structural signals and records the fallback. Failure never turns off sticky mode.

### 3. Let the Orchestrator own the Work Plan

There is no separate TODO Planner.

- The user may supply a Work Plan.
- The Orchestrator may create one from the Preparation Dossier.
- Simple work is described completely in the worker prompt.
- Complex or multi-package work uses `scratchpad/<topic>-plan.md` in Claude Code-compatible Markdown.
- The Orchestrator is the sole writer of the central plan.
- A plan file does not create an approval gate; user intent and unresolved decisions do.

Each Work Package uses the mandatory compact header defined in the glossary.

### 4. Assign maximal coherent packages directly

The Orchestrator starts every safe ready package after accepting the plan. It does not create file-sized microtasks and does not introduce a Dispatcher or adaptive queue.

A Package Worker owns implementation, in-scope discoveries, checks, review/fix work, and the final handoff. V1 nesting is Pi-only: a root Pi worker with `outputContract: package_handoff` receives injected `package_worker_spawn` and may launch depth-one `reviewer`, `verifier`, or `finding-fixer`. Bridge calls same parent `SubagentManager`; parent maps own lineage and cascade cancellation. Root and children share package budget and global `MAX_RUNNING = 4`, with root slot still occupied.

Eligibility, role, depth, budget, and correction state are checked before backend spawn and revalidated after asynchronous spawn before lineage publication. Stale children are closed. Children inherit cwd/worktree, scope, trust, model, and bounded permissions, have at most eight turns, load no extensions, and cannot access orchestration, TODO, approval, jobs, or background tools. Reviewer/verifier are read-only. Finding-fixer can edit only non-Git-administration files inside cwd. Every nested shell is limited to `rg` and safe `find`; Git and package-script commands are unavailable, and the root Package Worker runs checks. Prompts, names, output, and errors are bounded before parent observation. Nested-only cancellation returns partial evidence while root continues. Natural completion, failure, turn limit, correction result, root cancel, dispose, and shutdown use a two-phase root drain: stop the root run, cascade cancellation, keep its snapshot, delegation ownership, capacity slot, and workspace accounting live, then publish/release the root exactly once only after every descendant reaches an authoritative terminal turn notification or completed bounded process-group/session termination. No depth two or auto-respawn exists. Fleet lineage contains only `parentId`, `depth`, and `role`.

The only formal Concurrency Checkpoints are:

1. initial plan acceptance and parallel package start;
2. final completion review.

Normal package results, approvals, and job wakeups remain under ordinary Orchestrator control without injected lifecycle chatter.

### 5. Require structured handoffs

Every Package Worker returns a structured Package Handoff. A Mechanical Handoff Gate checks form and local invariants without AI reasoning.

- First invalid form: return exact errors to the same worker using the reserved finalization turn.
- Second invalid form: settle as `failed: invalid_handoff` and preserve raw output.
- Valid form: the Orchestrator Gate checks semantic truth and quality.
- Weak semantic evidence: return precise deficiencies to the same worker.
- Replace the worker only for exhausted budget, repeated failure, unavailable context, or trust concerns.

### 6. Recover conservatively after reload

Persist sticky mode, plan reference, package ownership, and TODO state. `/reload` or manager failure marks live packages `interrupted`; it never accepts them or blindly respawns mutating workers. The Orchestrator redispatches an interrupted package, and the replacement worker must inspect the current diff/worktree first.

### 7. Preserve ownership and mutation safety

Never parallelize mutations to the same files, worktree/ref, external state, or work whose premise is being rewritten. The parent retains approvals, semantic acceptance, integration, Git history, and external mutations.

## Consequences

### Positive

- Automatic activation no longer relies on remembering a skill.
- Parent context is spent on decisions and gates rather than repeated discovery.
- Workers receive meaningful outcomes and own their review loop.
- Structural handoff defects are rejected cheaply and deterministically.
- Complex plans and interrupted work survive session reloads.
- Rollback is immediate through settings or a session override.

### Negative

- Every TODO incurs lightweight classification, normally twice.
- Preparation becomes more demanding and may delay execution when evidence is incomplete.
- The central Work Plan and live TODO state can drift unless the Orchestrator updates them at meaningful boundaries.
- Reload recovery requires a replacement worker to inspect partial changes.

## Alternatives rejected

- Prompt-only orchestration: too easy to forget or drift from.
- Separate runtime Dispatcher/adaptive queue: more state and failure modes than direct assignment requires.
- Fixed higher worker slots: confuses logical work with safe concurrent execution.
- One-file tasks: pushes integration and verification back to the parent.
- Workers editing one shared plan file: creates parallel write conflicts.
- Runtime semantic acceptance: schema validation cannot judge evidence truth.
- Blind worker respawn after reload: unsafe on dirty mutable worktrees.

## Rollout

1. Implement behind `orchestrator.enabled` with `/orchestrator on|off|auto`.
2. Run focused unit and transcript tests.
3. Enable session `auto` and run the required dogfood matrix.
4. Compare observed behavior to this ADR.
5. Make `auto` the default only after the dogfood gate passes.
6. Roll back with global off or a session override; no data migration is required.

## Validation

Automated tests must cover:

- raw/prepared classification and generation races;
- provisional, sticky, completion, and override transitions;
- terminal `preparation_failed` after the bounded retry and prepared-classifier structural fallback with its recorded reason;
- Mechanical Handoff Gate correction and terminal invalid handoff;
- same-worker semantic correction guidance;
- root eligibility, all depth-one roles, and unknown/non-Pi/depth-two rejection before backend spawn;
- shared package/global limits, inherited tool policy, correction rejection, metadata propagation, nested-only cancellation, and root cancel/dispose cascade;
- reload reconstruction and interrupted ownership;
- final completion review.

Dogfood must cover:

- a simple direct TODO;
- a complex generated plan;
- a user-supplied plan;
- safe parallel packages and serialized conflicts;
- invalid form, weak evidence, and exceptional partial;
- long-running job with independent work;
- reload with a dirty interrupted package;
- completion shutdown and kill-switch rollback;
- explicit comparison of activation, maximal coherent package sizing, parallel starts, handoff correction, and shutdown against this ADR.

Acceptance requires complete evidence, no unsafe concurrent mutation, no broad parent repository discovery after a ready dossier, and behavior matching this ADR.

The TODO #130 candidate evidence matrix, including failed discovery runs and the final fresh-process concurrent Package Worker run, was retained as local scratchpad evidence and is intentionally excluded from the published package. Acceptance does not change the opt-in default.
