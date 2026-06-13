# Git Sidebar Navigation Fix + Tokyo Night Light Theme

## Problem

Two issues in the project chat git sidebar:

1. **Back navigation breaks git flow**: When viewing a diff or file from the git-status view, clicking back returns to the file browser (`browse` mode) instead of back to `git-status`. The `goBack()` function in `ChatFilePanel.tsx` always sets mode to `browse` regardless of where the user came from.

2. **Light mode contrast**: Terminal color tokens (`--sam-color-tn-*`) use the Tokyo Night dark palette and are intentionally not overridden for light mode. Components that use these tokens directly (git status indicators, diff renderer, workspace sidebar links) have poor contrast on light backgrounds.

## Research Findings

### Back Navigation
- `ChatFilePanel.tsx:251-260`: `goBack()` unconditionally sets `mode` to `browse` when in `view` or `diff` mode
- No tracking of which mode the user came from
- State machine: `git-status` → `diff` → back → `browse` (should be `git-status`)
- `useSessionLifecycle.ts:104-106`: Panel is opened with `initialMode: 'git-status'` but this isn't preserved during navigation

### Light Mode Theme
- `theme.css:272`: Comment says "Tokyo Night (--sam-color-tn-*) is intentionally NOT overridden"
- Tokyo Night has an official light variant (Tokyo Night Light) with proper contrast ratios
- `workspace-chrome.css:43-83`: Already has a `[data-ui-theme='sam-light']` block that remaps workspace chrome variables to semantic tokens — these will benefit from the tn-* overrides automatically
- Direct tn-* usage in: `DiffRenderer.tsx` (green/red/blue), `ChatFilePanel.tsx` (git status colors, error text), `ImageViewer.tsx` (error text), `GitDiffView.tsx` (added/modified colors)

## Implementation Checklist

- [ ] Add `[data-ui-theme='sam-light']` block in `packages/ui/src/tokens/theme.css` overriding all `--sam-color-tn-*` tokens with Tokyo Night Light palette
- [ ] Add `previousModeRef` to `ChatFilePanel.tsx` to track the mode before transitioning to `view` or `diff`
- [ ] Update `goBack()` to return to `previousModeRef.current` instead of always `browse`
- [ ] Update `openFile()` and `openDiff()` to save current mode before transitioning
- [ ] Add unit test for back navigation returning to git-status
- [ ] Run Playwright visual audit at mobile (375px) and desktop (1280px) viewports
- [ ] Verify workspace-chrome.css light overrides cascade correctly with new tn-* values

## Acceptance Criteria

- [ ] Clicking back from a diff/file view that was opened from git-status returns to git-status
- [ ] Clicking back from a diff/file view that was opened from browse returns to browse
- [ ] All `--sam-color-tn-*` tokens have light mode overrides using Tokyo Night Light palette
- [ ] Git status indicators (green/red/yellow) have adequate contrast on light backgrounds
- [ ] Diff renderer colors have adequate contrast on light backgrounds
- [ ] Workspace sidebar links are readable in light mode
- [ ] No visual regression in dark mode

## References

- Tokyo Night Light palette: https://github.com/enkia/tokyo-night-vscode-theme
- `packages/ui/src/tokens/theme.css` — theme token definitions
- `apps/web/src/components/chat/ChatFilePanel.tsx` — main git sidebar panel
- `apps/web/src/styles/workspace-chrome.css` — workspace chrome light overrides
- `apps/web/src/components/shared-file-viewer/DiffRenderer.tsx` — diff renderer colors
