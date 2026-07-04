# Credential Attribution Health

## Problem

Shared projects now have member/invite flows and shared sessions, but credential-backed shared resources still lack visible attribution. A member can edit or multiply a cron/GitHub trigger without seeing whether it runs on a co-worker's personal agent or compute credentials, or whether a project-level credential attachment covers the resource.

Implement a compact persistent project health surface, detailed modal, invite/member soft warnings, trigger inline warnings, and focused API/web tests. Do not expose credential values.

## Research Findings

- Project member and invite management is in `apps/api/src/routes/projects/members.ts` and `apps/web/src/components/project-settings/ProjectMembersSection.tsx`. Owners/admins use the existing `member:manage` capability. Invite creation and access-request decisions must remain non-blocking.
- Project navigation is in `apps/web/src/components/AppShell.tsx`, `NavSidebar.tsx`, and `MobileNavDrawer.tsx`. The health surface should be a compact control in these existing surfaces, not a new sidebar section.
- Trigger CRUD responses are built in `apps/api/src/routes/triggers/crud.ts` and typed in `packages/shared/src/types/trigger.ts`. Existing trigger rows include `userId` as creator/credential attribution owner.
- Trigger edit/list UI uses `apps/web/src/pages/ProjectTriggers.tsx`, `ProjectTriggerDetail.tsx`, and `apps/web/src/components/triggers/TriggerForm.tsx`/`TriggerCard.tsx`.
- Composable credential primitives are in `cc_credentials`, `cc_configurations`, and `cc_attachments` (`apps/api/src/db/schema.ts`, migration `0071`). Project attachment rows (`project_id`) are the right source for project-level coverage without returning secret material.
- Compute resolver support exists in `apps/api/src/services/composable-credentials/resolve.ts`, but `createProviderForUser` currently does not pass `projectId` into `resolveComputeConfig`. For this task, the summary can detect/report project-level coverage safely by querying attachment metadata; avoid broad provisioning behavior changes unless a tested path requires it.
- Legacy project-scoped agent credentials in `apps/api/src/routes/projects/credentials.ts` are caller-scoped. The summary should prefer composable project attachments for project-wide attribution and treat legacy personal/project-scoped rows carefully so members cannot read or act through another user’s secret identity.
- Trigger submission in `apps/api/src/services/trigger-submit.ts` still has an old precheck requiring a trigger owner's legacy cloud-provider credential. This conflicts with platform/project fallback behavior but is outside the requested UX unless needed to make attribution detection consistent.
- Shared types for members/invites live in `packages/shared/src/types/project.ts`; new summary types should live in shared types and be consumed by both API and web.
- Tests exist in `apps/web/tests/unit/components/ProjectMembersSection.test.tsx`, `apps/web/tests/unit/pages/project-triggers.test.tsx`, `apps/web/tests/unit/pages/project-trigger-detail.test.tsx`, and API route/service tests should follow existing Vitest patterns.

## Implementation Checklist

- [x] Add shared credential-attribution health response types covering counts, resource details, credential owner metadata, project coverage, and deep links.
- [x] Add API service support for project credential-attribution health summary, starting with trigger resources and including agent/LLM plus compute/provider credential coverage where inferable.
- [x] Add project route endpoint gated by project membership/capability; ensure owner/admin/member read access as appropriate and no secret fields are returned.
- [x] Enrich trigger responses with effective attribution metadata so trigger list/detail/edit screens can show inline warnings.
- [x] Add focused API tests for summary counts/details, project-vs-personal precedence, no secret leakage, and member/admin access.
- [x] Add web API client support for the health endpoint and attribution metadata.
- [x] Add compact persistent project health element to existing desktop and mobile navigation, opening a modal with details and fix deep links.
- [x] Add non-blocking invite/member-management soft warning/checklist when a project is already multiplayer or an invite/access transition is underway.
- [x] Add inline trigger/resource edit warnings when effective credential attribution is personal, especially when the actor differs from the trigger creator/credential owner.
- [x] Add focused web unit tests for nav badge/modal, invite warning, trigger inline warning, and mobile nav behavior.
- [ ] Run mandatory Playwright visual audit for changed production UI surfaces at mobile and desktop widths.
- [ ] Run `/do` validation: lint, typecheck, tests, build, specialist reviews, staging verification, PR, CI, merge, and production deploy monitoring.

## Acceptance Criteria

- API returns a project credential-attribution health summary with compact counts and detailed resources, without encrypted tokens, IVs, raw credentials, or secret material.
- Project-level credential attachment coverage wins over personal attribution in summary/detail and inline warning logic.
- Shared trigger resources backed by personal credentials display clear attribution such as `This runs on <name>'s personal key`.
- Invite/member flow shows a soft, non-blocking checklist/warning when multiplayer transition is active and personal-backed shared resources exist.
- Desktop and mobile navigation show only compact count/badge information; clicking opens a modal with details and deep links.
- Tests cover security-sensitive response shape, access control, UI modal/warnings, and mobile usability.
- Staging verification passes before PR creation; production deploy is monitored after merge.

## References

- SAM task `01KWQ9E3VBJPSW96SEAQK8PR5K`
- Merged foundation: PRs #1493, #1494, #1495, #1497, #1503, #1504
- `apps/api/src/routes/projects`
- `apps/api/src/routes/triggers/crud.ts`
- `apps/api/src/services/composable-credentials`
- `apps/api/src/services/provider-credentials.ts`
- `apps/api/src/middleware/project-auth.ts`
- `apps/web/src/components/AppShell.tsx`
- `apps/web/src/components/NavSidebar.tsx`
- `apps/web/src/components/MobileNavDrawer.tsx`
- `apps/web/src/components/project-settings/ProjectMembersSection.tsx`
- `apps/web/src/components/triggers`
