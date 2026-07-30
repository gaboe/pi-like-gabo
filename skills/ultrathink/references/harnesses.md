# Ultrathink harness mappings

Load only the active host section. Evidence and completion gates remain identical across hosts.

## Pi

- Native worker: `subagent_spawn`; durable phases: `todo`; long-running checks: `jobs`.
- Current in-process spawn schema has no `harness` selector. Never pass `harness`, `agent`, or `backend`.
- Route focused verification/scouting to Luna low/medium, bounded implementation to Terra low, synthesis/planning to Sol medium, and consequential security/concurrency/money/migration work to Sol high. Use xhigh only after documenting why high was insufficient; never select max automatically.
- Package workers return `package_handoff`. Parent retains semantic acceptance, approvals, Git, and external mutations.

## Codex

- First-class adapter: use `harness: "codex"` only when exposed by the active spawn schema.
- CLI fallback: `codex exec -C "$ROOT" -m <model> -s read-only -c 'model_reasoning_effort="<level>"' --json -o "$OUT" "$PROMPT"`; use `workspace-write` only for authorized local implementation.
- Route bounded lookup to `gpt-5.6-luna`, implementation/review to `gpt-5.6-terra`, and complex reasoning to `gpt-5.6-sol`; effort `low|medium|high|xhigh`.
- Preserve JSONL `thread_id` for resume. Default wall-clock cap: 15 minutes review, 45 minutes implementation.

## Claude Code

- First-class adapter: use `harness: "claude"` only when exposed by the active spawn schema.
- CLI fallback: from the target worktree run `claude -p --permission-mode plan --model opus --effort <level> --output-format json --session-id "$SID" "$PROMPT"`; use `acceptEdits` only for authorized local implementation.
- Effort is `low|medium|high|xhigh|max`; never choose `max` automatically. Resume with `claude --resume "$SID" -p ...`.
- Default wall-clock cap: 15 minutes review, 45 minutes implementation; account for Agent SDK/API credit consumption.
