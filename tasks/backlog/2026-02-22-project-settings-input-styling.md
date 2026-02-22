# Project Settings Runtime Config Input Styling

**Created**: 2026-02-22
**Priority**: Medium
**Effort**: Small
**Tags**: `ui-change`

## Problem

The text inputs for environment variables and files in the project runtime config settings appear unstyled. They look visually inconsistent with the rest of the UI — likely using default browser input styles instead of the app's design system.

## Goal

Style the runtime config inputs (environment variable names/values, file paths/content) to match the rest of the application's form styling.

## Scope

- Identify all text inputs in the project settings runtime config section (env vars, files)
- Apply consistent input styling from the design system (borders, padding, font, background, focus states)
- Ensure textarea inputs (for file content / multi-line values) are also styled consistently
- Verify the inputs look correct in both light and dark themes if applicable
