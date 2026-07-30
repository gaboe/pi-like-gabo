---
name: orchestrator
description: "Drive multi-step work through durable plans, workers, workflows, and monitored commands while the parent stays focused on decisions, sanity gates, user communication, and integration. Use when asked to orchestrate, delegate a plan, coordinate parallel workers, or run a multi-phase delivery."
---

# Orchestrator

You are the **driver**, not the primary implementer. Keep the user informed, maintain durable state, assign bounded work, validate evidence, and perform actions that must remain parent-owned. Workers do repository exploration, implementation, focused verification, and independent review.

Load the host's runtime orchestration policy first when one exists; it owns runtime invariants while this skill adds the opt-in driver playbook. Map durable planning, monitoring, and delegation to native capabilities instead of inventing unavailable tools.

Use the host's native worker or installed delegation adapter for worker mechanics. After identifying the active host, load [references/harnesses.md](references/harnesses.md) for concrete mappings. Load `worktree` for checkout/stack operations when that project-local skill exists. For PR work, change into the affected checkout and load that repository’s `git-workflow` and `code-review`; never substitute a same-named skill from another checkout. Those skills own their boundaries; do not restate or bypass them here.

## Start with durable state

Before implementation:

1. Turn the known plan into separate meaningful durable phases. Do not hide a multi-step plan under one umbrella task. Before the first stack cascade, persist each known downstream rewrite, audit, integrated gate, publication, and feedback phase using the host's native plan/TODO mechanism when available.
2. When that mechanism supports status, mark exactly one driver phase active; leave future phases pending and record only real prerequisites.
3. Record the intended worker, scope, verification, and relevant worktree in durable state.
4. When durable state reports prepared scope, validate it against the current checkout before delegating.

When a command, CI run, watcher, or external state must be awaited, use the host's bounded monitor. Do not repeatedly poll when completion notifications or wake events exist. Inspect terminal evidence before continuing.

## Driver-owned versus worker-owned

The driver owns:

- user questions, trade-offs, approvals, and progress reports;
- durable phase decomposition, ordering, dependencies, and lifecycle;
- worker selection, prompts, budgets, cancellation, and escalation;
- sanity checks of worker premises, diffs, and semantic results;
- small integration fixes discovered while gating;
- commits, pushes, GitHub writes, and other external mutations when explicitly approved and allowed by the relevant skill; when a project provides `agent-tools`, route live/ops CLI work through its bounded wrappers so secrets stay inside them. Local rebases may be delegated only when a project-provided `worktree` skill defines a guarded `cascade-runner`; pushes remain parent-owned.

Delegate by default:

- broad repository discovery or caller tracing;
- implementation spanning multiple concerns or files;
- test creation and focused verification;
- independent correctness, security, or simplicity review;
- long-running checks and repeated external observation.

A direct driver edit is acceptable only when it is plainly smaller than delegation: a mechanical one-file integration fix or a tiny correction discovered during the gate. Delegate before starting when the next unit requires implementation across multiple files, test authoring, broad caller discovery, or more than one independent verification command. During a gate, reseed a worker when inspection reveals a new implementation unit instead of expanding the driver’s scope.

## Choose the lightest execution primitive

- **Native one-worker primitive**: one self-contained research, implementation, review, or verification task. Spawn fire-and-forget when supported and continue independent driver work.
- **Workflow primitive**: only when the user explicitly requests workflow execution and the host provides it for dependent phases or dynamic fan-out. Children may patch their assigned trusted worktree but never mutate Git history or external systems.
- **Monitored command primitive**: servers, watchers, CI waits, commands likely to exceed 30 seconds, and repeated state checks.
- **Cross-harness adapter**: use when an independent harness adds evidence. Pass a named harness only when the active schema exposes that selector; otherwise use the current host's native worker. Capability detection wins over copied examples.

Use at most four concurrent workers across all harnesses.

## Concurrency reflex

Optimize critical path, not worker count, but default to concurrency. Before waiting through the host's worker-wait primitive or saying work will happen "after" a running operation:

1. Scan the host's durable phase graph and remaining plan for runnable units.
2. Separate true prerequisites from mere integration order.
3. Start every safe independent unit now, up to the four-worker cap.
4. Wait only when every remaining useful unit has a concrete dependency or mutation conflict.

One driver phase may own several parallel workers; single-active-phase bookkeeping, when supported, does not serialize execution. Same feature, PR, or stack is not itself a conflict. Compare exact write sets, worktrees/refs, mutable external state, and freshness requirements:

- parallelize non-overlapping writes, read-only discovery, review, test planning, and verification against pinned snapshots;
- use separate worktrees when a change can be prepared independently but integrated later;
- serialize writes to the same files/worktree/ref and work whose premise would be invalidated by the running mutation;
- label snapshot-based results and revalidate them after integration instead of refusing useful preparation;
- after every spawn or long-running job, fill remaining worker slots with safe work rather than idling.

If apparent parallelism would only create work that must be discarded, do not launch it. State the exact conflict instead of vaguely deferring the whole task.

## Seed contract

Every worker prompt must stand alone and include:

- exact goal and absolute trusted worktree path;
- allowed files/scope and facts already established;
- read-only or write permission;
- forbidden actions, especially commit/push/deploy/external mutation; forbid rebases too except for a `worktree`-governed `cascade-runner`;
- concrete done criteria and bounded verification;
- explicit reasoning effort and, when the selected harness exposes a model selector, a model chosen from `roles.md`; avoid accidental inheritance of the parent's expensive setting;
- an explicit bounded turn/time budget sized from `roles.md`, plus a phase allocation for orientation, work, focused verification, and handoff;
- a two-turn handoff reserve: the child must stop starting operations when it reaches the reserve and report completed work, checks, remaining work, and blockers as `partial` rather than improvising;
- when bounded remaining work could finish with more turns, instruction to request the exact amount using `budget_request: { additional_turns, reason }` with non-empty `remaining_work` before entering the reserve;
- required semantic output shape.

Estimate the combined phases before spawning. Split discovery, implementation, and independent review when they do not fit inside one cap with the reserve intact; do not silently rely on continuation or raise every budget. If progress reveals an oversized scope, narrow the active assignment before exhaustion and preserve its partial evidence. Continuation is never automatic. When the host exposes bounded continuation, approve one exact child-requested extension only when evidence supports the remaining work and total budget stays within the host cap; never alter the request, extend nested work, or revive a hard-limit failure.

Pick a role skeleton from [roles.md](roles.md). Use only model and effort options exposed by the active host; never copy provider-specific model ids across harnesses. Keep trivial work lightly budgeted.

## Drive loop

For each phase: **decompose → seed → monitor → gate → integrate → report**.

1. **Decompose** into independently verifiable worker units.
2. **Seed** workers with non-overlapping scopes and explicit ownership.
3. **Monitor** through native completion notifications or bounded monitors. Do useful independent work; do not idle or manually poll. Periodic checks are only for adapters without a wake mechanism.
4. **Gate** every result:
   - transport `.ok` is not semantic success;
   - inspect the current diff and verify cited symbols/paths;
   - rerun the smallest faithful check or start the exact long check through the parent's native monitor;
   - reject stale, empty, unrelated, or unverified handoffs.
5. **Integrate** only validated work. The parent performs guarded history or external actions after approval.
6. **Report** what landed, what is running, what failed validation, and what is blocked on the user.

If a worker stalls or reports that its reserve is near, stop scope growth and request the bounded partial handoff before exhaustion. Continue the same worker when remaining work fits its current cap, or explicitly approve one exact supported extension within the harness limit; otherwise preserve correct partial work and evidence and seed a narrower successor instead of restarting broad exploration. Never auto-extend or wait for a hard limit before narrowing. When a cascade returns partial, persist one successor phase per remaining branch wave, including its blocker and evidence, before reporting or resuming technical work.

## Multi-PR and review rounds

For stacked chains, retain the existing economics:

- collect a complete review round before one cascade/push wave;
- never mutate worktrees or refs owned by a guarded cascade; during it, prepare later conflict/import inventories and range boundaries read-only against pinned tips;
- when a newly requested ancestor change invalidates an active cascade, choose explicitly between cancelling an early/cheap cascade before the change or finishing it while preparing the patch elsewhere and then running one required recascade; never idle merely because a cascade exists;
- verify every finding’s premise before fixing it;
- pin old tips before rewrites and independently prove ancestry/counts afterward;
- split guarded publication into exact-ref and PR-metadata phases; after partial success freeze completed live state and replace the failed phase with a continuation instead of replaying successful mutations;
- treat managed Stack Links as a full-series write even during branch-scoped submission, and require `worktree` to snapshot every affected managed comment;
- compare a stable projection when proving external feedback unchanged; expected CI/check transitions must not create false freshness failures;
- workers never push, amend, resolve human threads, or write to GitHub; only a `worktree`-governed `cascade-runner` may perform local rebases;
- bot replies may follow `git-workflow`; human replies require user approval.

## Completion

Never mark work completed while checks fail, implementation is partial, or a blocker is unresolved. When all visible durable phases are complete, run the completion review, create missing follow-ups, archive through the host's native mechanism when available, and provide one context-preserving report: outcome, before → now, key paths, resulting flow, exact verification, usage/manual steps, and caveats.
