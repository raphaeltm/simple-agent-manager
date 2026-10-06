# Project offboarding preview API

## Problem

Wave 6A of the shared-projects initiative needs the backend foundation for project member offboarding. Owners/admins must be able to preview the impact of removing a member before any destructive apply step exists. The preview must expose which project-visible resources still depend on the departing member's personal-backed credentials and must never imply that SAM can copy or transfer secrets.

## Research Findings

- The design spec is `specs/034-project-offboarding/spec.md`. Locked product decisions are Option 2 `break_and_flag` by default and a two-step preview/apply contract with an `offboardingPlanId`.
- Membership is in `project_members`; the existing members route lives in `apps/api/src/routes/projects/members.ts` and is mounted by `apps/api/src/routes/projects/index.ts`.
- Capability helpers are in `apps/api/src/middleware/project-auth.ts`. Preview should reuse project membership/capability checks but also enforce the task's owner-only requirement for this wave.
- Credential attribution pins exist on `tasks` and `nodes`; triggers are user-owned and credential health already computes project-vs-personal coverage for triggers in `apps/api/src/services/credential-attribution-health.ts`.
- Composable credential attachments are in `cc_attachments` with configuration and credential ownership in `cc_configurations`/`cc_credentials`.
- Migration rule 31 forbids destructive table recreation. This wave should add new tables and columns only, likely as `apps/api/src/db/migrations/0085_project_offboarding.sql`.
- Vertical tests should use realistic multi-member/project state per rule 35. Existing project member route tests are in `apps/api/tests/unit/routes/project-members-invites.test.ts`.

## Implementation Checklist

- [x] Add additive SQL migration for:
  - `project_ownership_transfers`
  - `project_member_offboarding_plans`
  - `project_member_offboarding_resource_actions`
  - blocked/offboarding columns on `triggers`, `tasks`, `nodes`, and `deployment_environments`
  - indexes required by the spec
- [x] Update `apps/api/src/db/schema.ts` for new tables/columns and exported row types.
- [x] Add shared response/action contract types for offboarding preview.
- [x] Implement an offboarding preview service that:
  - validates target active membership
  - blocks sole-owner preview with `409 last_owner_requires_transfer`
  - enumerates project-visible memberships/resources for the departing member
  - detects active project attachment coverage owned by remaining active members before offering `reattach_to_project`
  - defaults live personal-backed resources to `break_and_flag`
  - persists a preview plan and resource-action rows without returning secret values
  - expires or supersedes older preview plans for the same project/member
- [x] Add `POST /api/projects/:id/members/:userId/offboarding-preview` in the members router with project-scoped predicates and owner-only authorization for this wave.
- [x] Update `specs/034-project-offboarding/` contracts if implementation requires a shape correction, documenting any deviation.
- [x] Add vertical-slice tests covering:
  - sole owner preview returns `409 last_owner_requires_transfer`
  - member with live personal-backed trigger/node/task/project attachment returns a persisted plan and default `break_and_flag` resources
  - existing active project attachment coverage enables `reattach_to_project`
  - a new preview supersedes/expires prior preview plans as apply-staleness groundwork
  - response does not leak encrypted credential/token fields
- [x] Run targeted API tests, migration safety, typecheck, lint, test, and build.

## Acceptance Criteria

- Preview endpoint shape follows the spec and returns a stable `offboardingPlanId`.
- Sole-owner offboarding preview returns `409 last_owner_requires_transfer`.
- Default recommendations follow Decision A: `break_and_flag` unless an active remaining project attachment already covers the consumer; `defer_removal` is available for human choice but not the default for live personal-backed resources.
- Preview plan persistence supports Wave 6C stale-plan rejection.
- No secret values are included in preview responses, logs, or plan/action details.
- No transfer/apply/UI behavior is implemented in this wave.

## References

- `specs/034-project-offboarding/spec.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/06-api-patterns.md`
