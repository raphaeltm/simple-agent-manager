# Stop expired-trial missing-VM cleanup retries

## Problem statement

Expired-trial cleanup repeatedly retries nodes whose persisted provider instance is conclusively absent. The same two production Hetzner instances produced 3,675 identical `platform_errors` from 2026-07-07 through 2026-07-13 because `deleteNodeResourcesStrict()` throws after a credentialed `getVM()` returns `null`, the scheduler releases the deletion claim to a retryable error state, and the next sweep repeats the path.

The fix must distinguish conclusive remote absence from uncertain deletion state. Missing credentials, provider lookup errors, ambiguous responses, and delete failures must continue to fail closed.

## Research findings

- Canonical SAM idea `01KVQA7X6JGMFC5EA0MD5KQ2NC` records the production counts and a staging instance with the same symptom.
- `apps/api/src/services/nodes.ts` previously resolved one arbitrary fallback credential for legacy nodes without a recorded provider. A `null` result from that single provider is not conclusive when another credentialed provider can own the same instance ID; every canonical credentialed provider must be checked, and multiple matches must fail closed.
- `apps/api/src/scheduled/trial-expire.ts` already claims the node before strict deletion and only tombstones workspaces/node after the strict call succeeds.
- Strict deletion currently treats conclusive absence as failure and returns no outcome to its caller.
- A fresh concurrent `status='destroying'` claim is currently reported as a cleanup error even though another sweep owns it. The owner can also finish between the failed claim and follow-up read; terminal `deleted`/`destroyed` state must be treated as successful competing work. Stale claims remain recoverable through the configured `TRIAL_NODE_DELETION_LOCK_STALE_MS` threshold.
- Local finalization must retain the existing guarded trial/workspace updates, close agent sessions and compute usage, clean ProjectData references, clean DNS best-effort, and tombstone the node only when no active workspace remains.
- Direct read-only Cloudflare checks were attempted on 2026-07-17; the configured staging and production debugging tokens both returned Cloudflare code 10000 authentication errors. The canonical production health evidence and recorded staging observation therefore remain the available environment evidence before implementation.
- Relevant lifecycle lesson: `tasks/archive/2026-03-16-workspace-lifecycle-fixes.md` documents why external deletion must not be silently skipped and why workspace status must be reconciled after resource deletion. `tasks/archive/2026-07-06-close-conversation-workspace-cleanup.md` reinforces consistent local workspace/session cleanup.

## Deliberate semantics

For a node with a recorded provider, strict deletion keeps using that exact provider. For a providerless legacy node, strict deletion resolves every provider in the canonical `CREDENTIAL_PROVIDERS` list with an exact target, queries every credentialed candidate, and accepts remote absence only when all of those lookups return exactly `null`. One present candidate is selected and persisted; multiple present candidates, malformed results, lookup failures, or no resolvable credential fail closed. Conclusive absence returns `providerVm: 'already-absent'`, continues best-effort DNS cleanup, and allows the scheduler's existing guarded local cleanup/tombstoning path to finish without inventing provider attribution.

Credential resolution failure, provider lookup rejection, malformed/ambiguous provider behavior, and provider deletion rejection remain exceptions. The scheduler releases those claims to the existing operator-visible retryable error state and persists the error.

A second invocation encountering a fresh deletion claim, or terminal state completed by the claim owner, will skip it without persisting an error. A stale claim remains reclaimable under the existing configurable lock timeout.

The extra provider work is bounded by the canonical provider list and applies only to providerless legacy nodes: at most one exact credential resolution per supported provider and one `getVM()` call per credentialed candidate. Nodes with recorded providers retain one credential resolution and one delete call.

## Implementation checklist

- [x] Introduce an explicit strict-delete result that distinguishes deleted/no-instance/conclusively-absent provider VMs.
- [x] Continue DNS cleanup and guarded local finalization after conclusive absence without weakening other strict failures.
- [x] Check every credentialed provider for providerless legacy nodes; select one present provider, require all-null for absence, and reject multiple matches.
- [x] Distinguish fresh concurrent and owner-completed terminal claims from actual claim failures; retain configurable stale-claim recovery.
- [x] Add service scenarios for all-provider absence, later-provider presence, multiple-provider ambiguity, missing credentials, lookup failure/malformed results, and DNS cleanup.
- [x] Add scheduler scenarios for finalization after absence, repeated invocation/idempotency, concurrent invocation, owner-completed terminal state, guarded local-reference cleanup, and unchanged retryable errors.
- [x] Run the corrected focused API suite (3 files, 22 tests) and build (9/9 tasks).
- [x] Rerun the extended affected suite (3 collected files, 82 tests), lint (0 errors), typecheck (16/16 tasks), build (9/9 tasks), and the full repository suite (19/19 tasks; API 438 files/6,190 tests; web 224 files/2,740 tests) on the repaired current-main head.
- [x] Apply Cloudflare/D1, security, test/vertical-slice, constitution, documentation-sync, and task-completion review lenses; no unresolved correctness findings remain before staging.
- [x] Push the assigned output branch and prepare a PR with exact evidence.
- [ ] Obtain the exclusive staging deployment slot and deploy the exact reviewed head.
- [ ] Verify the cleanup behavior and real Claude/Codex chat responses on staging, merge with green gates, then monitor production deployment and behavior.

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
