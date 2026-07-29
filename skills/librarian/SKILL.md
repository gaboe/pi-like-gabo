---
name: librarian
description: Research open-source libraries with evidence-backed answers and stable GitHub permalinks. Use for library internals, implementation details, history, authoritative documentation, or source-backed comparisons.
---

# Librarian

Adapted from [pi-web-access librarian](https://github.com/nicobailon/pi-web-access/blob/db08867a19fc9af95b5702f7024c882a2507fe4e/skills/librarian/SKILL.md); MIT notice: `LICENSES/pi-web-access-MIT.txt`.

Answer open-source research questions with primary evidence. Classify request before research:

| Type | Trigger | Primary approach |
|---|---|---|
| Conceptual | usage, API, best practice | official docs, `web_search`, `fetch_content` |
| Implementation | source, internals, how it works | `fetch_content` clone, local source search |
| History | why changed, regression, origin | local Git history, GitHub issue/PR history |
| Comprehensive | deep dive, comparison, ambiguous | combine all relevant approaches |

## Evidence order

1. Official documentation, upstream repository, releases, source code, issue/PR discussion
2. Maintainer-authored material
3. Reliable secondary sources

State version, branch, or commit scope. Distinguish verified facts from inference; name unresolved uncertainty.

## Conceptual research

Use varied `web_search` queries for current context. Use `fetch_content` for official docs or repository README/docs, then `get_search_content` for bounded follow-up slices. Prefer official documentation over blog posts. Cite source URLs with claims.

## Implementation research

1. Call `fetch_content` for repository URL (use `forceClone: true` only when API-only access is insufficient).
2. Capture the local clone path returned by `fetch_content`; never assume a fixed temporary directory.
3. Verify that path before local operations:

```bash
REPO='<path returned by fetch_content>'
test -d "$REPO" && test -e "$REPO/.git" || {
  printf 'Clone unavailable: %s\n' "$REPO" >&2
  exit 1
}
git -C "$REPO" rev-parse --show-toplevel
git -C "$REPO" rev-parse HEAD
```

4. Search clone with `fd` and `rg`; inspect files with `read`; use `bash` for Git and targeted shell work. Keep paths quoted.
5. Build GitHub source links with full SHA, never a moving branch:

```text
https://github.com/<owner>/<repo>/blob/<full-sha>/<path>#L<start>-L<end>
```

Use local evidence to identify exact line ranges. Every implementation claim about a function, class, or behavior gets a permalink when available.

## History research

After clone-path verification, inspect history locally:

```bash
git -C "$REPO" log --oneline -n 20 -- path/to/file.ts
git -C "$REPO" blame -L 10,30 -- path/to/file.ts
git -C "$REPO" show <full-sha> -- path/to/file.ts
git -C "$REPO" log --oneline --grep='keyword' -n 10
```

Use GitHub history for discussion and release context:

```bash
gh search issues 'keyword' --repo owner/repo --state all --limit 10
gh search prs 'keyword' --repo owner/repo --state merged --limit 10
gh issue view <number> --repo owner/repo --comments
gh pr view <number> --repo owner/repo --comments
gh api repos/owner/repo/releases --jq '.[0:5] | .[].tag_name'
```

Tie historical conclusions to commits plus issue/PR evidence where possible. A merged PR title alone is not proof of runtime behavior.

## Comprehensive research

Run independent `web_search` and `fetch_content` calls together when useful. Once clone path is returned and verified, combine official docs, local source, `git log`/`blame`/`show`, and GitHub issue/PR history. Compare versions explicitly; do not merge evidence from different revisions without saying so.

## Failure recovery

| Failure | Recovery |
|---|---|
| Search misses | Broaden terms; search concepts, symbols, and adjacent files |
| Clone path absent or verification fails | Say local source is unavailable; use `fetch_content`/`get_search_content` API view or retry clone deliberately |
| Repository too large | Use API view first; request `forceClone: true` only if local history/source search is necessary |
| File absent | List returned tree, check revision/path, then search nearby names |
| `gh` fails or rate limits | Use verified clone and Git history; report missing discussion evidence |
| Evidence conflicts or remains incomplete | State uncertainty, evidence found, and next discriminating check |

Answer directly. Cite official docs for concepts and full-SHA permalinks for code. Do not present inference as fact.
