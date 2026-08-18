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
```

Every Verified line carries its command; a claim without one belongs under Not verified.

**Not verified always has content.** It is the highest-value section and the first a worker drops.

Decided carries the rejected alternative, or the decision reopens in a month.

The header states staged versus committed, because a change held back pending a real-world test is a
different thing from one that landed, and a reader cannot tell from the diff.

Growing past a screen means the task was too big — split the next one.

The record says where to look. It is not itself evidence.
