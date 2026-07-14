# pi-plugins

Locally owned Pi package containing three reviewed extensions:

- `multi-skills`: inline `$skill-name` expansion and discovery
- `todo`: persistent task tool and overlay
- `btw`: parallel `/btw` side conversations

## Security model

Pi extensions execute with the user's full permissions. This package is installed by absolute local path, has no third-party runtime dependency, and is never updated by `pi update --extensions`. Review Git changes before pulling or editing it.

Upstream notices and documentation are retained under `LICENSES/` and each extension's `UPSTREAM.md`.

## Validate

```sh
npm ci
npm run check
```

## Install

```sh
pi install /Users/gabrielecegi/op/pi-plugins
```
