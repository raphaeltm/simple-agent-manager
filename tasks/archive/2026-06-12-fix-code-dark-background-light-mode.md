# Fix Code Rendering Dark Background in Light Mode

## Problem

In light mode, code blocks in the project chat (both in the file side panel and in the markdown renderer) render with transparent/light backgrounds. The `SyntaxHighlightedCode` component uses prism-react-renderer's `nightOwl` dark theme for syntax coloring, but the `<pre>` element has `bg-transparent`, so the dark-themed tokens appear on the light canvas background — making code nearly unreadable.

The expectation is that code should always have a dark background, even in light mode.

## Research Findings

### Affected Components

1. **`apps/web/src/components/MarkdownRenderer.tsx`** — `SyntaxHighlightedCode` component
   - Line 123: `<pre className="m-0 p-0 font-mono bg-transparent" ...>` — forces transparent background
   - Used by both the file panel (file viewing) and chat markdown (fenced code blocks)
   - The Highlight render callback provides `style` from the theme (includes background color) but it's not destructured or used

2. **`apps/web/src/components/MarkdownRenderer.tsx`** — `RenderedMarkdown` fenced code block wrapper
   - Line 237: `<div className="mb-3 overflow-x-auto rounded-md">` — no dark background on wrapper

3. **`apps/web/src/components/chat/ChatFilePanel.tsx`** — file view content area
   - Line 472: `<div className="flex-1 overflow-auto min-h-0 bg-canvas">` — `bg-canvas` is light in light mode

### Root Cause

`SyntaxHighlightedCode` uses `themes.nightOwl` which outputs dark-theme token colors, but `bg-transparent` on the `<pre>` means the background comes from the parent — which is light in light mode. The fix is to apply the theme's own background via the `style` render prop from `Highlight`.

## Implementation Checklist

- [x] In `SyntaxHighlightedCode`: Destructure `style` from Highlight render props and apply it to the `<pre>`, replacing `bg-transparent` with the theme's background color. Add padding for standalone use (file panel).
- [x] In `RenderedMarkdown` fenced code block: Changed wrapper to `overflow-hidden` so rounded corners clip the dark background properly.
- [x] In `ChatFilePanel`: Wrapped code viewer in a `min-h-full` div with `CODE_THEME_BG` background.
- [x] Also fixed `GitDiffView.tsx` which had the same `background: 'transparent'` issue.
- [x] Verify inline `<code>` in markdown is unaffected (it should remain with `bg-info-tint`) — confirmed, inline code uses a separate code path.

## Acceptance Criteria

- [ ] Code blocks in chat messages have a dark background in both light and dark modes
- [ ] File side panel code viewer has a dark background in both light and dark modes
- [ ] Inline code in markdown remains styled with info tint (not forced dark)
- [ ] No visual regression in dark mode
