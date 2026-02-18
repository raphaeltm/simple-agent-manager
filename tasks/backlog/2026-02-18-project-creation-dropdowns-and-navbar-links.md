# Project Creation Dropdowns and Top-Level Navbar Links

**Created**: 2026-02-18
**Status**: completed

## Request

Update the project creation experience to match workspace creation behavior by using dropdown selectors for repository and branch. Update the navbar so primary destinations (dashboard, projects, etc.) are accessible directly without opening the profile menu.

## Preflight Classification

- `ui-change`
- `cross-component-change`
- `business-logic-change`
- `docs-sync-change`

## Assumptions

1. Project creation already has repository/branch data-fetching hooks or API utilities reused by workspace creation.
2. Navbar currently hides primary navigation behind the avatar/profile menu on at least some breakpoints.
3. No API contract changes are required; this is a web UI behavior change.

## Impact Analysis

- **Web UI screens affected**: Project creation form and top navigation layout.
- **Shared components affected**: Potentially common repo/branch picker components used by workspace creation.
- **Behavioral risk**: Incorrect branch defaulting or stale repo/branch options if dropdown state management is wrong.
- **Mobile risk**: Top-level nav additions can overflow on small screens and must preserve tap targets.

## Constitution Check Plan (Principle XI)

- Confirm no hardcoded internal URLs are introduced.
- Confirm no new hardcoded limits/timeouts/identifiers are introduced.
- Reuse existing config-driven URL/navigation patterns.

## Implementation Plan

1. Locate project creation form and workspace creation repo/branch selector implementation.
2. Reuse or extract selector logic so project creation uses dropdowns for repository and branch.
3. Update navbar to expose key primary destinations as top-level items while keeping profile menu for account actions.
4. Add/update web unit tests for project create form and navbar rendering/navigation behavior.
5. Run targeted web tests plus lint/typecheck for impacted packages.
6. Update documentation references if behavior/docs mention old navigation or project creation inputs.

## Validation Checklist

- [x] Project creation shows repository dropdown and branch dropdown
- [x] Branch options update correctly when repository changes
- [x] Top-level navbar includes dashboard/projects (and other primary destinations)
- [x] Primary destinations are accessible without profile menu
- [x] Mobile layout remains usable (single-column where relevant, no overflow)
- [x] Tests added/updated and passing
- [x] Docs updated in same PR if any referenced behavior changed

## Completion Notes

- Added project-oriented routes (`/projects`, `/projects/new`) and reused the workspace creation flow in project mode.
- Added persistent top-level primary navigation in the header via `UserMenu` while retaining profile dropdown actions.
- Repo selector now behaves as a true dropdown on focus (shows available repositories without requiring typed input first).
- Mobile screenshot captured at `.codex/tmp/playwright-screenshots/landing-mobile.png`.
- Docs review outcome: no user-facing docs currently describe these navbar or frontend route details, so no additional docs required beyond this task record.
