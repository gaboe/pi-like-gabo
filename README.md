# pi-like-gabo

Gabo's reviewed Pi extensions, skills, and orchestration tools.

## Requirements

- macOS or Linux
- Git
- Node.js and npm
- [Pi coding agent](https://github.com/earendil-works/pi-mono) compatible with the `0.82.x` APIs
- Node.js `>=22.19.0`
- Rust toolchain with Cargo, only for building the optional comment-checker binary
- [RTK](https://github.com/rtk-ai/rtk) in `PATH` for compact `bash` output (optional; hook disables itself when absent)

Windows is not currently supported by the setup scripts or comment-checker paths.

## Install

Install one reviewed, immutable `pi-like-gabo` revision globally:

```sh
pi install git:github.com/gaboe/pi-like-gabo@<reviewed-commit-sha>
```

That single package installs and loads its pinned `pi-lens`, `pi-caveman`, and runtime dependencies. Projects such as Nexus do not need their own `.pi/settings.json` package entry. Installing `pi-lens` separately would duplicate ownership and must be avoided.

For development from a local checkout instead:

```sh
git clone https://github.com/gaboe/pi-like-gabo.git
cd pi-like-gabo
npm ci
npm run setup:ben
npm run build:comment-checker
pi install "$PWD"
```

Package contents:

- `permissions`: observe-only central tool classifier and bounded redacted audit events; unknown tools classify as `unknown` and all calls continue unchanged
- `pi-doctor`: read-only `/pi-doctor` report (`/capabilities` alias) for registered capabilities, runtime probes, duplicate discovery, and optional pi-lens detection
- `telemetry`: private, rotating local JSONL containing allowlisted lifecycle metadata only; see [`extensions/telemetry/README.md`](extensions/telemetry/README.md)
- `multi-skills`: inline `$skill-name` expansion and discovery
- `todo`: persistent task tool, waiting states, `/todo add` capture with bounded background preparation, and liveness scheduler
- `jobs`: durable command/WebSocket/HTTP monitors linked to TODO wakeups
- `fleet`: unified below-editor navigation for live/recent subagents and workflow runs/agents
- `shared-memory`: bounded Markdown memory shared with Claude Code, including Nexus worktree canonicalization and compaction guidance
- `pi-orchestration`: required orchestration policy explaining how TODOs, jobs, workflows, subagents, and `grill-me` fit together
- `orchestrator`: opt-in driver role for durable TODO planning, bounded delegation, concurrency gates, and evidence-based integration; moved from Nexus so the plugin is canonical
- `ultrathink`: explicit `/ultrathink [task]` (or `$ultrathink`) mode for bounded multi-agent investigation, synthesis, implementation, and independent verification; without an argument it uses the current conversation task
- `whats-next`: portable `/whats-next [focus]` or `$whats-next` skill reviews completed work; Pi's command uses one tool-free Terra subagent and presents material next steps through an explanatory `ask_user` multi-select
- `librarian`: source-backed open-source research with full-SHA GitHub permalinks
- `thinking-shortcuts`: `Shift+Up` increases and `Shift+Down` decreases thinking level
- `btw`: parallel `/btw` side conversations
- `comment-checker`: warns the agent after `edit`/`write` adds unnecessary comments
- `rtk`: vendored official RTK hook; rewrites supported `bash` commands through local `rtk` binary only
- `pi-caveman` (pinned package dependency): trims response prose; configured locally at `lite`
- `pi-lens` (pinned package dependency): project intelligence, diagnostics, LSP navigation, safe deferred warmup, and `/lens-health`
- Ben Davis's complete setup (root-tracked pi-tools): Pi-only in-process subagents, workflows, background terminals, ask-user, copy-all, Firecrawl, first-class `fd`/`rg`, automatic run summaries, a model dashboard, and TUI customization

## Security model

Pi extensions execute with the user's full permissions. The permissions extension is trusted in-process policy, not an OS sandbox or a process/filesystem/network security boundary. Its first release is observe-only: it classifies and emits bounded audit metadata but never blocks, asks, denies, or changes tool calls. Unknown tools audit as `unknown` and continue unchanged. Runtime and Pi-package dependencies are pinned; review dependency, lockfile, and Git changes before updating. A commit-pinned global install is immutable until its configured revision is deliberately replaced.

Telemetry writes allowlisted lifecycle metadata to private rotating local JSONL files. Firecrawl sends search queries, URLs, and requested page content to its external service. Its API key is read from `~/.pi/agent/.env`; never commit or share that file. Remove Firecrawl from `pi.extensions` if external requests are not acceptable. The file-search setup downloads pinned `fd` and `rg` release binaries over HTTPS and verifies their SHA-256 checksums before installation. The current Pi CLI dependency shrinkwrap pins `brace-expansion@5.0.7`, which npm reports for GHSA-mh99-v99m-4gvg (local process availability/DoS); the latest compatible Pi package still contains it, so update when upstream refreshes that shrinkwrap and do not feed untrusted glob patterns into privileged unattended sessions. Do not install extensions whose permissions or data flow you have not reviewed.

Project code is MIT licensed. Upstream notices and documentation remain under `LICENSES/`, vendor repositories, and each extension's `UPSTREAM.md`. The vendored RTK hook is Apache-2.0; source pin is [`extensions/rtk/UPSTREAM.md`](extensions/rtk/UPSTREAM.md).

## Usage

See [orchestration glossary](docs/orchestration-domain.md), [ADR 0001](docs/adr/0001-automatic-orchestrator-mode.md), and [Jobs, TODO, and Workflows guide](docs/pouzivanie-jobs-todos.md).

Run `/pi-doctor` or `/capabilities` for a deterministic, non-mutating capability and health report. The reviewed [`gaboe/pi-lens`](https://github.com/gaboe/pi-lens) fork is bundled through a commit-pinned dependency and registered by this package. Use `/lens-health` for its detailed status. Healthy/idle pi-lens and LSP states stay silent in the permanent footer; actionable failures remain visible.

Orchestrator rollout defaults off. Opt in with `{"orchestrator":{"enabled":true}}` in `~/.config/rpiv-todo/config.json`, then use `/orchestrator on|off|auto` for session control.

With an empty focused prompt, press Down or Left to enter Fleet navigation. Use Up/Down, Enter, and Escape to navigate main, subagents, workflow runs, and workflow agents.

## Validate

```sh
npm ci
npm run setup:ben
npm run build:comment-checker # builds pinned MIT source; no downloaded executable
npm run check
# Focused foundation tests:
node --import tsx --test extensions/permissions/policy.test.mjs extensions/pi-doctor/doctor.test.mjs
```

Firecrawl reads `FIRECRAWL_API_KEY` from `~/.pi/agent/.env`. Never commit that file. Pi-tools is root-tracked under `vendor/pi-tools` with user-confirmed MIT source attribution. Caveman and pi-lens are immutable package dependencies exposed through this package's Pi manifest.

The checker is built from `code-yeongyu/go-claude-code-comment-checker` at commit `ec3c30c1f4c51a245ab82ffca74241868f902f3f`. Its platform binary stays local under `bin/`; the SHA-256 file is tracked.

## Updating

Review and test a new repository commit, then replace the configured global pin explicitly:

```sh
pi install git:github.com/gaboe/pi-like-gabo@<new-reviewed-commit-sha>
```

For a development checkout:

```sh
git pull --ff-only
npm ci
npm run setup:ben
npm run build:comment-checker
```
