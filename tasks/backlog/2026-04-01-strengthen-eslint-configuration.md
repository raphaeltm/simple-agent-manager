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

## Implementation Checklist

### Phase 1: Install plugins and update config
- [ ] Install `eslint-plugin-jsx-a11y` at root
- [ ] Install `eslint-plugin-simple-import-sort` at root
- [ ] Add `jsx-a11y/recommended` to the `.tsx` override in `.eslintrc.cjs`
- [ ] Add `simple-import-sort` plugin with `simple-import-sort/imports: error` and `simple-import-sort/exports: error`
- [ ] Add `@typescript-eslint/consistent-type-imports` rule (error, auto-fixable)

### Phase 2: Add stricter TypeScript rules (non-type-aware)
- [ ] Add `@typescript-eslint/no-non-null-assertion: warn`
- [ ] Evaluate `@typescript-eslint/no-inferrable-types: error` (auto-fixable)

### Phase 3: Fix violations
- [ ] Run `pnpm lint --fix` from root to auto-fix import ordering + type imports
- [ ] Review and fix remaining lint violations (or downgrade rules with too many violations to warn)
- [ ] Ensure `pnpm lint` passes with 0 errors

### Phase 4: Verify
- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] `pnpm build` passes

## Acceptance Criteria

- [ ] Accessibility rules (`jsx-a11y/recommended`) enabled for `.tsx` files
- [ ] Import ordering enforced via `simple-import-sort` (auto-fixable)
- [ ] Stricter TypeScript rules enabled (at least `consistent-type-imports`)
- [ ] `no-console` already enforced for API code (from PR #581 — verify still present)
- [ ] `pnpm lint` passes in CI with 0 errors
- [ ] All auto-fixable violations fixed

## References

- `.eslintrc.cjs` — root ESLint config
- `package.json` — root package
- `.claude/rules/02-quality-gates.md` — quality requirements
