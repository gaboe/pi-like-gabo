# Publication dossier: pi-like-gabo

Status: **prepared locally; remote-history reconciliation is unresolved**. This document is not authorization to commit, push, tag, release, publish, delete, recreate, or rewrite anything.

## Intended release

- Repository: `https://github.com/gaboe/pi-like-gabo`
- Visibility: public
- Channel: GitHub only; npm publication is out of scope and `private: true` remains set.
- Project license: MIT, copyright `gaboe`.
- Telemetry and Firecrawl: included, with the data-flow and credential warnings in the README.

## Prepared local changes

- Public package identity, repository, homepage, issue tracker, author, and keywords.
- Matching package-lock root identity.
- Root MIT `LICENSE`; third-party notices remain separate.
- Clone, dependency, build, install, update, validation, platform, and security guidance.
- Local scratchpads, environment files, credential files, and private-key formats excluded; generated checksum paths made portable.
- Node.js `>=22.19.0` declared consistently; the unused `git-info` setup step removed.
- The pinned pi-caveman MIT notice copied into `LICENSES/`.

## Preflight evidence

- Current root: branch `main`, commit `db5107e`, with a large intentional dirty worktree and no configured remote.
- The target public repository already exists with an unrelated root commit. Repository creation is no longer applicable, and no remote-history reconciliation is authorized.
- `gitleaks git .`: no findings in reachable root history.
- `gitleaks dir .`: one synthetic credential fixture in the vendored transcript-redaction test; no real credential identified.
- Root tracked-content scan found configuration names and credential-handling code, not credential values.
- `vendor/pi-caveman` is clean and its commit is contained by `origin/main`.
- `vendor/pi-tools` is ordinary root-tracked vendored source, preserving the required modified working tree without a nested Git link. Upstream URL, revision, and a copied MIT notice are recorded locally; author-origin redistribution permission remains independently unverifiable and is an explicitly accepted residual risk.
- Cleanup intentionally removes nested `node_modules`; run `npm ci` and `npm run setup:ben` before root `npm run typecheck` or `npm run check`. Metadata consistency checks and `git diff --check` pass.

## pi-tools provenance resolution

The required modified working tree is now ordinary root-tracked source at `vendor/pi-tools`, preserving current capability parity without a nested submodule. Its upstream source URL and revision are recorded in [`vendor/pi-tools/UPSTREAM.md`](../vendor/pi-tools/UPSTREAM.md). A copied MIT notice exists, but author-origin redistribution permission could not be independently verified; publication proceeds only with that accepted residual risk stated explicitly.

Generated dependencies, caches, build output, and nested Git metadata are excluded. Fresh setup installs pi-tools directly; only `vendor/pi-caveman` remains a submodule. Publication still requires final review and separate approvals.

## Exact final approval scope (not yet requested)

After blockers are resolved and the complete diff receives a final review, request approvals in this order:

1. **Local approval:** create one reviewed atomic commit from the exact candidate on the agreed local branch.
2. **Separate external approval:** choose how to reconcile the existing unrelated public repository history, then perform only the explicitly approved remote action and verify the resulting public clone.

A normal push of the current local `main` cannot create or fast-forward the existing remote history. The selected future strategy is to replace remote `main` with the reviewed local publication history by force-push. This recorded strategy is not authorization to add a remote or push; those actions require a separate bounded approval after the local commit. Replacing the branch may not immediately remove the old commit or its author email from GitHub caches or unreachable-object retention.

Excluded unless separately approved: npm publication, tags/releases, GitHub Actions secrets, branch protection or other repository-setting changes, history rewriting, repository deletion/recreation, and any deployment.
