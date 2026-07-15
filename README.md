# pi-plugins

Locally owned Pi package containing three reviewed extensions:

- `multi-skills`: inline `$skill-name` expansion and discovery
- `todo`: persistent task tool and overlay
- `btw`: parallel `/btw` side conversations
- `comment-checker`: warns the agent after `edit`/`write` adds unnecessary comments
- Ben Davis's complete setup (pinned submodule): cross-harness subagents, workflows, ask-user, copy-all, Firecrawl, Git/model dashboards, and TUI customization

## Security model

Pi extensions execute with the user's full permissions. This package is installed by absolute local path, has no third-party runtime dependency, and is never updated by `pi update --extensions`. Review Git changes before pulling or editing it.

Upstream notices and documentation are retained under `LICENSES/` and each extension's `UPSTREAM.md`.

## Validate

```sh
npm ci
npm run setup:ben
npm run build:comment-checker # builds pinned MIT source; no downloaded executable
npm run check
```

Firecrawl reads `FIRECRAWL_API_KEY` from `~/.pi/agent/.env`. Ben's upstream is pinned under `vendor/my-pi-setup`; update it only after reviewing the submodule diff.

The checker is built from `code-yeongyu/go-claude-code-comment-checker` at commit `ec3c30c1f4c51a245ab82ffca74241868f902f3f`. Its platform binary stays local under `bin/`; the SHA-256 file is tracked.

## Install

```sh
pi install /Users/gabrielecegi/op/pi-plugins
```
