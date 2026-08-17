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

## Profiles

`luna` — Codex at high reasoning. The default and, so far, the only profile worth the pane:

```bash
herdr agent start luna --kind codex --pane <pane-id> --timeout 60000 -- -c model_reasoning_effort="high"
```

Split a pane first (right for a wide caller, down for a narrow one), pass `--no-focus`, and pass the
caller's `$PWD` as `--cwd` so the worker lands in the same tree.

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

Require one short markdown file per task, in a directory the repo already ignores, named
`<date>-<slug>.md`. Fixed headings, terse, under a screen. You read one file instead of running six
commands, and the reasoning behind a decision outlives the chat log:

```markdown
# <task>     <commit sha | staged: <paths> | uncommitted>

## Did
- one line per change, with the file it touched

## Verified
- <claim> — `<command>` → <decisive output line>

## Not verified
- <what, and what it would take>

## Numbers
- <figure> — `<command that measured it>`

## Decided
- <choice> over <alternative>, because <reason>

## Blocked
- <what needs the real world, a human, or another decision>
```

Every Verified line carries its command; a claim without one belongs under Not verified. **Not
verified always has content** — it is the highest-value section and the first a worker drops.
Decided carries the rejected alternative, or the decision reopens in a month. The header states
staged versus committed, because a change held back pending a real-world test is a different thing
from one that landed and a reader cannot tell from the diff.

The record says where to look. It is not itself evidence.

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

Close the panes and agents you created once their work is done. Leave alone the ones you did not.
