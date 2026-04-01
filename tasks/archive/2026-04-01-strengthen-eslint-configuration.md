# Strengthen ESLint Configuration

**Created:** 2026-04-01
**Idea ID:** `01KN2PV5J7B3CD97ASDW7FV2D3`
**Master Tracker:** `01KN2PVZR7SMC6T5EDCEQXVFTQ` (Code Quality Refactor)

## Problem Statement

The ESLint configuration is minimal — only `eslint:recommended` + `@typescript-eslint/recommended` with 2 custom rules. This misses accessibility issues in React components, inconsistent import ordering across the codebase, and potential TypeScript bugs that stricter rules would catch. PR #581 already enforces `no-console` for the API; this task builds on that foundation.

## Research Findings

### Current State
- **Config:** Single root `.eslintrc.cjs` (ESLint 8, @typescript-eslint v7)
- **Extends:** `eslint:recommended`, `@typescript-eslint/recommended`
- **React override:** `plugin:react/recommended`, `plugin:react-hooks/recommended` for `.tsx` files
- **Custom rules:** `@typescript-eslint/no-unused-vars` (error), `@typescript-eslint/no-explicit-any` (warn)
- **no-console:** Already enforced for `apps/api/src/` (excluding `logger.ts`) — from PR #581
- **Current violations:** 23 warnings (all `no-explicit-any`), 0 errors
- **ESLint deps:** Each package has its own `eslint`, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser` devDeps
- **Packages with React/JSX:** `apps/web`, `packages/ui`, `packages/acp-client`, `packages/terminal`

### Key Decisions
- **Skip flat config migration:** ESLint 8 doesn't default to flat config. Migration adds risk with no behavioral benefit. Defer to a separate task.
- **Skip type-aware rules initially:** Rules like `no-floating-promises` require `parserOptions.project` which significantly slows linting in monorepos. Add non-type-aware stricter rules now; type-aware rules can be a follow-up.
- **Install new plugins at root level:** Since we have a single root `.eslintrc.cjs`, plugins go in root `devDependencies`.
- **Auto-fix first, manual fix second:** `simple-import-sort` and `consistent-type-imports` are auto-fixable. Run `--fix` before manual triage.
- **a11y rules as warnings:** 72 pre-existing a11y violations. Start as warnings for incremental adoption; fixing them is a separate effort.

## Implementation Checklist

### Phase 1: Install plugins and update config
- [x] Install `eslint-plugin-jsx-a11y` at root
- [x] Install `eslint-plugin-simple-import-sort` at root
- [x] Add `jsx-a11y/recommended` to the `.tsx` override in `.eslintrc.cjs`
- [x] Add `simple-import-sort` plugin with `simple-import-sort/imports: error` and `simple-import-sort/exports: error`
- [x] Add `@typescript-eslint/consistent-type-imports` rule (error, auto-fixable)

### Phase 2: Add stricter TypeScript rules (non-type-aware)
- [x] Add `@typescript-eslint/no-non-null-assertion: warn`
- [x] Decided against `no-inferrable-types` — marginal value, wide blast radius

### Phase 3: Fix violations
- [x] Run `pnpm lint --fix` from root to auto-fix import ordering + type imports
- [x] Review and fix remaining lint violations — downgraded high-violation a11y rules to warn
- [x] Ensure `pnpm lint` passes with 0 errors
- [x] Fix source-contract test broken by import reordering (node-stop.test.ts)
- [x] Fix pre-existing settings test failure (missing getSmokeTestStatus mock)

### Phase 4: Verify
- [x] `pnpm lint` passes
- [x] `pnpm typecheck` passes
- [x] `pnpm test` passes
- [x] `pnpm build` passes

## Acceptance Criteria

- [x] Accessibility rules (`jsx-a11y/recommended`) enabled for `.tsx` files (as warnings for incremental adoption)
- [x] Import ordering enforced via `simple-import-sort` (auto-fixable, as errors)
- [x] Stricter TypeScript rules enabled (`consistent-type-imports` as error, `no-non-null-assertion` as warning)
- [x] `no-console` already enforced for API code (from PR #581 — verified still present)
- [x] `pnpm lint` passes in CI with 0 errors
- [x] All auto-fixable violations fixed (645 files touched)

## References

- `.eslintrc.cjs` — root ESLint config
- `package.json` — root package
- `.claude/rules/02-quality-gates.md` — quality requirements
