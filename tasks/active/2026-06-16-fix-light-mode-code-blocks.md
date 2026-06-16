# Fix Light Mode Code Block Readability

## Problem

In light mode, fenced code blocks (triple backticks) render dark text on a dark background in project chat messages (and potentially other markdown surfaces). The text is unreadable.

## Root Cause

The `makeCodeComponent` function in `packages/acp-client/src/components/MessageBubble.tsx` renders language-less fenced code blocks with `background: '#011627'` (nightOwl dark blue) but does not set an explicit text color. The text color is inherited from the parent `.prose` container, which in light mode uses `var(--sam-color-fg-primary)` — a dark color. Result: dark text on dark background.

The same issue exists in `MermaidCodeFallback` in `packages/acp-client/src/components/MermaidDiagram.tsx`.

## Research Findings

### Affected Files
1. `packages/acp-client/src/components/MessageBubble.tsx:171` — language-less fenced `<pre>` block: `background: '#011627'` with no `color`
2. `packages/acp-client/src/components/MermaidDiagram.tsx:559` — `MermaidCodeFallback`: same issue
3. `apps/web/src/components/MarkdownRenderer.tsx` — `RenderedMarkdown` component's `<pre>` (line 224) does not set explicit bg/color for fenced blocks but delegates to `SyntaxHighlightedCode` for language blocks; inline code uses `bg-info-tint` which is theme-aware

### Not Affected
- Fenced code blocks WITH a language in MessageBubble — `HighlightedCode` uses prism-react-renderer's `themes.nightOwl` which sets both background and text color via inline styles
- Inline code in MessageBubble — uses explicit Tailwind classes (`bg-gray-100 text-gray-800` for agent, `bg-blue-500 text-blue-50` for user) that are mapped to SAM tokens
- `SyntaxHighlightedCode` in MarkdownRenderer — uses `themes.nightOwl` with inline styles

### nightOwl Theme Colors
- Background: `#011627`
- Plain text: `#d6deeb`

## Implementation Checklist

- [ ] Add `color: '#d6deeb'` to the language-less fenced code `<pre>` in `MessageBubble.tsx:makeCodeComponent` (line ~171)
- [ ] Add `color: '#d6deeb'` to `MermaidCodeFallback` in `MermaidDiagram.tsx` (line ~559)
- [ ] Verify `MarkdownRenderer.tsx` doesn't need the same fix (it delegates to `SyntaxHighlightedCode` which handles color via theme)
- [ ] Check `HighlightedCode` in MessageBubble.tsx — confirm prism theme sets text color (it does via inline styles)
- [ ] Add/update tests to verify light-mode code block text color
- [ ] Build `acp-client` package to confirm no errors

## Acceptance Criteria

- [ ] Fenced code blocks (``` and ```language) are readable in both light and dark modes
- [ ] Language-less fenced code blocks show light text on dark background in both themes
- [ ] Mermaid code fallback blocks are readable in both themes
- [ ] Inline code remains readable in both themes (no regression)
- [ ] All existing tests pass
- [ ] acp-client package builds successfully
