# Workspace Header Username Overflow

**Created**: 2026-02-22
**Priority**: High
**Effort**: Small
**Tags**: `ui-change`

## Problem

Since the UI overhaul (spec 019), the user's name is displayed next to their profile picture in the workspace header. This pushes the icon buttons (settings, etc.) to the left, causing layout breakage. The icons crowd together or overlap, making the header unusable.

## Goal

Fix the workspace header so the username does not cause layout overflow or push icons out of position.

## Scope

- Investigate whether the username should be hidden in the workspace header (where horizontal space is limited) or truncated with ellipsis
- Ensure the header icon buttons maintain consistent positioning regardless of username length
- Test with long usernames and short usernames to confirm no overflow
