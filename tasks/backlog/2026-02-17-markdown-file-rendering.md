# Markdown File Rendering in File Viewer

**Created**: 2026-02-17
**Size**: Small
**Area**: UI (`apps/web`)

## Problem

When opening markdown files (`.md`, `.mdx`) in the file browser, they're displayed as syntax-highlighted source code. For documentation-heavy repos this makes `.md` files hard to read — you see raw markup instead of rendered content.

## Desired Behavior

- When a markdown file is opened in the file viewer, render it as formatted markdown by default
- Provide a toggle button in the file viewer header to switch between "Rendered" and "Source" views
- Persist the user's preference (e.g., localStorage) so it sticks across files and sessions

## Current State

| Component | File | Notes |
|-----------|------|-------|
| **FileViewerPanel** | `apps/web/src/components/FileViewerPanel.tsx` | Displays all files via `SyntaxHighlightedCode` (Prism) |
| **MessageBubble** | `packages/acp-client/src/components/MessageBubble.tsx` | Already uses `react-markdown` + `remark-gfm` for chat rendering |
| **Dependencies** | `apps/web/package.json` | `react-markdown` v10.1.0, `remark-gfm` v4.0.1 already installed in the monorepo |

## Implementation Plan

- [ ] Detect markdown files by extension (`.md`, `.mdx`) in `FileViewerPanel`
- [ ] Add a "Rendered / Source" toggle button to the file viewer header (only visible for markdown files)
- [ ] When "Rendered" is active, render file content with `react-markdown` + `remark-gfm` instead of `SyntaxHighlightedCode`
- [ ] Style the rendered markdown to match the existing dark theme (headings, lists, tables, code blocks, links)
- [ ] Code blocks within rendered markdown should use Prism syntax highlighting (reuse existing `SyntaxHighlightedCode` or similar)
- [ ] Persist toggle preference in localStorage (key like `sam:md-render-mode`)
- [ ] Ensure mobile layout works — rendered markdown should respect viewport width, no horizontal overflow
- [ ] Add unit tests for the toggle behavior and markdown detection

## Design Notes

- Reuse patterns from `MessageBubble` for markdown rendering config (custom components, link handling)
- Toggle could be a simple icon button — e.g., `Eye` (rendered) / `Code` (source) from lucide-react
- Keep "Source" mode as an escape hatch so users can always see raw markdown when needed

## Out of Scope

- Rendering other rich formats (HTML, RST, AsciiDoc)
- Editing markdown in-place
- Table of contents / outline navigation
