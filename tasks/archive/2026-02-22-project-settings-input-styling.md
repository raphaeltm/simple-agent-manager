# Project Settings Runtime Config Redesign

**Created**: 2026-02-22
**Priority**: Medium
**Effort**: Medium
**Tags**: `ui-change`

## Problem

The runtime config section in project settings (environment variables and files) has multiple styling and UX issues:

1. **Unstyled inputs**: Text inputs use default browser styles, visually inconsistent with the rest of the UI.
2. **Oversized list items**: The environment variable and file list rows are big and clunky — too much vertical space per item, making the list feel bloated.
3. **Clunky delete buttons**: The delete buttons for removing env vars/files are oversized and don't feel integrated into the list design.

Overall the list and form layout needs a redesign, not just a styling pass.

## Goal

Redesign the runtime config lists and forms to feel compact, polished, and consistent with the rest of the app. Take inspiration from well-known UI frameworks (e.g., shadcn/ui, Radix, Ant Design, Material UI) for key-value list and editable list patterns.

## Scope

- Redesign env var and file list layout to be compact — tighter row height, inline key/value pairs, subtle separators
- Style all text inputs and textareas to match the app's design system (borders, padding, font, background, focus states)
- Replace clunky delete buttons with compact icon buttons (e.g., small trash icon, or X) aligned to the row
- Look at editable list / key-value pair components from shadcn/ui, Radix, Ant Design, or Material UI for layout and interaction inspiration
- Ensure textarea inputs (for file content / multi-line values) are also styled consistently
- Verify the inputs look correct in both light and dark themes if applicable
