#!/usr/bin/env bash
set -euo pipefail

readonly REPO=https://github.com/code-yeongyu/go-claude-code-comment-checker.git
readonly REV=ec3c30c1f4c51a245ab82ffca74241868f902f3f
readonly ROOT=$(cd "$(dirname "$0")/.." && pwd)
readonly TARGET="$ROOT/bin/$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/arm64/arm64/; s/x86_64/x64/')"
readonly TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

git -C "$TMP" init -q
git -C "$TMP" remote add origin "$REPO"
git -C "$TMP" fetch -q --depth 1 origin "$REV"
git -C "$TMP" checkout -q FETCH_HEAD
test "$(git -C "$TMP" rev-parse HEAD)" = "$REV"
(cd "$TMP" && cargo build --locked --release)
mkdir -p "$TARGET"
cp "$TMP/target/release/comment-checker" "$TARGET/comment-checker"
chmod 0755 "$TARGET/comment-checker"
shasum -a 256 "$TARGET/comment-checker" | tee "$TARGET/comment-checker.sha256"
