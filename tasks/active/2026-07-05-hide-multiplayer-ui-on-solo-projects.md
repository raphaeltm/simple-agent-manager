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
- [x] Run focused local Playwright visual audit at 375px and 1280px for solo and multiplayer states, storing screenshots under `.codex/tmp/playwright-screenshots/`.
- [ ] Run `/do` quality gates: lint, typecheck, tests, build, task-completion validation, specialist reviews, staging verification, PR, CI, merge, and production deploy monitoring.

## Local Validation Log

- `pnpm typecheck` passed after implementation.
- `pnpm lint` passed after import-order fixes, with existing warnings only.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/project-multiplayer.test.ts tests/unit/services/credential-attribution-health.test.ts tests/unit/routes/credential-attribution-health.test.ts` passed.
- `pnpm --filter @simple-agent-manager/web test -- tests/unit/SessionTreeItem.test.tsx tests/unit/components/credential-health-nav-item.test.tsx tests/unit/components/trigger-credential-warning.test.tsx` passed.
- `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/shared-session-ux-audit.spec.ts tests/playwright/credential-health-audit.spec.ts --project="iPhone SE (375x667)" --project="Desktop (1280x800)"` passed after installing Chromium and its OS dependencies: 16 passed, 8 viewport-gated skips. Representative screenshots were inspected from `.codex/tmp/playwright-screenshots/` and `apps/web/.codex/tmp/playwright-screenshots/`.
- Initial full `pnpm test` exposed missing route-test mocking for the new trigger `getProjectMultiplayerState()` lookup in `apps/api/tests/unit/routes/triggers.test.ts`; create/list trigger tests returned 500 because the mock DB query queue was consumed by the new lookup.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/routes/triggers.test.ts` passed after mocking the shared multiplayer-state service in that route test: 19 tests passed.
- `pnpm test` passed after the trigger route mock fix: 19 successful Turbo tasks; API 376 files / 5760 tests passed; Web 211 files / 2590 tests passed.
- `pnpm build` passed after the trigger route mock fix, with existing Vite dynamic import and chunk-size warnings only.
- `pnpm typecheck` passed again after the trigger route mock fix.
- `pnpm lint` passed again after the trigger route mock fix, with existing warnings only.
- Staging deploy succeeded: GitHub Actions `deploy-staging.yml` run `28755545141` completed green for branch `sam/wave-7-multiplayershared-projects-01kwt0`; smoke-tests job completed green.
- Live staging verification passed with a temporary Playwright verifier against `https://app.sammy.party`: created a throwaway Artifacts project and chat session, confirmed `GET /api/projects/:id` and credential-health summary reported `multiplayerActive: false` for the solo state, verified desktop/mobile chat UI showed no `My sessions` / `All sessions` scope toggle and no session ownership label, created an active invite link, confirmed `GET /api/projects/:id` reported `multiplayerActive: true`, then verified desktop/mobile chat UI showed the scope toggle and ownership label. The verifier revoked the invite and deleted the throwaway project in cleanup.
- Live staging screenshots inspected:
  - `apps/web/.codex/tmp/playwright-screenshots/staging-wave7-solo-chat-desktop.png`
  - `apps/web/.codex/tmp/playwright-screenshots/staging-wave7-solo-chat-mobile.png`
  - `apps/web/.codex/tmp/playwright-screenshots/staging-wave7-invite-chat-desktop.png`
  - `apps/web/.codex/tmp/playwright-screenshots/staging-wave7-invite-chat-mobile.png`
- `curl -fsS https://api.sammy.party/health` returned healthy JSON.
- `pnpm quality:observability-noise` passed with no significant log noise detected; D1 observability was skipped because `OBSERVABILITY_DB_ID` was not set, and Workers telemetry was unavailable with 403.
- Staging note: live staging covered the server-computed flag and chat/ownership surfaces with real project/invite state. Credential-health nav and trigger attribution warning visibility for non-empty resource data remain covered by local render/simulate tests and local Playwright because the throwaway staging project intentionally had no credential-backed resources.

## Specialist Review Log

### Task Completion Validation Report

**Task**: `tasks/active/2026-07-05-hide-multiplayer-ui-on-solo-projects.md`  
**Branch**: `sam/wave-7-multiplayershared-projects-01kwt0`  
**Date**: 2026-07-05

#### Verdict: PASS

| Check | Status | Issues |
|-------|--------|--------|
| A: Research -> Checklist | PASS | 0 findings without checklist items |
| B: Checklist -> Diff | PASS | 0 checked items missing diff coverage |
| C: Criteria -> Tests | PASS | 0 acceptance criteria without test/manual coverage |
| D: UI -> Backend | PASS | 0 UI inputs not propagated |
| E: Multi-Resource | N/A | No new multi-resource selector |
| F: Vertical Slice | PASS | API helper/service tests plus render/simulate and Playwright coverage exercise the server flag through user-visible UI |

Findings: none blocking. Research findings map to implementation changes in `apps/api/src/services/project-multiplayer.ts`, `apps/api/src/routes/projects/crud.ts`, `apps/api/src/routes/projects/credential-health.ts`, `apps/api/src/routes/triggers/crud.ts`, the project-chat session components, `CredentialHealthNavItem`, and trigger warning components. Acceptance criteria are covered by focused Vitest tests and Playwright visual audits for solo and multiplayer states.

### UI/UX Validation Report

Variants considered:
1. Have each UI surface independently fetch members/invites/access requests.
2. Gate only credential-health summary and leave project chat on local heuristics.
3. Add one server-computed `multiplayerActive` flag to project/credential/trigger payloads and use it across the UI.

Selected direction: option 3. It matches the product rule, avoids duplicate client fetching, and keeps the existing UI layout intact while removing solo-project clutter.

| Category | Score | Notes |
|----------|------:|-------|
| Visual hierarchy and scanability | 5 | No new visual language; solo views remove non-applicable controls. |
| Interaction clarity | 5 | Multiplayer filter remains interactive only when valid; solo projects do not expose inactive affordances. |
| Mobile usability | 5 | Drawer controls are gated at 375px; no horizontal overflow in Playwright assertions. |
| Accessibility | 4 | Existing roles/labels preserved; removed controls are absent rather than disabled. |
| System consistency | 5 | Reuses existing components, tokens, and layout patterns. |

Screenshot evidence:
- Mobile session multiplayer: `.codex/tmp/playwright-screenshots/shared-session-ux-mobile.png`
- Mobile session solo: `.codex/tmp/playwright-screenshots/solo-session-ux-mobile.png`
- Desktop session multiplayer: `.codex/tmp/playwright-screenshots/shared-session-ux-desktop.png`
- Desktop session solo: `.codex/tmp/playwright-screenshots/solo-session-ux-desktop.png`
- Mobile credential solo: `apps/web/.codex/tmp/playwright-screenshots/credential-health-solo-hidden-mobile-375x667.png`
- Desktop credential solo: `apps/web/.codex/tmp/playwright-screenshots/credential-health-solo-hidden-desktop-1280x800.png`

Issues found/fixed during visual verification:
- The shared-session Playwright mock originally returned a project-shaped object for `/credential-attribution-health`, which crashed the AppShell. Fixed by returning a health-shaped mock with `multiplayerActive`.
- No overlap, clipping, or horizontal overflow found after the final Playwright rerun.

### Security Audit Report

Scope: project membership/invite/request gating for credential attribution and session ownership UI.

| Severity | Count |
|----------|------:|
| CRITICAL | 0 |
| HIGH | 0 |
| MEDIUM | 0 |
| LOW | 0 |

Findings: none. The change only suppresses client UI surfaces based on existing authorized project data. API routes still use `requireProjectAccess` / `requireProjectCapability` before computing or returning project credential and trigger attribution state. No credentials, tokens, JWT claims, WebSocket auth, or cross-user authorization boundaries were loosened.

### Cloudflare/D1 Review

Scope: Worker API route/service changes and D1 queries.

| Category | Status |
|----------|--------|
| Wrangler Config | N/A |
| D1 Setup | OK |
| KV Usage | N/A |
| R2 Setup | N/A |
| Testing | OK |

Findings: none. `getProjectMultiplayerState()` uses Drizzle parameterized queries against existing indexed project membership/invite/request tables and does not require migrations or binding changes. The helper runs after existing project authorization checks in route paths.

### Constitution / Env / Docs / Tests Review

- Constitution Principle XI: PASS. Diff added no hardcoded URLs, timeouts, limits, or deployment-specific identifiers.
- Env validation: PASS. No `Env` interface, secret, or deployment script changes.
- Documentation sync: PASS. No public endpoint, environment variable, deployment, or user-facing documentation contract changed; shared response types were updated with tests.
- Test-engineer review: PASS. Coverage includes server condition tests for solo/member/invite/request, API route/service propagation tests, React render/simulate tests for solo and multiplayer, and Playwright visual audits at 375px and 1280px for solo and multiplayer UI states.

## Acceptance Criteria

- A solo project (one active owner, no active invite, no pending request) shows no project chat scope toggle, no session ownership indicators, no Credentials nav item/modal, and no trigger credential warning UI.
- A project with more than one active member shows all multiplayer affordances where relevant.
- A solo project with an active invite link or pending access request shows all transition affordances automatically.
- The server computes the multiplayer/solo condition once and exposes it through shared response types; affected UI components do not independently fetch project members.
- Behavioral tests render and simulate both solo and multiplayer states; no source-contract tests are used for the required UI coverage.
- Local Playwright screenshots cover solo and multiplayer states at 375px and 1280px.
- Staging verification proves a live solo project hides the multiplayer UI, then creating an invite makes the surfaces appear.

## PR / CI Notes

- PR: https://github.com/raphaeltm/simple-agent-manager/pull/1519
- Initial PR CI passed build, lint, typecheck, unit tests, specialist evidence, UI compliance, staging smoke, VM smoke, and the full Playwright Visual Tests job.
- Preflight evidence initially failed because the PR body did not include the required `AGENT_PREFLIGHT` block at workflow creation time. The PR body now includes the required block; a fresh pull request event is required so CI reads the corrected body.

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
