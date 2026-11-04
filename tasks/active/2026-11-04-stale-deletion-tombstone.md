# Prevent stale workspace deletion records from blocking wake

## Problem

The November 4 recap chat accepted a user reply but could not wake: workspace 01M6KXKS1RYDXT0RJG6QEEY6MG remained stopping after local cleanup lost its completion record. Idea 01M6MCNSKJG34QS64NAJK1TXRE contains production evidence and independent Opus assessment. User authorized shipping to production in reviewer session.

## Research

- `workspace_deletion_reconciler.go` lists/deserializes records before acquiring the lifecycle lock, then saves the stale copy on failure. An inline deletion can finalize and remove metadata while the reconciler waits, then its completion tombstone is overwritten.
- `workspace_deletion.go` rejects metadata absence on incomplete records forever even when all artifacts are already absent. Recovery must only attest absence, never infer permission to delete unowned files.
- `persistence/workspace_deletion.go` upserts without version checks; writers already share a lifecycle lock. Refresh state under that lock rather than adding a new concurrency mechanism.
- Pattern exists since #2463; #2516 made inline attempts survive caller cancellation. Neither #2526 nor current main fixes it.
- Lessons: VM rule 06 requires stable resource identity; rule 54 means current nodes do not automatically hot-upgrade. Staging requires fresh real VM and cleanup; production recovery must preserve active sessions and use supported operations.

## Checklist

- [ ] Reproduce stale-read interleaving via real reconciler and deletion writer.
- [ ] Re-read intent under lock, validate key identity, skip finalized/removed records.
- [ ] Remove redundant error-path persistence.
- [ ] Converge metadata-missing intents only after verifying all physical artifacts absent, retaining owner/incarnation checks.
- [ ] Test recovery, remaining artifacts, ownership, ordinary deletion, and discriminating mutations.
- [ ] Document lifecycle behavior and incident lesson.
- [ ] Run Go focused/race/full tests, vet and build; relevant repository checks.
- [ ] Local Go/security/test/completion/doc/constitution reviews; resolve findings.
- [ ] Staging fresh VM heartbeat/access plus sleep→delete→wake; cleanup resources.
- [ ] PR and CI; CodeRabbit request and bounded wait; merge and verify production deploy.
- [ ] Verify affected workspace deletion proof through safe recovery; do not wake recap or repost.

## Acceptance criteria

1. Concurrent inline and background deletion cannot regress a finalized tombstone.
2. Existing poisoned records converge when artifacts are proven absent; any present artifact or failed probe preserves refusal without removal.
3. Identity, owner, incarnation, preservation expiry and generation checks remain enforced.
4. Normal deletion and sleep/wake work on fresh staging VM.
5. Production deploy succeeds and affected workspace becomes recoverable without executing its old approval prompt.

## References

- `packages/vm-agent/.claude/rules/06-vm-agent-patterns.md`, `27-vm-agent-staging-refresh.md`, `54-vm-agent-rollout-compatibility.md`
- `.claude/rules/35-vertical-slice-testing.md`
- Production post already published: https://x.com/simpleagentman/status/2118118731767304669
