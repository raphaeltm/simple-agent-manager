# Swap Chat List and Settings Icon Positions in Mobile Header

## Problem

In project chat mode on mobile, the chat list icon (List) is on the left and settings (gear) is on the right. User is right-handed and frequently accesses the chat list, making the current left-side placement ergonomically poor — requires reaching across the phone.

## Goal

Swap positions:
- Settings icon → left side of mobile header
- Chat list icon → right side of mobile header
- MobileSessionDrawer → slides in from right instead of left
- SettingsDrawer already opens from the right — no change needed there (or consider flipping to left)

## Research Findings

### Key Files
- `apps/web/src/pages/project-chat/index.tsx` — Mobile header (lines 173-198), desktop sidebar (lines 33-167)
- `apps/web/src/pages/project-chat/MobileSessionDrawer.tsx` — Drawer slides from left (`left-0`, `translateX(-100%)`)
- `apps/web/src/app.css` — Keyframe animations for drawer slide-in
- `apps/web/src/components/project/SettingsDrawer.tsx` — Already slides from right

### Current Layout (Mobile)
- Left: Chat list button (`List` icon, 18px)
- Center: Project name
- Right: Settings button (`Settings` icon, 16px)

### Drawer Behavior
- MobileSessionDrawer: `fixed top-0 left-0 bottom-0`, slides via `translateX(-100%)` → `translateX(0)`
- SettingsDrawer: `fixed top-0 right-0 bottom-0`, slides from right

## Implementation Checklist

- [ ] Swap button positions in mobile header bar (`project-chat/index.tsx`)
- [ ] Change MobileSessionDrawer to slide from right (`right-0` instead of `left-0`, `border-l` instead of `border-r`)
- [ ] Update CSS animation to slide from right (`translateX(100%)` instead of `translateX(-100%)`)
- [ ] Verify desktop sidebar is unaffected
- [ ] Run lint/typecheck

## Acceptance Criteria

- [ ] On mobile, settings icon is on the left, chat list icon is on the right
- [ ] Chat list drawer slides in from the right side
- [ ] Desktop layout is unchanged
- [ ] No accessibility regressions (drawer still has dialog role, ESC closes, backdrop click closes)
