# Hide Multiplayer UI on Solo Projects

## Problem Statement

Wave 7 of the multiplayer/shared-projects initiative needs to remove multiplayer clutter from single-owner projects. The project chat scope toggle, session ownership indicators, credential-health navigation, and trigger credential attribution warnings currently show even when a project has exactly one active member, no active invite link, and no pending access request.

The canonical transition rule is already implemented in `apps/web/src/components/project-settings/ProjectMembersSection.tsx`: multiplayer is active when active members > 1, or an active invite link exists, or a pending access request exists. Reuse that condition server-side so all affected UI surfaces receive one shared boolean instead of fetching member data independently.

## Research Findings

- `ProjectMembersSection.tsx` computes `multiplayerTransitionActive` from active members, active invite link, or pending request and uses it to gate the settings-page credential transition warning. This is the canonical behavior and must become a reusable server-computed condition.
- `apps/api/src/routes/projects/crud.ts` returns `ProjectDetailResponse` for `getProject()`, and project chat already reads that through `useProjectContext()`/`useProjectChatState()`. Adding `multiplayerActive` to the project detail payload can drive chat sidebar controls without extra member-list fetches.
- `apps/api/src/services/credential-attribution-health.ts` and `apps/api/src/routes/projects/credential-health.ts` currently return personal credential warnings without member/invite/request awareness. Add the shared server-computed flag to the summary and use it to hide credential-health navigation and inline trigger warnings.
- Trigger responses are enriched by `attachCredentialAttribution()` in `apps/api/src/routes/triggers/crud.ts`, and warning UI is in `TriggerCredentialWarning.tsx`, `TriggerCard.tsx`, `TriggerForm.tsx`, and `ProjectTriggerDetail.tsx`. Trigger warnings should be gated by the same `multiplayerActive` flag.
- Project chat surfaces for the scope toggle are `apps/web/src/pages/project-chat/index.tsx` and `MobileSessionDrawer.tsx`; session ownership indicators are rendered through `SessionList.tsx` → `SessionTreeItem.tsx` → `SessionItem.tsx`.
- Current searches show no separate deployment/environment credential-attribution warning UI outside the offboarding modal text and credential-health modal resources. Re-scan during implementation; if a production deployment/environment warning surface exists, gate it with the same flag.
- Existing focused tests include API credential health tests, web credential health nav tests, trigger warning tests, ProjectMembersSection tests, and Playwright audits for shared sessions and credential health. Extend those with render/simulate coverage for both solo and multiplayer/active-invite states.
- UI changes require local Playwright visual audit screenshots at 375px and 1280px. This task specifically needs solo and multiplayer states for the changed project chat/credential/trigger surfaces.

## Post-Mortem

### What Broke

Multiplayer-specific UI affordances shipped globally, so solo project owners saw controls and warnings that only make sense after a project becomes shared.

### Root Cause

Earlier waves implemented each multiplayer affordance locally and did not propagate the canonical settings-page transition condition into the shared API/UI contract.

### Timeline

Waves 1-6 shipped shared sessions, invite/access requests, and credential attribution surfaces on July 4, 2026. Wave 7 was opened on July 5, 2026 after the solo-project clutter became visible.

### Why It Wasn't Caught

Tests and audits covered the multiplayer affordances in active/shared states but did not include the inverse solo state across every surface.

### Class of Bug

Cross-surface feature gating drift: a product mode is defined in one surface but not exposed as a shared contract, so later UI components render out of context.

### Process Fix

This task will add explicit tests for both sides of the product-mode gate and update the task checklist to require a re-scan of all known multiplayer affordances before validation. If a durable repo rule needs strengthening beyond this task record, update `.claude/rules/` in the implementation branch.

## Implementation Checklist

- [x] Add a shared server helper/service that computes `multiplayerActive` using the canonical condition: active members > 1 OR active invite link OR pending access request.
- [x] Expose `multiplayerActive` on the project detail payload and shared `Project`/`ProjectDetailResponse` types so project chat can read it through existing context.
- [x] Expose the same `multiplayerActive` boolean on `ProjectCredentialAttributionHealthSummary`.
- [x] Gate project chat desktop and mobile `My sessions` / `All sessions` controls on `project.multiplayerActive`.
- [x] Gate session ownership badges/indicators so they only render when `project.multiplayerActive` is true and there is more than one active member behind that server condition.
- [x] Gate `CredentialHealthNavItem` so the Credentials nav item and modal are hidden for solo projects even when credential-backed resources exist.
- [x] Gate trigger credential attribution warnings in trigger cards, trigger form, and trigger detail using the server-computed condition.
- [x] Re-scan deployment/environment UI for credential attribution warnings and gate any production equivalents found with the same condition.
- [x] Add/extend behavioral tests for solo state: none of the four multiplayer surfaces render.
- [x] Add/extend behavioral tests for multiplayer/active-invite state: all four surfaces render and interactions still work.
- [x] Add API/service tests proving `multiplayerActive` is false for solo projects and true for member #2, active invite, or pending request.
- [ ] Run focused local Playwright visual audit at 375px and 1280px for solo and multiplayer states, storing screenshots under `.codex/tmp/playwright-screenshots/`.
- [ ] Run `/do` quality gates: lint, typecheck, tests, build, task-completion validation, specialist reviews, staging verification, PR, CI, merge, and production deploy monitoring.

## Acceptance Criteria

- A solo project (one active owner, no active invite, no pending request) shows no project chat scope toggle, no session ownership indicators, no Credentials nav item/modal, and no trigger credential warning UI.
- A project with more than one active member shows all multiplayer affordances where relevant.
- A solo project with an active invite link or pending access request shows all transition affordances automatically.
- The server computes the multiplayer/solo condition once and exposes it through shared response types; affected UI components do not independently fetch project members.
- Behavioral tests render and simulate both solo and multiplayer states; no source-contract tests are used for the required UI coverage.
- Local Playwright screenshots cover solo and multiplayer states at 375px and 1280px.
- Staging verification proves a live solo project hides the multiplayer UI, then creating an invite makes the surfaces appear.

## References

- SAM task `01KWT0KMC4RXGZ1JGAED08685M`
- Idea `01KVX4YP9C5255TEB28PGM1159`
- `apps/web/src/components/project-settings/ProjectMembersSection.tsx`
- `apps/web/src/pages/project-chat/index.tsx`
- `apps/web/src/pages/project-chat/MobileSessionDrawer.tsx`
- `apps/web/src/pages/project-chat/SessionItem.tsx`
- `apps/web/src/components/CredentialHealthNavItem.tsx`
- `apps/web/src/components/triggers/TriggerCredentialWarning.tsx`
- `apps/api/src/routes/projects/crud.ts`
- `apps/api/src/routes/projects/credential-health.ts`
- `apps/api/src/services/credential-attribution-health.ts`
- `apps/api/src/routes/triggers/crud.ts`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/35-vertical-slice-testing.md`
