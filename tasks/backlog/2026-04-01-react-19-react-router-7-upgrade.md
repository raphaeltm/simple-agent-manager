# React 19 + React Router 7 Upgrade

## Problem Statement

Upgrade the monorepo from React 18.3.1 → React 19 and React Router 6.30.3 → React Router 7. This is the final item in the code quality refactor sequence, following dependency standardization (PR #585) and ESLint strengthening (PR #584).

## Research Findings

### Current Versions (from pnpm catalog)
- react: 18.3.1
- react-dom: 18.3.1
- @types/react: 18.3.27
- @types/react-dom: 18.3.7
- react-router-dom: 6.30.3
- @testing-library/react: 14.3.1
- @vitejs/plugin-react: 5.2.0
- vitest: 4.1.2
- jsdom: 24.1.3

### React 19 Breaking Changes Affecting This Codebase

1. **forwardRef deprecation** (4 files) — React 19 supports ref as a regular prop
   - `packages/ui/src/components/Input.tsx`
   - `packages/acp-client/src/components/SlashCommandPalette.tsx`
   - `packages/acp-client/src/components/AgentPanel.tsx`
   - `packages/terminal/src/MultiTerminal.tsx`

2. **@types/react@19 type changes** — `ReactElement["props"]` is `unknown` instead of `any`, other strictness changes. Need `@types/react@19` and `@types/react-dom@19`.

3. **React.memo namespace usage** (8 files in acp-client) — Optional modernization to named `memo` import.

4. **Already compliant**: No defaultProps, no propTypes, no string refs, no ReactDOM.render (already uses createRoot), proper JSX transform configured.

### React Router 7 Breaking Changes

1. **Package consolidation** (CRITICAL) — `react-router-dom` is deprecated, replaced by `react-router`
   - General imports: `from "react-router"`
   - DOM-specific (BrowserRouter): `from "react-router/dom"`

2. **44 files need import path updates**:
   - 42 files in `apps/web/src/`
   - 2 files in `packages/ui/src/` (Tabs.tsx, Breadcrumb.tsx)

3. **No API changes** — useNavigate, useParams, useSearchParams, Link, NavLink, Outlet, Route, Routes all have stable APIs. No data router patterns used.

4. **Peer dependency update** — `packages/ui/package.json` needs `react-router: ^7` instead of `react-router-dom: ^6`

### Testing Infrastructure
- 131 test files using @testing-library/react
- act() imported from @testing-library/react (correct pattern)
- @testing-library/react 14.3.1 → may need upgrade to v16 for React 19 compat
- No deprecated test patterns found

### Affected Packages
- `apps/web` — main app (React + React Router)
- `packages/acp-client` — React component library
- `packages/terminal` — terminal component
- `packages/ui` — design system (React + React Router)
- `packages/vm-agent/ui` — VM agent UI

## Implementation Checklist

### Phase A: Update React 19
- [ ] Update pnpm catalog: `react` → 19.x, `react-dom` → 19.x
- [ ] Update pnpm catalog: `@types/react` → 19.x, `@types/react-dom` → 19.x
- [ ] Run `pnpm install` and fix any peer dependency conflicts
- [ ] Fix TypeScript compilation errors from React 19 type changes
- [ ] Refactor `forwardRef` in 4 files to use ref as regular prop
- [ ] Modernize `React.memo` → named `memo` import in acp-client (8 files)
- [ ] Update peer dependencies in library packages (acp-client, terminal, ui)
- [ ] Run `pnpm typecheck` — fix all failures
- [ ] Run `pnpm test` — fix all failures
- [ ] Run `pnpm build` — fix all failures

### Phase B: Update React Router 7
- [ ] Update pnpm catalog: remove `react-router-dom`, add `react-router` → 7.x
- [ ] Run `pnpm install`
- [ ] Update `BrowserRouter` import in App.tsx to `from "react-router/dom"`
- [ ] Update all 43 other imports from `react-router-dom` to `react-router`
- [ ] Update `packages/ui/package.json` peer dependency to `react-router: ^7`
- [ ] Run `pnpm typecheck` — fix all failures
- [ ] Run `pnpm test` — fix all failures
- [ ] Run `pnpm build` — fix all failures

### Phase C: Update Testing Infrastructure
- [ ] Check if @testing-library/react needs upgrade for React 19
- [ ] Update if needed, fix any test failures
- [ ] Run full test suite: `pnpm test`

### Phase D: Quality Verification
- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] `pnpm build` succeeds
- [ ] No React deprecation warnings in console

## Acceptance Criteria
- [ ] React 19.x installed and working across all packages
- [ ] React Router 7.x installed and working
- [ ] Zero React deprecation warnings in console
- [ ] All existing tests pass
- [ ] All pages render correctly (verified via Playwright on staging)

## References
- React 19 upgrade guide
- React Router v7 migration guide
- pnpm-workspace.yaml (catalog)
- .claude/rules/02-quality-gates.md
- .claude/rules/13-staging-verification.md
