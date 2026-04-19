# Trial Onboarding — Late-Audit Hardening Follow-ups

## Problem

After PR #760 merged, a late-arriving security audit returned with findings. Two were stale (already fixed in the merged branch). The rest are non-exploitable hardening items worth addressing before `sam/trial-onboarding-mvp` merges to `main`.

## Context

- Late audit task-id: `a35608e033ac4405a` (returned 2026-04-19, after PR #760 merged)
- The audit ran against a pre-remediation commit; CRITICAL-1 (no rate limit) and HIGH-1 (fingerprint HMAC verify) had already been fixed in `a696fb82` and `c9d46d02` respectively.
- None of the remaining findings are actively exploitable in the current state.

## Findings to Address

### HIGH-3 — `SameSite=Lax` on claim cookie

`apps/api/src/services/trial/cookies.ts:196` sets `SameSite=Lax` for both fingerprint and claim cookies. The claim cookie is functionally a bearer credential ("I own this trial project"). The auditor recommends `SameSite=Strict`.

**Acceptance criteria**:
- [ ] Verify the OAuth claim flow works end-to-end with `SameSite=Strict` on the claim cookie (github.com OAuth callback → api.sammy.party → app.sammy.party/try/:id?claim=1 → `POST /api/trial/:id/claim`)
- [ ] Keep fingerprint cookie at `Lax` (needs to survive cross-site OAuth initiation)
- [ ] Staging test with the actual OAuth flow — unit tests cannot validate browser cookie semantics
- [ ] If Strict breaks the flow, document the specific navigation that requires Lax and keep it

### HIGH-4 — `trial.ready` `workspaceUrl` derived from KV-backed record

`apps/api/src/services/trial/bridge.ts:41-43` falls back to `record.workspaceId` from KV when `opts.workspaceUrl` is absent. If the KV mirror write lagged or failed, `workspaceUrl` emits as empty string.

**Note**: The auditor's cross-trial wiring concern is invalid — `readTrialByProject` is keyed by unique `projectId`, not fingerprint. The real impact is a potentially-empty `workspaceUrl` field, which is a reliability/UX issue, not security.

**Acceptance criteria**:
- [ ] Change the ACP bridge call sites to always pass `workspaceUrl` explicitly (the caller has the workspace record in scope)
- [ ] Remove the KV-derived fallback or log a warning when it fires

### MEDIUM-2 — Sentinel installation trust assertion

`apps/api/src/durable-objects/trial-orchestrator/helpers.ts:31-36` inserts trial projects under `resolveAnonymousInstallationId(env)` — the sentinel row. If this row is ever mapped to a real GitHub App installation (misconfiguration), trial projects inherit that installation's permissions.

**Acceptance criteria**:
- [ ] Add a startup/migration-time assertion that the sentinel row has null/sentinel credentials (no real `access_token`)
- [ ] Document in `docs/architecture/trial-orchestrator.md` that the sentinel row must never map to a real installation
- [ ] Consider env var `TRIAL_INSTALLATION_IS_SENTINEL=true` as a startup check

### MEDIUM-1 — `TrialOrchestrator.getStatus()` RPC access control (hypothetical)

`getStatus()` is not currently exposed over HTTP. The auditor flagged this as future risk if an admin route is ever added.

**Acceptance criteria**:
- [ ] Add a code comment on `getStatus()` in `trial-orchestrator/index.ts` warning against unauthenticated HTTP exposure
- [ ] If admin status endpoint is needed in future, must be gated by `requireAdmin()`

### LOW items (defer to backlog-of-backlog or close as won't-fix)

- LOW-1 — `trial.ready` `workspaceUrl` disclosure to SSE subscriber: inherent to design (anonymous trial before claim). Document in architecture.
- LOW-2 — `timingSafeEqual` length oracle: migrate to `crypto.subtle.verify()` in general cookies refactor (not trial-specific).
- LOW-3 — GitHub API unauthenticated 60 req/hour: already documented; may use GitHub App token when operator sets one.

## Out of Scope

- CRITICAL-1, HIGH-1 (stale; already fixed in PR #760)
- HIGH-2 (KV rate-limiter atomicity): already deferred with documented rationale; superseded by general migration away from KV rate limiting

## References

- Merged PR: #760
- Audit task: `a35608e033ac4405a`
- Disposition comment: see PR #760 conversation thread
