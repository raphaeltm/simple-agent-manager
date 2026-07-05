# Offboarding apply API

## Problem

Wave 6C of shared-project member offboarding needs the apply endpoint for the
two-step preview/apply flow. Owners/admins must be able to apply an unexpired,
fresh offboarding plan, explicitly choose the action for each affected resource,
and remove the member only when live personal-backed resources have been
resolved or intentionally deferred.

## Research Findings

- `specs/034-project-offboarding/spec.md` defines the locked product semantics:
  break-and-flag by default, no secret transfer, reattach only with existing
  active project coverage, and stale plan rejection.
- Wave 6A implemented preview in
  `apps/api/src/services/project-offboarding-preview.ts` and resource
  enumeration in `apps/api/src/services/project-offboarding-preview-resources.ts`.
- Membership and offboarding routes are mounted from
  `apps/api/src/routes/projects/members.ts`; ownership transfer lives in
  `apps/api/src/routes/projects/ownership-transfer.ts`.
- Offboarding data model and blocked fields are already present in
  `apps/api/src/db/migrations/0085_project_offboarding.sql` and
  `apps/api/src/db/schema.ts`.
- Existing preview and ownership transfer route tests in
  `apps/api/tests/unit/routes/project-members-offboarding-preview.test.ts` and
  `apps/api/tests/unit/routes/project-ownership-transfer.test.ts` provide the
  route-level vertical-slice style to extend.
- Rule 11 requires project-scoped write predicates for any table with
  `project_id`, plus explicit scope validation before mutating caller-supplied
  resources.
- Rule 35 requires realistic cross-layer tests with multi-member,
  multi-resource state rather than internal helper-only tests.

## Implementation Checklist

- [ ] Add shared request/response types for offboarding apply.
- [ ] Add Valibot request validation for `planId`, `actions`, and
  `finalMemberStatus`.
- [ ] Implement an offboarding apply service that validates plan ownership,
  expiry, status, resource actions, freshness against current resource
  enumeration, and owner-removal constraints.
- [ ] Execute resource actions for triggers, task trees, nodes, deployment
  environments, and project attachments using project-scoped predicates.
- [ ] Persist `selected_action`, per-resource `status`, and plan `applied_at`.
- [ ] Remove the member only after successful non-deferred resource handling.
- [ ] Add `POST /api/projects/:id/members/:userId/offboarding-apply` requiring
  `member:manage`.
- [ ] Add vertical-slice tests for happy path, reattach trigger, deferred node,
  expired/stale/owner/unresolved rejection, project-scoped writes, and audit
  rows.

## Acceptance Criteria

- Apply rejects expired plans with `409 expired_plan`.
- Apply rejects plans whose resource state changed since preview with
  `409 stale_plan`.
- Apply rejects owner removal without a completed transfer with
  `409 last_owner_requires_transfer`.
- Apply rejects unresolved live resources with
  `409 unresolved_credential_attribution`.
- Break-and-flag disables triggers, cancels queued/draft tasks, marks blocked
  nodes/deployments as needed, disables departing project attachments, and
  records audit action rows.
- Reattach for triggers keeps the trigger active only when current remaining
  project coverage exists.
- Deferred actions keep the membership active and return blockers.
- Member removal sets `project_members.status = 'removed'` and `removed_at`
  only when all selected actions allow removal.

## References

- `specs/034-project-offboarding/spec.md`
- `tasks/archive/2026-07-05-project-offboarding-preview.md`
- `tasks/archive/2026-07-05-ownership-transfer-api.md`
- `.claude/rules/10-e2e-verification.md`
- `.claude/rules/11-fail-fast-patterns.md`
- `.claude/rules/35-vertical-slice-testing.md`
