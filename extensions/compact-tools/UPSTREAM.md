# Upstream provenance

Renderer lifecycle and safe fallback behavior are derived from
[`pi-compact-transcript`](https://github.com/avhagedorn/pi-compact-transcript)
at commit `abf969c69052cc69419a806fddc5b350ee7e57e0` (MIT). The full upstream notice is preserved in [`LICENSES/pi-compact-transcript-MIT.txt`](../../LICENSES/pi-compact-transcript-MIT.txt).

Local behavior differs intentionally:

- groups reads and searches by category;
- leaves Pi's native edit/write diff renderer untouched;
- shortens workspace/worktree paths and shell commands;
- gives custom tools a generic intent/result row;
- does not patch assistant/thinking rendering.
