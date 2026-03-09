# Add Command Palette Button to Mobile Hamburger Menu

## Problem

Mobile users can only trigger the command palette via `Cmd/Ctrl+K` keyboard shortcut, which isn't practical on mobile devices. The mobile hamburger menu (MobileNavDrawer) needs a visible button to open the command palette.

## Research Findings

- **MobileNavDrawer** (`apps/web/src/components/MobileNavDrawer.tsx`): Right-slide drawer with user info header, nav items, and sign-out button.
- **AppShell** (`apps/web/src/components/AppShell.tsx`): Renders MobileNavDrawer on mobile, already has `commandPalette.open` available.
- **Desktop** already has a "Search..." button in the sidebar that opens the command palette.
- **CommandPaletteButton** component exists but is workspace-specific; we'll add an inline search trigger styled consistently with the desktop version.

## Implementation Checklist

- [ ] Add `onOpenCommandPalette` prop to `MobileNavDrawerProps`
- [ ] Add a search/command palette button in the drawer, between header and nav items
- [ ] Close drawer and open command palette on button click
- [ ] Pass `commandPalette.open` from AppShell to MobileNavDrawer
- [ ] Add behavioral tests for the new button
- [ ] Run typecheck, lint, and tests

## Acceptance Criteria

- Mobile hamburger menu shows a "Search..." button that opens the command palette
- Clicking the button closes the drawer and opens the command palette
- Button is styled consistently with the desktop search trigger
- Existing tests continue to pass
- New behavioral test verifies the button renders and fires the callback
