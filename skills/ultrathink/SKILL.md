---
name: ultrathink
description: Opt-in adaptive evidence-complete mode for consequential coding, debugging, review, research, or design. Use only when the user explicitly invokes /ultrathink or $ultrathink, says ultra think, use every agent, investigate exhaustively, or asks for the strongest/deepest multi-agent pass. Never activate from task difficulty alone.
---

# Ultrathink

Produce the strongest proportionate answer or implementation supported by current evidence. Depth adapts to uncertainty and consequence; agent count does not define rigor.

## Activation and authority

- Explicit opt-in only. Never infer this mode because work looks difficult.
- Treat `/ultrathink <request>` or `$ultrathink <request>` as authorization for bounded local investigation, planning, implementation, and verification described by the request.
- With `/ultrathink` and no request, use only the active task from conversation context. Ask if no task is identifiable; never invent one.
- It is **not** approval to commit, push, publish, merge, deploy, change external systems, spend money, expose credentials, or perform any other approval-gated mutation. Parent retains user questions, approvals, semantic acceptance, integration, Git history, and external mutations.
- Use a workflow only when the user says `ultracode` or explicitly requests workflow execution and the host provides one. Otherwise use direct work plus the current harness's native planning, monitoring, and delegation capabilities as proportionate.

## Adaptive evidence plan

Before acting, identify the outcome, decisive claims, consequence of error, unknowns, current worktree/state, and smallest evidence that could confirm or falsify each claim.

### Trivial or readily reversible work

Do not manufacture ceremony. Inspect the current relevant source/state, gather minimal decisive evidence, perform the smallest faithful check, and add a quick independent sanity check. Independence may be a fresh deterministic calculation, a separate runtime probe, or one focused native verifier; fan-out, a dossier, and multiple agents are not mandatory. Stop when evidence covers the claim.

### Hard consequential technical work

Use 2–4 distinct lanes when their evidence can change the result, subject to a global four-worker cap and mutation conflicts. Prefer maximal coherent perspectives over file-sized tasks.

Resolve the harness once before spawning:

1. Use the host's native worker or installed delegation adapter.
2. Pass a named harness only when the active spawn schema exposes that selector.
3. Otherwise use the current host's native worker and never pass unsupported fields.
4. Use only models and effort levels exposed by the selected harness; never copy provider-specific model ids across harnesses.

After identifying the host, load [references/harnesses.md](references/harnesses.md) for concrete tool, model, and fallback mappings.

Typical lanes are authoritative source/documentation inspection, runtime or deterministic verification, implementation/synthesis, and independent adversarial review. Start safe read-only lanes in parallel. Serialize overlapping writes, shared worktree/ref mutations, and work whose premise is changing. More agents are not evidence by themselves, and duplicate generic reviews do not count as independent lanes.

For any open-source library research, implementation claim, history question, or source-backed comparison, load and follow the `librarian` skill. Require version or commit scope and stable full-SHA GitHub permalinks for source claims when available.

Prefer evidence in this order when applicable: current repository source and configuration, authoritative specifications or vendor documentation, reproducible runtime behavior, focused tests/checks, then secondary material. Inspect actual symbols, callers, boundaries, versions, and failure paths rather than relying on summaries. For implementation, inspect the current source and dirty state before editing, then verify the final current diff/state rather than a stale snapshot.

## Evidence ledger

Maintain a compact ledger for every decisive claim. It may live in the response, Package Handoff, or a task artifact when large.

| Decisive claim | Authoritative source or check | Independent verifier result | Disagreement and resolution | Residual uncertainty / confidence |
| --- | --- | --- | --- | --- |

A verifier must independently inspect or reproduce the evidence, not merely agree with the synthesis. Resolve disagreements using stronger source/runtime evidence or one focused tie-breaker, never majority vote. Preserve unresolved disagreement in the ledger.

Never claim literal 100% certainty or infallibility. If a decisive claim cannot be verified, name the missing evidence, lower confidence, and return a partial/qualified result rather than presenting it as complete.

## Execution discipline

1. Use the lightest plan that can satisfy the relevant completion gate. Hard consequential mutable work gets an evidence-backed preparation dossier and meaningful durable phases in the host's native plan/TODO mechanism; trivial work may proceed directly.
2. Give each lane a self-contained scope, permissions, stale conditions, done criteria, harness/model/effort, and explicit turn budget. Use native workers by default; cross-harness work goes through an installed delegation adapter or explicitly supported harness selector, never an improvised raw process when a first-class transport exists.
3. Estimate orientation, work, focused verification, and handoff. Keep trivial tasks small. Use 8–12 turns for narrow scouts, 16–24 for broad review/planning, 24–32 for focused implementation, and 32–48 only for one justified cohesive multi-file/root-cause package.
4. When the harness uses turn budgets, reserve the final two worker turns for verification summary and handoff. Before the reserve, a worker with bounded remaining work returns `partial` with exact `budget_request`, reason, and non-empty `remaining_work`. Approve at most one exact extension within that harness's cap. Never auto-extend, revive a hard-limit failure, or extend nested work.
5. Run checks. Put commands likely to exceed 30 seconds or repeated external waits in the host's bounded monitor, continue independent work, and rely on completion/wake events when supported. Do not poll a first-class monitor. Terminal evidence requires inspection.
6. Require independent adversarial review against the final current source/diff/state. Resolve findings or record them as residual risk.
7. When the host uses package workers, require its schema-valid handoff contract; mechanical validity is not semantic acceptance.

## Completion gates

### Analysis/research/design

Complete only when:

- scope and question are answered against current authoritative source/state;
- every decisive claim appears in the evidence ledger with a source/check and independent verifier result;
- material alternatives, failure modes, and disagreements are resolved by evidence or explicitly retained;
- recommendation states assumptions, residual uncertainty, confidence, and any approval still required;
- parent rechecks decisive evidence for freshness and semantically accepts the result.

If any decisive claim lacks obtainable verification, return a qualified partial analysis with exact missing evidence and consequence. Do not fill gaps with agent consensus.

### Implementation/debugging

Complete only when:

- current source, callers/boundaries, dirty state, and user-owned changes were inspected and preserved;
- final current diff/state satisfies each requested criterion and contains no unrelated mutation;
- smallest faithful focused checks pass, including runtime evidence where behavior depends on runtime state;
- independent adversarial review examines the final current diff/state and findings are fixed or recorded as blocking/residual risk;
- evidence ledger links each decisive behavior/correctness claim to its check and verifier result;
- parent inspects current source/diff/state, reruns or validates decisive checks, and semantically accepts the package.

A failed required check, stale review, unresolved blocking finding, or unverifiable decisive behavior means `partial`, `blocked`, or `failed`, never `done`.

## Explicit workflow shape

Only when workflow execution is explicitly authorized:

```text
prepare → parallel evidence lanes → bounded synthesis/implementation → independent adversarial verification → parent acceptance
```

Use structured schemas when later phases branch on results. Workflow children remain read-only for external systems. Return proposed external mutations to the parent for exact user approval.

## Stop conditions

Stop fan-out when the completion gate is met, evidence converges, budget is exhausted, a prerequisite is missing, mutation ownership conflicts, or only an approval-gated action remains. Report best verified partial evidence and residual uncertainty. Never spawn agents merely to appear thorough.
