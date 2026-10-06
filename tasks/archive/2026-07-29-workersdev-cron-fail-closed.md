# workers.dev cron setup fail-closed remediation

## Problem

The reusable staging/production deploy workflow currently attempts to initialize the account workers.dev subdomain before Worker deployment, but hard failures only emit a warning and allow the deploy to continue. Cloudflare cron triggers may not work unless the workers.dev subdomain prerequisite is configured, so deployment must fail closed by default or use a clearly named explicit degraded-mode override.

## Research findings

- `.github/workflows/deploy.yml` and `.github/workflows/deploy-staging.yml` both call `.github/workflows/deploy-reusable.yml`; the reusable workflow is the single target.
- `.github/workflows/deploy-reusable.yml` step `Ensure workers.dev Subdomain` treats 2xx and 409 as success, but warns/continues for every other HTTP result.
- Existing workflow static tests live in `scripts/quality/deploy-reusable-workflow.test.ts`.
- Related deployment hardening task `tasks/archive/2026-07-18-safe-d1-migration-deploy-order.md` uses the same static workflow-test pattern for deployment gates.
- Public docs mention self-hosting/deployment configuration, but this fix preserves default success behavior and only changes failed prerequisite handling; public docs are only needed if an explicit operator override is added.

## Implementation checklist

- [x] Change `Ensure workers.dev Subdomain` to fail closed by default for non-2xx/non-409 responses.
- [x] Add a clearly named degraded-mode override only if needed.
- [x] Preserve successful 2xx deploy behavior.
- [x] Preserve 409 already-configured deploy behavior.
- [x] Add tests for success, 409 already-enabled, hard failure, and explicit override if implemented.
- [x] Run targeted workflow quality tests.
- [x] Run broader relevant validation.
- [x] Complete local Cloudflare/security/test/task-completion reviews.
- [ ] Open PR and do not merge.

## Acceptance criteria

- Deployment exits non-zero by default when workers.dev subdomain setup cannot be configured/verified.
- 2xx and 409 responses continue to pass.
- Any degraded-mode path is explicitly named and opt-in.
- Static tests prove the shell behavior branches.
- PR includes test evidence, CI status, and no-breaking-change/deploy-risk rationale.

