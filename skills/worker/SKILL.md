---
name: worker
description: Drive a coding agent as a long-running implementation worker in a Herdr pane, and review its claims against receipts.
argument-hint: "Worker profile (luna) and the task, or empty to continue an existing worker"
disable-model-invocation: true
---

# worker

The worker keeps the keyboard; you keep the judgement. It writes the code, you decide what is true.

**Delegate for cost.** A worker in a Herdr pane is cheap where you are expensive: it grinds through
the long build-test-fix loops on its own context and its own subscription, while your window stays
free for decisions, and Herdr keeps it observable — panes, lifecycle states, prompt-and-wait — so
cheap does not mean blind. That economics sets the allocation: hand over the work measured in files
touched and iterations survived; keep what is measured in judgement calls.

`orchestrator` owns the **seed contract** — budgets, phases, scope, permissions — and applies here
unchanged. This skill owns the other half: what a worker must hand back, and how you check it.

Mechanics live in the `herdr` skill and in `herdr agent --help`. Read those for pane and agent
commands rather than a copy here.

The bar: every claim you pass to the user carries a receipt you re-ran yourself, and every number in
it was measured at the moment you wrote it.

## Profiles

`luna` — Codex at high reasoning. The default and, so far, the only profile worth the pane:

```bash
herdr agent start luna --kind codex --pane <pane-id> --timeout 60000 -- \
  -m gpt-5.6-luna -c model_reasoning_effort="high"
```

**A codex pane that reasons but never runs a command has a broken install, not a bad seed.** Every
shell call in the TUI goes through a separate `codex-code-mode-host` binary beside `codex` in the
Caskroom, and an interrupted upgrade can leave it missing while `codex --version` answers happily.
The worker then starts, reads its seed, thinks about it, and fails *before execution* on every
command, reporting only that the runner is unavailable. Check for the binary:

```bash
ls /opt/homebrew/Caskroom/codex/*/bin/
```

Two files, or the pane is dead on arrival. `brew reinstall --cask codex` restores it and does not
kill agents already holding panes — running processes keep their open handles. Do not reach for
`-c features.code_mode_host=false`: it works in `codex exec` but the TUI refuses shell outright
without the host, so it turns a fixable install into a permanently mute worker.

**Always pass `-m` explicitly.** Without it the model comes from `~/.codex/config.toml`, which is a
global the worker does not control and which changes for reasons that have nothing to do with this
task — so a pane you believed was luna can quietly be something else, and the report reads the same
either way. The profile name in this skill means nothing unless the flag pins it. The same applies
to `-c model_reasoning_effort`: that config sets `xhigh` today, so passing `high` is a real override
and not a restatement of the default. Pin both, and the pane is what the name says it is.

Split a pane first (right for a wide caller, down for a narrow one), pass `--no-focus`, and set the
worker's directory with `--cwd` on `herdr pane split`. `agent start` has no such flag and answers
`unknown option: --cwd`.

**Start the worker in the root repository, never in a child checkout.** In a meta-repo the work lands
in the submodules, but the root is where it is *seen*: from `nexus/` one worker reads `nexus-be/` and
`docs/` in a single tree, the root skills and permissions apply, and `git status` shows the submodule
pointers its commits are about to move. Started inside `docs/`, that same worker holds one repository,
reaches its sibling only through `../`, and its git commands land in the submodule while the pointer
bump they imply stays invisible. Hand it the root as `--cwd` and let it `cd` into the submodule
itself.

**Name every worker `<profile>-<role>`.** Herdr requires the name to be unique among live agents, and
a bare `luna` blocks the second one you want — so `luna-docs`, `luna-fix`, `luna-review`. The profile
says which model is behind it and the role says what it is for, which makes `herdr agent list`
self-describing when five panes are open and turns every later command into the obvious one:
`herdr agent prompt luna-fix …` needs no lookup. Names match `[a-z][a-z0-9_-]{0,31}`, follow the pane
occupant, and free up when that agent exits, so a role name is reusable for its successor.

Gabo's read on the alternatives, which no `--help` will tell you: sol and terra do not suit worker
duty. Grok is a valid `--kind` and could take a pane, but has no sub-agents, so it cannot fan out
underneath itself. Add a profile here when one earns it.

Prompts run for minutes, so send them backgrounded with `--wait` and let the harness wake you. A
completion notification means the agent settled — a separate claim from the work being right, and
only one of those is yours to make.

`herdr agent prompt <target> <text>` takes the prompt as a positional argument; there is no
`--file`, and passing one exits 0 after printing `unknown option: --file`, so a seed that never
reached the pane looks exactly like one that did. A long seed goes in as `"$(cat seed.txt)"`. To
wait, `herdr agent wait <name> --until idle --until blocked` is the primitive — do not build a
sleep-and-poll loop beside it.

**Herdr reports failure through exit 0.** The `--file` case above, and `agent wait` answering
`{"error":{"code":"agent_not_running"}}` when the pane died under it, both look like success to a
shell that checks status. Parse the JSON, do not trust the code.

There is no `agent stop`. Ending one means quitting the program in its pane — `herdr pane send-text
<pane> "/quit"` then `herdr agent send-keys <name> enter` — and the first `enter` after a
`send-text` regularly does not register, so send it again and confirm the agent is gone from `agent
list` rather than assuming. Names free up only once it is.

**Confirm the worker ran a command before you believe it is working.** `agent_status: working` means
the program is busy, not that its tools function; the missing-host failure above sat in `working`
for its whole life. One `pane read` a minute in, looking for real command output rather than
reasoning prose, separates a worker from a worker-shaped stall.

## Reply path

Resolve your live Herdr agent name from `herdr agent list` by matching `$HERDR_PANE_ID`; never guess
it from model or role. End every prompt to a worker with this exact footer:

```text
Reply-to: <driver-agent-name>
```

Put the callback rule below in the seed itself; the worker cannot infer it from this driver-side
skill. When work reaches `done`, `partial`, `blocked`, or `failed`, the worker sends one asynchronous
result prompt to that reply target before settling:

```bash
herdr agent prompt <driver-agent-name> "[worker-result]
worker: <worker-agent-name>
status: <done|partial|blocked|failed>
summary: <outcome or blocker>
work-record: <path>
verified: <decisive receipt or not verified>
Reply-to: <worker-agent-name>"
```

Use no `--wait`: this is a handoff notification, not worker acceptance of the orchestrator's next
turn. The result prompt supplements the required work record; it does not replace receipts or the
driver's gate.

## Monitor Herdr workers

A **monitor** is the current host harness's background wait-and-wake capability, not a named tool.
Run each long Herdr prompt under one bounded monitor. When the harness has no background primitive,
use one bounded foreground `herdr --wait`; never replace wake-up with a sleep-and-poll loop.

Target the unique Herdr agent name. This process is the same when driver or worker is Pi, Claude Code,
Codex, or another recognized kind.

Completion criterion: the harness wakes the driver with a terminal monitor event and captured output
or artifact location. Then inspect work record, current diff, and decisive receipts before accepting
the worker's claims.

**`idle` right after a dispatch means the prompt never ran.** `agent prompt` pastes the text and the
first enter after a paste regularly does not register, so the pane sits on `[Pasted Content N chars]`
with the agent `idle` — and a monitor that treats `idle` as terminal fires within the minute and reads
as "finished". Require the status to reach `working` once before you accept `idle` as done, and when
`idle` arrives that fast, read the pane instead of the report. `herdr agent send-keys <name> enter`,
twice, submits what is sitting there.

A monitor also earns a **stall** branch: while the status says `working`, compare the pane's output
size between polls and report when it has not moved for ten minutes. That is the shape that catches a
worker which reasons but never executes — the missing `codex-code-mode-host` failure above sits in
`working` for its whole life.

For harness adapters, timeout recovery, `blocked`/`unknown`/`agent_not_found`, artifact capture, or a
reviewer sharing the worktree, read [monitoring.md](monitoring.md).

## Receipts

**A claim without a receipt is a claim.** A receipt is the command plus the decisive line of its
output: the run directory listing, the row count, the log line, the binary actually running.

Ask for receipts, and re-run the ones that matter. The gap between a worker's report and its
artifacts is where the expensive findings live:

- A spike reported as passing had proven nothing — the test lacked a second participant, so the
  question it existed to answer was never exercised.
- A recording pipeline reported `finished` on every successful run while archiving the wrong
  artefact, because an empty end-of-stream marker was counted as a missing chunk.

Neither was visible in what the worker said. Both were visible in the run directory. When report and
artifact disagree, the artifact wins — and send back the evidence, not the verdict: the log line, the
counts, the diff.

**Re-measure every number before stating it, or label it unverified.** Numbers are the part of a
report that gets invented, because they look like evidence whether or not anyone counted. This binds
hardest on figures you produced yourself earlier: an estimate repeated often enough starts reading
like a measurement. One that was 900 MB by reasoning measured 135 MB, because the data was
speech-gated and nobody had checked.

## Vacuous passes

A gate is a filter, not an oracle. Require one — `./check.sh`, `cargo test` — before every commit,
and keep asking what it does not cover.

A **vacuous** pass is green and empty: a suite whose input was absent, so three tests returned early
and reported success; a path no real run takes. It looks identical to success and reads as proof. The
tell is usually a number beside the result — a suite finishing in a tenth of the expected time, a
count of zero where the fixture has rows.

When a gate goes green on a change you expected to be hard, look closer.

## The work record

Seeding a worker means requiring its work record: read
[`work-record.md`](work-record.md) for the headings and the rules behind them. Every task hands one
back, or you are reconstructing state by hand next round.

## Shared tree

The worker has the tree open while you work in it, so:

- Stage explicit paths. `git add -A` sweeps the worker's half-finished edits into your commit under
  your message.
- Read `git status --short` before editing. A file in the worker's modified set gets dispatched, not
  edited.
- Leave shared history alone while another agent holds the tree.
- After a safe edit — a file the worker is not touching — say what you changed and whether you
  rebuilt, so it is not fixed twice.
- Require split commits: a verified change and an unverified one together means neither reverts
  cleanly.

## Correction

You will hand a worker a wrong premise. An agent told to fix a bug finds something to change whether
or not the bug exists, so retract explicitly: name the part withdrawn, the part that still stands,
and why.

**Quote the decision record; do not paraphrase it into the seed.** A seed written from memory of a
decision drifts from it, and the worker implements the drift faithfully — one paraphrase of "a null
projection returns 404" as "returns the row" cost a full round plus a hand-rolled type to make the
wrong behaviour work. Paste the sentence from the ledger or ADR that decides the point.

**Diff the seed against what you told the user it contains.** Announcing a five-item round and
dispatching four is invisible until a review pass finds the fifth item unimplemented, and by then it
reads as the worker's omission rather than yours.

Keep any instrumentation that earned its place on its own. It is usually the thing that would have
caught the wrong premise first — after a diagnosis-by-guesswork round, the diag output that settled
it in one line was worth more than the fix.

## Evidence over assurance

Ask for the shape of the answer, not for reassurance. "Run these variants on this recording, lay the
same span side by side, report wall-clock each, and say which you would ship" beats "make it better".

- Ground truth absent means no error rate. Say so instead of producing a number.
- Ask what was **not** verified. That answer is where the next bug is.
- Hand over a hypothesis to be disproved, not confirmed.

## Continuing, and knowing when to stop

Accumulated context is the expensive part, so **related work continues in the same worker** — the one
that just fixed the window planner already knows why the windows are measured in audio seconds. Reuse
the name and keep going.

**Unrelated work gets a new agent.** A worker holding a hundred thousand tokens about one subsystem is
worse than empty for a different problem: you pay for all of it on every turn, and it carries
assumptions from the old task into the new one, confidently. When the subject genuinely changes, close
that worker and start a fresh one. The test is whether the accumulated context would be *evidence* or
*noise* for what comes next.

**Run several at once when the work is genuinely parallel.** Separate subsystems, separate panes,
separate names — `luna-ingest` and `luna-tui` do not need to wait for each other. What they must not
share is a file: overlapping scopes in one tree produce two workers reverting each other, so give each
one an explicit set of paths and keep those sets disjoint. Where they cannot be, sequence the work
instead of parallelising it.

Close the panes and agents you created once their work is done.

**Sweep idle panes as part of every gate, not once at the end.** After each result you accept, ask
of every idle agent: is there a next task where its accumulated context is *evidence*, or would it
be *noise*? Keep the ones whose subsystem still has work — the agent that just moved six vias
should move the other three. Close the rest. An agent whose subsystem is finished is not free to
keep: it holds a unique name you may want, occupies a pane, and invites the mistake of handing it
unrelated work because it happens to be idle.

A rough rule that has held: keep at most one idle agent per live subsystem, and close any agent
whose deliverable you have already gated and committed.

Closing is a two-step with a confirmation, because there is no `agent stop`:

```bash
herdr pane send-text <pane-id> "/quit"
herdr agent send-keys <name> enter      # the first enter after send-text often does not register
herdr agent send-keys <name> enter      # so send it again
herdr agent list                        # confirm the name is GONE, do not assume
```

The name frees only once the agent has actually left `agent list`. If it is still there, the pane
is still occupied and `agent start` with that name will fail.
