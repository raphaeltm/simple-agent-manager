# Summary Card Modal: Render Markdown Properly

## Problem

The `TruncatedSummary` component's modal displays task summary content as plain text. When summaries contain Markdown (code blocks, tables, mermaid diagrams, headers, lists, etc.), it renders as raw markdown syntax instead of formatted content.

## Research Findings

- **Component**: `apps/web/src/components/chat/TruncatedSummary.tsx`
- **Current behavior**: Modal uses `<p className="... whitespace-pre-wrap break-words">{summary}</p>` (line 116-118)
- **Existing solution**: `RenderedMarkdown` component at `apps/web/src/components/MarkdownRenderer.tsx` already supports:
  - Code blocks with syntax highlighting (prism-react-renderer)
  - Mermaid diagrams (with DOMPurify SVG sanitization)
  - GFM tables
  - Headers, lists, blockquotes, links
  - Inline code
- **Dependencies**: `react-markdown` and `remark-gfm` already in `apps/web/package.json`

## Implementation Checklist

- [ ] Replace the plain `<p>` tag in the modal with `<RenderedMarkdown content={summary} inline />`
- [ ] Verify the inline card preview still shows plain text (truncated, no markdown rendering needed there)
- [ ] Write Playwright visual audit test with diverse markdown content
- [ ] Update existing unit tests to account for markdown rendering
- [ ] Run typecheck, lint, test, build

## Acceptance Criteria

- [ ] Code blocks in summaries render with syntax highlighting
- [ ] Tables render as formatted HTML tables
- [ ] Mermaid diagram code blocks render as diagrams
- [ ] Headers, lists, blockquotes render properly
- [ ] Inline code renders with monospace styling
- [ ] Links render as clickable anchor tags
- [ ] Long content scrolls properly in the modal
- [ ] No horizontal overflow on mobile
- [ ] Existing TTS functionality still works (summary text prop unchanged)

## References

- `apps/web/src/components/MarkdownRenderer.tsx` — existing markdown renderer
- `apps/web/src/components/chat/TruncatedSummary.tsx` — component to modify
