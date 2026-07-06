# Runtime Signup Approval Config

## Problem

SAM already supports `REQUIRE_APPROVAL` as a deployment-time signup approval gate, but changing it requires editing environment configuration and redeploying. Superadmins need a runtime Admin UI switch that controls whether future non-admin users require approval, while preserving `REQUIRE_APPROVAL` as the default/fallback for existing and self-hosted deployments.

Turning approval off should let pending users pass the gate because the gate is disabled. It must not silently rewrite stored pending users to active.

## Research Findings

- `apps/api/src/auth.ts` uses `env.REQUIRE_APPROVAL` in BetterAuth `user.create.before` to decide whether new users become `active` or `pending`.
- `apps/api/src/middleware/auth.ts` uses `env.REQUIRE_APPROVAL` in `requireApproved()` to block pending users.
- `apps/api/src/services/session-factory.ts` uses `env.REQUIRE_APPROVAL` in API token/device-flow session creation.
- `apps/api/src/routes/admin.ts` already has superadmin-only admin user routes guarded by `requireAuth(), requireApproved(), requireSuperadmin()`.
- `apps/web/src/pages/AdminUsers.tsx` is the existing Admin -> Users surface and is the right place for a compact platform setting panel.
- Shared admin/user types live in `packages/shared/src/types/user.ts`; admin API client functions live in `apps/web/src/lib/api/admin.ts`.
- D1 migrations are append-only SQL files under `apps/api/src/db/migrations`; latest migration on `origin/main` is `0086_project_member_removed_at.sql`.

## Checklist

- [x] Add a `platform_settings` D1 table and Drizzle schema entry with `key`, `value`, `updated_at`, and `updated_by`.
- [x] Add a signup approval service that reads the runtime override and falls back to `REQUIRE_APPROVAL`.
- [x] Wire `auth.ts`, `middleware/auth.ts`, and `session-factory.ts` through the shared service.
- [x] Add superadmin admin endpoints to get/update signup approval config.
- [x] Add shared request/response types and validation schema.
- [x] Add Admin Users UI control with explicit copy for pending-user behavior.
- [x] Add backend tests for fallback, persisted overrides, and gate behavior.
- [x] Add route-level admin API tests for read/update wiring and superadmin guard.
- [x] Add frontend tests and Playwright visual/browser coverage for the Admin Users control.
- [x] Update public configuration docs to mention runtime override fallback semantics.

## Acceptance Criteria

- [x] Existing deployments keep their current `REQUIRE_APPROVAL` behavior until a superadmin changes the runtime setting.
- [x] The runtime setting is persisted in D1 and includes update metadata.
- [x] All approval checks share one resolver/service.
- [x] Superadmins can read and update the setting from the admin API and Admin Users UI.
- [x] Turning approval off does not mutate existing pending users.
- [x] Tests cover backend resolver/gate behavior and frontend UI behavior.
- [x] Local validation and specialist reviews are completed.
- [ ] Staging verification, PR, CI, and merge steps are completed.

## Validation

- Staging deploy `28830181609` completed successfully: deploy, D1 backup, `0087_platform_settings.sql` migration, post-migration data-integrity check, health check, and smoke tests all passed.

## References

- Idea `01KWWQZJHWD8YRV913D4T0HWFQ`
- Existing approval PR: https://github.com/raphaeltm/simple-agent-manager/pull/162
- Env wiring PR: https://github.com/raphaeltm/simple-agent-manager/pull/164
- Trials runtime-switch precedent: https://github.com/raphaeltm/simple-agent-manager/pull/1368
