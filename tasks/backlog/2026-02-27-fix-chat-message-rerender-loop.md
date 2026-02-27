# Fix Chat Message UI Re-rendering Loop

**Created**: 2026-02-27
**Priority**: High
**Classification**: `ui-change`, `cross-component-change`

## Symptoms

When viewing chat messages in an ACP session (workspace chat via AgentPanel):

1. **Can't click links or select text** — elements disappear or become unclickable during re-renders
2. **Wacky scroll behavior near the bottom** — scroll position fights with auto-scroll on each render cycle
3. **Horizontal scroll on code blocks resets immediately** — side-scrolling a `<pre>` inside an agent message snaps back after a fraction of a second
4. **General "infinite loop" feeling** — the UI is constantly updating even when no new content is arriving

All symptoms are consistent with excessive re-rendering triggered by a feedback loop between state updates, observers, and scroll management.

## Root Cause Analysis

There are **two independent rendering surfaces** for chat messages. Both have issues, but the ACP session (AgentPanel) path is the primary source of the user-reported symptoms.

---

### Surface 1: AgentPanel (ACP Session Chat) — PRIMARY

**Path:** `ChatSession` → `useAcpSession` + `useAcpMessages` → `AgentPanel` → `ConversationItemView` → `MessageBubble`/`ToolCallCard`/`ThinkingBlock`

#### Issue A: No React.memo on any conversation item component (CRITICAL)

**Files:**
- `packages/acp-client/src/components/AgentPanel.tsx:294-313` (`ConversationItemView`)
- `packages/acp-client/src/components/MessageBubble.tsx` (entire file)
- `packages/acp-client/src/components/ToolCallCard.tsx` (entire file)
- `packages/acp-client/src/components/ThinkingBlock.tsx` (entire file)

**Problem:** None of the conversation item rendering components are wrapped in `React.memo()`. Any state change in `AgentPanel` — even toggling `isAtBottom`, typing in the input, or showing/hiding the slash command palette — causes **every** `ConversationItemView` to re-render, which re-renders every `MessageBubble`, which re-parses every message's Markdown.

**Impact:** A conversation with 100 messages re-parses 100 Markdown documents on every keystroke, every scroll event that toggles `isAtBottom`, and every streaming chunk.

#### Issue B: Inline `components` prop in MessageBubble destroys code block DOM (CRITICAL)

**File:** `packages/acp-client/src/components/MessageBubble.tsx:29-58`

```tsx
<Markdown
  remarkPlugins={[remarkGfm]}
  components={{
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children, ...props }) => { ... },
    a: ({ href, children }) => ( ... ),
  }}
>
```

**Problem:** The `components` object is created inline on every render. Each render creates new function references for `pre`, `code`, and `a`. `react-markdown` sees new component references and **unmounts then remounts** the custom renderers. This destroys the DOM nodes for code blocks, which resets their `scrollLeft` to 0.

**This is the direct cause of the "horizontal scroll on code blocks resets" symptom.** The `<pre>` element is physically removed from the DOM and recreated on each render, losing all scroll state.

**Fix:** Hoist the `components` object to module scope or memoize it with `useMemo`.

#### Issue C: MutationObserver/ResizeObserver feedback loop with scroll state

**File:** `packages/acp-client/src/hooks/useAutoScroll.ts:93-121`

**Problem:** The `useAutoScroll` hook attaches a MutationObserver with `{ childList: true, subtree: true }` to the scroll container. When React re-renders children (even if the DOM doesn't structurally change), the observer can fire, triggering `scheduleScrollToBottom()`, which sets `el.scrollTop`, which fires the scroll event listener, which calls `setIsAtBottom()`, which causes a React state update, which re-renders AgentPanel (without React.memo, all children re-render), which can trigger the MutationObserver again.

The RAF coalescing prevents this from being truly infinite, but it creates a rapid multi-cycle cascade:

```
Stream chunk → setItems → re-render all items (no memo) →
  MutationObserver fires → scheduleScrollToBottom → RAF →
    set scrollTop → scroll event → setIsAtBottom → re-render all items →
      MutationObserver fires → scheduleScrollToBottom → RAF coalescence stops it
```

Each cycle involves re-rendering every `MessageBubble` with full Markdown re-parsing.

#### Issue D: Streaming chunks trigger full-list re-render

**File:** `packages/acp-client/src/hooks/useAcpMessages.ts:176-188` (`agent_message_chunk` handler)

**Problem:** Each streaming chunk calls `setItems(prev => updateLastItem(...))` which creates a new array. The new array reference causes `AgentPanel` to receive new `messages.items`, which re-renders the `.map()` loop. Without `React.memo` on `ConversationItemView`, every item re-renders on every chunk, not just the one being updated.

During active streaming, chunks arrive 10-50+ times per second. At 100 conversation items, that's 1,000-5,000 unnecessary component re-renders per second.

---

### Surface 2: ProjectMessageView (Project-Level Chat) — SECONDARY

**Path:** `ProjectChat` → `ProjectMessageView` (HTTP polling + WebSocket)

#### Issue E: Dual polling + WebSocket race condition

**File:** `apps/web/src/components/chat/ProjectMessageView.tsx:133-161`

**Problem:** When `session.status === 'active'`, the component runs **both** a WebSocket connection and a 3-second HTTP polling interval simultaneously. The WebSocket handler deduplicates by ID when appending messages, but the polling handler blindly replaces the entire array:

```tsx
// WebSocket: deduplicates ✓
setMessages((prev) => {
  if (prev.some((m) => m.id === newMsg.id)) return prev;
  return [...prev, newMsg];
});

// Polling: replaces entire array ✗
setMessages(data.messages);
```

The polling `setMessages(data.messages)` fires every 3 seconds with a **new array reference** even if the messages haven't changed. This triggers the auto-scroll `useEffect` and re-renders the entire message list.

#### Issue F: Auto-scroll fires on every poll cycle

**File:** `apps/web/src/components/chat/ProjectMessageView.tsx:121-124`

```tsx
useEffect(() => {
  if (messages.length > 0 && !loading) {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }
}, [messages.length, loading]);
```

**Problem:** The dependency is `messages.length`, not the array reference. If polling returns the same number of messages, this won't fire. However, if polling and WebSocket race (WS adds one, poll replaces all), the length can oscillate, causing repeated smooth-scroll calls that fight with user interaction.

---

## Recommended Fixes

### Fix 1: Memoize conversation item components (Highest Impact)

Wrap `ConversationItemView`, `MessageBubble`, `ToolCallCard`, and `ThinkingBlock` in `React.memo()`. This alone will eliminate ~90% of unnecessary re-renders because parent state changes (input, scroll, palette) won't cascade.

```tsx
const ConversationItemView = React.memo(function ConversationItemView({ item }: { item: ConversationItem }) {
  // ... existing switch
});
```

**Files:** `AgentPanel.tsx`, `MessageBubble.tsx`, `ToolCallCard.tsx`, `ThinkingBlock.tsx`

### Fix 2: Hoist Markdown `components` prop (Fixes code block scroll reset)

Move the `components` object to module scope so it's a stable reference:

```tsx
// Module-level constant
const MARKDOWN_COMPONENTS = {
  pre: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  code: ({ className, children, ...props }: ...) => { ... },
  a: ({ href, children }: ...) => ( ... ),
};

// In MessageBubble:
<Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
```

Also hoist `remarkPlugins={[remarkGfm]}` to avoid creating a new array each render.

**File:** `MessageBubble.tsx`

### Fix 3: Deduplicate or eliminate dual polling + WebSocket

In `ProjectMessageView`, either:
- **Option A:** Remove the polling fallback when WebSocket is connected (check `ws.readyState`)
- **Option B:** Use a smarter polling strategy that compares message IDs before calling `setMessages`, to avoid replacing with an identical array
- **Option C:** Add a `lastMessageId` or `etag` check so polling is a no-op when nothing changed

**File:** `ProjectMessageView.tsx`

### Fix 4: Guard auto-scroll against no-op updates

In `ProjectMessageView`, track the previous message count and only fire `scrollIntoView` when it actually increases:

```tsx
const prevCountRef = useRef(0);
useEffect(() => {
  if (messages.length > prevCountRef.current && !loading) {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }
  prevCountRef.current = messages.length;
}, [messages.length, loading]);
```

**File:** `ProjectMessageView.tsx`

### Fix 5: Consider virtualizing the message list (Long-term)

For conversations exceeding ~50 items, the re-render cost grows linearly. A virtualized list (e.g., `react-virtuoso` or `@tanstack/react-virtual`) would cap the rendered DOM to visible items only, dramatically improving performance.

**Files:** `AgentPanel.tsx`, `ProjectMessageView.tsx`

---

## Affected Files

| File | Change |
|------|--------|
| `packages/acp-client/src/components/AgentPanel.tsx` | Wrap `ConversationItemView` in `React.memo` |
| `packages/acp-client/src/components/MessageBubble.tsx` | Hoist `components` + `remarkPlugins`, wrap in `React.memo` |
| `packages/acp-client/src/components/ToolCallCard.tsx` | Wrap in `React.memo` |
| `packages/acp-client/src/components/ThinkingBlock.tsx` | Wrap in `React.memo` |
| `apps/web/src/components/chat/ProjectMessageView.tsx` | Fix dual polling, guard auto-scroll |

## Acceptance Criteria

- [ ] Code blocks inside agent messages retain horizontal scroll position during streaming
- [ ] Links inside messages are clickable without being interrupted by re-renders
- [ ] Text in messages can be selected and copied without selection disappearing
- [ ] Scroll position near the bottom is stable (no jitter/fighting)
- [ ] React DevTools Profiler shows <5 component re-renders per streaming chunk (down from N*items)
- [ ] Conversation with 100+ items remains responsive during active streaming
- [ ] All existing chat tests continue to pass
- [ ] New tests verify React.memo prevents unnecessary re-renders

## Verification Steps

1. Open React DevTools Profiler, record during active streaming
2. Verify only the streaming message item re-renders (not the entire list)
3. Horizontally scroll a code block during streaming — verify it holds position
4. Click a link in an agent message during streaming — verify it navigates
5. Select text in a message during streaming — verify selection persists
6. Scroll up to read earlier messages, verify auto-scroll doesn't yank you back
7. Scroll to bottom, verify new messages appear smoothly
