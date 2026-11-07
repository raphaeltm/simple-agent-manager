# Classify GCP create errors so a stockout descends instead of failing the task

PR 1 of 4 for provider priority and cross-provider fallback (idea `01M6NXTF2RQ5QXHM7YZ4ZF0XBK`,
conversation task `01M6SGNFCMQ19R91JPDAGGQEDC`). Also fixes item 5 of idea
`01M236QPGGC6B150FG4QHT17MW`.

## Problem

`classifyGcpError` (`packages/providers/src/gcp-metadata.ts`) has no call sites. Every GCP
`ProviderError` therefore carries `category: 'unknown'`:

- A synchronous HTTP error from `instances.insert` is built by `providerFetch`
  (`provider-fetch.ts:assertProviderResponseOk`) with only `{ providerCode }`.
- An asynchronous operation error (`pollOperation`, `gcp.ts`) is built with no status, no code
  and no category: `new ProviderError('gcp', undefined, 'GCP operation failed: ...')`.

`handleProvisioningAttemptFailure` (`apps/api/src/durable-objects/task-runner/node-provisioning-failure.ts`)
asks one question, `isTransientCapacityError`, and fails anything else permanently. So a GCP
zone stockout (`ZONE_RESOURCE_POOL_EXHAUSTED`) fails the task on its first attempt, even when the
pool's `fallback-chain` policy has other permitted offerings (another zone or machine type).

## Research findings

- GCP reports stockouts as an operation error: `status: DONE`,
  `error.errors[].code = ZONE_RESOURCE_POOL_EXHAUSTED | ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS`,
  message "The zone '…' does not have enough resources available to fulfill the request…". The
  insert was rejected; no instance exists.
- GCP reports quota and rate limits as HTTP 403 (reason `quotaExceeded` / `rateLimitExceeded`),
  or as operation code `QUOTA_EXCEEDED`. The current classifier checks `403 → auth_error` BEFORE its
  message fallback, so a quota 403 with no structured `status` would read as `auth_error`.
- `providerFetch` keeps `error.status` as `providerCode` for GCP, because `error.code` is numeric.
  It drops `errors[].reason`.
- The current classifier maps a bare `UNAVAILABLE` / HTTP 503 to `transient_capacity`. On the
  create POST that is unsafe. The TaskRunner treats `transient_capacity` as "delete the node row and
  try another offering" (`node-provisioning.ts`, rethrow branch). A 503 on the insert POST does not
  prove the instance was not created, so that action could leave a ghost VM and create a second one
  (TLA+ path P2/P3, Library `/engineering/research/provider-priority-2026-11-05/`).
- Consumers of `ProviderError.category` / `isTransientCapacityError` (rule 67 enumeration):
  1. `node-provisioning.ts` `isProviderCreateRejectedBeforeVmIdentity`: Hetzner-only. GCP is
     unaffected.
  2. `node-provisioning.ts` rethrow branch: a capacity failure deletes the `creating` node row.
     A GCP stockout has no instance, so this is correct.
  3. `node-provisioning-failure.ts` `handleProvisioningAttemptFailure`: capacity → next permitted
     offering, else exhaustion policy. This is the intended effect.
  4. `vm-admission-provider-capacity.ts` `classifyVmProviderCapacityError`: Hetzner-only. GCP
     quota still fails fast. Cross-provider handling of GCP quota is slice 3 (deferred to PR 3 of
     the idea).
  5. `deployment-provisioning.ts`: rethrow mode, then rollback. A stockout leaves no VM, so this is
     correct.
  6. `node-manual-deletion.ts` `auth_error`: delete path only. Not touched (classification is
     applied on the create path only).
  7. `hetzner-server-create.ts`: Hetzner-only.
- The durable direct-provisioning path (`node-lifecycle-provisioning.ts`, `durableAllocation`)
  turns every non-Hetzner create error into `NodeAllocationUncertainError` and reconciles by
  label. That is conservative and unchanged here. Cross-provider fallback on that path is deferred
  to PR 3 of idea `01M6NXTF2RQ5QXHM7YZ4ZF0XBK` (slice 3, "wake path").
- `gcp.ts` is 794 lines (rule 18). Split it before adding code.

## Implementation checklist

- [x] Split `gcp.ts`: move operation polling (deduplicating zonal and global) and paginated list
      helpers into `gcp-api.ts`, and firewall setup into `gcp-firewall.ts`. Separate commit, no
      behaviour change.
- [x] Rework `classifyGcpError` so each arm names its recovery action:
  - stockout code or stockout message → `transient_capacity`;
  - quota code or message → `quota_exceeded`, checked before the 403 → `auth_error` arm;
  - rate-limit code or message → `rate_limited`, checked before 403;
  - auth → `auth_error`;
  - a bare `UNAVAILABLE` / 503 with no stockout evidence → `unknown` (ambiguous outcome; never
    descend), with a comment explaining why.
- [x] Operation errors carry `providerCode` (the decisive code) and `category` at construction.
- [x] `createVM` maps synchronous `ProviderError`s through the classifier at construction,
      preserving status, code, message and cause. Abort reasons pass through unchanged.
- [x] Update the `hetzner-metadata.ts` comment that says `classifyGcpError` has no call sites.
- [x] Provider tests, built through the real `GcpProvider.createVM` with fresh responses per call:
      stockout operation error, `_WITH_DETAILS`, quota 403 without a status, quota operation
      error, rate-limit 403, permission 403 (control), bare 503 (control: stays `unknown`), and
      an operation timeout (control: stays `unknown`). Each asserts the parsed message and code.
- [x] Action-layer tests (`task-runner-capacity-exhaustion.test.ts`): a GCP stockout error produced
      by the real `GcpProvider` descends the fallback chain; a GCP auth error from the real
      producer fails fast; a GCP 503 fails fast.
- [x] Surgical revert: remove the wiring (keep exports) and confirm the stockout tests go red.
- [x] Hetzner non-regression: the existing Hetzner placement and capacity suites stay green
      unchanged.
- [x] Docs: check self-hosting GCP and provider docs for statements about GCP error handling.

## Acceptance criteria

- [x] A GCP `ZONE_RESOURCE_POOL_EXHAUSTED` failure during task provisioning descends to the
      pool's next permitted offering under `fallback-chain` (action-layer test).
- [x] A GCP permission or auth error still fails the task on the first attempt (control test).
- [x] An ambiguous GCP create outcome (bare 503, operation timeout) never descends.
- [x] All Hetzner capacity and placement tests pass unchanged.

## Staging

Raphaël waived real-staging GCP verification for this idea (session
`eecddba8-c34e-4333-ad4a-15b6c8b1cb9b`, 2026-11-07: "Please ship it to production with thorough
testing outside of a real staging env. I'll test in prod."). GCP is not connected on staging.

## References

- `packages/providers/.claude/rules/72-error-categories-must-match-the-recovery-action.md`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `apps/api/.claude/rules/67-shared-predicates-that-trigger-actions.md`

## Implementation notes

- Classification is assigned at construction for every GCP operation error (`pollGcpOperation` →
  `gcpOperationError`), not only on create. The only other category consumer that can see a GCP
  operation error is `node-manual-deletion.ts` `isCredentialRejection` (`auth_error`), where a
  PERMISSION_DENIED operation error really is a credential rejection.
- `gcp.ts` split: 794 → 487 lines (`gcp-api.ts`, `gcp-firewall.ts`, `gcp-instance-lookup.ts`).
- Surgical revert (wiring removed, exports kept): 11/14 provider cases and 3/4 action-layer cases
  went red. The ones that stayed green are the controls that must hold either way: bare 503, poll
  timeout, caller abort, and the ambiguous-503 action-layer case.
- Docs: `apps/www/src/content/docs/docs/guides/compute-pools.md` now says which provider errors
  count as "sold out" and which stop the work.
