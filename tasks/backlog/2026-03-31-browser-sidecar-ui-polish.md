# Browser Sidecar UI Polish

**Created**: 2026-03-31
**Source**: UI/UX specialist review of Neko Browser Streaming Sidecar (PR #568, completed post-merge)

## Problem

The BrowserSidecar component uses hand-rolled inline styles instead of the design system's shared components (`Button`, `Alert`). CSS variable names don't match the actual token names in `packages/ui/src/tokens/theme.css`, causing light-theme hex fallbacks to render on the dark canvas. Touch targets are below the 44px minimum for mobile.

## Acceptance Criteria

### Critical
- [ ] Replace all hand-rolled `<button>` elements with `Button` from `@simple-agent-manager/ui` — ensures focus rings, correct touch targets, and consistent styling
- [ ] Fix CSS variable names: `--sam-border` → `--sam-color-border-default`, `--sam-bg-secondary` → `--sam-color-bg-surface`, `--sam-bg-accent` → `--sam-color-bg-inset`, `--sam-bg-danger` → `--sam-color-danger-tint`, `--sam-border-danger` → correct danger border token
- [ ] Ensure all interactive elements meet 44px minimum touch target on mobile (pass `isMobile` prop from WorkspaceSidebar)

### High
- [ ] Replace bare `<div>` error display with `Alert` component from `@simple-agent-manager/ui` (`variant="error"`)
- [ ] Narrow `BrowserSidecarStatusResponse.status` type from `string` to `'off' | 'running' | 'starting' | 'error'` in `apps/web/src/lib/api.ts`
- [ ] Add `aria-hidden="true"` to decorative spinner icons; add visually-hidden status text for loading state
- [ ] Add `aria-label="Start remote browser"` to the start button

### Medium
- [ ] Make forwarded ports clickable links consistent with port display in WorkspaceSidebar
- [ ] Extract `options` object dependencies in useBrowserSidecar hook to individual values to prevent unnecessary callback recreation

## References
- BrowserSidecar component: `apps/web/src/components/BrowserSidecar.tsx`
- useBrowserSidecar hook: `apps/web/src/hooks/useBrowserSidecar.ts`
- Design system Button: `packages/ui/src/components/Button.tsx`
- Design system Alert: `packages/ui/src/components/Alert.tsx`
- Theme tokens: `packages/ui/src/tokens/theme.css`
