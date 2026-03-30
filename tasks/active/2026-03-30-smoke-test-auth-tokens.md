# Smoke Test Auth Tokens + Automated Staging Smoke Suite

## Problem

Staging verification relies on agents manually running Playwright tests after deployment. This fails repeatedly — agents rationalize page-load checks as "feature verification" or run out of time. The core blocker for automated smoke tests is authentication: the app uses GitHub OAuth which cannot be reliably automated in CI.

## Research Findings

### Auth System
- BetterAuth handles OAuth with GitHub, session cookies for auth
- Auth routes in `apps/api/src/routes/auth.ts` — single file with catch-all route
- Auth factory in `apps/api/src/auth.ts` — creates BetterAuth instance
- Auth middleware in `apps/api/src/middleware/auth.ts` — `requireAuth()` / `optionalAuth()`
- JWT/session managed by BetterAuth (not custom JWT creation)
- Session cookie set by BetterAuth on OAuth callback

### Database
- D1 schema in `apps/api/src/db/schema.ts`
- Latest migration: `0032_agent_profile_extended_fields.sql`
- Next migration number: `0033`
- Drizzle ORM for D1; migrations in `apps/api/src/db/migrations/`

### Env Interface
- Defined in `apps/api/src/index.ts` (lines ~59-200+)
- Env vars added to interface + `.env.example` + `configure-secrets.sh`
- Feature flags follow pattern: optional string, check truthy

### Settings UI
- `apps/web/src/pages/Settings.tsx` — tab-based shell with Outlet
- SettingsContext provides credentials + reload callback
- Tabs: Cloud Provider, GitHub, Agent Keys, Agent Config, Notifications
- Forms follow: useState + API call + toast + reload pattern
- Dialog component in `packages/ui/src/components/Dialog.tsx`
- ConfirmDialog in `apps/web/src/components/ConfirmDialog.tsx`

### API Client
- `apps/web/src/lib/api.ts` — centralized `request<T>()` with cookie auth
- All endpoints prefixed `/api/`

### Testing
- Vitest for unit/worker tests; Playwright for visual audits
- Playwright config at `apps/web/playwright.config.ts`
- Playwright tests at `apps/web/tests/playwright/`
- CI workflow at `.github/workflows/ci.yml`
- Deploy staging at `.github/workflows/deploy-staging.yml`

## Implementation Checklist

### Phase 1: Token Auth Backend

- [ ] Add `SMOKE_TEST_AUTH_ENABLED` to Env interface in `apps/api/src/index.ts`
- [ ] Add `SMOKE_TEST_AUTH_ENABLED` to `.env.example` with documentation
- [ ] Add `SMOKE_TEST_AUTH_ENABLED` to `configure-secrets.sh` mapping
- [ ] Create D1 migration `0033_smoke_test_tokens.sql` with table + indexes
- [ ] Add Drizzle schema for `smoke_test_tokens` table in `schema.ts`
- [ ] Create `apps/api/src/routes/smoke-test-tokens.ts` with endpoints:
  - `GET /api/auth/smoke-test-tokens` — list tokens (requires auth + gate)
  - `POST /api/auth/smoke-test-tokens` — create token (requires auth + gate)
  - `DELETE /api/auth/smoke-test-tokens/:id` — revoke token (requires auth + gate)
  - `POST /api/auth/token-login` — login via token (gate only, no auth)
- [ ] Implement feature gate middleware/helper that returns 404 when env var unset
- [ ] Implement token generation: `sam_test_` prefix + 32 bytes crypto-random base64url
- [ ] Implement token hashing: SHA-256 of raw token, store hash only
- [ ] Implement token login: hash provided token, lookup in D1, verify not revoked, create BetterAuth session
- [ ] Update `last_used_at` on successful token login
- [ ] Add feature flag endpoint: `GET /api/auth/smoke-test-status` — returns `{ enabled: boolean }`
- [ ] Write unit tests for token generation, hashing, CRUD, login, revocation, gate behavior

### Phase 2: Token Auth UI

- [ ] Add API client functions in `apps/web/src/lib/api.ts`:
  - `getSmokeTestStatus()` — check if feature enabled
  - `listSmokeTestTokens()` — list user's tokens
  - `createSmokeTestToken(name)` — generate new token
  - `revokeSmokeTestToken(id)` — revoke token
- [ ] Create `apps/web/src/components/SmokeTestTokens.tsx` component:
  - Feature gate: only render if `smokeTestEnabled` is true
  - Token list with name, created date, last used, revoke button
  - Generate button opens dialog
  - One-time token display with copy button
- [ ] Add "Smoke Test Tokens" tab to Settings page routing
- [ ] Write component tests for the token management UI

### Phase 3: Smoke Test Suite

- [ ] Create `tests/smoke/` directory structure:
  - `helpers/auth.ts` — login via token, return authenticated browser context
  - `smoke.config.ts` — Playwright config for smoke tests
  - `health.spec.ts` — API health + page loads
  - `dashboard.spec.ts` — Dashboard renders with projects
  - `settings.spec.ts` — Settings page loads with all sections
- [ ] Create Playwright config for smoke tests (separate from visual audits)
- [ ] Implement auth helper that POSTs to `/api/auth/token-login` and captures session cookie
- [ ] Write 5+ smoke tests covering critical paths

### Phase 4: CI Integration

- [ ] Add smoke test step to `deploy-staging.yml` after deployment
- [ ] Add `SMOKE_TEST_AUTH_ENABLED` mapping in `configure-secrets.sh`
- [ ] Document token setup in deploy-staging workflow comments

### Infrastructure (Merge-Blocking)

- [ ] `SMOKE_TEST_AUTH_ENABLED` added to Env interface
- [ ] `SMOKE_TEST_AUTH_ENABLED` added to `.env.example`
- [ ] `SMOKE_TEST_AUTH_ENABLED` mapping in `configure-secrets.sh`
- [ ] D1 migration for `smoke_test_tokens` table
- [ ] Smoke test CI step configured (can be skipped if token not yet set)

## Acceptance Criteria

1. A logged-in user can generate a smoke test token from Settings (when feature enabled)
2. A logged-in user can see their tokens with name, dates, and revoke them
3. A CI system can POST a token to `/api/auth/token-login` and receive a valid session cookie
4. All endpoints return 404 when `SMOKE_TEST_AUTH_ENABLED` is not set
5. Revoked tokens are rejected immediately
6. Token is shown exactly once on creation (never returned again)
7. Smoke test suite runs successfully when given a valid token
8. CI step in deploy-staging.yml runs smoke tests after deployment

## References

- Idea: 01KMYYTZPFWPTJ62HAWPTR6RHH
- `apps/api/src/routes/auth.ts` — existing auth routes
- `apps/api/src/auth.ts` — BetterAuth factory
- `apps/api/src/db/schema.ts` — D1 schema
- `apps/web/src/pages/Settings.tsx` — settings UI
- `.github/workflows/deploy-staging.yml` — staging deployment
