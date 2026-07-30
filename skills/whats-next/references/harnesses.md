# What's Next harness mappings

Load only the active host section. Fresh durable state and fail-closed completion are mandatory everywhere.

## Pi

- `/whats-next` extension command is the preferred runtime path.
- Reviewer: one tool-free Terra child, low effort, `maxTurns: 1`, bounded timeout, no extensions.
- Durable state: complete `todo` snapshot before review and a fresh reread afterward.
- Material findings: exactly one explanatory `ask_user` multi-select parent follow-up.
- Current in-process spawn schema has no `harness` selector; never pass one.

## Codex

- First-class adapter: use one tool-free child with `harness: "codex"` only when exposed by the active spawn schema; select its bounded review model and low effort.
- CLI fallback: `codex exec -C "$ROOT" -m gpt-5.6-terra -s read-only -c 'model_reasoning_effort="low"' --json -o "$OUT" "$PROMPT"`, with a 15-minute hard cap and non-empty prompt guard.
- Parse only the final structured result, then reread native durable task state. Use native decision UI when available; otherwise ask once in text.

## Claude Code

- First-class adapter: use one tool-free child with `harness: "claude"` only when exposed by the active spawn schema; select its bounded review model and low effort.
- CLI fallback: from the target worktree run `claude -p --permission-mode plan --model opus --effort low --output-format json --session-id "$SID" "$PROMPT"`, with a 15-minute hard cap.
- Parse `.result`, then reread native durable task state. Use native decision UI when available; otherwise ask once in text.
