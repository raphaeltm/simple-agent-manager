# Fix Light-Mode Text Color for Syntax-Highlighted Code Blocks

## Problem

In light mode, fenced code blocks with language specifiers (e.g. ```typescript) render dark text on a dark background in project chat messages. The previous fix (PR #1338, commit 93e47955) only addressed **plain** code blocks (no language). Syntax-highlighted code blocks via `HighlightedCode` still lack an explicit text color on the `<pre>` container.

## Root Cause

`HighlightedCode` in `packages/acp-client/src/components/MessageBubble.tsx` (line 63-113) sets `background: NIGHT_OWL_CODE_BACKGROUND` (`#011627`) on the `<pre>` but does NOT set an explicit `color`. In light mode, the assistant bubble class `glass-msg-assistant` applies `color: var(--sam-color-fg-primary) !important` which resolves to `#11271d` (dark green-black). This dark color is inherited through the `.prose` container into the `<pre>` element.

While individual prism tokens receive inline colors from `getTokenProps`, the `<pre>` element itself has no base text color. This means:
- Any token that doesn't get an explicit color inherits dark text
- Selection highlight uses the inherited dark color
- Edge cases with plain text tokens may show dark-on-dark

Compare with `SyntaxHighlightedCode` in `MarkdownRenderer.tsx` which correctly spreads `themeStyle` (including `color: '#d6deeb'`) onto its `<pre>`.

## Research Findings

### Affected Components

1. **`HighlightedCode`** in `packages/acp-client/src/components/MessageBubble.tsx:63-113`
   - Sets `background` but not `color` on `<pre>`
   - The `Highlight` render prop provides a `style` object with both `color` and `backgroundColor`, but `HighlightedCode` doesn't destructure or use it — only uses `tokens`, `getLineProps`, `getTokenProps`

### Already Fixed (PR #1338)
- Plain code blocks (no language) in `MessageBubble.tsx:makeCodeComponent` — has `color: NIGHT_OWL_CODE_FOREGROUND`
- `MermaidCodeFallback` in `MermaidDiagram.tsx`

### Not Affected
- `SyntaxHighlightedCode` in `MarkdownRenderer.tsx` — correctly uses `{...themeStyle}` which includes both color and background
- Inline code in `MessageBubble.tsx` — uses Tailwind classes with explicit colors
- Inline code in `RenderedMarkdown` — uses `bg-info-tint` (transparent, theme-aware)

## Implementation Checklist

- [x] Add `color: NIGHT_OWL_CODE_FOREGROUND` to the `HighlightedCode` `<pre>` style in `MessageBubble.tsx`
- [x] Add/update test to verify syntax-highlighted code blocks have explicit text color in light mode
- [x] Build `acp-client` package to confirm no errors
- [x] Run full test suite — 449 tests pass

## Acceptance Criteria

- [x] Fenced code blocks with language (```typescript, ```bash, etc.) show light text on dark background in light mode
- [x] No regression in dark mode rendering
- [x] All existing tests pass (449/449)
- [x] acp-client package builds successfully
