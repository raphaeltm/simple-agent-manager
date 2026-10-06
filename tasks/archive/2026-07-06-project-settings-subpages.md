# Project settings sub-pages

## Problem

The project settings page has become too crowded. It mixes project metadata, members, repository access, credential connections, agents, runtime configuration, infrastructure sizing, scaling controls, and deployment setup in one long page. The previous session started splitting this surface into sub-pages but stopped before the branch was pushed and completed through the `/do` workflow.

Users need stable deep links to the specific settings area they are trying to fix, and project settings should be easier to scan on mobile and desktop without hiding critical controls.

## Research Findings

- Prior SAM session `98b3e6e5-c038-45ca-a8f1-91ceb893bb56` implemented most of the split but ended during Playwright validation after Chromium/system dependencies were unavailable.
- `apps/web/src/pages/ProjectSettings.tsx` owned the monolithic project settings surface and can host a route shell with nested settings sub-pages.
- Project routes are declared in `apps/web/src/App.tsx`; project settings currently need nested routes under `/projects/:id/settings`.
- Existing settings subsections already live in reusable components, including `ProjectMembersSection`, `RepositoryAccessSettings`, `ProjectConnectionsSection`, `ProjectAgentsSection`, `ProjectRuntimeConfigSection`, `ScalingSettings`, and `DeploymentSettings`.
- Several user-facing links need to move with the split:
  - No-agent chat CTA should open the Agents sub-page.
  - Credential health/fix links should open Connections.
  - Repository and member audits should open Access.
  - Scaling/default VM/idle-timeout audit paths should open Infrastructure.
  - Deployment OAuth callbacks should return to Deploy.
- UI changes require Playwright visual audit coverage on mobile and desktop per `.claude/rules/17-ui-visual-testing.md`.

## Implementation Checklist

- [x] Add a project settings shell with tab navigation and nested outlet support.
- [x] Split the existing settings sections into route-backed sub-pages:
  - General
  - Access
  - Connections
  - Agents
  - Infrastructure
  - Runtime
  - Deploy
- [x] Preserve `/projects/:id/settings` behavior with an index redirect to General.
- [x] Preserve GCP deployment OAuth query handling by redirecting settings index OAuth returns to Deploy.
- [x] Update frontend deep links and route tests for the new sub-page URLs.
- [x] Update backend-generated fix/callback links for Connections and Deploy.
- [x] Add focused Playwright audit coverage for project settings sub-pages with mobile and desktop screenshots.
- [x] Fix any visual defects found during screenshot inspection.
- [x] Run focused typecheck, unit tests, API tests, and Playwright audit.

## Workflow Status

Product implementation is complete. Remaining `/do` workflow gates after task archive are tracked in `.do-state.md`, the PR description, CI checks, staging verification evidence, and production deploy monitoring.

## Acceptance Criteria

- `/projects/:id/settings` lands on the General settings sub-page by default.
- Each major settings cluster has a stable sub-page URL and tab.
- Existing links and backend-generated URLs send users to the relevant sub-page instead of the crowded settings root.
- Deployment OAuth success/error returns preserve query params and show the Deploy sub-page.
- Access settings remain usable with long names, long repository identifiers, pending requests, and invite links on a 375px mobile viewport.
- No horizontal overflow or clipped settings controls appear in the focused Playwright screenshots.
- Unit and Playwright tests cover the route split and changed deep links.

## References

- Parent project ID: `01KHRJGANBBWGDY1NZ0KVF0D4J`
- Parent task ID: `01KWVGK8W7KQ0XMT9GB0XD08WD`
- Parent session ID: `98b3e6e5-c038-45ca-a8f1-91ceb893bb56`
- UI visual testing rule: `.claude/rules/17-ui-visual-testing.md`
