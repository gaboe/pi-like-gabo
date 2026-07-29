---
name: subagents
description: invoke this skill when the user asks you to use subagents
---

# Subagents

Each subagent is headless, has its own context window, cannot see the parent conversation, and cannot ask the user. Ordinary children cannot orchestrate, spawn subagents, or run workflows. Give every child a self-contained prompt with paths, constraints, and the expected report.

Root Pi Package Workers using `output_contract: "package_handoff"` are the only exception: parent manager injects sequential `package_worker_spawn` for depth-one `reviewer`, `verifier`, or `finding-fixer` workers. Call it before root bash: observed bash permanently taints that process/workspace because detached descendants cannot be proven gone. Finding-fixer acquires a process-global canonical-root mutation lease before backend spawn; overlapping workers/tools block acquisition, and overlapping main/Pi write/edit/bash or new workers are denied while held. Its Package Worker ancestor is the sole exemption because sequential spawn blocks the parent until the child settles. Root terminal paths drain all descendants before publishing or releasing root capacity, delegation, and workspace state. Cancel/error/dispose/reconciliation completion release the lease. Those workers cannot nest or orchestrate. Nested workers receive no shell: every file read uses the native descriptor-safe reader, while finding-fixers use leased native edit/write. Missing native helper fails all nested file access closed. Safe-writer rechecks staged and published type, link count, and bytes around publication. Pi revalidates authority synchronously at each native read/edit/write boundary, preventing new plugin-mediated operations after revocation; this is not OS isolation and cannot recall work already handed to the platform. Pi nested-worker attempts beyond depth one are rejected. External/pre-extension processes remain outside plugin coordination.

## Pi subagents

**Default:** Pi in-process sessions inherit parent model and thinking when omitted.

Do not use models from the Anthropic provider even if one appears in the model list.

Use only exact Pi provider/model IDs:

| Model                        | Recommended use and effort                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `openai-codex/gpt-5.6-luna`  | focused scout/verifier `low`; broad exploration `medium`                                     |
| `openai-codex/gpt-5.6-terra` | bounded, multi-file, or root-cause implementation `low`                                      |
| `openai-codex/gpt-5.6-sol`   | routine review `low`; planning or complex synthesis `medium`; risk-triggered analysis `high`; genuinely difficult work may justify `xhigh` |

For orchestrated work, always set model and effort explicitly. Omission inherits the parent and can accidentally fan out `high` or `xhigh` to routine workers.

**Thinking budgets:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. These map directly to pi thinking levels.

## Spawn and Manage

Call `subagent_spawn` with a complete `prompt`, short `name`, optional `working_dir`, `model`, and `reasoning_effort`. At most four subagents run concurrently. Safe same-TODO Package Worker calls may be batched: assignment handshakes queue FIFO, then authorized workers run concurrently.

Set `max_turns` from an explicit estimate of orientation, work, focused verification, and handoff. Use 8–12 only for narrow mechanical scouts, 16–24 for broad review/planning, 24–32 for focused implementation, and 32–48 only for cohesive multi-file/root-cause work. Reserve the final two turns for reporting; split the assignment if it does not fit. Every Pi worker receives its total budget in the initial prompt. Ordinary workers also receive a near-limit finalization warning; Package Workers retain their dedicated handoff/correction path without competing queued guidance.

If bounded remaining work needs more turns, the worker settles before its reserve with `status: "partial"`, exact `budget_request: { additional_turns, reason }`, and non-empty `remaining_work`. The parent independently decides whether the request is justified. Approve it only by sending the exact requested `additional_turns`; one extension is allowed, nested workers cannot extend, and total `max_turns` remains at most 48. Hard-limit failures cannot be revived.

- `subagent_send({ id, message, additional_turns? })`: steer a running worker or continue an eligible settled worker in the same session. For semantic Package Worker deficiencies, send precise corrections to that worker; do not spawn a replacement or implement its package in the parent while ownership and budget remain valid.
- `subagent_check({ id })`: peek without blocking.
- `subagent_list()`: list all runs.
- `subagent_wait({ ids })`: block only when results are required to proceed.
- `subagent_cancel({ ids })`: stop runs while preserving partial transcripts.
- `/subagents`: inspect or take over a run interactively.

Results return automatically. After spawning, continue useful parent work instead of immediately waiting.
