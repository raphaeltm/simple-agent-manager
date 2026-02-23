# Git Viewer Rendered Markdown Toggle

**Created**: 2026-02-22
**Priority**: Medium
**Effort**: Small
**Tags**: `ui-change`

## Problem

When viewing markdown files in the git file viewer, users only see the raw markdown source. There is no easy way to switch to a rendered/preview view, making it harder to read documentation and READMEs from the git history.

## Goal

Add a toggle in the git file viewer that lets users switch between raw markdown source and a rendered markdown preview for `.md` files.

## Scope

- Add a "Rendered" / "Source" toggle button when viewing `.md` files in the git viewer
- Render markdown using the same renderer/styles used elsewhere in the app (if any) or a lightweight markdown renderer
- Preserve scroll position when toggling between views
- Default to rendered view for README files, source view for others (or make this configurable)
