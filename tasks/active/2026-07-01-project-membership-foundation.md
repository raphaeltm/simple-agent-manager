# Project Membership Foundation

## Problem Statement

SAM projects are still authorized primarily through `projects.user_id` and `requireOwnedProject()`. That blocks the larger shared-project tenancy direction because every project-scoped capability is implicitly owner-only. We need the first behavior-preserving foundation slice: introduce project membership rows and capability-aware helpers without exposing shared-project access or changing user-visible behavior yet.

This is the first implementation slice for SAM idea `01KVX4YP9C5255TEB28PGM1159` ("Real multi-tenancy for shared projects and project-scoped infrastructure credentials").

## Scope

Implement only the project-membership foundation:

- Add a `project_members` D1 table and Drizzle schema.
- Backfill each existing `projects.user_id` as an active owner member.
- Seed owner membership whenever projects are created.
- Add role/capability definitions and helper functions:
  - `requireProjectAccess(db, projectId, userId)`
  - `requireProjectCapability(db, projectId, userId, capability)`
- Keep existing behavior unchanged for users:
  - No invite UI.
  - No shared project list behavior.
  - No project-owned infra credentials.
  - No broad route migration.
- Optionally migrate one low-risk proof point only if useful; otherwise keep `requireOwnedProject()` behavior-preserving by delegating through the new membership primitive while preserving owner-only access.

## Research Findings

- `apps/api/src/db/schema.ts` still defines `projects.userId` as required owner state, with per-user uniqueness indexes.
- `apps/api/src/middleware/project-auth.ts` currently contains `requireOwnedProject()`, `requireOwnedTask()`, and `requireOwnedWorkspace()` with owner-centric IDOR checks.
- `requireOwnedProject` is used broadly across API routes and tests, so a bulk migration is intentionally out of scope for this PR.
- `nodes.user_id` and `workspaces.user_id` remain ownership/scoping fields; deployment provisioning still bins and resolves provider credentials by user. That belongs to later tenant/infrastructure phases.
- Existing IDOR test guidance in `.claude/rules/28-credential-resolution-fallback-tests.md` requires behavioral tests with mismatched returned rows, not source-contract assertions.
- `.claude/rules/31-migration-safety.md` forbids unsafe table recreation on FK parents. This PR only adds a table and indexes.
- `.claude/rules/35-vertical-slice-testing.md` requires realistic cross-boundary state for route/schema behavior.
- Staging verification must deploy the branch, query D1 directly to verify the migration, authenticate through Playwright token-login, and submit a chat message as the primary user on a test project.

## Implementation Checklist

- [x] Add D1 migration `0081_project_members.sql` with additive `project_members` table, indexes, and owner backfill from `projects.user_id`.
- [x] Add `projectMembers` schema/table and inferred types in `apps/api/src/db/schema.ts`.
- [x] Add membership roles/capability definitions in API code near project auth.
- [x] Implement `requireProjectAccess()` and `requireProjectCapability()` with defense-in-depth user/project/status checks.
- [x] Preserve existing `requireOwnedProject()` behavior so current owners still pass and non-owners still receive `404`.
- [x] Seed owner project membership in all project creation paths discovered during research.
- [x] Add focused unit tests for membership auth helper behavior, including mismatched returned rows and missing/inactive memberships.
- [x] Add migration/schema tests proving the migration file creates/backfills the expected table and indexes.
- [ ] Run local validation: lint, typecheck, targeted tests, full test/build suite as required by `/do`.
- [ ] Deploy to staging and verify D1 migration state via Cloudflare API.
- [ ] Use Playwright token-login as `SAM_PLAYWRIGHT_PRIMARY_USER`, open staging, navigate to a test project, and submit a chat message successfully.

## Acceptance Criteria

- Existing single-owner project behavior is unchanged.
- Existing `requireOwnedProject()` callers continue to work without broad route rewrites.
- Every current project gets exactly one active owner membership for `projects.user_id`.
- New projects create an active owner membership for the creator/owner.
- Membership helpers distinguish access from capabilities and fail closed for missing, inactive, or insufficient membership.
- Tests cover IDOR/defense-in-depth behavior with mismatched rows.
- Staging deploy succeeds, the migration is visible in D1, and the primary staging user can still submit a project chat message.

## Explicit Non-Goals

- No invite/member-management UI.
- No shared-project listing for non-owners.
- No project-owned deployment infrastructure credentials.
- No deployment-node ownership changes.
- No broad `user_id` cleanup on child tables.
- No broad route migration from owner-only access to member access.

## References

- SAM idea: `01KVX4YP9C5255TEB28PGM1159`
- `.claude/rules/28-credential-resolution-fallback-tests.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/32-cf-api-debugging.md`
