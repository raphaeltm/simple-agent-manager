# Fix Platform Compute Quota Bypass

## Problem

The compute quota system has a bypass vulnerability. Quota enforcement checks whether a user has ANY cloud provider credential in the `credentials` table. If they do, quotas are skipped entirely — even if the node being provisioned uses a platform credential (different provider). A user can register any Hetzner trial token, become "BYOC-exempt," and provision unlimited nodes using the platform's Scaleway key.

## Research Findings

### Buggy Enforcement Points

1. **`apps/api/src/routes/tasks/submit.ts:136-179`** — Queries `credentials` table for any `cloud-provider` record for the user. If found, sets `userHasByocCredentials = true` and skips all quota checks. Does not consider which provider will actually be used.

2. **`apps/api/src/durable-objects/task-runner/node-steps.ts:130-155`** — Same pattern: raw SQL query for any `cloud-provider` credential, skips quota if found. Uses `if (!hasOwnCreds)` guard.

3. **`apps/api/src/routes/nodes.ts:155-204`** — Manual node creation has NO quota check at all. Users can create nodes via API with platform credentials unbounded.

### What's Already Correct

- `createProviderForUser()` in `provider-credentials.ts:178-246` correctly resolves `credentialSource: 'user' | 'platform'` — tries user cred for target provider first, falls back to platform.
- `provisionNode()` in `nodes.ts:119-124` persists `credential_source` on the node record.
- `startComputeTracking()` reads `credential_source` from node.
- `calculateVcpuHoursForPeriod()` filters by `credentialSource`.
- `checkQuotaForUser()` only counts platform usage.

### Helper Function Bug

`userHasOwnCloudCredentials()` in `compute-quotas.ts:116-132` checks for ANY cloud-provider credential, not one for the specific target provider. This is also used in `usage.ts` for the `byocExempt` flag (informational, not gating).

### Fix Approach

Create a new `resolveCredentialSource()` function in `provider-credentials.ts` that mirrors `createProviderForUser()`'s resolution logic but without decryption or provider instantiation — just determines whether `'user'` or `'platform'` credentials would be used for a given target provider. Replace the credential-existence checks in submit.ts and node-steps.ts with calls to this function.

## Implementation Checklist

- [ ] Add `resolveCredentialSource()` to `provider-credentials.ts` — lightweight credential source resolution without decryption
- [ ] Update `userHasOwnCloudCredentials()` in `compute-quotas.ts` to accept optional `targetProvider` parameter
- [ ] Fix `submit.ts` — replace credential-existence check with `resolveCredentialSource()` call using the resolved `provider`
- [ ] Fix `node-steps.ts` — replace raw SQL credential check with `resolveCredentialSource()` call using `state.config.cloudProvider`
- [ ] Add quota check to manual node creation in `nodes.ts` POST `/` handler
- [ ] Write unit tests for `resolveCredentialSource()` covering all scenarios
- [ ] Write regression tests:
  - User with Hetzner cred provisioning on Scaleway (platform) → quota enforced
  - User with no credentials → quota enforced
  - BYOC user using own credential → quota exempt
  - Manual node creation with platform credential → quota enforced
- [ ] Update existing integration tests that check source-contract patterns to reflect new code

## Acceptance Criteria

- [ ] A user who registers a Hetzner credential but provisions on Scaleway (platform key) is quota-limited
- [ ] A user who registers an invalid/expired credential is still quota-limited when platform credential is used as fallback
- [ ] A user with no credentials at all is quota-limited
- [ ] A user genuinely using their own valid Hetzner credential to provision a Hetzner node is exempt
- [ ] Manual node creation respects quotas when using platform credentials
- [ ] Admin-set default quota and per-user overrides still work correctly
- [ ] Quota enforcement error messages clearly tell the user their usage and limit

## Key Files

- `apps/api/src/services/provider-credentials.ts` — add `resolveCredentialSource()`
- `apps/api/src/services/compute-quotas.ts` — update `userHasOwnCloudCredentials()`
- `apps/api/src/routes/tasks/submit.ts` — fix quota gating
- `apps/api/src/durable-objects/task-runner/node-steps.ts` — fix quota gating
- `apps/api/src/routes/nodes.ts` — add quota check to manual creation
- `apps/api/tests/unit/compute-quotas.test.ts` — update tests
- `apps/api/tests/integration/compute-quotas.test.ts` — update integration tests
