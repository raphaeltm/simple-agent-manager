# Self-host L9/L10: connected GitHub and GitLab accounts

## Problem
Email/Google users need a GitHub identity for GitHub-backed work. Explicit linking must resist session theft, preserve the SAM email, notify its owner and support unlink. Google linking remains refused.

## Research
- BetterAuth 1.7.14 link-social checks a session but not freshness; OAuth callback trusts state.link. Bind step-up and callback to an authoritative live session.
- Email OTP revokes provider accounts when email_verified=0: deny issuance/redemption for unverified provider-linked users, with a provider sign-in email.
- Main has admin-only account-linked alerts; notify the affected account owner for all roles.
- Integration slice preserves verified linked email but fails open on DB errors: preserve identity fail closed.
- Repo-hosting lives in packages/repo-hosting; port only relevant contracts, no cherry-picks.
- StagingTestResources and verification reference have no approved interactive GitHub identity. Coordinator informed on feature.selfhost-landing; real OAuth staging evidence blocks merge.

## Checklist
- [x] Independent adversarial design review and threat model; static callback URIs
- [x] Step-up, session-bound explicit linking (GitHub/GitLab only), callback enforcement
- [x] Preserve verified SAM email across differently emailed provider sign-ins
- [x] Owner notification and safe unlink without lockout
- [x] Email-code guard prevents provider/session loss (F15)
- [x] Token errors distinguish unconnected, expired, provider outage (F14), configuration and unavailable feature
- [x] Connected accounts, onboarding gate, auth banner, app section and member warnings use one canonical operation
- [x] Behavioral real-library/SQL regressions; adversarial controls; mobile/desktop Playwright audit
- [x] Docs and API contract sync, local checks and all specialist reviews
- [ ] Both staging leases checked; approved GitHub identity; real login/link/notification/unlink/Google refusal/session IP
- [ ] Draft PR, ready CI, CodeRabbit request/wait, gates, merge and production smoke; idea/channel update

## Acceptance criteria
Email user completes step-up then links different-email GitHub, returns with unchanged SAM email, gets email notification and can unlink while retaining sign-in. Stale/stolen session without step-up, Google linking, cross-user and revoked-session callbacks are refused without mutations. Existing GitHub login still works. Unverified provider users cannot redeem email code or lose links/sessions. GitHub 503 is retryable, never authorization-expired; email-only users get Connect GitHub. UI is accessible at 375/1280 in both themes. Required independent reviews and real staging proof precede merge.

## References
SAM task 01M7KNB1V0BPYHJQSN5MFZBVEW; idea 01M72M9AEB933ZY8269D376DKC; integration origin/sam/selfhost-pass-2; decisions D4/C5/C6/C8/F1/F14/F15. Rules 11,17,19,24,28,30,48,62,77; /do and sam-glass.

## Validation checkpoint
Independent security design/final reviews PASS; unlink concurrency fixed and reverified. Test-engineer real BetterAuth/SQLite auth and regression suites91/91; token/route contracts27/27; web5378 tests PASS; UI production-build Playwright40/40 in both themes at375/1280 with discriminating overflow/onboarding checks. Full checks rerun pending. Proof TTL uses existing D1 admin settings (OAuth category), default300sec range60..900; no new environment/deploy configuration. Real staging OAuth, owner email delivery and storedIP still blocked on approved GitHub interactive test identity/inbox; coordinator notified. PR2830 remains unmerged.

## Final review corrections
Sonar reported12 small maintainability/accessibility findings; resolved without changing authentication semantics (label variables, setter naming, decorative SVGs, readonly props, repeated predicate and invite-token loop). Full local run38/39: web425files passed, API16,478 passed/1failed. The new real-route TTL override test exposed OAuth-category legacy string-only resolution rejecting a numeric override. Moved the emailed proof lifetime to the existing Email category and guide path; focused32/32 passes; final full API rerun in progress. This is a real setting-boundary bug, not a flake; no test bypass. Security independently reverified.

## Resumed release checkpoint (2026-11-17)
Full API final run16479passed/4skipped/0failed, web5378passed, local production UI40/40 passed; all required independent reviews completed PASS/ADDRESSED. Proof TTL is in **Email**, not the legacy OAuth category; real numeric override regression passes.

Raphaël explicitly approved Inbox `ask:01M7M9GFK90E73NBPWQ14KBESD` at09:02:34UTC: “C: Merge without the live run (I approve the exception)”. This waives only real GitHub login/consent/link, external mail delivery and unlinking a real provider. Returning-user, step-up/callback/replay/stolen-session, preserved-email, owner notification invocation and safe unlink are covered by real BetterAuth/SQLite vertical slices with external HTTP/mail faked. No accounts created or personal/production credentials used.

Main e5c5aa4f7 merged; additive settings conflicts independently reviewed PASS. Fresh lint22/22, typecheck36/36, build18/18, real auth81/81 and settings34/34 PASS. Initial checks required frozen-lockfile installation of main's new dependency; no lockfile/code workaround.

CI44053442421 passed API/web/package/Workers tests and Sonar0newissues. PR Evidence initially saw the old human-review label; exception is now documented and label removed. One existing chat-switching browser assertion expected the pre-#2760 exact tail cursor; the test mock also ignored the sequence bound. Correct the fixture to full ordered cursors and explicitly exercise cached-return refresh, proving stale expectation fails. Auth/product code remains unchanged.

Remaining release gates: final-head fullCI; normal exact-head staging deployment; workload/token sign-in; Settings375/1280; step-up initiation and missing-proof refusal; Google refusal; stored sessionIP; missing-link403 connect prompt; API/console checks; cleanup/lease release; archive, merge, production monitoring and idea/channel completion. These are not waived. Staging2 reserved, queued turn and durable wake recorded in local state. Final operational evidence belongs in PR2830's Staging Verification section.

Test repair review PASS: full tuple cursor comparison and guaranteed cached-return refresh preserve explicit older-history admission. Reverting only the expected overlap sequence causes both mobile/desktop assertions to fail; restored. Desktop comment locator updated to its real accessible name. This is test-only CI maintenance in the same audit file, with no production behavior change. Final live/CI/merge evidence is tracked in PR2830; task record archived after independent implementation-completion review, operational completion remains pending.

## 13:36UTC release checkpoint
Head5335 synchronized main3026. Full CI44079543475 failed exactly one inherited Insights test: the fixed 2026-11-16 usage window expired against the account port's real Date.now; dependent aggregates failed. Pre-fix failure reproduced locally. Stabilized Date.now to the fixture's NOW and restored after each test; no assertions or production behavior changed. Both real-SQL fixture suites34/34 and lint PASS; independent review PASS. Fresh final-head full CI required.

Raphaël policy795e72a6 forbids deployment secret readback/copy. Cancelled own acquire44079483526 and deploy44079532166 before deployment (deploy SKIPPED). Release44080703973 SUCCESS, holder absent and own reservation removed, next peer notified. No live staging writes/tests occurred. Deployment waits safe-secret PR2841 merge, then sync/review workflow and requeue; all non-OAuth staging checks remain required.

## 14:39UTC CI checkpoint
Head7a7243 fullCI44094515002 passed the repaired Insights shard but failed exactly one inherited #2688 concurrency test at runtime-secret-requests.test.ts:777. First launched request is not guaranteed first database batch due async encryption; test incorrectly assumed it. Added a first-batch-reached barrier before launching second submit, while holding first transaction until both pass pending prechecks. All original winner/loser/value/provenance/notification/redaction assertions retained. Full suite39/39, ESLint/diff checks and independent review PASS. E2E44094515052SUCCESS. Fresh fullCI required after test-only repair. Safe-deploy dependency2841 remainsOPEN with failingAPI2/3; owner notified, no staging deploy/checks performed.

## 2026-11-18 live verification and release blocker
Safe main0c672 synchronized in20a155; fullCI44126193004 and E2E44126193179 SUCCESS. Normal primary staging deployment44220668713 SUCCESS including smoke tests. Both approved token fixtures already have GitHub linked; no email-only principal exists. Coordinator explicitly approved hybrid UI evidence intercepting only the browser read-only list-accounts response to omit GitHub. No principals were created or provider links modified.

Live unmocked secondary checks PASS: sign-in, verified session, missing/forged GitLab proof403 LINK_STEP_UP_REQUIRED, Google400 LINK_PROVIDER_REFUSED, account links unchanged, real Connect GitHub click and confirmation-email request200, stored session IP matches Cloudflare trace, health200 and sign-out200. Hybrid ConnectedAccounts375/1280 screenshots/overflow checks passed without API5xx/page/console errors. Durable evidence branch sam/pr2830-visual-evidence commitdca117534; never merge this evidence branch. Real OAuth/mail/unlink exception remains scoped as above. Auth banner/member warning local audits cover triggers absent from linked fixtures; no additional endpoints intercepted. Onboarding GitHub gate is skipped for existing projects/installations on these fixtures.

**Merge blocker:** subsequent primary regression02:30:50–02:31:11 observed list-accounts500. Bounded Worker-tail reproduction02:37:08–02:37:59 observed broad AUTH_UNAVAILABLE503 across get-session, credentials, projects/overview/inbox and cc attachments;15 new session-verification errors persisted. All sessions signed out200; tail deleted. Normal release44224873202 SUCCESS;02:42:31 status holderNULL, next queued task notified. No live writes/jobs, VMs or fixtures remain. Root cause remains unknown; no blind redeploy or merge. Earlier six observability noise groups predated02:05 deployment request entirely, but the new errors are explicitly not exempted by that baseline.

Added two production-route real BetterAuth/SQLite regressions for existing GitHub sign-in followed by missing/forged proof3x, repeated get-session/list-accounts, three concurrent paired reads and61s cache turnover. All50 focused linking/OAuth/F15/refresh tests PASS, ESLint PASS; persisted session/account tokens and verified email unchanged. get-session uses production readAuthSession/withAuthReadDeadline. Limitation: synchronous SQLite D1 adapter cannot emulate Cloudflare distributed D1 stalls/deadlines; no claim that local green clears the live failure. Runtime D1 has no auth-read timeout/attempt overrides, platform_settings types valid, direct config reads349/238ms at02:40. Independent local cache/deadline investigation continues; coordinator requires root cause report before redeploy.
