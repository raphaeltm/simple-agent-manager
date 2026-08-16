# Make Account Suspension an Unconditional Access-Denial Boundary

## Problem

CTO-A1-001 identified a bypass where a `suspended` user can keep access when signup approval is disabled. The shared approval guard in `apps/api/src/services/signup-approval.ts` returns early for `requireApproval=false`, before checking `user.status === 'suspended'`. Route middleware in `apps/api/src/middleware/auth.ts` also returns early on the same configuration before evaluating the authenticated user's status.

Suspension must be an unconditional access-denial boundary regardless of signup-approval configuration or admin role. Active users and the established pending-user behavior must remain API-compatible.

## Preflight Classification

- `security-sensitive-change`: account status controls authenticated access.
- `business-logic-change`: user status and signup approval configuration interact.
- `public-surface-change`: API responses for suspended users intentionally change from allowed to 403; valid active/pending controls must remain unchanged.
- `cross-component-change`: BetterAuth browser sessions, API-token login, and device-token login share `apps/api/src/services/signup-approval.ts` through middleware and `apps/api/src/services/session-factory.ts`.

## Research Findings

- `apps/api/src/services/signup-approval.ts` centralizes runtime signup-approval configuration and session-gate logic. Current `assertUserAllowedBySignupApproval()` returns before suspended-user rejection when approval is disabled.
- `apps/api/src/middleware/auth.ts` projects BetterAuth session `role` and `status` into `auth` context. `requireApproved()` currently returns before checking status when approval is disabled, and also lets admins pass before suspended-user rejection when approval is enabled.
- `apps/api/src/services/session-factory.ts` calls `assertSessionUserApproved()` before creating session cookies for non-OAuth session creation.
- `apps/api/src/routes/api-tokens.ts` uses `buildSessionLoginResponse()` for `POST /api/auth/token-login`; this covers CLI/PAT redemption while preserving existing response bodies for active users.
- `apps/api/src/routes/device-flow.ts` uses `buildSessionLoginResponse()` for `POST /api/auth/device/token`; this covers device-flow session creation while preserving existing response bodies for active users.
- Browser-session audit found most app routes use `requireAuth(), requireApproved()`. A small set (`apps/api/src/routes/sam.ts`, `apps/api/src/routes/project-agent.ts`, and `apps/api/src/routes/trial/claim.ts`) used `requireAuth()` without `requireApproved()`, so suspended-user denial must live in `requireAuth()` itself. `optionalAuth()` must avoid attaching suspended users as authenticated context for optional flows such as GitHub installation callback handling.
- `apps/api/src/auth.ts` login-time self-heal already excludes `status='suspended'` from automatic superadmin promotion.
- Public docs in `apps/www/src/content/docs/docs/guides/self-hosting.mdx` already state login-time self-heal applies to OAuth, token-login, and device-flow and never auto-promotes suspended users. No user/operator doc update is needed for this narrow internal enforcement fix.
- Relevant incident/task history:
  - `tasks/active/2026-07-06-signup-approval-config.md` documents that turning approval off lets pending users pass without rewriting them to active.
  - `tasks/archive/2026-03-12-fix-workspace-callback-auth-middleware-leak.md` and `tasks/archive/2026-05-12-fix-agent-auth-failures.md` document auth middleware boundary mistakes and the need to test mounted route behavior, not just isolated helpers.
- Previous SAM task `01KZTNV7NP5Z71QX51P4DDTVZV` / branch `sam/account-suspension-unconditional-immediate-ddtvzv` has no task-specific commits beyond its old base and no PR.

## Implementation Checklist

- [x] Add discriminating tests for active/pending/suspended/admin users with signup approval on/off at the shared approval-service boundary.
- [x] Add route/middleware tests proving `requireApproved()` denies suspended users regardless of approval config and role, while preserving active/pending behavior.
- [x] Add session-factory/API-token coverage proving PAT login inherits the centralized suspension denial and active login response remains unchanged.
- [x] Add device-flow coverage proving device-token redemption inherits the centralized suspension denial and active redemption remains unchanged.
- [x] Implement the narrow centralized fix without changing valid-user response schemas.
- [x] Add a minimal process guard for the bug class if existing rules do not already cover unconditional account-status denial.
- [x] Run focused tests and proportionate repository gates.
- [x] Complete mandatory specialist reviews: security-auditor, cloudflare-specialist, test-engineer, constitution-validator.
- [x] Complete final task-completion-validator review before archive.
- [x] Archive this task record on the feature branch before PR creation.

## Acceptance Criteria

- [x] Suspended users are denied with 403 regardless of signup approval on/off.
- [x] Suspended admin and superadmin users are denied; admin role cannot bypass suspension.
- [x] Active users continue to pass with signup approval on/off.
- [x] Pending non-admin users continue to pass only when signup approval is off and receive the established `APPROVAL_REQUIRED` 403 when it is on.
- [x] API-token and device-token session creation for active users preserve the established success body/cookie behavior.
- [x] API-token and device-token session creation for suspended users do not create sessions.
- [x] Browser-session route middleware and PAT/device redemption paths are traced to the same centralized check.
- [x] No staging deployment or staging mutation is performed for this PR per explicit user instruction.
- [ ] CI is monitored and fixed until every applicable check is terminal green; PR remains open and unmerged.

## Post-Mortem

### What broke

Suspended users could continue accessing authenticated SAM routes and session-creation paths when signup approval was disabled.

### Root cause

The approval guard modeled signup approval as the top-level gate and returned immediately when approval was disabled. That made `status='suspended'` a child condition of signup approval instead of an unconditional account-state denial.

### Timeline

The runtime signup approval configuration work documented in `tasks/active/2026-07-06-signup-approval-config.md` introduced the shared resolver/gate shape. The CTO audit task `01M048XHK36SVM6RD8QE84W9G1` later identified CTO-A1-001 and supplied current code evidence at `apps/api/src/services/signup-approval.ts` and `apps/api/src/middleware/auth.ts`.

### Why it was not caught

Existing tests covered runtime override behavior for pending users, but did not include an active/pending/suspended/admin matrix across approval on/off. The missing negative controls allowed a security status to depend on an unrelated feature flag.

### Class of bug

Security-denial boundary nested under a feature/configuration gate.

### Process fix

Add a narrow agent rule requiring account-denial statuses such as suspension to be tested as unconditional before feature-flag or role bypasses are allowed.

## Validation

- `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/signup-approval.test.ts tests/unit/middleware/require-approved.test.ts tests/unit/routes/api-tokens.test.ts tests/unit/routes/device-flow.test.ts` failed before implementation with 10 expected suspended-user bypass failures.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/signup-approval.test.ts tests/unit/middleware/auth.test.ts tests/unit/middleware/require-approved.test.ts tests/unit/routes/api-tokens.test.ts tests/unit/routes/device-flow.test.ts` passed after implementation: 5 files, 45 tests.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/routes/auth-logging.test.ts tests/unit/workspace-proxy-ownership.test.ts tests/unit/services/signup-approval.test.ts tests/unit/middleware/auth.test.ts tests/unit/middleware/require-approved.test.ts tests/unit/routes/api-tokens.test.ts tests/unit/routes/device-flow.test.ts` passed after security/test/cloudflare follow-up fixes: 7 files, 59 tests.
- `pnpm --filter @simple-agent-manager/api lint` passed.
- `pnpm --filter @simple-agent-manager/api typecheck` passed.
- `pnpm --filter @simple-agent-manager/api test` passed: 543 files, 7290 tests.
- `pnpm --filter @simple-agent-manager/api build` passed.
- `pnpm check:fast` passed. Existing non-blocking diagnostics remained: format ratchet reports 2017/2225 unformatted files while staying within ratchet; oxlint reports advisory diagnostics; existing web/acp-client lint warnings remain.
- `pnpm typecheck` passed.
- `pnpm build` passed. Existing non-blocking API build warning remained: no output files found for `@simple-agent-manager/api#build`.
- Repository-wide `pnpm test` failed once under full Turbo concurrency with unrelated API timeout/import-hook failures in 15 existing files. The changed auth-focused tests were green in that run; rerunning the exact 15 failed API files directly with `pnpm --filter @simple-agent-manager/api test -- ...` passed: 15 files, 186 tests. The full API-only suite later passed, so this is recorded as an existing concurrency flake rather than task regression.

## Specialist Review Evidence

- `security-auditor`: Initial local review failed direct `getAuthenticatedUser()` paths and side effects before denied session creation. Follow-up passed after protecting direct API-token management, device approve/token exchange, `/api/auth/me`, and workspace proxy fallback paths.
- `cloudflare-specialist`: Initial local review warned that BetterAuth cookie cache could leave stale active session data for up to five minutes. Follow-up passed after auth gates request `disableCookieCache` and no D1/KV/R2/wrangler changes were introduced.
- `test-engineer`: Initial review passed core matrix tests but warned about direct session routes. Final review passed after adding `/api/auth/me` and workspace proxy fallback tests; final focused suite covered 7 files / 59 tests.
- `constitution-validator`: Passed. No Principle XI hardcoded-value violations; fixed BetterAuth `disableCookieCache` call option and test fixture literals are not configurable business constants.
- `task-completion-validator`: Passed with procedural warnings only: exclude unrelated `.codex/config.toml`, include the new `require-approved` test and archived task record intentionally, and monitor post-PR CI while keeping the PR open/unmerged and avoiding staging/deploy.
