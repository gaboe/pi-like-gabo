# The work record

What a worker writes down so the driver reads one file instead of running six commands, and so the
reasoning behind a decision outlives the chat log. Required with every task.

One short markdown file per task, in a directory the repo already ignores, named `<date>-<slug>.md`.
Fixed headings, terse, under a screen.

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

## Remember
- <lesson that outlives this task, or drop the section>
```

Every Verified line carries its command; a claim without one belongs under Not verified.

**Not verified always has content.** It is the highest-value section and the first a worker drops.

Decided carries the rejected alternative, or the decision reopens in a month.

Remember holds what the next task needs, not this one's outcome — a gotcha, a convention the code does
not state, a path that cost an hour to find. The worker proposes; the driver decides what survives and
writes its own summary, because pasting the worker's wording into durable memory imports its framing
with it.

The header states staged versus committed, because a change held back pending a real-world test is a
different thing from one that landed, and a reader cannot tell from the diff.

Growing past a screen means the task was too big — split the next one.

The record says where to look. It is not itself evidence.
