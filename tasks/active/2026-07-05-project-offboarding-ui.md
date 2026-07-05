# Project Offboarding UI

## Problem Statement

Wave 6D needs the web UI for shared-project member offboarding and ownership transfer. Owners/admins must be able to remove non-owner active members through a preview/apply review, non-owner members must be able to leave the project through the same flow, and owners must be able to transfer ownership to eligible active members. The UI must make personal-key cost impact explicit and must not imply SAM can transfer or copy a secret.

## Research Findings

- `specs/034-project-offboarding/spec.md` defines the locked UI flow, copy guidance, edge cases, and project chat credential health integration.
- `apps/web/src/components/project-settings/ProjectMembersSection.tsx` currently lists members, invite links, access requests, and credential sharing warnings. It already loads members and credential attribution health together.
- `apps/web/src/lib/api/projects.ts` exposes member/invite APIs and credential health but not the merged ownership transfer or offboarding endpoints.
- Shared backend types already include `ProjectOwnershipTransfer*` and `ProjectMemberOffboarding*` contracts in `@simple-agent-manager/shared`.
- `apps/web/src/components/CredentialHealthNavItem.tsx` currently shows compact credential counts and a modal, but the modal labels every resource as a trigger and does not group by Triggers, Running tasks, Nodes, and Deployments.
- Existing tests: `apps/web/tests/unit/components/ProjectMembersSection.test.tsx`, `apps/web/tests/unit/components/credential-health-nav-item.test.tsx`, and `apps/web/tests/playwright/project-members-audit.spec.ts`.
- `/do` UI work requires local Playwright visual audit screenshots at mobile 375px and desktop 1280px with normal, long text, empty, many item, and error states.

## Implementation Checklist

- [ ] Add web API client methods for `POST /api/projects/:id/ownership-transfer`, `POST /api/projects/:id/members/:userId/offboarding-preview`, and `POST /api/projects/:id/members/:userId/offboarding-apply`.
- [ ] Add member-row actions in `ProjectMembersSection`:
  - owner-only transfer ownership for eligible active members;
  - owner/admin remove member for non-owner active members;
  - current non-owner leave project.
- [ ] Implement ownership-transfer confirmation dialog explaining the old owner becomes admin, calling the transfer API, refreshing settings, and showing success/error toasts.
- [ ] Implement offboarding preview/apply modal:
  - load preview after remove/leave click;
  - show last-owner blockers;
  - group live resources by Triggers, Running tasks, Nodes, and Deployments;
  - show explicit personal-key cost language;
  - default each selector to `break_and_flag`;
  - show `reattach_to_project` only when available;
  - include `defer_removal`;
  - apply with `planId` and selected actions;
  - refresh members and credential health after success;
  - show retry guidance for `stale_plan`, `expired`, and `unresolved_credential_attribution`.
- [ ] Extend credential health nav/modal so the badge includes offboarding/blocked resources and the modal groups Triggers, Running tasks, Nodes, and Deployments with deep links.
- [ ] Add/extend unit tests for transfer dialog, remove member flow, leave project flow, selected action payloads, success refresh, and 409 error guidance.
- [ ] Extend Playwright visual audit with mocked offboarding data:
  - normal 3-4 resources across trigger/task/node types;
  - long resource names/descriptions;
  - empty clean-removal state;
  - many 15+ resources;
  - expired/stale error states;
  - mobile 375px and desktop 1280px screenshots.
- [ ] Run focused unit tests and Playwright audit, then broader web validation.

## Acceptance Criteria

- Owners can transfer ownership to an active eligible member; the dialog copy states the old owner becomes admin and settings refresh after success.
- Owners/admins can remove active non-owner members through the preview/apply modal.
- A current non-owner member can leave a project through the preview/apply modal.
- The offboarding modal sends preview/apply requests to the correct endpoints with `offboardingPlanId`/`planId` semantics and selected per-resource actions.
- `break_and_flag` is the default action and no UI copy implies a user secret can be transferred.
- Credential health surfaces offboarding/blocked resources in compact counts and grouped modal details with real fix links.
- Unit tests cover behavioral API calls and error states.
- Playwright visual audit screenshots verify normal, long text, empty, many-resource, and error states on mobile and desktop without overflow.

## References

- `specs/034-project-offboarding/spec.md`
- PR #1510, PR #1512, PR #1513
- `.claude/rules/17-ui-visual-testing.md`
