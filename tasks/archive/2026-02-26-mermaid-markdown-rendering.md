# Mermaid Rendering in Markdown Viewer

**Created**: 2026-02-26
**Completed**: 2026-02-26
**Status**: completed

## Goal

Add Mermaid diagram rendering support to the `RenderedMarkdown` component and enforce a max-width of 900px centered layout for markdown content.

## Requirements

- [x] Add `mermaid` library to `apps/web`
- [x] Detect `language-mermaid` code blocks in `RenderedMarkdown`
- [x] Render mermaid diagrams inline instead of showing raw mermaid syntax
- [x] Set `maxWidth: 900px` and `margin: 0 auto` on the markdown container
- [x] Add unit tests for mermaid rendering
- [x] Typecheck, lint, and test pass
- [x] Update CLAUDE.md with mermaid guideline

## Implementation

- Installed `mermaid` package in `apps/web`
- Created `MermaidDiagram` component using `mermaid.render()` API with dark theme
- Integrated into `RenderedMarkdown` code block handler — `language-mermaid` routes to `MermaidDiagram`
- Updated `markdownContainerStyle` to `maxWidth: 900` with `margin: '0 auto'`
- Added 8 unit tests covering rendering, error states, max-width, and inline code bypass
- Added mermaid guideline to CLAUDE.md Development Guidelines
