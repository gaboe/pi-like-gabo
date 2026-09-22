# Steering a live worker

`herdr agent prompt` is a write into a pane, and a write into a pane can go nowhere. A pane whose
agent died answers `agent_not_found` inside the task file only; an apostrophe truncates a
shell-quoted prompt; the first enter after a paste regularly does not register. One transcript
history of 125 started workers carried 28 `agent_not_found` results — one worker in four.

Move the payload to disk and leave the pane a **doorbell**. The file is the delivery; the pane only
says a file arrived.

## Layout

One directory per worker, outside every git worktree so no steer can be committed by accident:

```
<driver-scratchpad>/steer/<agent-name>/001.md
<driver-scratchpad>/steer/<agent-name>/handled/
```

Numbers only ever go up, and allocation scans both the inbox and `handled/`, so one instruction is
processed at most once per worker.

## Seed

The worker cannot infer this from the driver's skill. Put it in the seed verbatim:

```text
Steering inbox: <inbox-path>
At the start of every turn, and whenever a [steer] line appears, list that directory. Read the
lowest-numbered file, do what it says, then `mv` it into handled/. That move is your
acknowledgement — nothing else reports that you took the instruction.
```

## Send

Write the file first, then ring:

```bash
herdr agent prompt <agent-name> "[steer] new instruction in your inbox; read it"
```

The line is constant and carries no payload, so ringing again is free and a duplicate is a no-op:
the worker finds the inbox empty or the message already in `handled/`.

## Read the acknowledgement

`ls <inbox>` is the whole check. In that same history `herdr agent read` averaged 2759 characters per
call; a directory listing is a line.

- inbox empty — delivered and acted on;
- message present, status `working` — mid-turn, wait one monitor window;
- message present after two monitor windows, status `idle` — the doorbell was swallowed, ring again;
- message present after a third ring, or `agent_not_found` — the worker is gone. Read the work record,
  then decide relaunch or successor.

Keep an unhandled message where it is until the worker takes it or you retire the worker: it is the
only record that the instruction was never received.
