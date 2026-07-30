# Compact tools

General display-only Pi tool renderer.

- Groups adjacent reads and searches.
- Keeps native edit/write diffs.
- Shortens workspace paths and long commands.
- Summarizes custom tools without dumping arguments.
- Shows concise error output.
- Preserves original renderers under `Ctrl+O`.
- Reuses the same rows in subagent takeover transcripts.
- Keeps provider-visible tool-result text under a shared 64 KiB budget, preserving newest results, non-text blocks, and the full persisted transcript.
- Automatically compacts sessions above 100k context tokens and rearms below 80k.

Use `/compact-tools on|off|toggle|status`.
