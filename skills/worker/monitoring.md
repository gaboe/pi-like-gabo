# Worker monitoring

A **monitor** is a host-harness capability that runs one bounded Herdr wait and wakes the driver when the worker settles, blocks, fails, or reaches the deadline.

## Host adapter

Use the current harness primitive:

- Pi: background `jobs` command around `herdr agent prompt ... --wait` or `herdr agent wait ...`; link the owning TODO as `waiting:jobs` when available.
- Claude Code: background Bash/task with completion notification and captured output.
- Other harness: managed background process, task, or future with completion notification.
- No background primitive: one bounded foreground Herdr `--wait` call.

Completion criterion: the driver receives one terminal monitor event with captured output or artifact location. A sleep-and-poll loop does not meet it.

## Worker state

Monitor state and worker state are separate:

- wait timeout: wait window expired; worker may still run;
- `working`: start one replacement bounded monitor;
- `idle` or `done`: worker settled and can accept related work;
- `blocked`: read the question or approval UI before input;
- `unknown`: inspect `agent get`, monitor output, and work record; terminal appearance is not evidence;
- `agent_not_found`: process or pane exited; inspect work record and monitor artifact before starting a same-kind successor.

After a timeout, run `herdr agent get <name>` and one bounded `herdr agent read <name>` exactly once. Then re-arm one monitor or handle the terminal state.

## Target and artifacts

Target the unique agent name. Model labels, pane titles, terminal IDs, and provider session IDs are not stable cross-harness targets.

On settlement, inspect in order:

1. required work record;
2. current diff/status;
3. decisive receipts;
4. recent pane output only when record and artifacts disagree or are missing.

Store terminal capture at a distinct `*-terminal-capture.txt` path. Reusing the worker artifact path destroys the evidence.

## Shared worktree

A read-only reviewer and writing worker may share a worktree only when reviewer scope is pinned to an immutable snapshot. Otherwise settle reviewer first. Completion criterion: reviewer range remains identical to the range named in its verdict.
