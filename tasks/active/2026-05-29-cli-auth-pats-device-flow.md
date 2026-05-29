# CLI Authentication with PATs and Device Flow

## Problem

SAM CLI authentication currently requires users to manually extract a BetterAuth session cookie from the browser and pass it to `sam auth login`. The repository already has a gated smoke-test token system that can mint BetterAuth sessions, but it is hidden behind `SMOKE_TEST_AUTH_ENABLED`, uses test-only naming, and does not support first-class CLI login.

This task implements two production authentication paths:

1. Personal access tokens exposed in the settings UI and consumable via `sam auth login --token`.
2. OAuth-style device flow for interactive `sam auth login`, backed by KV and approved in the web UI.

## Research Findings

- `apps/api/src/routes/smoke-test-tokens.ts` contains the token CRUD and `POST /api/auth/token-login` implementation. The session creation and signed cookie code must be extracted before route changes so token login and device token exchange share one implementation.
- `apps/api/src/db/schema.ts` defines `smokeTestTokens` over the `smoke_test_tokens` table. No migration is needed; only TypeScript exports and imports should be renamed to `apiTokens`.
- `apps/api/src/index.ts` currently mounts token routes immediately before `authRoutes`. New `/api/auth` routes must remain before the BetterAuth catch-all.
- `apps/web/src/components/SmokeTestTokens.tsx`, `apps/web/src/pages/Settings.tsx`, `apps/web/src/pages/SettingsSmokeTestTokens.tsx`, and `apps/web/src/lib/api/misc.ts` implement the gated settings UI and must be renamed to API-token concepts.
- `packages/cli/internal/cli/run.go` only supports session-cookie login and calls `authenticatedClient(runtime)` from task/chat/workspace paths. Adding `SAM_API_TOKEN` requires `authenticatedClient(ctx, runtime)` and a network exchange.
- `packages/cli/internal/cli/client.go` already has an injectable HTTP boundary suitable for PAT/device auth exchanges.
- Relevant failure modes from postmortems/rules: Hono wildcard middleware and route-order leaks must be tested through combined route mounting; token lifecycle and revocation must be explicit; CLI changes require high-quality command-boundary tests and Go coverage.
- Staging verification must exercise real CLI, API, and browser flows on `https://api.sammy.party` and `https://app.sammy.party`.

## Implementation Checklist

- [x] Create shared API session factory service from the existing token-login session creation and cookie signing logic.
- [x] Rename smoke-test token API route/module to API tokens, remove feature gate/status endpoint, accept `sam_pat_` for new tokens and both `sam_pat_`/`sam_test_` for token login, and return `sessionCookie` in JSON.
- [x] Rename Drizzle exports and validation schemas from smoke-test names to API-token names without changing the D1 table name.
- [x] Add device-flow API routes using KV for code creation, approval, polling, one-time redemption, TTLs, and rate limiting.
- [x] Update API env interface and `.env.example` from smoke-test variables to API-token and device-flow variables.
- [x] Rename web API-token settings UI, make the tab always visible at `/settings/api-tokens`, and remove environment-gate messaging.
- [x] Add public `/device` web page with code prefill, unauthenticated login redirect with returnTo, approval submission, success, and error states.
- [x] Update Go CLI auth login to support `--token`, default interactive device flow, browser open best effort, polling, and `SAM_API_URL` + `SAM_API_TOKEN` env exchange.
- [x] Update CLI docs and any stale references from smoke-test tokens to API tokens where applicable.
- [x] Add/update API, web, and CLI tests for PATs, backward compatibility, device flow, env token exchange, and settings/device UI behavior.
- [x] Run local quality gates including CLI Go coverage and web visual audit for changed UI surfaces.
- [ ] Run specialist reviews: task-completion-validator, cloudflare-specialist, security-auditor, go-specialist, ui-ux-specialist, env-validator, doc-sync-validator, constitution-validator, and test-engineer.
- [ ] Deploy to staging and run the mandatory PAT, device-flow, edge-case, regression, and cleanup verification plan.
- [ ] Open PR, wait for CI/Sonar/staging evidence, then merge if all gates pass.

## Acceptance Criteria

- Users can generate/revoke personal access tokens from Settings -> API Tokens without a feature flag.
- New tokens use the `sam_pat_` prefix, while existing `sam_test_` tokens still authenticate through `token-login`.
- `POST /api/auth/token-login` returns a valid `sessionCookie` field in JSON and sets the cookie header.
- `sam auth login --api-url <url> --token <pat>` saves a working CLI config and reports the authenticated user.
- `SAM_API_URL` + `SAM_API_TOKEN` allow authenticated CLI commands without a config file or session cookie env var.
- `sam auth login --api-url <url>` starts a device flow, prints/open the verification URL, polls, and saves config after browser approval.
- `/device?code=XXXX-1234` is public, preserves the code through login, approves only with an authenticated user, and handles invalid/expired codes cleanly.
- Unit/integration tests cover the PAT and device-flow happy paths and edge cases, including route mounting order where relevant.
- Staging verification passes the full user-provided test plan and records evidence in the PR.

## References

- Idea `01KSTJSX5Z1HHYRAKJDR6FW4FX`
- `.claude/rules/06-api-patterns.md`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/36-cli-quality.md`
- `docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md`
- `docs/notes/2026-03-08-mcp-token-revocation-postmortem.md`
- `docs/notes/2026-05-19-cli-sonar-quality-gap-postmortem.md`
