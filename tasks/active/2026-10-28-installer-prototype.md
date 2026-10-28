# Standalone Cloudflare installer prototype

Build the first authorization/handoff vertical slice discussed with Raphaël. Independent app and deployment at install.${BASE_DOMAIN}; staging install.sammy.party, production install.simple-agent-manager.org. Hosted and self-hosted app share code. Full SAM builds/updates are follow-up, visibly unavailable in prototype.

Research: design v4 SAM idea 01M60R60ZQT4203MGXAVJNPRH5. Cloudflare confidential OAuth supported; API CORS avoided by Worker-side calls. New OAuth clients private by default. Public promotion permanent and requires DNS verification. Stage private first. Existing staging debugging token cannot deploy; use GitHub environments/deployment pipeline.

- [x] Standalone Worker UI, OAuth with expiring server-side sessions, account selection
- [x] Authenticated user-owned bootstrap Worker, explicit handoff and cleanup
- [x] Configuration/deploy scripts, canonical-only directory-scoped staging/production workflow
- [x] Public hosted/self-hosted guide and app README
- [x] Tests: callback replay/expiry, CSRF, account isolation, cleanup, upstream failures
- [x] Mobile/desktop browser screenshots and overflow assertions
- [x] Specialist code review, staging Worker deployment, public endpoint and mobile/desktop checks
- [ ] Configure OAuth client and verify real Cloudflare consent
- [ ] PR with validation and explicit prototype limitations

Acceptance: no marketing/main-app storage or session dependency; no cloud tokens in browser/logs/URLs; deployments do not run in forks; env-derived domain; user gets clear bounded prototype outcome; self-host instructions reproducible; staging address serves verified build.

Workflow adjustment: reuse SAM-provided isolated branch/workspace and task file on that branch, avoid unrelated main task commit. New installer pipeline replaces whole-platform staging deployment for this isolated app.

Validation: 12 tests, lint/typecheck/dry-run build, public-doc build/link checks and 12 browser screenshots pass; real local cross-site form/redirect/cookie handoff passes. Security and completion reviewers passed code. Staging run 40679197642 deployed the Worker but OAuth client configuration returned403; requested OAuth Client Read/Write on staging deployment token. Live API evidence identified wildcard `*.sammy.party/*` interception; deployment now adds exact installer hostname route. New bounded staging smoke provisions/checks/deletes a temporary Worker independently of OAuth consent.

Staging run [40680257534](https://github.com/raphaeltm/simple-agent-manager/actions/runs/40680257534): temporary Worker provisioning, anonymous401, ownership handoff and cleanup passed; exact routing fixed. Live install.sammy.party serves build23852a97f; mobile/desktop screenshots reviewed, no overflow, login correctly disabled. Real endpoint checks: foreign-Origin403, unconfigured sign-in503, anonymous session401, privacy200. OAuth provisioning403 is the remaining blocker; no real consent success claimed. Production configured but not deployed. Branch5151bdeef adds public prerequisite correction. PR held until staging OAuth verification per /do phase6 gate.
