# Trial Onboarding — Wave 0: Foundation

**Status**: Active
**Branch**: `sam/role-larger-workflow-wave-01kph2` (off `sam/trial-onboarding-mvp`)
**Parent task**: `01KPH19V0BPGYZ4J517NDX6ARR` · **Idea**: `01KPGJQ853C44JEREXWEZS1GQ8`
**Owner**: subtask `01KPH22XQDA8V44JH61CHAQAB8`

## Objective

Lay down the foundation for a zero-friction URL-to-workspace onboarding MVP so that the 4 parallel Wave 1 tracks (core API, DO + provisioning, SSE + frontend, claim/waitlist) can proceed without merge conflicts.

**Out of scope**: any endpoint wiring beyond 501 stubs; any real provisioning; any frontend beyond stubs; any deploy/staging verification (orchestrator handles).

## Research & Findings

### Repo conventions confirmed
- **Wrangler**: top-level only (no `[env.*]` in checked-in config — generated at deploy time by `scripts/deploy/sync-wrangler-config.ts`). Rule 07.
- **Hono routing**: mount subrouters via `app.route('/', subRouter)`. Wildcard middleware leaks across sibling subrouters — use per-route middleware. Rule 06.
- **Error handling**: throw `AppError`; the global `app.onError()` catches and returns JSON. NEVER use middleware try/catch on subrouters.
- **Shared package**: uses `zod` today; task mandates `valibot` — added to pnpm catalog at `0.42.1`.
- **DB migrations**: next number is **0043** (two entries at 0042: `0042_project_agent_defaults.sql`, `0042_project_scoped_credentials.sql`).
- **Wrangler DO migration tag**: next tag is **v7** (current head is `v6`).
- **Existing `trial.ts` route**: at `/api/trial-status` — different path from new `/api/trial/...` endpoints, no conflict.

### System user seed impact audit
Checked queries that read from `users`:
- `apps/api/src/routes/projects/crud.ts` — all filter by `eq(schema.projects.userId, userId)` where `userId = getUserId(c)`. Seeded id `system_anonymous_trials` will never match an authenticated user's id. **Safe.**
- `apps/api/src/routes/admin.ts` list query (unfiltered) — will show the system user row. **Not a `userId` filter**, so not in scope of the constraint. Noted as follow-up for admin UI (add exclusion or dedicated role filter in Wave 1+).
- BetterAuth users table shape tolerates the seed: `id`, `email` are NOT NULL; everything else has defaults (`emailVerified=false`, `role='user'`, `status='active'`, timestamps auto).

### Non-negotiables
- **Valibot** (not Zod) for new trial validation.
- **Principle XI**: no hardcoded URLs/timeouts/limits — use `DEFAULT_*` constants + env overrides.
- **Constant-time compare** in HMAC verification (prevents timing oracle).
- **No `[env.*]`** in `wrangler.toml`.

## Implementation Checklist

- [ ] `packages/shared/src/trial.ts` — types, Valibot schemas, cookie name constants, `TRIAL_ANONYMOUS_USER_ID`, `TrialErrorCode`
- [ ] Export from `packages/shared/src/index.ts`
- [ ] Add `valibot` to pnpm catalog + shared package.json
- [ ] Migration `0043_trial_foundation.sql` — system user seed + `trial_waitlist` table + unique index
- [ ] Update `apps/api/src/db/schema.ts` with `trialWaitlist` Drizzle table
- [ ] Wrangler: `TrialCounter` DO binding, `v7` migration, trial env vars
- [ ] Env type: add `TRIAL_COUNTER`, trial vars + `TRIAL_CLAIM_TOKEN_SECRET`
- [ ] `apps/api/src/services/trial/cookies.ts` — HMAC sign/verify (constant-time), cookie builders
- [ ] `apps/api/src/services/trial/kill-switch.ts` — KV-backed with 30s cache
- [ ] `apps/api/src/services/trial/discovery-prompt.ts` — prompt + version constant
- [ ] Route stubs returning 501 `{ error: 'not_implemented', wave: 'wave-1' }` for create/events/claim/waitlist/status
- [ ] Mount `trialRoutes` at `/api/trial` in `apps/api/src/index.ts`
- [ ] `apps/api/src/durable-objects/trial-counter.ts` — TrialCounter DO (SQLite transaction)
- [ ] Export `TrialCounter` from `apps/api/src/index.ts`
- [ ] `apps/web/src/pages/Try.tsx`, `TryDiscovery.tsx` stubs
- [ ] Mount `/try` and `/try/:trialId` in web router
- [ ] `docs/guides/trial-configuration.md` + link from `self-hosting.md`
- [ ] Unit tests: cookies (sign→verify round trip, tamper rejection, constant-time), kill-switch (cache/ttl), TrialCounter (atomic increment)
- [ ] Quality gates: `pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm quality:wrangler-bindings`
- [ ] Push branch

## Acceptance Criteria

- [ ] All Wave 1 tracks can import their needed types from `@simple-agent-manager/shared`
- [ ] `wrangler.toml` passes `quality:wrangler-bindings` (no `env.*`, TRIAL_COUNTER present at top-level, v7 migration added)
- [ ] DB migration applies cleanly and seed is idempotent (`ON CONFLICT DO NOTHING`)
- [ ] 501 stubs return the expected JSON (verified via unit/integration test)
- [ ] TrialCounter atomically increments/decrements within a single transaction
- [ ] Build/typecheck/lint/test all green
- [ ] Branch pushed; **no PR opened** (orchestrator integrates)

## Notes

- Skipping Phase 6 (staging) and Phase 7 PR creation per parent task instructions.
- Admin user list will include system user row — add to backlog for Wave 1+ UI polish.
- `valibot` added at `0.42.1` (current stable); schemas kept small + reused across Wave 1 tracks.
