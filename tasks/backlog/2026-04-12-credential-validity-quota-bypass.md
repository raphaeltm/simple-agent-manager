# Credential Validity Quota Bypass

**Created**: 2026-04-12
**Context**: Discovered by task-completion-validator during PR #682 review

## Problem

`resolveCredentialSource()` determines credential source by checking for row existence in the `credentials` table. It returns `credentialSource: 'user'` for any matching row, regardless of whether the stored token is valid, expired, or revoked.

This means a user can register an intentionally-invalid cloud provider credential to bypass quota enforcement without ever actually using their own infrastructure. The invalid credential makes them appear as BYOC, but provisioning will fall back to platform credentials when the invalid token fails.

## Root Cause

`resolveCredentialSource()` mirrors `createProviderForUser()`'s lookup logic, which also doesn't validate tokens at lookup time. Token validation happens later when the provider is instantiated and makes a real API call. The quota gate runs before token validation, creating a window where an invalid credential grants quota exemption.

## Acceptance Criteria

- [ ] A user with an expired/invalid credential is still quota-limited when platform credential is used as fallback
- [ ] `resolveCredentialSource` or the quota gate considers credential validity
- [ ] Test: user registers invalid credential, submits task that falls back to platform — quota is enforced

## Possible Approaches

1. **Add `isVerified` flag to credentials table** — Set after first successful API call, filter for it in `resolveCredentialSource`
2. **Validate credential at quota gate** — Make a lightweight API call (e.g., list regions) to verify the token works before granting exemption
3. **Accept the risk** — Document that credential row existence grants exemption, rely on the fact that `createProviderForUser()` will fail if the token is bad (task fails, no actual resource consumed)

## References

- PR #682 — fix(security): enforce compute quotas based on credential source
- `apps/api/src/services/provider-credentials.ts:resolveCredentialSource()`
- `apps/api/src/services/provider-credentials.ts:createProviderForUser()`
