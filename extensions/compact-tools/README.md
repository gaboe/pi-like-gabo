# Compact tools

General display-only Pi tool renderer.

- Groups adjacent reads and searches.
- Keeps native edit/write diffs.
- Shortens workspace paths and long commands.
- Summarizes custom tools without dumping arguments.
- Shows concise error output.
- Preserves original renderers under `Ctrl+O`.
- Reuses the same rows in subagent takeover transcripts.
- Keeps modeled provider tool-result output under a shared 64 KiB budget. Each image/binary block costs the provider's 20-character image placeholder; each result keeps at most the newest 16 blocks and replaces excess/old blocks with text omissions. Image/binary bytes never persist.
- Automatically compacts after an agent finishes above 90% of its model context window; unknown windows use 100k. It rearms at 80% of that threshold.

Use `/compact-tools on|off|toggle|status`.

## Recover omitted output

On text truncation, compact-tools stores complete text blocks joined with Pi's `\n` provider separator, UTF-8 encoded, in `<absolute-session-dir>/.compact-tool-artifacts/<sha256(session-id)>/<opaque-id>.txt`. Marker gives absolute `read`/`rg` path, opaque ID, SHA-256 of exact UTF-8 bytes, and exact omitted character range/count. Empty or relative session directories disable persistence; truncation still works and never falls back to the working directory. Images/binary blocks never persist.

Artifacts are owner-only (`0700` directories, `0600` files), atomic, content-verified before reuse, capped at 512 KiB each and 16 files / 8 MiB per session. Startup/retention cleanup removes only stale extension-owned temp names and oldest extension artifacts in that confined directory; it never recurses or removes other files. Marker handoff revalidates file type, byte length, and SHA-256 after batch cleanup. No redaction helper exists: sensitive tool output, including secrets, may be stored within these bounds. File contents are `fsync`ed before rename, but the containing directory is not `fsync`ed, so a filesystem or power failure can still lose the rename.
