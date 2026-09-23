# Light Mode Slice C: Workspace Chrome Tokens

## Problem

Convert workspace and node-detail chrome surfaces to theme tokens on top of `sam/implement-foundation-layer-light-01kten`, while preserving existing Tokyo Night dark islands for terminal, diff, code, and `tn-*` utility surfaces.

## Constraints

- Output branch: `sam/light-mode-slice-c-01ktev`
- Open a draft PR only.
- Do not merge.
- Do not deploy staging.
- Zero dark-mode visual delta.
- No layout or behavior changes.

## Scope

- `apps/web/src/pages/workspace/*`
- `Node*`, `Nodes*`
- `components/node/*`
- Git components
- file/diff viewers
- `WorkspaceSidebar*`
- `TabStrip*`
- `WorkspaceCard/Card` within workspace
- `WorktreeSelector*`

## Research Notes

- Use theme CSS custom properties from `packages/ui/src/tokens/theme.css`.
- Preserve Tokyo Night islands for terminal, diff, code, and `tn-*` utilities in both themes.
- Existing test coverage includes unit tests for workspace, node, file browser, Git changes, Git diff, workspace sidebar, tab strip, and workspace card components.
- Visual audit must cover dark and light themes at 375px and 1280px with varied node/workspace/file/diff states.

## Implementation Checklist

- [x] Inventory scoped files and classify token conversion versus preserved Tokyo Night islands.
- [x] Convert workspace page chrome, headers, sidebars, panels, tab strips, buttons, and cards to theme tokens.
- [x] Convert node list/detail chrome and node component panels/cards to theme tokens.
- [x] Convert Git/file viewer surrounding chrome while preserving diff/code content islands.
- [x] Convert worktree selector and workspace card chrome.
- [x] Run focused unit tests for affected components.
- [x] Run lint, typecheck, and test suite.
- [x] Run Playwright visual screenshots in dark/light at 375px and 1280px across workspace, node, file, and diff states.
- [ ] Open draft PR and report branch plus PR URL.

## Validation Evidence

- `pnpm typecheck` - passed.
- `pnpm lint` - passed with existing warnings only.
- `pnpm --filter @simple-agent-manager/web lint` - passed with existing warnings only after final test adjustment.
- `pnpm test` - passed on rerun: 19/19 Turbo tasks, web 173 files and 2,235 tests passed.
- `pnpm build` - passed with existing Vite chunk-size warnings.
- `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/workspace-node-chrome-light-audit.spec.ts --project "iPhone SE (375x667)" --project "Desktop (1280x800)"` - passed, 12/12 browser cases.
- Screenshots written under `.codex/tmp/playwright-screenshots/`: `workspace-file`, `workspace-diff`, and `node-detail` for dark/light at 375x667 and 1280x800.

## Acceptance Criteria

- Surrounding workspace/node/file/Git chrome uses theme tokens and adapts correctly in light mode.
- Dark mode remains visually unchanged outside unavoidable token indirection.
- Terminal, diff, code, and `tn-*` utility islands remain Tokyo Night in both themes.
- No layout or behavior changes are introduced.
- Quality checks and screenshot-backed visual audit evidence are recorded before PR.
