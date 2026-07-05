# Ownership Transfer API

## Problem

Wave 6B of project offboarding needs an owner-only API for transferring project ownership to another active project member. The transfer must keep `projects.user_id` synchronized for legacy owner-scoped indexes, preserve `projects.created_by`, keep exactly one active owner in v1, and record an audit row.

## Research Findings

- `specs/034-project-offboarding/spec.md` defines `POST /api/projects/:id/ownership-transfer`, owner-only authorization, active admin target requirement, atomic updates, audit row, and last-owner protection.
- Wave 6A already added `project_ownership_transfers` in `apps/api/src/db/migrations/0085_project_offboarding.sql` and exported `projectOwnershipTransfers` from `apps/api/src/db/schema.ts`; no additional migration is currently needed.
- Project roles and capabilities live in `apps/api/src/middleware/project-auth.ts`. It has no `project:transfer_ownership` capability yet; owner/admin separation currently relies on `project:delete`.
- Membership/offboarding routes live in `apps/api/src/routes/projects/members.ts` and are mounted under `/api/projects` via `apps/api/src/routes/projects/index.ts`.
- Shared project member API types live in `packages/shared/src/types/project.ts`; request validation schemas live in `apps/api/src/schemas/projects.ts`.
- Existing 6A tests in `apps/api/tests/unit/routes/project-members-offboarding-preview.test.ts` use realistic route-level state and can be extended for the transfer vertical slice.
- Rule 31 requires additive migrations only. Rule 35 requires route-to-D1 vertical-slice tests with realistic multi-member state. Rule 11-style project scoping means every write predicate must include the project scope.

## Implementation Checklist

- [ ] Add `project:transfer_ownership` as an owner-only project capability.
- [ ] Add shared request/response types and a Valibot request schema for ownership transfer.
- [ ] Implement `POST /api/projects/:id/ownership-transfer` in the project members route.
- [ ] Validate body defaults and v1 role constraints: `toUserId` required, `oldOwnerRole` defaults to `admin`, only `admin` accepted for the old owner role, target must be an active admin member, viewer/maintainer/non-member/inactive targets rejected.
- [ ] Execute the ownership transfer atomically via D1 batch: set target role owner, set old owner role, update `projects.user_id`, and insert `project_ownership_transfers`.
- [ ] Preserve `projects.created_by` and include project scope in all write predicates.
- [ ] Add vertical-slice route tests for happy path, non-member/inactive/viewer/maintainer target rejection, non-owner rejection, audit row contents, and offboarding preview after transfer.
- [ ] Run focused API tests and relevant quality checks.

## Acceptance Criteria

- Happy path: an owner transfers to an active admin; both membership roles update, `projects.user_id` updates, and `projects.created_by` is not modified.
- Transfers to non-members, inactive members, viewers, and maintainers are rejected.
- Non-owners cannot transfer ownership.
- Each successful transfer writes `project_ownership_transfers` with project, from user, to user, actor, and completion timestamp.
- After transfer, the old owner is an admin and can be offboarded via the existing preview route without `last_owner_requires_transfer`.
- No offboarding apply, UI, or staging-verification wave functionality is implemented in this PR.

## References

- `specs/034-project-offboarding/spec.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/28-credential-resolution-fallback-tests.md`
