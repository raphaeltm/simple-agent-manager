# Declutter Workspace Toolbar

**Created**: 2026-02-14
**Priority**: Medium
**Relates to**: Workspace page layout, mobile UX

## Summary

The workspace toolbar/header is getting cramped. Move stop/rebuild workspace buttons into the workspace side panel (under the workspace name). Keep file browser and git changes buttons in the toolbar.

## Current State

The toolbar contains:
- Workspace name / back navigation
- File browser button (new)
- Git changes button (new)
- Stop workspace button
- Rebuild workspace button
- Kebab/overflow menu

This is too many items for mobile viewports, and stop/rebuild are infrequent actions that don't need prime toolbar real estate.

## Proposed Changes

### Keep in toolbar:
- Workspace name / back navigation
- File browser button
- Git changes button
- Side panel toggle (if not already present)

### Move to workspace side panel (under workspace name):
- Stop workspace button
- Rebuild/restart workspace button
- Any other workspace lifecycle actions

## Design Notes

- The side panel already shows workspace details — lifecycle actions fit naturally there
- Stop/rebuild are destructive/infrequent actions, so slightly more friction (opening panel) is actually appropriate
- This frees up toolbar space for high-frequency tools (files, git, future tools)
- On mobile, fewer toolbar items means larger touch targets for the remaining ones
