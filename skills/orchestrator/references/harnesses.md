# Orchestrator harness mappings

Load only the active host section. Capability detection overrides examples.

## Pi

- Native worker: `subagent_spawn`; continuation/steering: `subagent_send`; collection: completion notifications or `subagent_wait` when needed.
- Durable state: `todo`; bounded monitor: `jobs`; decision UI: `ask_user`.
- Current in-process spawn schema has no `harness` selector. Never pass `harness`, `agent`, or `backend`.
- Model: use Luna for scouts, deterministic verification, and precisely scoped low-risk implementation with an existing pattern and deterministic check; Terra for ambiguous root causes, domain decisions, or broad/coupled implementation; Sol for review, synthesis, and consequential risk.
- Effort: choose independently—low for mechanical work, medium for multi-step reasoning, high only for genuinely difficult bounded work, and xhigh only after documented high-effort insufficiency. Capability detection overrides these examples.
- Turn budgets: 8–12 narrow scout, 16–24 broad review/planning, 24–32 implementation, 32–48 only for one justified cohesive package. Reserve final two turns for handoff.
- Package workers use `package_handoff`; parent owns semantic acceptance and Git/external mutations.

## Codex

- First-class adapter: pass `harness: "codex"` only when the active spawn schema exposes it; use that schema's lifecycle tools and model ids.
- CLI fallback from another host: run `codex exec -C "$ROOT" -m <model> -s read-only -c 'model_reasoning_effort="<level>"' --json -o "$OUT" "$PROMPT"` in a background process. Require a non-empty prompt. Use `-s workspace-write` only for explicitly authorized local edits.
- CLI models: `gpt-5.6-luna` for bounded lookup, `gpt-5.6-terra` for implementation/review, `gpt-5.6-sol` for complex reasoning; effort `low|medium|high|xhigh`.
- Persist the JSONL `thread_id`; resume with `codex exec ... resume <thread_id>`. Treat `turn.completed` as completion and `turn.failed` as failure.
- Wall-clock defaults: 15 minutes review/analysis, 45 minutes implementation. Parent enforces timeout and approval boundaries.

## Claude Code

- First-class adapter: pass `harness: "claude"` only when the active spawn schema exposes it; use that schema's lifecycle tools and model ids.
- CLI fallback from another host: in the target worktree run `claude -p --permission-mode plan --model opus --effort <level> --output-format json --session-id "$SID" "$PROMPT"` in a background process. Use `--permission-mode acceptEdits` only for explicitly authorized local edits.
- Effort: `low|medium|high|xhigh|max`; never choose `max` automatically. Answer is `.result` in the JSON; resume with `claude --resume "$SID" -p --permission-mode plan --output-format json "$DELTA"`.
- Wall-clock defaults: 15 minutes review/analysis, 45 minutes implementation. Parent enforces timeout, credit awareness, and approval boundaries.
