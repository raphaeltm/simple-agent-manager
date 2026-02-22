# Implementation Plan: UI/UX Overhaul

**Branch**: `019-ui-overhaul` | **Date**: 2026-02-22 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/019-ui-overhaul/spec.md`

## Summary

Comprehensive UI/UX overhaul addressing systemic usability issues identified by a competitive analysis against 7 comparable products and a Nielsen heuristics audit. The overhaul adds persistent navigation, reduces entity list visual clutter via overflow menus, reorganizes monolithic detail pages into routed sub-sections, builds 6 missing UI primitives (DropdownMenu, ButtonGroup, Tabs, Breadcrumb, Tooltip, EmptyState), standardizes typography into a 6-tier scale, and aligns the dashboard with the project-first architecture. Implementation is phased: primitives and typography first, then navigation and page restructuring, then dashboard and onboarding refinements.

## Technical Context

**Language/Version**: TypeScript 5.x (React 18 + Vite for web UI)
**Primary Dependencies**: React 18, React Router 6, Vite, existing `@simple-agent-manager/ui` design system
**Storage**: N/A (frontend-only changes; backend APIs already exist from spec 018)
**Testing**: Vitest + React Testing Library for unit/component tests; Playwright for E2E
**Target Platform**: Modern browsers (Chrome, Firefox, Safari, Edge); mobile-first responsive (breakpoint: 768px)
**Project Type**: Web application (monorepo: `apps/web/` + `packages/ui/`)
**Performance Goals**: All new components render in <16ms (60fps); no layout shift on navigation transitions; Lighthouse accessibility score >= 90
**Constraints**: Zero new runtime dependencies for primitives (build on native browser APIs + existing design tokens); all primitives must work without JavaScript for initial render (progressive enhancement where applicable)
**Scale/Scope**: 13 pages, 50+ components to audit/refactor; 6 new primitives; 5 new sub-routes for project detail; 4 new sub-routes for settings

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Open Source Sustainability | PASS | All UI changes are in the open source core; no enterprise-only features |
| II. Infrastructure Stability | PASS | Frontend-only changes; no VM provisioning, DNS, or idle detection impact. Component tests required per quality gates. |
| III. Documentation Excellence | PASS | New primitives will have usage examples in UiStandards page; no new API endpoints to document |
| IV. Approachable Code & UX | PASS | This spec directly improves UX (persistent nav, reduced clutter, guided onboarding). Components follow single responsibility. |
| V. Transparent Roadmap | PASS | Spec 019 is the tracking document |
| VI. Automated Quality Gates | PASS | Existing CI (lint, typecheck, test) covers all changes; compliance checklist from spec 009 applies |
| VII. Inclusive Contribution | PASS | New primitives include keyboard navigation and ARIA attributes for accessibility |
| VIII. AI-Friendly Repository | PASS | Components follow consistent patterns; no scattered business logic |
| IX. Clean Code Architecture | PASS | New primitives go in `packages/ui/`; page components stay in `apps/web/src/pages/`; no circular dependencies |
| X. Simplicity & Clarity | PASS | No new external dependencies; primitives built on native browser APIs; no premature abstraction |
| **XI. No Hardcoded Values** | **WATCH** | Typography scale, spacing tokens, and breakpoints must use CSS variables with configurable defaults — no hardcoded px values in component code. All existing hardcoded colors (hex/rgba found in audit) must be replaced with design tokens. |
| XII. Zero-to-Production Deployability | PASS | Frontend-only; no new infrastructure resources, bindings, or secrets required |

**Pre-Design Gate Result**: PASS (Principle XI requires vigilance during implementation but no blocking violations)

### Post-Design Re-Check (Phase 1 Complete)

| Principle | Status | Post-Design Notes |
|-----------|--------|-------------------|
| XI. No Hardcoded Values | PASS | All new tokens use CSS custom properties: `--sam-type-*` (typography), `--sam-color-*-tint` (colors), `--sam-shadow-*`, `--sam-z-*`. Remediation plan targets 674+ existing hardcoded values. |
| IV. Approachable Code & UX | PASS | All 6 primitives specify keyboard navigation + ARIA roles. Mobile-first responsive via `useIsMobile()` hook. |
| IX. Clean Code Architecture | PASS | Primitives in `packages/ui/`, pages in `apps/web/src/pages/`, hooks extracted for 3+ usage patterns. No circular dependencies. |
| X. Simplicity & Clarity | PASS | Zero new external dependencies. Nav items are application constants, not configurable business logic. |
| XII. Zero-to-Production Deployability | PASS | No new infrastructure, secrets, or bindings. Frontend-only via existing Vite build. |

**Post-Design Gate Result**: ALL PASS — no violations to justify

## Project Structure

### Documentation (this feature)

```text
specs/019-ui-overhaul/
├── plan.md              # This file
├── research.md          # Phase 0: Technology decisions and patterns
├── data-model.md        # Phase 1: Component models and state management
├── quickstart.md        # Phase 1: Developer guide for new primitives
├── contracts/           # Phase 1: Component API contracts
│   ├── primitives.md    # DropdownMenu, ButtonGroup, Tabs, Breadcrumb, Tooltip, EmptyState APIs
│   ├── navigation.md    # Persistent navigation component API
│   └── typography.md    # Typography scale token definitions
└── tasks.md             # Phase 2 output (/speckit.tasks command)
```

### Source Code (repository root)

```text
packages/ui/src/
├── components/
│   ├── Button.tsx              # Existing (update hover patterns)
│   ├── Card.tsx                # Existing
│   ├── DropdownMenu.tsx        # NEW: Overflow action menus
│   ├── ButtonGroup.tsx         # NEW: Grouped action buttons
│   ├── Tabs.tsx                # NEW: Route-integrated tab strip
│   ├── Breadcrumb.tsx          # NEW: Navigation path
│   ├── Tooltip.tsx             # NEW: Hover explanations
│   ├── EmptyState.tsx          # NEW: No-data placeholder
│   └── ...                     # Existing components
├── primitives/
│   ├── PageLayout.tsx          # UPDATE: Add sidebar nav variant
│   ├── Typography.tsx          # UPDATE: Extend with 6-tier scale
│   └── Container.tsx           # Existing
├── tokens/
│   ├── theme.css               # UPDATE: Add typography scale + section spacing tokens
│   └── semantic-tokens.ts      # UPDATE: Add typography token mappings
└── index.ts                    # UPDATE: Export new components

apps/web/src/
├── components/
│   ├── AppShell.tsx            # NEW: Persistent navigation wrapper
│   ├── NavSidebar.tsx          # NEW: Desktop sidebar navigation
│   ├── MobileNavDrawer.tsx     # UPDATE: Integrate with AppShell
│   ├── UserMenu.tsx            # UPDATE: Remove inline nav links
│   ├── WorkspaceCard.tsx       # UPDATE: Replace action buttons with overflow menu
│   ├── ProjectSummaryCard.tsx  # UPDATE: Compact layout
│   ├── OnboardingChecklist.tsx # NEW: Setup progress tracker
│   └── project/
│       ├── ProjectTabs.tsx     # NEW: Tab navigation for project sub-routes
│       └── ...                 # Existing (refactored into sub-routes)
├── pages/
│   ├── Dashboard.tsx           # UPDATE: Project-first layout + onboarding
│   ├── Project.tsx             # UPDATE: Split into sub-route shell
│   ├── ProjectOverview.tsx     # NEW: Extracted from Project.tsx
│   ├── ProjectTasks.tsx        # NEW: Extracted from Project.tsx
│   ├── ProjectSessions.tsx     # NEW: Extracted from Project.tsx
│   ├── ProjectSettings.tsx     # NEW: Extracted from Project.tsx
│   ├── ProjectActivity.tsx     # NEW: Extracted from Project.tsx
│   ├── Settings.tsx            # UPDATE: Split into sub-route shell
│   ├── SettingsCloudProvider.tsx  # NEW: Extracted from Settings.tsx
│   ├── SettingsGitHub.tsx         # NEW: Extracted from Settings.tsx
│   ├── SettingsAgentKeys.tsx      # NEW: Extracted from Settings.tsx
│   ├── SettingsAgentConfig.tsx    # NEW: Extracted from Settings.tsx
│   └── ...                     # Existing pages (update navigation)
├── App.tsx                     # UPDATE: Add nested routes
└── styles/
    └── global-overrides.css    # UPDATE: Remove inline style patterns

tests/
├── unit/
│   ├── DropdownMenu.test.tsx   # NEW
│   ├── ButtonGroup.test.tsx    # NEW
│   ├── Tabs.test.tsx           # NEW
│   ├── Breadcrumb.test.tsx     # NEW
│   ├── Tooltip.test.tsx        # NEW
│   ├── EmptyState.test.tsx     # NEW
│   └── AppShell.test.tsx       # NEW
└── e2e/
    ├── navigation.spec.ts     # NEW: Persistent nav E2E
    └── project-tabs.spec.ts   # NEW: Project sub-routes E2E
```

**Structure Decision**: Web application monorepo structure. New UI primitives go in `packages/ui/src/components/` for cross-surface reusability. Page restructuring happens in `apps/web/src/pages/` with new sub-route pages extracted from monolithic components. The `AppShell` component wraps all protected routes with persistent navigation.

## Complexity Tracking

> No constitution violations requiring justification. All changes use existing patterns and extend the established design token system.
