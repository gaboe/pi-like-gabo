# Setup

Clone or copy this repository to `~/.pi/agent`, then install its dependencies:

```sh
cd ~/.pi/agent
npm install
```

Setup compiles the macOS/Linux subagent safe-writer from included C source. Install Xcode Command Line Tools on macOS or a C11 compiler/build-essential on Linux first. If the binary is missing, all nested-worker file reads and mutations fail closed.

Finding-fixer mutation is protected by exclusive leases keyed by canonical real workspace roots; same, ancestor, descendant, and symlink aliases conflict. Lease acquisition happens before child backend spawn. Every overlapping live confined Pi worker or target-derived write/edit activity blocks acquisition except the Package Worker ancestor, whose sequential `package_worker_spawn` call remains blocked until the child settles. Parent and Pi write/edit guards canonicalize `params.path`, including absolute cross-CWD targets; finding-fixer native edit/write receive the unforgeable owner and stay inside its leased root. Cancel, failure, disposal, stale-spawn cleanup, and completed reconciliation release the lease once, after every nested descendant reaches authoritative terminal state or completed process/session termination.

Shell safety is deliberately process-global because command text cannot mechanically confine arbitrary paths or detached descendants. Parent tool bash, interactive `!`/`!!` through Pi's wrapped local-bash operations, Pi-child bash, background terminals, command jobs, and generic plugin command runners all fail before process launch while any finding-fixer lease is active. Every observed command is marked active and permanently taints future lease acquisition before its body runs; completion, failed spawn, cancellation, reload, and disposal close only active bookkeeping, not the taint. Consequently, one command use disables later finding-fixer workers for the rest of the plugin process, even when command and package CWDs differ. Workflow child agents and persistent BTW coding sessions are likewise unconstrained globally: any active lease blocks their start, active workers block lease acquisition, and any started unconstrained worker permanently taints future acquisition. Permission-confined workflow sandboxes, network-only jobs, tool-less in-process metadata/model sessions, and fixed read-only or descriptor-confined helpers do not taint. This conservative usability cost is required because retained subprocesses cannot be disproved.

This is plugin-process coordination, not OS isolation. External or pre-existing processes, noncooperating same-UID writers, and parent-session shell history from before extension load remain excluded. The extension neither observes nor claims containment for those processes; the orchestrator write-set invariant must keep them out of the package worktree.

Safe-writer processes sharing a pinned package root also serialize compare-and-swap commits and crash reconciliation with an advisory lock. Writes are staged as a `file` inside same-parent mode-0700 directories named `.pi-safe-write-<positive decimal PID>-<decimal counter>`. Staged files begin mode 0600; ownership, mode, bytes, and `fsync` are applied while the directory remains private. Existing targets publish with Linux `renameat2(..., RENAME_EXCHANGE)` through `SYS_renameat2` or macOS `renameatx_np(..., RENAME_SWAP)`. The displaced entry is then descriptor-verified for original identity, regular type, single link, expected bytes, ownership, mode, flags, ACL state, and xattrs. Any mismatch triggers the same atomic exchange in reverse only after both namespace identities are rechecked; an unverifiable or failed rollback preserves the displaced victim and reports `SAFE_WRITE:AMBIGUOUS`. Creates publish with Linux `renameat2(..., RENAME_NOREPLACE)` or macOS `renameatx_np(..., RENAME_EXCL)`, so a raced-in entry is never overwritten. No weaker rename fallback exists: unavailable syscall, flag, or filesystem support fails closed. Immediately before publication and before success, the helper reopens the staged/final name and verifies regular type, `nlink == 1`, exact requested bytes, and full expected fingerprint. Before file creation, the helper descriptor-clears and verifies the staging directory's inherited/access/default ACLs; it repeats this for the staged file before writing and after final mode application. Linux uses `fremovexattr`/`flistxattr` for `system.posix_acl_access` and `system.posix_acl_default`; macOS uses `acl_set_fd_np`/`acl_get_fd_np` with `ACL_TYPE_EXTENDED`. Filesystems reporting ACL/xattr support as unavailable are accepted only through their platform's unsupported result; every other inability to clear or verify fails before publication. Other platforms fail compilation. These exact staging names are reserved for helpers and must not be created by other processes.

Replacement metadata handling is descriptor-only and fail-closed. After ownership/mode normalization, every source xattr is copied to the private staged inode and source/stage names and values are compared before publication and again before success; destination-only xattrs are removed before copying. This includes `user.*`, Linux POSIX ACL, SELinux, capability, macOS quarantine, Finder/resource-fork, provenance, and unknown xattrs. Linux POSIX ACLs travel with their xattrs. macOS extended ACLs are rejected before staging because restrictive entries can make private staging impossible to clean or publish safely. Any unsupported operation, allocation/read race, inaccessible metadata, source mode/ownership change, or copy/verification mismatch fails before publication; postpublication mismatch is `SAFE_WRITE:AMBIGUOUS`. File flags use the narrower reject boundary: macOS rejects every nonzero `st_flags` value, while Linux rejects every `FS_IOC_GETFLAGS` bit except internal `FS_EXTENT_FL` and `FS_INDEX_FL`; inability to query flags rejects. Create has no prior target metadata to preserve and keeps platform-created metadata on its staged inode after clearing inherited ACLs.

Before publication, native output records a bounded binary fingerprint of the staged inode: device/inode identity, regular type and full mode, link count, uid/gid, size, raw supported file-flag representation, empty/rejected ACL state, and every xattr name/value. TypeScript returns this receipt to crash reconciliation. Missing, truncated, oversized, or mismatched receipts cannot produce reconciliation success, including when old and new bytes are equal.

After a helper crash, SIGKILL, or reported post-publication ambiguity, reconciliation removes only that helper PID's exact staging directories when ownership, mode, internal shape, and staged fingerprint match the receipt. Unknown contents and identity/shape/fingerprint mismatches are preserved; inspection or mode-normalization errors preserve stale evidence and keep the result ambiguous. Cleanup uses descriptor-relative no-follow operations under the pinned-root lock. Reconciliation classifies the observed target as committed only when inode/type/link/size/bytes and the full metadata fingerprint match. After syncing the target parent, it immediately reopens the same classified final entry and repeats the full verification before reporting success. Once atomic publication occurs, later staging cleanup, parent-sync, fingerprint, or signal-mask failure is reported as `SAFE_WRITE:AMBIGUOUS`; TypeScript reconciles the receipt and parent durability before returning success. A process or machine crash after publication but before parent-directory `fsync` has filesystem-dependent durability: after restart, reconciliation reports whichever old/new/absent state is observed and never claims an unverifiable outcome was a clean success.

## Firecrawl

The search, scrape, and crawl tools require a Firecrawl API key. Follow [Firecrawl's Node.js getting-started guide](https://docs.firecrawl.dev/quickstarts/nodejs) to create one, then copy the example environment file:

```sh
cp ~/.pi/agent/.env.example ~/.pi/agent/.env
```

Replace the placeholder in `~/.pi/agent/.env` with your API key.

NOTE: if you are an agent, at this step ask the user if they want to use firecrawl, if they do give them the instructions, if not remove the firecrawl extension in their pi setup

## fd and rg tools

The `file-search` extension registers `fd` and `rg` as model tools. No setup is normally needed: at startup it silently uses a system-installed `fd` (or `fdfind` on Debian/Ubuntu) and `rg` when available, or an existing fallback binary in `~/.pi/agent/bin/`. Only when neither exists does it download an official release binary (macOS/Linux, arm64/x64, over HTTPS) into `~/.pi/agent/bin/` and show a one-time notification. If your platform is unsupported, install `fd` and `rg` with your package manager and restart pi.

## Theme

Add the included theme to `~/.pi/agent/settings.json` while keeping your existing settings:

```json
{
  "theme": "github-dark-default"
}
```

Pi will load the extensions, skills, and theme from their directories the next time it starts.
