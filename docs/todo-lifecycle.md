# TODO lifecycle

The persisted task status and the public status are related but not identical. A task with persisted `status: completed` and `review.status: pending` is shown publicly as `verifying` until independent review approves it.

```mermaid
stateDiagram-v2
    [*] --> Created: todo create

    Created --> Preparing: prepare=true or scope changes
    Created --> Ready: direct task without preparation
    Preparing --> Ready: dossier and target validated
    Preparing --> WaitingUser: real clarification required
    Preparing --> Ready: bounded preparation fallback

    Ready --> Selected: dependency graph satisfied
    Selected --> InProgress: scheduler claims actionable owner
    InProgress --> WaitingUser: user decision required
    InProgress --> WaitingJobs: monitored jobs registered
    InProgress --> Verifying: result and evidence submitted

    WaitingUser --> Ready: correlated answer persisted
    WaitingJobs --> WaitingJobs: partial job evidence
    WaitingJobs --> Ready: all/any condition satisfied
    Ready --> Preparing: same-token queued preparation resumes
    Preparing --> Selected: preparation completes
    Selected --> InProgress: parent continuation claims task

    state "Independent completion review" as Verifying {
        [*] --> ReviewPending
        ReviewPending --> ReviewRunning: reviewer owns dispatchedAt
        ReviewRunning --> ReviewApproved: evidence accepted
        ReviewRunning --> SemanticRejected: implementation or evidence rejected
        ReviewRunning --> OperationalFailure: crash, timeout, snapshot race
        OperationalFailure --> ReviewPending: bounded backoff retry
    }

    Verifying --> Completed: ReviewApproved
    Verifying --> Ready: SemanticRejected and remediation
    Verifying --> Verifying: OperationalFailure retry

    Completed --> Ready: scope changes invalidate approval
    Completed --> Archived: todo clear after all work is archivable
    Archived --> [*]

    state "Dependency failure and recovery" as DependencyFlow {
        SourceFailed --> DependentFailed: propagate failed prerequisite
        SourceFailed --> SourceRecompleted: fresh completion evidence
        SourceRecompleted --> SourceVerifying: stale failed verification removed
        SourceVerifying --> SourceApproved: completion review approves
        SourceApproved --> DependentReady: inherited failure removed
    }
```

## Actionable selection and continuation

1. `selectReadyTasks` excludes unresolved dependencies, user waits, job waits, cycles, and active owners.
2. The scheduler selects one actionable owner and may reorder multiple ready tasks without violating dependencies.
3. A matching job event persists terminal evidence and changes its waiter to `pending`.
4. If that transition exposes a same-token queued preparation, the preparation queue is restarted.
5. When preparation or completion-review approval exposes executable work, the scheduler requests one bounded parent continuation.
6. The continuation revalidates task revision, lifecycle, target, and ownership before changing the task to `in_progress`.

## Completion review recovery

Operational failures do not ask the user to approve broken infrastructure. The review remains pending, releases `dispatchedAt`, waits for bounded backoff, and is redispatched. Retry scheduling is armed from the common review-run `finally` boundary after active reviewer ownership is released, preventing a pending/verifying task from becoming orphaned.

Semantic rejection is different: it returns the task to actionable remediation and requires changed completion evidence before another review.

## Dependency recovery

A semantic source failure marks descendants with `failed prerequisite`. Fresh completion evidence removes stale failed verification metadata while preserving unrelated metadata and `blockedBy` edges. Once the source is no longer a semantic failure, propagation removes inherited failure metadata and descendants become ready again.

## Clear and UI semantics

`todo clear` refuses unresolved, rejected, waiting, or unreviewed work. It archives only completed tasks with approved completion evidence and preserves unresolved tasks.

`herdr:blocked` is reserved for actual user input or approval. Preparation, completion review, subagents, and jobs are background work. A job wait is displayed with a running marker such as `▶ running · mode: jobs` rather than pretending the user is blocking it.

## Verification and delivery evidence

- Comprehensive `npm run check` passed on the committed tree: root tests `653/653`, vendor Node tests `320/320`, file-search tests `23/23`, plus root/vendor typecheck and formatting checks.
- Commit `0a04c4bcb3a633b8d9315a4c062830ddaf420582` was pushed normally to `origin/feature/pi-hardening-suite` and local/remote HEAD matched.
- The commit recorded 120 paths: 102 modified, 17 added, and one intentional tracked deletion.
- Later review-remediation changes are intentionally assigned to TODO #17 for a follow-up commit and push after their completion reviews approve.
