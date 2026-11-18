# Diagnose staging auth read failures and preserve their sanitized cause

## Problem
Primary staging intermittently returns HTTP503 AUTH_UNAVAILABLE from authenticated routes and occasionally HTTP500 from /api/auth/list-accounts. readAuthSession/withAuthReadDeadline conceals whether the original failure was IoTimeoutError, AdminSettingsUnavailableError, login configuration resolution/decryption, or another exception. A clean direct D1 query cannot distinguish these paths. Preserve safe classifications and stage/attempt duration without session tokens, secrets, SQL parameters, cookies, or account identity.

## Evidence
- L9/L10 PR2830 exact20a155 normal primary deployment44220668713 and smoke tests succeeded2026-11-18. Security/provider refusal/session-IP/hybridUI checks passed02:29; separate primary regression02:30:50–02:31:11 observed /api/auth/list-accounts500 plus console error.
- Bounded Worker tail02:37:08–02:37:59 confirmed deliberate503/outcome=ok/no exceptions from credentials, project overview/inbox, projects, cc attachments and get-session;15 new Session verification is temporarily unavailable errors persisted in observability D1.
- Earlier holder task01M7NBB7PJCTYXS7MY1T1DTGZ3 saw intermittent503 on a different exact head before the L9 deploy. At02:29 the standard24h observability gate had72 session-verification errors, all before02:05, plus five historical node/snapshot/GCP groups. Intermittency is established; a common root cause is not.
- No timeout/attempt platform overrides; defaults5000ms and2 attempts. platform_settings row types valid; direct D1 configuration queries349/238ms at02:40. These are controls, not proof of healthy Worker-binding I/O.
- New real BetterAuth/SQLite regressions sign in through OAuth then send missing/forged proof3x, read production get-session/list-accounts repeatedly/concurrently and after61s cache turnover. All50 focused tests pass; session/account tokens unchanged. Synchronous SQLite cannot emulate Cloudflare distributed D1 stalls.
- read-auth-session.ts, admin-settings-cache.ts and d1-session.ts match main0c672. resolveAdminSettingDetailsMany wraps all errors as AdminSettingsUnavailableError, so configuration/decryption errors can resemble D1 unavailability. No secret was read back or decrypted in a runner.
- All created sessions signed out, tail deleted, primary lease released successfully in44224873202; no fixture provider links modified, new principals or VMs created. L9 merge remains blocked until a clean final-head staging regression; failed live runs are not waived.

## Investigation / acceptance
- [ ] Preserve sanitized original error category and operation/attempt timing at the boundary before errors are wrapped; test redaction explicitly.
- [ ] Trace cold/warm configuration and authoritative-session I/O, including cross-request cache/session behavior and request cancellation.
- [ ] Separate Worker/D1 latency, configuration validation/decryption, exhausted deadline and adapter failures using evidence; do not infer from503 alone.
- [ ] Reproduce through production auth routing in real Worker/Miniflare and the distributed staging environment where necessary; no weakening auth validation or increasing deadlines without measured cause.
- [ ] Add discriminating regression coverage for the identified cause and verify concurrent get-session/list-accounts remains healthy.

Source: task01M7KNB1V0BPYHJQSN5MFZBVEW, coordinator01M7JMXS2JRW6QQMB1356ENPM3, PR2830. Related code: apps/api/src/services/read-auth-session.ts, admin-settings-cache.ts, admin-settings-resolution.ts, platform-config-login.ts. Durable evidence: PR2830 Staging Verification; sam/pr2830-visual-evidence (evidence only, never merge).

## PR2830 ordinary authentication I/O audit
Independent source audit: zero D1/external-call delta. Assumptions: valid session, no refresh due, adapter joins disabled, configuration snapshots warm. Endpoint-owned data reads excluded.

| Entry point | Before | After | D1 operations |
|---|---:|---:|---|
| requireAuth | 3 | 3 | approval1 +session/user2 |
| optionalAuth | 2 | 2 | session/user2 |
| raw get-session with accepted cookie cache | 0 | 0 | no session SQL |
| authoritative get-session | 2 | 2 | session/user2 |
| list-accounts | 5 | 5 | agent-session precheck2 +cache-stripped handler session/user2 +accounts1 |

Cold/expired configuration adds2 shared reads in both versions: platform_settings and enabled integration credentials. withAuthReadDeadline limit resolution shares the settings snapshot. Due session refresh adds1 UPDATE in both versions. New accountLinkingPlugin hooks match only /link-social and /unlink-account; validateLinkUserInfo does work only for link-account; keepLinkedAccountEmail adds1 lookup only in provider getUserInfo during OAuth, never ordinary session reads. Sources: middleware/auth.ts requireAuth/optionalAuth; routes/auth.ts get-session and generic auth handler; services/read-auth-session.ts withAuthReadDeadline; services/platform-config-login.ts resolveLoginOAuthConfig; services/admin-settings-cache.ts loadOverrides; services/admin-settings-resolution.ts integration credential snapshot; services/account-linking.ts; services/linked-account-identity.ts.
