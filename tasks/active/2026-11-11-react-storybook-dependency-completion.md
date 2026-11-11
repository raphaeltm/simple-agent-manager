# Complete React and Storybook dependency updates (#2638, #2640)

## Problem

Dependabot PR #2638 bumped the catalog `react` to 19.3.1 and `@types/react` to 19.3.0 but left
`react-dom` at 19.2.7. React refuses to run with mismatched `react`/`react-dom` versions, so the
terminal tests failed to import (CI run 42900302518). Dependabot PR #2640 bumped only
`@storybook/addon-a11y` to 10.6.6; that version imports `HIGHLIGHT_MENU_CLICK` from
`storybook` core, which does not exist in the pinned `storybook` 10.6.0 (CI run 42900519474).

Both are partial updates of packages that are released in lockstep. This replacement candidate
moves each lockstep group together. Coordinated by PR Shepherd (2026-11-11); channel
`feature.pr-shepherd-deps-20261111`. Draft + `needs-human-review` until the coordinator approves
the exact PR number and head. Do not merge.

## Research Findings

- React versions come from the `catalog:` in `pnpm-workspace.yaml`; consumers are `apps/web`,
  `packages/ui`, `packages/terminal`, `packages/acp-client` (all `catalog:`).
- `react-dom@19.3.1` peers `react ^19.3.1`; `@types/react-dom@19.3.0` peers `@types/react ^19.3.0`.
  All four must move together.
- Storybook is only used in `packages/ui` (`storybook`, `@storybook/react`,
  `@storybook/react-vite`, `@storybook/addon-docs`, `@storybook/addon-a11y`). Storybook releases
  these in lockstep; align them all on 10.6.6 (the #2640 target).
- `.storybook/main.ts` / `preview.ts` use only stable public APIs; no config change needed.
- Lockfile change beyond the bumped packages: `scheduler` 0.27.0 → 0.28.0 (react-dom dependency)
  and dedupe removals only.

## Implementation Checklist

- [x] Catalog: react, react-dom 19.3.1; @types/react, @types/react-dom 19.3.0
- [x] packages/ui: all Storybook packages 10.6.6
- [x] Regenerate pnpm-lock.yaml; confirm a single react/react-dom version resolves
- [ ] Typecheck, lint, tests for web, ui, terminal, acp-client
- [ ] Storybook build + Storybook Playwright audit (packages/ui)
- [ ] Playwright desktop/mobile screenshot audit of the app, reviewed and posted
- [ ] Local specialist review (task-completion-validator, ui-ux-specialist)
- [ ] Staging deploy + live verification
- [ ] Draft PR with `needs-human-review`; report exact head to coordinator

## Acceptance Criteria

- [ ] Exactly one `react` and one `react-dom` version (19.3.1) in the lockfile
- [ ] All Storybook packages resolve to the same version
- [ ] Terminal, UI, web, acp-client tests pass; Storybook builds and its Playwright audit passes
- [ ] CI green on the candidate head, including Test and Workspace Quality Surfaces
- [ ] Staging app loads and works with zero React errors
- [ ] PR stays DRAFT + `needs-human-review`; originals #2638/#2640 untouched
