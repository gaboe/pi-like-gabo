# Local telemetry

Metadata-only telemetry stays on this machine in `~/.pi/agent/telemetry/telemetry.jsonl`.

- Directory mode: `0700`; file mode: `0600`.
- Active file rotates at 1 MiB; four archives are retained.
- Writes are serialized, queue-bounded, and given 250 ms to drain at shutdown.
- Invalid events and all telemetry I/O failures are dropped without affecting Pi or producer extensions.

## Schema v1

Every line has `v`, ISO `ts`, and one event shape:

- `workflow_run`: `runId`, `phase`, `status`, `durationMs`, optional enum `errorCategory`.
- `workflow_agent`: run/agent IDs, `phase`, `status`, `turns`, `maxTurns`, `durationMs`, optional enum `errorCategory`.
- `job`: `jobId`, lifecycle `action`, `kind`, `status`, `attempt`, `durationMs`.
- `todo_state` / `todo_no_progress`: `taskId`, `status`.
- `background_terminal`: `terminalId`, `phase`, `status`, `durationMs`, optional enum `exitCategory`.

Consumer rebuilds each record from this allowlist. Prompts, questions, titles, tool arguments, commands, output, URLs, file paths, secrets, arbitrary errors, and unknown fields are never serialized.
