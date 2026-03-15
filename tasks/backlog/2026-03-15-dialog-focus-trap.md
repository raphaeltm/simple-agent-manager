# Add Focus Trap to Dialog Component

## Problem

The shared `Dialog` component (`packages/ui/src/components/Dialog.tsx`) does not implement a focus trap. When a dialog is open, Tab/Shift-Tab can move focus to elements behind the backdrop. This is a WCAG 2.1 SC 2.1.2 failure.

The dialog correctly focuses itself on open and handles Escape to close, but does not cycle Tab focus within its focusable children.

## Context

Discovered during UI/UX review of the TruncatedSummary audio playback PR. Pre-existing issue affecting all Dialog usages in the app, made more noticeable by audio player controls adding several focusable elements inside the dialog.

## Acceptance Criteria

- [ ] Dialog traps Tab focus within its focusable children when open
- [ ] Shift-Tab wraps from first to last focusable element
- [ ] Tab wraps from last to first focusable element
- [ ] Focus trap is released when dialog closes
- [ ] Existing Dialog consumers continue to work without changes
