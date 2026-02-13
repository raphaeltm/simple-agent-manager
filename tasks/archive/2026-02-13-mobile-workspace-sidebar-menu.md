# Mobile Workspace Sidebar Menu

**Status**: active
**Created**: 2026-02-13
**Branch**: mobile-sidebar-menu

## Summary

On mobile viewports (<=767px), the workspace sidebar (rename field + event log) is hidden with no way for users to access these features. Add a menu icon to the workspace header on mobile that opens an overlay/sheet with the sidebar content.

## Checklist

- [x] Add MoreVertical icon button to header (mobile only, 44px touch target)
- [x] Add mobileMenuOpen state variable
- [x] Create mobile sidebar overlay (backdrop + slide-in panel)
- [x] Extract sidebar content to shared variable (rename + events)
- [x] Use inline styles matching existing Workspace.tsx patterns
- [x] Use CSS variables from design system
- [x] Close overlay on backdrop click
- [x] Close overlay on X button click
- [x] Close overlay on Escape key press
- [x] Add unit tests: menu button renders on mobile
- [x] Add unit tests: menu button hidden on desktop
- [x] Add unit tests: overlay opens with rename + events
- [x] Add unit tests: overlay closes (X button, backdrop, Escape)
- [x] All tests pass
- [x] Typecheck passes

## Implementation Notes

- Used `MoreVertical` and `X` icons from lucide-react (already a project dependency)
- Extracted sidebar content (rename section + events section) into a `sidebarContent` JSX variable to avoid duplicating JSX between desktop sidebar and mobile overlay
- Mobile overlay uses `role="dialog"` with `aria-label` for accessibility
- Escape key handler registered via `useEffect` only when overlay is open
- Panel slides from the right, 85vw width, max 360px
- All touch targets >= 44px on mobile
