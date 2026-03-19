# Add Virtual Scrolling to Chat Message Lists

**Created**: 2026-03-19
**Priority**: Medium
**Classification**: `ui-change`, `cross-component-change`

## Problem

Chat messages are rendered as full DOM nodes (up to 5,000 per session). As conversations grow, DOM performance degrades — especially on mobile and lower-end devices. The current implementation renders every message regardless of viewport visibility.

## Context

- Default message limit was raised from 100→1000, max from 500→5000 (task `2026-03-03-chat-message-limits-and-scroll.md`)
- Re-rendering loop was fixed (Feb 27) with React.memo + fingerprint dedup, but the linear DOM growth remains
- Industry standard for chat with 1000+ messages is virtual scrolling — only rendering items in/near the viewport
- Previously evaluated and deferred due to complexity; now reconsidered as message counts grow

## Technical Assessment

### What Virtual Scrolling Would Change

Two rendering surfaces need virtualization:

1. **ProjectMessageView** (`apps/web/src/components/chat/ProjectMessageView.tsx`) — DO-backed message history
2. **AgentPanel** (`packages/acp-client/src/components/AgentPanel.tsx`) — ACP live streaming view

### Library Options

| Library | Pros | Cons |
|---------|------|------|
| **TanStack Virtual** (`@tanstack/react-virtual`) | Headless, lightweight (10-15kb), full styling control, active maintenance | Reverse/chat scroll requires custom work, no official chat recipe |
| **react-virtuoso** | Built-in reverse scroll, `followOutput` prop for stick-to-bottom, chat-specific API | Opinionated styling, larger bundle |
| **Virtua** | Built-in reverse scrolling support | Smaller community, less documentation |

**Recommendation**: `react-virtuoso` for fastest path to working chat virtualization (its `followOutput` and reverse scroll are purpose-built for this). TanStack Virtual if we want more control long-term.

### Complexity Factors

These are the reasons this was previously deferred:

1. **Dynamic row heights** — Messages vary wildly in height (single-line vs multi-paragraph with code blocks). Requires `measureElement` or similar dynamic sizing.
2. **Reverse scroll (load-more)** — Scrolling up to load older messages must prepend without jumping. Virtualized lists handle this differently than regular DOM.
3. **Streaming message growth** — The last message grows token-by-token during streaming. The virtualizer must handle an item changing height continuously.
4. **ACP→DO view transition** — When switching from ACP (live) to DO (persisted) view during the grace period, the entire message list changes. Virtualizer state (scroll position, measured heights) must be preserved or gracefully reset.
5. **Scroll-to-bottom behavior** — Current `isStuckToBottomRef` pattern + `scrollIntoView` must work with the virtualizer's scroll API.
6. **Code block interactions** — Horizontal scroll within code blocks, copy buttons, and syntax highlighting must survive virtualization (items unmount when scrolled out of view).
7. **Load-more pagination** — Current `scrollHeight` preservation on prepend needs to work with virtual scroll offsets.

### Suggested Approach

1. Start with **ProjectMessageView only** (DO-backed, simpler lifecycle)
2. Use `react-virtuoso` with `followOutput` for stick-to-bottom
3. Implement `itemContent` renderer that wraps existing `chatMessagesToConversationItems()` output
4. Handle load-more via `startReached` callback (replaces current scroll position preservation)
5. Validate streaming performance (continuous height changes on last item)
6. If successful, apply same pattern to AgentPanel
7. Benchmark: measure DOM node count, memory usage, and frame rate before/after

### References

- [LogRocket: Building livestream chat with TanStack Virtual (Dec 2025)](https://blog.logrocket.com/speed-up-long-lists-tanstack-virtual/)
- [Reverse Infinite Scroll with TanStack Virtual](https://medium.com/@rmoghariya7/reverse-infinite-scroll-in-react-using-tanstack-virtual-11a1fea24042)
- [Stream React Chat SDK: VirtualizedMessageList](https://getstream.io/chat/docs/sdk/react/components/core-components/virtualized_list/)
- [Open WebUI Performance Discussion #13787](https://github.com/open-webui/open-webui/discussions/13787)
- [Virtual Scrolling: Rendering millions of messages (Kreya)](https://kreya.app/blog/using-virtual-scrolling/)

## Acceptance Criteria

- [ ] Chat with 1000+ messages renders only visible items (± overscan buffer)
- [ ] DOM node count stays constant regardless of message count
- [ ] Streaming messages (last item growing) render smoothly at 60fps
- [ ] Scroll-to-bottom / autoscroll behavior preserved
- [ ] Load-more pagination works without scroll jumps
- [ ] ACP→DO grace period transition preserves scroll position
- [ ] Code blocks retain horizontal scroll, copy, syntax highlighting
- [ ] Mobile performance measurably improved (frame rate, memory)
- [ ] Existing chat tests pass or are updated for virtualized rendering
- [ ] Benchmark results documented (before/after DOM count, memory, fps)
