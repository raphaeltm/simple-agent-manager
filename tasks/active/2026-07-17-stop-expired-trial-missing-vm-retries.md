# Stop expired-trial missing-VM cleanup retries

## Problem statement

Expired-trial cleanup repeatedly retries nodes whose persisted provider instance is conclusively absent. The same two production Hetzner instances produced 3,675 identical `platform_errors` from 2026-07-07 through 2026-07-13 because `deleteNodeResourcesStrict()` throws after a credentialed `getVM()` returns `null`, the scheduler releases the deletion claim to a retryable error state, and the next sweep repeats the path.

The fix must distinguish conclusive remote absence from uncertain deletion state. Missing credentials, provider lookup errors, ambiguous responses, and delete failures must continue to fail closed.

## Research findings

- Canonical SAM idea `01KVQA7X6JGMFC5EA0MD5KQ2NC` records the production counts and a staging instance with the same symptom.
- `apps/api/src/services/nodes.ts` resolves credentials before calling `provider.getVM()` for legacy nodes without a recorded provider. A resolved provider returning `null` is conclusive absence; thrown lookups remain ambiguous.
- `apps/api/src/scheduled/trial-expire.ts` already claims the node before strict deletion and only tombstones workspaces/node after the strict call succeeds.
- Strict deletion currently treats conclusive absence as failure and returns no outcome to its caller.
- A fresh concurrent `status='destroying'` claim is currently reported as a cleanup error even though another sweep owns it. Stale claims remain recoverable through the configured `TRIAL_NODE_DELETION_LOCK_STALE_MS` threshold.
- Local finalization must retain the existing guarded trial/workspace updates, close agent sessions and compute usage, clean ProjectData references, clean DNS best-effort, and tombstone the node only when no active workspace remains.
- Direct read-only Cloudflare checks were attempted on 2026-07-17; the configured staging and production debugging tokens both returned Cloudflare code 10000 authentication errors. The canonical production health evidence and recorded staging observation therefore remain the available environment evidence before implementation.
- Relevant lifecycle lesson: `tasks/archive/2026-03-16-workspace-lifecycle-fixes.md` documents why external deletion must not be silently skipped and why workspace status must be reconciled after resource deletion. `tasks/archive/2026-07-06-close-conversation-workspace-cleanup.md` reinforces consistent local workspace/session cleanup.

## Deliberate semantics

A credentialed provider lookup that resolves successfully and returns `null` is an idempotent remote-delete success. Strict cleanup will return an explicit `providerVmAbsent` outcome, continue best-effort DNS cleanup, and allow the scheduler's existing guarded local cleanup/tombstoning path to finish. It will emit bounded structured operational logging, not a recurring `platform_error`.

Credential resolution failure, provider lookup rejection, malformed/ambiguous provider behavior, and provider deletion rejection remain exceptions. The scheduler releases those claims to the existing operator-visible retryable error state and persists the error.

A second invocation encountering a fresh deletion claim will skip it as concurrent work without persisting an error. A stale claim remains reclaimable under the existing configurable lock timeout.

## Implementation checklist

- [x] Introduce an explicit strict-delete result that distinguishes deleted/no-instance/conclusively-absent provider VMs.
- [x] Continue DNS cleanup and guarded local finalization after conclusive absence without weakening other strict failures.
- [x] Distinguish fresh concurrent claims from actual claim failures; retain configurable stale-claim recovery.
- [x] Add service scenarios for conclusive absence, missing credentials, lookup failure/ambiguity, and local DNS cleanup after absence.
- [x] Add scheduler scenarios for finalization after absence, repeated invocation/idempotency, concurrent invocation, guarded local-reference cleanup, and unchanged retryable errors.
- [x] Run focused API tests and the full repository quality suite.
- [ ] Run requested specialist reviews and address all correctness findings.
- [ ] Push the assigned output branch and prepare a PR with exact evidence.
- [ ] Request `STAGING_LEASE_REQUEST`; do not deploy or merge until `STAGING_LEASE_GRANTED`.
- [ ] After lease grant, verify the cleanup behavior on staging, merge with green gates, monitor production deployment and behavior, release the lease, and complete the SAM task.

## Acceptance criteria

- Conclusive provider absence completes the existing guarded local cleanup exactly once and cannot produce an unbounded recurring error stream.
- Credentials missing, lookup/API failure, ambiguous provider state, and delete failure still fail closed and remain operator-visible/retryable.
- Cleanup claims prevent concurrent external/local deletion; a fresh competing claim does not create a false platform error, while stale claims remain recoverable by configuration.
- Workspace, agent-session, compute-usage, ProjectData, DNS, node, and trial consistency are preserved.
- Scenario-driven regression tests cover all requested cases and exact verification evidence is recorded in the PR and SAM completion.

## References

- SAM idea `01KVQA7X6JGMFC5EA0MD5KQ2NC`
- `apps/api/src/scheduled/trial-expire.ts`
- `apps/api/src/services/nodes.ts`
- `apps/api/tests/unit/scheduled/trial-expire.test.ts`
- `apps/api/tests/unit/services/nodes-delete.test.ts`
- `health-report-2026-07-13.md`
- `.claude/rules/14-do-workflow-persistence.md`
- `.claude/rules/32-cf-api-debugging.md`
