#!/usr/bin/env bash
set -euo pipefail

readonly ROOT=$(cd "$(dirname "$0")/.." && pwd)
readonly PI_TOOLS="$ROOT/vendor/pi-tools"
npm --prefix "$PI_TOOLS" ci
for extension in ask-user background-terminals copy-all file-search firecrawl-search model-info subagents summaries ui-customization; do
	npm --prefix "$PI_TOOLS/extensions/$extension" ci
done
