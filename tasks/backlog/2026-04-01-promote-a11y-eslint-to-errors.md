# Promote a11y ESLint Rules from Warnings to Errors

## Problem

The 8 `jsx-a11y/*` rules in `.eslintrc.cjs` are set to `'warn'` severity. They were introduced as warnings for incremental adoption (see strengthen-eslint-configuration change). As of 2026-04-01, there are 72 remaining violations across the codebase.

## Goal

Fix all 72 violations and then promote the rules from `'warn'` to `'error'` so they are CI-blocking.

## Rules to Promote

- `jsx-a11y/click-events-have-key-events`
- `jsx-a11y/no-static-element-interactions`
- `jsx-a11y/label-has-associated-control`
- `jsx-a11y/no-autofocus`
- `jsx-a11y/no-noninteractive-element-interactions`
- `jsx-a11y/interactive-supports-focus`
- `jsx-a11y/no-interactive-element-to-noninteractive-role`
- `jsx-a11y/aria-role`

## Acceptance Criteria

- [ ] All 72 violations fixed (not suppressed with eslint-disable)
- [ ] All 8 rules changed from `'warn'` to `'error'` in `.eslintrc.cjs`
- [ ] `pnpm lint` passes with no a11y warnings or errors
