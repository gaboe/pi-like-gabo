# Herdr compatibility surface

This document maps the Pi-package surfaces that matter when this package runs inside a Herdr pane. `package.json#pi.extensions` is the authoritative extension inventory and load order.

## Supported baseline

- Node.js: `>=22.19.0`
- Pi APIs: `0.82.x` (`@earendil-works/pi-coding-agent`, `pi-ai`, and `pi-tui`)
- Package shape: 29 ordered extensions, 7 skills, and 1 theme
- Tested local Herdr pairing: Herdr 0.8.0, Pi integration v8, Pi 0.82.1

Herdr's managed `herdr-agent-state.ts` extension is separate from this package. It is enabled only when `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID` are present. It reports the root TUI session through `session_start`, `agent_start`, and `agent_settled`; no package extension should duplicate that socket protocol.

## Authoritative Herdr requirements

The installed CLI and managed integration are the authority for this assessment:

- `~/.agents/skills/herdr/SKILL.md` defines caller context, targeting, terminal ownership, and safety rules.
- `~/.pi/agent/extensions/herdr-agent-state.ts` is the installed Pi integration v8 and defines the event/socket contract.
- `herdr integration status` reports Pi integration v8 as current.

| Requirement | Herdr contract | Package implication |
| --- | --- | --- |
| Activation | `HERDR_ENV=1` plus non-empty `HERDR_SOCKET_PATH` and `HERDR_PANE_ID` | Package behavior must remain unchanged when any value is absent. |
| Mode | Only root `ctx.mode === "tui"` sessions are reportable; `hasUI` is insufficient | TUI adapters must gate on `mode`, not generic UI availability. |
| Session identity | Absolute session file is preferred; session ID is fallback | Session reload/compaction must keep Pi's session manager available to the managed integration. |
| Lifecycle | `session_start` reports identity; `agent_start` means `working`; idle `agent_settled` means `idle` | Package-generated follow-up turns must use normal Pi lifecycle instead of custom state spoofing. |
| Blocked state | Reference-counted `herdr:blocked` events, `{active, label?}` | Every active interactive wait must emit exactly one inactive event in `finally`. Nested waits are supported. |
| Transport | Newline-delimited JSON requests over Herdr's Unix socket/Windows named pipe, 500 ms then 1500 ms attempt | The package must not open, cache, close, or retry this socket itself. |
| Terminal persistence | Herdr owns persistent PTY panes and accepts interactive input through `pane`/`agent` commands | Package background processes must not assume a PTY or interactive stdin and must not kill the pane. |
| Targeting | Use `--current`, explicit opaque pane ID, or unique live agent name | Never infer pane IDs or act on the UI-focused pane from plugin code. |
| State vocabulary | `working`, `blocked`, `idle`; Herdr derives user-facing `done`/`unknown` detection semantics | Fleet status names cannot be passed through without an explicit mapping. |

## Ordered extension inventory

| Order | Entry point | Integration surface |
| ---: | --- | --- |
| 1 | `extensions/permissions/index.ts` | Observes `tool_call`; emits `permissions:audit`; never blocks calls. |
| 2 | `extensions/telemetry/index.ts` | Subscribes to the package telemetry channel and writes bounded local JSONL. |
| 3 | `extensions/automation-pause/index.ts` | TUI terminal-input listener; double-Escape pause/abort protocol. |
| 4 | `extensions/multi-skills/index.ts` | Input expansion, autocomplete provider, commands, and editor widget. |
| 5–13 | `btw`, `comment-checker`, `thinking-shortcuts`, `ultrathink`, `whats-next`, `compact-tools`, `rtk`, `decision-guidance`, `shared-memory` | Prompt/input transforms, tool hooks, custom messages, rendering, and session-local/shared state. External command and message names are compatibility contracts. |
| 14 | `pi-caveman` | Commit-pinned third-party extension. |
| 15 | `vendor/pi-tools/extensions/ask-user/index.ts` | TUI confirmation/selection overlay and `ask_user` tool. Relevant to Herdr's blocked state. |
| 16 | `vendor/pi-tools/extensions/background-terminals/index.ts` | Owns tracked background command processes and cleanup. |
| 17 | `extensions/jobs/index.ts` | Persistent command/WebSocket/poll jobs, network approval UI, lifecycle events, and follow-up delivery. |
| 18 | `extensions/todo/index.ts` | Durable task state, automatic continuation, agent lifecycle hooks, and orchestration ownership gates. |
| 19–26 | `copy-all`, `file-search`, `firecrawl-search`, `model-info`, `subagents`, `summaries`, `ui-customization`, `workflows` | Vendored tools/TUI plus subagent and workflow runtimes. Tool names and package-worker schemas are public contracts. |
| 27 | `extensions/fleet/index.ts` | TUI-only fleet overlay over the shared versioned fleet protocol. |
| 28 | `extensions/pi-doctor/index.ts` | TUI capability-report overlay and `/pi-doctor` commands. |
| 29 | `pi-lens` | Commit-pinned diagnostics/code-intelligence extension. |

Changing this order can change listener precedence, input handling, and shared-event behavior.

## Compatibility-sensitive contracts

### Agent and session lifecycle

The package and Herdr both observe Pi lifecycle events. The package must preserve Pi's semantics for:

- `session_start`, `session_compact`, `session_tree`, and `session_shutdown`
- `agent_start`, `agent_end`, and `agent_settled`
- stale `ExtensionContext` proxies during compaction/reload

`extensions/todo/index.ts` schedules work after `agent_settled`. Its `sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` calls legitimately start another turn, so Herdr should continue to report `working` until the automation settles.

### Blocked state

Herdr integration v8 accepts the shared event:

```ts
pi.events.emit("herdr:blocked", { active: true, label: "Waiting for approval" });
pi.events.emit("herdr:blocked", { active: false });
```

The package emits this event around `ask_user` and jobs network-scope confirmation, balancing every active event with an inactive event through cancellation and errors. Durable TODO `waiting:user` state alone does not emit it because no interactive overlay is necessarily open.

### Terminal input and overlays

- `automation-pause` subscribes with `ctx.ui.onTerminalInput`; it consumes Escape only for its documented active-automation cases.
- `fleet` subscribes only in `ctx.mode === "tui"`, ignores non-empty prompts and non-editor focus, and disposes its listener/widget/timer on shutdown.
- `pi-doctor`, `ask_user`, jobs approval, and other custom overlays own focus while open.

Herdr should continue to own the outer pane. Package code must not parse Herdr escape sequences, resize the pane, or assume that `ctx.hasUI` implies TUI mode. Use `ctx.mode === "tui"` for TUI-only behavior.

### Process ownership and API comparison

`background-terminals`, `jobs`, subagents, workflows, and Herdr can all have live processes, but ownership must remain distinct:

- Herdr owns pane/shell lifetime.
- Background-terminal and jobs backends own only processes they start and track.
- Session cleanup must not kill the Herdr pane or unrelated pane processes.
- A Herdr adapter must not replace existing job/subagent lifecycle protocols.

| Surface | Input model | Lifetime owner | Fleet compatibility |
| --- | --- | --- | --- |
| Herdr pane/agent | Interactive persistent PTY; CLI can send text/keys and read screen/scrollback | Herdr workspace/session | No native adapter; states and IDs differ from `FleetItem`. |
| `bg_*` background terminal | Command receives immediate stdin EOF; captured stdout/stderr; no interactive follow-up | Package background-terminal service | Existing package source, not a Herdr pane. |
| Jobs | Command/WebSocket/HTTP polling with durable state and bounded event delivery | Jobs manager/session cleanup | Existing `jobs` Fleet source. |
| Subagents/workflows | Pi-managed autonomous sessions with package protocols | Respective service/runtime | Existing versioned Fleet sources. |

Direct coexistence is therefore the correct architecture. Replacing `bg_*` or jobs with Herdr would change stdin, persistence, cleanup, and API semantics. A future Herdr Fleet adapter would need its own versioned source type, status mapping, read/open behavior, and read-only CLI discovery; the current `fleet:state:v1` union cannot accept it safely.

### Shared protocols and mutation ownership

Use the existing versioned fleet, job, telemetry, automation-pause, and subagent protocols. Preserve literal tool names, command names, event channels, custom message types, status/widget keys, and package-handoff fields. Add a new versioned channel when a schema must change.

TODO orchestration and package workers enforce workspace-mutation leases. Commands launched through Herdr must not bypass those guards or write concurrently to an owned package scope without an explicit ownership policy.

### Non-TUI operation

RPC, JSON, and print modes have no pane UI even when an API reports `hasUI=true`. TUI listeners, overlays, and Herdr state reporting must be gated by `ctx.mode === "tui"`; tools must degrade safely or reject interactive approval when no TUI exists.

## Current compatibility result

| Capability | Result |
| --- | --- |
| Coexist in one Pi TUI session | Compatible |
| Herdr `working` / `idle` reporting | Compatible through Herdr's managed extension |
| TODO/jobs automatic follow-ups | Compatible; each triggered turn is visible to Herdr lifecycle tracking |
| Terminal input and overlays | Compatible with focus/mode guards; preserve extension order |
| Herdr `blocked` reporting | Compatible for `ask_user` and jobs network approval |
| Durable TODO `waiting:user` reporting | Not emitted without an active interactive overlay |
| Show Herdr panes in Fleet | Not implemented; not required for coexistence |
| Replace package process managers with Herdr | Unsupported and not recommended |

## Gap and risk register

| Area | Compatibility / conflict | Risk | Smallest fix | Smallest verification |
| --- | --- | --- | --- | --- |
| Root lifecycle | Compatible: Herdr's managed extension independently observes normal Pi turns. | Low; custom follow-ups could regress if they bypass `triggerTurn`. | Keep TODO/jobs continuations on Pi's normal follow-up API. | Run one automatic continuation and observe `working` then settled state with `herdr agent explain`. |
| Interactive questions | Resolved: `ask_user` emits balanced reference-counted blocked events. | A missing inactive event would leave the pane permanently blocked. | Keep the wrapper's `finally`; do not emit from render callbacks. | Unit-test active/inactive order plus abort/error paths. |
| Jobs network approval | Resolved: confirmation emits balanced blocked events. | Same stuck-blocked risk; nested dialogs require balanced counts. | Keep one active/inactive pair around `ui.confirm`. | Add a focused approval harness covering accept, reject, and thrown UI errors. |
| Durable `waiting:user` | Intentional limitation: a stored task status is not necessarily a currently displayed prompt. | Herdr may show idle while durable work awaits a later user answer. | No fix unless a real persistent approval UI is introduced. | Confirm no synthetic blocked state survives after an overlay closes. |
| Escape handling | Potential input overlap: automation-pause observes raw terminal input inside Pi while Herdr owns the outer PTY. | Double-Escape behavior depends on Herdr forwarding raw Escape unchanged. | Do not add Herdr-specific key parsing; retain Pi focus/editor/automation guards. | Manual in-pane test: single Escape keeps Pi semantics; double Escape pauses only active automation; pane remains alive. |
| Process lifetime | Compatible by separation: Herdr owns panes; bg/jobs own child processes they start. | Duplicate cleanup or backend substitution could kill unrelated work or change stdin semantics. | Never select Herdr as a jobs backend from `HERDR_ENV`; kill only tracked IDs. | Start a tracked command, stop/shutdown Pi, and verify the Herdr shell pane survives. |
| Session shutdown | Package jobs are session-owned and disposed; Herdr pane is session-host-owned. | Assuming jobs survive Pi shutdown would lose durable runtime state or leak processes. | Document jobs as Pi-session-owned; use Herdr panes explicitly when persistence beyond Pi is desired. | Shutdown with one job and one separate Herdr pane command; verify only the job is disposed. |
| Fleet visibility | Intentional gap: Fleet v1 accepts only subagents, jobs, and workflows. | Extending the union in place would break protocol consumers; Herdr states do not map 1:1. | If requested, design `fleet:*:v2` plus a read-only Herdr source and explicit status/open mapping. | Contract tests for old/new consumers, opaque pane IDs, unavailable CLI, and moved panes. |
| Environment detection | Compatible without package guard: managed integration self-disables unless all Herdr variables exist. | Package-level behavior keyed only on `HERDR_ENV` could partially activate outside a usable session. | Avoid Herdr environment branching; event emission is harmless with no listener. | Run focused tests with no Herdr variables and with an event bus lacking a listener. |
| Non-TUI modes | Compatible when mode-gated. | RPC may expose `hasUI=true`, causing accidental terminal behavior. | Continue using `ctx.mode === "tui"` for terminal integrations. | Exercise print/JSON/RPC startup and verify no Herdr report or input listener. |

### Priority

1. **Required and implemented:** balanced blocked reporting for active `ask_user` and jobs approval UI.
2. **Required regression coverage:** approval rejection/error paths and manual Escape forwarding in a real Herdr pane.
3. **Documented behavior:** jobs remain Pi-session-owned; `HERDR_ENV` does not switch process backends.
4. **Optional feature:** Herdr panes in Fleet require a separately designed versioned protocol and are not a compatibility fix.

## Herdr pane smoke-test result

Current-pane test against Herdr 0.8.0 / Pi integration v8:

- `herdr pane send-keys <current> escape escape` reached Pi and aborted the active tool call; the Herdr pane survived and remained reportable/interactive.
- Sending two separate Escape commands 100 ms apart also left the pane alive.
- A deterministic retry waited until Herdr reported the pane `idle`, then sent two separate Escape inputs 100 ms apart while a disposable background terminal was active. The target was not paused or stopped; the monitor reached its explicit `double-escape-did-not-pause` failure marker after 30 seconds.
- Therefore **single Escape forwarding and pane survival are compatible, but double-Escape automation pause is not compatible through Herdr's CLI key injection path**. The user explicitly stated this functionality is not needed, so it is documented rather than fixed.
- All disposable test processes were stopped; no other pane or workspace was touched.

## Validation checklist

1. Validate against Pi 0.82.x before widening support.
2. Start Pi inside Herdr and confirm direct integration reports `working`, then `idle`.
3. Trigger TODO/jobs follow-up automation and confirm state remains `working` across turns.
4. Open and close Fleet, ask-user, jobs approval, and pi-doctor overlays; verify input/focus restoration.
5. Double-Escape active automation; verify only owned automation/processes stop and the Herdr pane survives.
6. Run focused blocked-event tests proving exactly one active/inactive pair for ask-user success and UI rejection, plus jobs approval rejection and UI rejection.
7. Manually verify Escape/abort/reload/shutdown interruption leaves no blocked count after the overlay closes.
8. Run focused tests for `automation-pause`, `fleet`, `jobs`, `todo`, and the Herdr adapter.
