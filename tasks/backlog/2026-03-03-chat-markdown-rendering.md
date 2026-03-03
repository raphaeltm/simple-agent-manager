# Chat Markdown Rendering Improvements

## Problem

Chat messages are rendered inconsistently across the two chat UIs:

1. **Project Chat** (`ProjectMessageView.tsx`) renders all message content as plain text via `whitespace-pre-wrap`. Agent responses with markdown formatting (code blocks, headers, lists, links) display as raw text.

2. **Workspace Chat** (`acp-client/MessageBubble.tsx`) has basic markdown via `react-markdown` + `remark-gfm` but lacks syntax highlighting for code blocks — they render as unstyled `<pre>` elements.

A full-featured `MarkdownRenderer.tsx` exists in `apps/web/` with syntax highlighting (`prism-react-renderer`), Mermaid diagrams, and styled elements, but neither chat UI uses it for message content.

## Research Findings

### Key Files
- `apps/web/src/components/chat/ProjectMessageView.tsx` — Project chat message rendering (plain text)
- `packages/acp-client/src/components/MessageBubble.tsx` — Workspace chat message rendering (basic markdown)
- `apps/web/src/components/MarkdownRenderer.tsx` — Full-featured renderer (unused by chat)
- `packages/acp-client/src/components/AgentPanel.tsx` — Workspace chat container

### Dependencies
- `apps/web/` already has: `react-markdown`, `remark-gfm`, `prism-react-renderer`, `mermaid`
- `packages/acp-client/` has: `react-markdown`, `remark-gfm` — missing `prism-react-renderer`

### Current Usage of MarkdownRenderer
- `FileViewerPanel.tsx` — renders markdown file previews
- `GitDiffView.tsx` — has its own local `RenderedMarkdown` for diff content

## Implementation Plan

### 1. Project Chat: Use RenderedMarkdown for message content
- [x] Import `RenderedMarkdown` from `MarkdownRenderer.tsx` in `ProjectMessageView.tsx`
- [x] Replace plain text `{content}` in `MessageBubble` with `<RenderedMarkdown>`
- [x] Replace plain text `{content}` in `AssistantBubble` with `<RenderedMarkdown>`
- [x] Adjust styles so RenderedMarkdown fits within the bubble layout (remove padding/max-width from RenderedMarkdown when used inline)

### 2. Workspace Chat: Add syntax highlighting to MessageBubble
- [x] Add `prism-react-renderer` as a dependency to `packages/acp-client/`
- [x] Update the `code` component overrides in `MessageBubble.tsx` to use `Highlight` from `prism-react-renderer` for fenced code blocks
- [x] Ensure inline code styling remains unchanged

### 3. Tests
- [x] Add behavioral test for ProjectMessageView markdown rendering (renders markdown, not plain text)
- [x] Update MessageBubble tests to verify syntax highlighting renders for code blocks

### 4. Quality
- [x] `pnpm typecheck` passes
- [x] `pnpm lint` passes
- [x] `pnpm test` passes
- [x] `pnpm build` passes

## Acceptance Criteria
- [ ] Project Chat renders agent messages with full markdown: headings, code blocks with syntax highlighting, lists, links, tables
- [ ] Workspace Chat renders code blocks with syntax highlighting (colored tokens, not plain monospace)
- [ ] Both chats render inline code with styled background
- [ ] No regressions in existing chat functionality (grouping, tool activity blocks, streaming indicators)
- [ ] Tests prove the rendering works behaviorally (not source-contract)

## References
- `.claude/rules/02-quality-gates.md` — test requirements
- `apps/web/src/components/MarkdownRenderer.tsx` — reference implementation
