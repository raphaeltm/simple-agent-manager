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
- [ ] Independent adversarial design review and threat model; static callback URIs
- [ ] Step-up, session-bound explicit linking (GitHub/GitLab only), callback enforcement
- [ ] Preserve verified SAM email across differently emailed provider sign-ins
- [ ] Owner notification and safe unlink without lockout
- [ ] Email-code guard prevents provider/session loss (F15)
- [ ] Token errors distinguish unconnected, expired, provider outage (F14), configuration and unavailable feature
- [ ] Connected accounts, onboarding gate, auth banner, app section and member warnings use one canonical operation
- [ ] Behavioral real-library/SQL regressions; adversarial controls; mobile/desktop Playwright audit
- [ ] Docs and API contract sync, local checks and all specialist reviews
- [ ] Both staging leases checked; approved GitHub identity; real login/link/notification/unlink/Google refusal/session IP
- [ ] Draft PR, ready CI, CodeRabbit request/wait, gates, merge and production smoke; idea/channel update

## Acceptance criteria
Email user completes step-up then links different-email GitHub, returns with unchanged SAM email, gets email notification and can unlink while retaining sign-in. Stale/stolen session without step-up, Google linking, cross-user and revoked-session callbacks are refused without mutations. Existing GitHub login still works. Unverified provider users cannot redeem email code or lose links/sessions. GitHub 503 is retryable, never authorization-expired; email-only users get Connect GitHub. UI is accessible at 375/1280 in both themes. Required independent reviews and real staging proof precede merge.

## References
SAM task 01M7KNB1V0BPYHJQSN5MFZBVEW; idea 01M72M9AEB933ZY8269D376DKC; integration origin/sam/selfhost-pass-2; decisions D4/C5/C6/C8/F1/F14/F15. Rules 11,17,19,24,28,30,48,62,77; /do and sam-glass.
