# SAM Chat Markdown Renderer

## Problem

The SAM top-level agent chat UI (`SamPrototype.tsx`) renders all message content as plain text. When SAM produces markdown-formatted responses (code blocks, tables, lists, headers, etc.), they appear as raw markdown syntax rather than rendered HTML.

A working prototype exists at `prototypes/markdown-render/` that demonstrates the exact look and feel desired — green glass theme, syntax-highlighted code blocks with copy buttons, styled tables, task lists, blockquotes, etc.

## Research Findings

### Current State
- **SAM chat MessageBubble** (`apps/web/src/pages/sam-prototype/components.tsx:237-287`): renders `msg.content` as plain text via `<span>{msg.content}</span>`
- **Project chat MessageBubble** (`packages/acp-client/src/components/MessageBubble.tsx`): already uses `react-markdown` + `prism-react-renderer` + `remark-gfm` for full markdown rendering
- **Workspace catalog** already has: `react-markdown: 10.1.0`, `remark-gfm: 4.0.1`, `prism-react-renderer: 2.4.1`
- The `apps/web/package.json` already lists `react-markdown: "catalog:"`

### Approach
1. Add `react-markdown`, `remark-gfm`, and `prism-react-renderer` to the SAM chat's MessageBubble
2. Create SAM-themed markdown component overrides (green glass colors instead of the blue/white used in acp-client)
3. Add a CSS module or scoped styles for the markdown body within SAM bubbles — matching the prototype's green-themed styles
4. Add a copy button to code blocks (the prototype has this; acp-client does not)

### Key Files
- `apps/web/src/pages/sam-prototype/components.tsx` — MessageBubble to modify
- `apps/web/src/pages/SamPrototype.tsx` — parent page (no changes needed beyond imports)
- `prototypes/markdown-render/src/style.css` — reference CSS for green-themed markdown
- `packages/acp-client/src/components/MessageBubble.tsx` — reference for react-markdown integration pattern

## Implementation Checklist

- [ ] Add `remark-gfm` and `prism-react-renderer` to `apps/web/package.json` (react-markdown already present)
- [ ] Create `apps/web/src/pages/sam-prototype/sam-markdown.tsx` — SAM-themed markdown components (code blocks with copy, inline code, links, tables all in green glass theme)
- [ ] Create `apps/web/src/pages/sam-prototype/sam-markdown.css` — scoped CSS for markdown body within SAM bubbles (adapted from prototype style.css)
- [ ] Update `MessageBubble` in `components.tsx` to render SAM messages through `react-markdown` instead of plain text (user messages stay as plain text)
- [ ] Ensure streaming messages still render correctly with the animated `...` indicator
- [ ] Ensure tool call chips still render below markdown content
- [ ] Verify no horizontal overflow on mobile (375px)
- [ ] Run Playwright visual audit with mock markdown content

## Acceptance Criteria

- [ ] SAM messages render markdown: headers, bold/italic, inline code, fenced code blocks with syntax highlighting, tables, lists, task lists, blockquotes, horizontal rules, links, images
- [ ] Code blocks have a language label and copy button matching the prototype style
- [ ] All markdown elements use the green glass theme colors (not the blue/white from acp-client)
- [ ] User messages remain plain text (no markdown rendering)
- [ ] Streaming indicator still works during message streaming
- [ ] Tool call chips render correctly below rendered markdown
- [ ] No horizontal scrollbar on mobile viewport (375px)
- [ ] No new lint/typecheck/build errors

## References

- Prototype: `prototypes/markdown-render/`
- SAM chat UI: `apps/web/src/pages/SamPrototype.tsx`
- ACP MessageBubble (pattern reference): `packages/acp-client/src/components/MessageBubble.tsx`
