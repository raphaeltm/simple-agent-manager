# Fix Chat Scroll Position Jump on Message Send and Agent Handoff

**Created**: 2026-03-19
**Priority**: High
**Classification**: `ui-change`

## Problem

Two related scroll position issues in the chat interface:

### Issue 1: Scroll jumps on message send

When the user hits submit/enter to send a message, the scroll position immediately jumps to a different location (somewhere up in the conversation). The user has to tap the scroll-to-bottom button to get back. This happens consistently on every send.

### Issue 2: Scroll bump on agent handoff

When the agent finishes and human control is handed back, there's a noticeable scroll position shift — roughly 100-600 pixels. If the user has scrolled up to read earlier output, this bump is disruptive. Not as severe as Issue 1 but still annoying.

## Likely Causes

### Issue 1: Send handler triggering state changes that affect scroll

When a message is sent:
1. The input is cleared (textarea height changes)
2. An optimistic message is appended to the list
3. The message is POSTed to the API
4. The server confirms and broadcasts via WebSocket

The scroll jump likely comes from one of:
- **Textarea height collapse** — clearing the input reduces the textarea height, which shifts the scroll container's layout. If the scroll position is measured before the layout update, the saved position becomes stale.
- **Optimistic message append triggering autoscroll logic** — the new message may trigger `scrollIntoView` but with a stale scroll state reference
- **`mergeMessages` with 'append' strategy** causing a re-render that resets scroll

### Issue 2: ACP→DO grace period transition

When the agent finishes:
1. ACP stream stops → grace period starts (3s)
2. After grace: switch from ACP ConversationItems to DO ChatMessages
3. The message list is replaced with a differently-structured list

The bump likely comes from:
- **Different message heights** — ACP ConversationItems and DO ChatMessages may render at slightly different heights (different grouping, metadata, spacing)
- **Grace period end replacing the view** — the entire message list swaps, and scroll position preservation via `requestAnimationFrame` may not perfectly match
- **Polling firing during transition** — the 3s polling cycle may deliver a `mergeMessages('replace')` that causes a layout shift

## Investigation Steps

1. **Reproduce Issue 1**: Add `console.log` to the send handler and all scroll-related effects. Log scroll position before/after each step (input clear, optimistic append, API response).
2. **Check textarea height handling**: Does clearing the input cause a layout shift that isn't compensated?
3. **Check `mergeMessages` during send**: Is the optimistic→confirmed reconciliation causing a re-render that resets scroll?
4. **Reproduce Issue 2**: Add logging around the grace period transition. Log scroll position before/after the ACP→DO view switch.
5. **Check `requestAnimationFrame` scroll preservation**: Is the RAF callback in the grace period transition actually restoring the correct position?
6. **Check if polling interferes**: Does a poll cycle fire at the same time as the transition?

## Affected Files

- `apps/web/src/components/chat/ProjectMessageView.tsx` — main message view, scroll logic, grace period
- `apps/web/src/hooks/useChatWebSocket.ts` — WebSocket message handling
- `packages/acp-client/src/hooks/useAutoScroll.ts` — auto-scroll logic
- `apps/web/src/lib/merge-messages.ts` — message state updates

## Acceptance Criteria

- [ ] Sending a message does not change scroll position (user stays where they were, or smooth-scrolls to bottom if stuck-to-bottom)
- [ ] Agent handoff does not cause visible scroll position shift
- [ ] Autoscroll still works correctly when stuck to bottom
- [ ] Load-more pagination still preserves scroll position
- [ ] No regression in streaming message display
