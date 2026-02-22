# File Browser Image Rendering

**Created**: 2026-02-22
**Priority**: Medium
**Effort**: Medium
**Tags**: `ui-change`, `business-logic-change`

## Problem

The file browser currently does not render image files. When a user navigates to an image file (PNG, JPG, GIF, SVG, WebP, etc.), they cannot see the image content inline — they only see raw binary data or nothing at all.

## Goal

Support rendering common image formats directly in the file browser so users can view images without leaving the workspace UI.

## Scope

- Detect image file types by extension (png, jpg, jpeg, gif, svg, webp, ico, bmp)
- Render images inline in the file viewer panel when an image file is selected
- Handle large images gracefully (constrain dimensions, allow zoom/scroll)
- Show appropriate fallback for unsupported or corrupted image files

## Open Questions

1. Should images be fetched as base64 via the existing file read API, or served directly from the workspace via a dedicated binary endpoint?
2. What size limit should trigger a warning or lazy-load behavior?
3. Should SVGs be rendered as images or also show source code with a toggle?
