# Light Mode Slice E Core Pages

## Problem

Settings, project management, library, ideas, triggers, memory, policies, activity, notifications, and remaining non-admin/non-chat/non-workspace pages still contain hardcoded dark-mode colors that ignore the light theme foundation. Convert these surfaces to semantic SAM theme tokens while preserving the current dark-mode appearance.

## Constraints

- Base branch: `sam/implement-foundation-layer-light-01kten`.
- Output branch: `sam/light-mode-slice-e-01ktev`.
- Open a draft PR only. Do not merge.
- Do not deploy staging.
- Do not touch chrome/design-system primitives, chat surfaces, workspace/node surfaces, admin/analytics surfaces, or prototype files.
- Preserve Tokyo Night/code/log dark islands.
- Prime directive: zero dark-mode delta. Replace a hardcoded color only when the token dark value matches the prior literal or the existing class already maps to that semantic color.

## Research Findings

- The foundation layer defines dark defaults in `packages/ui/src/tokens/theme.css` and light overrides under `[data-ui-theme='sam-light']`.
- Existing app styles already expose semantic Tailwind utilities such as `bg-surface`, `bg-inset`, `text-fg-primary`, `text-fg-muted`, `border-border-default`, `bg-danger-tint`, and status token utilities.
- High-priority Slice E literals are in `apps/web/src/pages/AgentContextPage/*`, `apps/web/src/pages/ProjectSettings.tsx`, `apps/web/src/pages/ProjectLibrary.tsx`, `apps/web/src/pages/ProjectNotifications.tsx`, library components, settings pages, project ideas/tasks/triggers pages, and page-specific components.
- Existing Playwright coverage includes `agent-context-audit.spec.ts`, `project-triggers` unit tests, `project-library` unit tests, `project-notifications` unit tests, `settings` unit tests, and multiple related UI audits.

## Implementation Checklist

- [x] Audit Slice E page/component files for hardcoded dark classes and inline color literals.
- [x] Convert AgentContextPage memory, policies, overview, and activity/actions surfaces to theme tokens.
- [x] Convert project settings, library, notifications, ideas, tasks, triggers, and settings surfaces to theme tokens.
- [x] Keep code/log/Tokyo Night islands dark and leave excluded admin/chat/workspace/prototype/chrome/design-system files untouched.
- [x] Add or update tests for theme-token coverage and UI behavior where useful.
- [x] Run local Playwright visual audit in dark and light at 375 and 1280 with forms, lists, empty states, long names, many rows, dialogs, and error states.
- [x] Run lint, typecheck, tests, and build.
- [x] Run required specialist validation before the draft PR.

## Acceptance Criteria

- Slice E surfaces are light-mode-aware through semantic theme tokens.
- Dark mode retains the prior colors for converted literals.
- Tokyo Night/code/log islands remain dark.
- Excluded files/surfaces are not changed.
- Required quality and visual checks pass or have exact documented blockers.
- A draft PR is opened and not merged.
