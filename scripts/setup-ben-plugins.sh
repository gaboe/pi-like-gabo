#!/usr/bin/env bash
set -euo pipefail

readonly ROOT=$(cd "$(dirname "$0")/.." && pwd)
readonly BEN="$ROOT/vendor/my-pi-setup"

git -C "$ROOT" submodule update --init --recursive
npm --prefix "$BEN" ci
for extension in ask-user copy-all firecrawl-search git-info model-info subagents ui-customization; do
	npm --prefix "$BEN/extensions/$extension" ci
done
