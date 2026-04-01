# Eliminate `as any` Casts and Unsafe Type Assertions

## Problem

The API worker and web UI contain ~25 instances of unsafe type assertions (`as any`, `as string`, unvalidated `JSON.parse`, bare `slice(7)`) that hide potential runtime errors and weaken TypeScript's type safety guarantees.

## Research Findings

### Key Files
- **Notification service**: `apps/api/src/services/notification.ts` expects `NotificationEnv { NOTIFICATION, DATABASE }` — `Env` is a structural superset, so `as any` is unnecessary
- **Bearer token pattern**: 6 locations use `authHeader.slice(7)` without checking the token is non-empty after slicing
- **`parsePositiveInt`**: Already in `apps/api/src/lib/route-helpers.ts`, accepts `string | undefined` — env var `as string` casts are unnecessary
- **Task status**: No `isTaskStatus` guard exists in shared; `canTransitionTaskStatus` expects `TaskStatus` but DB returns `string`
- **Existing lib dir**: `apps/api/src/lib/` exists with `errors.ts`, `route-helpers.ts`, etc. — good home for `extractBearerToken`
- **ScalingSettings**: `Project` type already has all 8 scaling params as optional fields — `as any` unnecessary
- **ProjectChat silent catches**: Lines 330, 338 swallow errors silently; line 384 is intentional (cosmetic task titles)

### No `isTaskStatus` in shared
Need to add a `TASK_STATUSES` array and `isTaskStatus()` guard to `packages/shared/src/types.ts`.

## Implementation Checklist

### Phase 1: Shared types (packages/shared)
- [ ] Add `TASK_STATUSES` constant array and `isTaskStatus()` type guard to shared types
- [ ] Export from shared index

### Phase 2: extractBearerToken helper (apps/api)
- [ ] Create `extractBearerToken()` in `apps/api/src/lib/auth-helpers.ts`
- [ ] Replace `slice(7)` in `routes/tasks/crud.ts` (~line 409)
- [ ] Replace `slice(7)` in `routes/nodes.ts` (~lines 101, 546)
- [ ] Replace `slice(7)` in `routes/project-deployment.ts` (~line 334)
- [ ] Replace `slice(7)` in `routes/workspaces/_helpers.ts` (~line 104)
- [ ] Replace `slice(7)` in `routes/mcp/_helpers.ts` (~line 239)

### Phase 3: Remove `as any` / `as string` casts
- [ ] Remove `c.env as any` in `routes/tasks/crud.ts` (~lines 520, 530, 624, 634)
- [ ] Remove `as string` casts in `routes/mcp/_helpers.ts` (~lines 102-123) — `parsePositiveInt` already accepts `string | undefined`
- [ ] Remove `as string` cast in `routes/projects/acp-sessions.ts` (~line 36)
- [ ] Remove `as string` cast in `routes/workspaces/agent-sessions.ts` (~line 148)
- [ ] Fix `err.statusCode as any` in `index.ts` (~line 424) — Hono's `c.json` second param type issue
- [ ] Fix task status cast in `routes/tasks/crud.ts` (~lines 354, 562) — validate with `isTaskStatus()` first
- [ ] Fix notification type validation ordering in `routes/notifications.ts` (~lines 44-49)

### Phase 4: Safe JSON.parse
- [ ] Wrap WebSocket message parsing in `durable-objects/project-data/index.ts` (~lines 97, 299) with shape validation
- [ ] Wrap GitHub webhook payload parsing in `routes/github.ts` (~line 216)
- [ ] Wrap OAuth state parsing in `routes/project-deployment.ts` (~line 499)
- [ ] Wrap analytics batch parsing in `routes/analytics-ingest.ts` (~line 139) — already has shape check, just improve cast order
- [ ] Add object type check after `JSON.parse` in `services/provider-credentials.ts` (~lines 53, 78)

### Phase 5: Admin logs array size + Web UI
- [ ] Add array size limit in `durable-objects/admin-logs.ts` (~line 82)
- [ ] Fix `as any` casts in `apps/web/src/components/ScalingSettings.tsx` (~lines 113, 143, 170) — use `keyof Project`
- [ ] Replace silent `.catch(() => {})` with `console.error` in `apps/web/src/pages/ProjectChat.tsx` (~lines 330, 338)
- [ ] Replace silent `.catch(() => {})` with `console.error` in `apps/web/src/components/ScalingSettings.tsx` (~line 133)

### Phase 6: Tests
- [ ] Add unit test for `extractBearerToken()` helper
- [ ] Add unit test for `isTaskStatus()` guard
- [ ] Verify existing tests still pass

## Acceptance Criteria

- [ ] Zero `as any` casts in the files listed above
- [ ] Zero bare `slice(7)` on bearer tokens — all use shared `extractBearerToken()`
- [ ] Zero `as string` casts on env vars passed to `parsePositiveInt()`
- [ ] All `JSON.parse` calls in listed files have try/catch and shape validation
- [ ] Admin logs WebSocket validates array size
- [ ] ScalingSettings uses proper typing instead of `as any`
- [ ] Silent `.catch(() => {})` replaced with `console.error` logging
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass
- [ ] No new `as any` introduced
