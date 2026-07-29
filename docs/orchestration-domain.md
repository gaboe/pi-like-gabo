# Orchestration domain

This glossary defines the language used by the local Pi orchestration extensions. It separates model roles from deterministic validation and avoids introducing a scheduler domain that the design does not need.

## Terms

### Orchestrator

The top-level model role. It turns user intent into maximal coherent work packages, sets boundaries, dependencies, permissions, done criteria, and budgets, directly assigns packages, and semantically accepts their results. It does not implement a package except for a bounded integration correction.

### Orchestrator mode

A policy for one work batch that keeps the top-level agent in the Orchestrator role. Automatic classification may activate it provisionally; execution makes it sticky until the batch and its children settle. `/orchestrator on|off|auto` is the session override. Manual `off` and the global kill switch take precedence over stickiness: they prevent new package assignment, cooperatively cancel orchestration-owned workers, and preserve unfinished packages as `interrupted` for later recovery.

### Work batch

One related body of work handled under a single Orchestrator-mode lifecycle.

### Work plan

The execution contract supplied by the user or authored by the Orchestrator from a verified Preparation Dossier.

- A simple plan is fully contained in a self-contained worker prompt.
- A complex or multi-package plan lives at `scratchpad/<topic>-plan.md` in the same Markdown style used by Claude Code plans.
- A plan file is not itself an approval gate. The user's stated intent decides whether execution starts or waits.

The central plan is written only by the Orchestrator. It may link naturally large artifacts, logs, screenshots, or reports produced by workers.

### TODO tracker

The live progress, wait, and dependency view corresponding to the Work Plan. It does not create the plan, assign packages, or schedule workers.

### Preparation Analyst

A read-only background agent that produces a comprehensive, evidence-backed Preparation Dossier. The dossier must let the Orchestrator author a Work Plan without repeating repository discovery. It includes:

- applicable instructions and skills;
- verified current code, symbols, paths, and reusable patterns;
- scope, explicit exclusions, worktree/ref, and dirty-state facts;
- dependencies, conflicts, freshness conditions, and candidate parallel boundaries;
- risks, decisions, approvals, candidate questions, exact checks, and evidence sources.

Unknown facts remain explicit gaps. The analyst does not own or approve the Work Plan.

### TODO Classifier

A lightweight agent run when a TODO is created and again after preparation. It labels whether the TODO requires orchestration. Before execution becomes sticky, mode is derived from all current-generation unresolved TODO classifications rather than whichever classifier finished last. Strong signals include explicit plan/delegate/orchestrate intent, independent packages, multiple repositories or worktrees, a broad coherent package suitable for autonomous delegation, long-running coordination with independent work, or a durable handoff requirement. Step count alone is not a signal.

### Work package

A maximal coherent bounded outcome assigned directly by the Orchestrator to one Package Worker. A package normally includes implementation, relevant checks, review/fix work, and a verified handoff.

Every package has this compact header:

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

### Package Worker

An autonomous agent that owns one Work Package end-to-end. It absorbs newly discovered work that remains inside the assigned outcome and mutation scope.

### Nested Worker

A Pi-only `reviewer`, `verifier`, or `finding-fixer` launched by a root Pi Package Worker through the injected `package_worker_spawn` bridge. Bridge routes into same parent `SubagentManager`; it never creates an independent manager. Root and child share package lifecycle, turn budget, Fleet state, and global `MAX_RUNNING = 4`; root slot remains occupied.

Only `{ depth: 0, role: "package-worker" }` with `outputContract: package_handoff` is eligible. Child gets `{ parentId, depth: 1, role }`, at most eight turns, inherited cwd/worktree, package scope, trust, model, and bounded permissions. Reviewer/verifier are read-only. Finding-fixer may edit only non-Git-administration files inside cwd. All nested shell access is limited to `rg` and safe `find`; Git and package-script commands are unavailable, and the root Package Worker runs checks. Nested sessions have no extensions or subagent, workflow, TODO, ask-user, jobs, or background-terminal tools. Nested prompts/names and returned output/errors are size-bounded before parent observation.

Unknown, ordinary, depth-one, exhausted-budget, and correction-turn parents are rejected before Pi session spawn. Parent eligibility is revalidated after asynchronous Pi session spawn and before lineage publication; stale children are closed. There is no depth two or automatic respawn. Nested-only cancellation returns partial evidence and leaves root running. Every root terminal path enters a two-phase drain: the root snapshot, delegation ownership, capacity slot, and workspace accounting remain live while all descendants are cancelled and reach an authoritative terminal state; only then is the root result published and its accounting released. Pi native nested-worker tools synchronously revalidate authority at each read/edit/write boundary. This blocks new plugin-mediated operations after revocation, but is not OS isolation and cannot recall an operation already handed to the platform. External processes and work outside plugin coordination remain outside these guarantees.

### Package Handoff

The required structured final response from a Package Worker. It contains:

- semantic status: `done`, `partial`, `blocked`, or `failed`;
- every acceptance criterion and its evidence;
- changed paths;
- checks and results;
- review/fix result;
- remaining work and risks.

`partial` is exceptional: a true blocker, scope expansion, ownership conflict, approval need, or exhausted budget.

### Mechanical Handoff Gate

Deterministic, non-AI validation of Package Handoff shape and local invariants. It verifies required fields, requires evidence, and rejects `done` unless every criterion passed. It may return invalid form once to the same worker using the reserved finalization turn. A second invalid response becomes `failed: invalid_handoff` with raw evidence preserved.

It cannot judge truth or quality.

### Orchestrator Gate

Semantic acceptance by the Orchestrator. It checks evidence truth, quality, relevance, and alignment with the original intent. A weak handoff goes back to the same Package Worker with precise deficiencies. The Orchestrator does not silently normalize it or take over implementation.

### Concurrency checkpoint

One Orchestrator action, not a runtime component:

1. after the Work Plan is complete or accepted, start every safe ready package;
2. when all TODOs appear complete, perform final completion review.

Between these points the Orchestrator naturally reacts to package results, approvals, and job wakeups.

## Invariants

- Never parallelize mutations to the same files, worktree/ref, external state, or work based on a premise currently being rewritten.
- Logical packages and worktrees are not capped by the number of concurrently executing workers.
- The parent owns user communication, approvals, semantic gates, integration, Git history, and external mutations.
- `/reload` never implies completion. Live packages become `interrupted`; a replacement worker must inspect the current diff/worktree before continuing.
- A classifier or preparation failure never disables an already sticky Orchestrator mode.
- Nested lineage exposes only bounded `parentId`, `depth`, and `role`; never prompts, paths, ownership tokens, or credentials.

## Terms deliberately not used

There is no orchestration-domain **Dispatcher**, adaptive queue, or runtime scheduler. The Orchestrator creates the plan and directly assigns workers. Existing host limits remain implementation constraints, not domain concepts.
