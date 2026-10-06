# Removed project member re-invitation state semantics

## Problem Statement

A production-removed member can follow a fresh invite and see the exact message "Access approved — You can open the project now" while having no project access and no way to request access again. Removal changes `project_members.status` to `removed`, but the historical `project_access_requests.status='approved'` row remains. Invite preview and request creation currently treat that historical approval as current authorization even though canonical project access requires an active membership.

This task delivers only the backend/API and shared-contract phase. Final web affordances remain a dependent follow-up.

## Research Findings

- `GET /api/projects/invite-links/:token` in `apps/api/src/routes/projects/members.ts` already loads both membership and request records, but emits `approved-request` whenever request history is approved and membership is not active. Current access truth is the active `project_members` row, so an inactive/removed member with approved history must be eligible to request again.
- `POST /api/projects/invite-links/:token/request` rejects all approved history with `409`, despite already rejecting actual active members separately. The unique `(project_id, requester_user_id)` request record should be reset to `pending` only when no active membership exists.
- Re-request mutation must be conditional on the prior request state so concurrent retries are idempotent: one caller transitions approved/denied history to pending; concurrent callers observe/return the same pending request rather than overwriting a later approval or failing a unique insert race.
- Approval already upserts `project_members` to `status='active'`, reactivating a removed row. It must retain the `member:manage` authorization boundary and requester-scoped GitHub repository verification.
- Invite expiry/revocation validation occurs before request mutation. Invite usage should count a newly created or genuinely reset request, not idempotent retries of an already-pending request.
- Offboarding apply in `apps/api/src/services/project-offboarding-apply.ts` intentionally preserves historical creator/audit data. Resetting or expiring an approved request during offboarding is unnecessary once preview/request eligibility derives from active membership, and would erase decision coherence or couple offboarding to a reusable request-state transition. Preserve the approved history until a new invite is actually used to re-request.
- `project_access_requests` has a unique `(project_id, requester_user_id)` index. The implementation can use conditional update/insert conflict handling without a migration.
- Existing scenario tests live in `apps/api/tests/unit/routes/project-members-invites.test.ts`; they mock D1 at the route boundary and can cover the full invite preview → re-request → approval/reactivation state journey with realistic linked rows.
- Canonical shared-project authorization remains active-membership/capability based. This change must not add creator-only checks for project-scoped resources.
- The public docs currently describe invite links only at roadmap level; no user-facing endpoint contract needs updating for this state correction. The shared response union remains backward compatible for older clients even if the backend no longer emits `approved-request` without active membership.
- Relevant retained lessons require exact symptom preservation, full state-transition tests, project-scoped authorization predicates, and staging verification before merge.

## Implementation Checklist

- [x] Make invite preview treat stale approved history for a non-active member as `can-request` using current membership truth.
- [x] Make request creation/reset conditional and idempotent for approved/denied history and insert races while preserving active-member and pending behavior.
- [x] Count invite usage only for a new or reset pending request; preserve expiry/revocation and requester-scoped GitHub checks.
- [x] Preserve offboarding audit history; do not rewrite approved request decisions during removal.
- [x] Add scenario-driven API tests for removed → preview → pending re-request → approval → active membership.
- [x] Preserve negative tests for active members, authorization, expired/revoked links, and project privacy/shared-project policy.
- [x] Add concurrent/idempotent request tests proving retries cannot overwrite an approval or create duplicate state.
- [x] Run focused and full quality suites, then complete requested specialist reviews.
- [ ] Push the branch, prepare the PR with the exact production symptom/post-mortem, request `STAGING_LEASE_REQUEST`, and wait for the parent coordinator before any staging mutation.
- [ ] After lease grant, validate the complete backend journey with staging users, pass CI, merge, and monitor production deployment.

## Acceptance Criteria

- A removed or otherwise non-active member with historical approved request data previews a valid invite as eligible to request access, never as currently approved.
- The same user can safely transition the existing request record back to pending through a valid invite; concurrent/repeated calls are idempotent and do not overwrite a later approval.
- An authorized owner/admin can approve that pending request and the existing membership row becomes active again.
- Active members remain blocked from requesting; existing pending and denied semantics, invite expiry/revocation/usage, requester GitHub verification, and project privacy are preserved.
- Unauthorized actors cannot approve requests, and active project members retain canonical shared access independent of resource creator identity.
- Automated route/service coverage proves the complete state journey and negative/concurrent cases.
- No offboarding mutation erases historical approval/audit data merely to repair current-state derivation.
- No frontend affordance is implemented in this phase.

## References

- SAM task `01KXQKMV5ZFXSYN3Y3FEW107YJ`
- SAM idea `01KX944QR4X2Z4SG72KQPVNXKN`
- `apps/api/src/routes/projects/members.ts`
- `apps/api/src/services/project-offboarding-apply.ts`
- `packages/shared/src/types/project.ts`
- `apps/api/tests/unit/routes/project-members-invites.test.ts`
- `tasks/archive/2026-07-04-project-invite-link-access-requests.md`
- `specs/034-project-offboarding/spec.md`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/35-vertical-slice-testing.md`
