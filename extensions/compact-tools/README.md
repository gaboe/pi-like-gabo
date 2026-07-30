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
- Automatically compacts after an agent finishes above 100k context tokens (or 80% of a smaller model window) and rearms at 80% of that threshold.

Use `/compact-tools on|off|toggle|status`.
