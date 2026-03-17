# Chat Message Duplication Analysis Report

**Date:** 2026-03-17
**Author:** Claude (automated analysis)
**Status:** Research complete, implementation plan pending

## Executive Summary

Chat messages in the project chat UI suffer from duplication because **6 independent data sources** feed into a single `messages` state array using **3 different update strategies** (replace, append, prepend) with **deduplication only at render time**. This means the state itself can accumulate duplicates, and the autoscroll effect — which depends on `messages.length` — fires spuriously when duplicates inflate the count.

## Architecture: Message Delivery Paths

### The 6 Sources

| # | Source | File | Strategy | Dedup |
|---|--------|------|----------|-------|
| 1 | Initial REST load | `ProjectMessageView.tsx:438-454` | `setMessages(data.messages)` (replace) | None (fresh state) |
| 2 | WebSocket `message.new` | `ProjectMessageView.tsx:349-365` | `setMessages(prev => [...prev, msg])` (append) | ID check + optimistic replace |
| 3 | WebSocket catch-up (reconnect) | `ProjectMessageView.tsx:369-373` | `setMessages(catchUpMessages)` (replace) | None (full replace) |
| 4 | Polling fallback (3s interval) | `ProjectMessageView.tsx:540-576` | `setMessages(data.messages)` (replace) | Fingerprint skip |
| 5 | Load more (pagination) | `ProjectMessageView.tsx:668-701` | `setMessages(prev => [...data, ...prev])` (prepend) | None |
| 6 | ACP agent session | `ProjectMessageView.tsx:773-831` | Separate `agentSession.messages.items` | Timestamp + ID filter at render |

### The Backend Dual-Delivery Problem

The VM agent sends each message through **two** paths simultaneously:

1. **Real-time ACP stream** (`session_host.go:1958`): `broadcastMessage(data)` → directly to browser via ACP WebSocket
2. **Batch persistence** (`session_host.go:1961-1974`): `ExtractMessages()` → outbox → batch POST → ProjectData DO → `broadcastEvent('messages.batch')` → browser via DO WebSocket

This means the browser receives the same logical message content from:
- The ACP WebSocket (immediate, during `isPrompting`)
- The DO WebSocket (delayed 1-5s, after batch flush + persist + broadcast)
- Polling (every 3s, from REST API)

### Deduplication Layers (Current)

| Layer | Where | Mechanism | Limitation |
|-------|-------|-----------|------------|
| VM outbox | `schema.go:14` | `UNIQUE message_id` + `INSERT OR IGNORE` | Only prevents intra-VM duplicates |
| ProjectData DO | `project-data.ts:318-326` | `SELECT id` before insert | Prevents DB duplicates; **still broadcasts** |
| WebSocket onMessage | `ProjectMessageView.tsx:351` | `prev.some(m => m.id === msg.id)` | Only for append path; **not for replace paths** |
| Render-time | `ProjectMessageView.tsx:115-123` | `Set<string>` on message IDs | Catches duplicates **in the rendered output** but state still holds duplicates |
| ACP/DO merge | `ProjectMessageView.tsx:803-806` | Timestamp + `doIds` Set | Fragile — depends on timestamp ordering |

## Root Causes of Visible Duplication

### Root Cause 1: Polling Full-Replace Races with WebSocket Append

**Scenario:**
1. T=0ms: Poll completes → `setMessages([msg1, msg2])` (replace)
2. T=500ms: WebSocket delivers `msg3` → `setMessages(prev => [...prev, msg3])` → `[msg1, msg2, msg3]`
3. T=3000ms: Poll fetches `[msg1, msg2, msg3]` → `setMessages([msg1, msg2, msg3])` (replace)
4. Between T=3000ms and T=3000.1ms: React batches both state updates

**Result:** State is `[msg1, msg2, msg3]` — no duplication in this exact scenario. But if WebSocket delivers `msg3` *after* the poll fetch started but *before* it completes, `msg3` exists in state from WebSocket, then gets replaced by the poll array that also contains `msg3`. The message flickers.

### Root Cause 2: ACP→DO Grace Period Mismatch

**Scenario:**
1. Agent stops prompting → grace period starts (10 seconds, `ProjectMessageView.tsx:425-428`)
2. During grace, `useFullAcpView = true` → full ACP view rendered
3. At ~2s, VM agent batch flush completes → DO has messages → poll picks them up
4. But grace still active until T=10s → still showing ACP view
5. At T=10s, grace ends → switches to DO view
6. DO messages and ACP messages show the **same content rendered differently** (ACP ConversationItems vs DO-converted ConversationItems)

**Result:** User sees a visual "jump" where the entire message list re-renders with slightly different formatting/grouping. This looks like duplication even when it isn't — messages may be grouped differently between ACP and DO views.

### Root Cause 3: WebSocket Catch-Up Replaces In-Flight Messages

**Scenario:**
1. WebSocket disconnects briefly
2. During disconnect, messages arrive (user doesn't see them)
3. WebSocket reconnects → `onCatchUp` fires → `setMessages(catchUpMessages)` (full replace)
4. But the REST fetch for catch-up may not include the very latest messages (propagation delay)
5. Messages that were in state from before disconnect are replaced with a potentially stale snapshot

**Result:** Messages appear, disappear, then reappear on the next poll cycle.

### Root Cause 4: Load-More Prepend Without Dedup

**Scenario:**
1. State: `[msg5, msg6, msg7]` (most recent)
2. User clicks "Load earlier messages"
3. Fetch returns `[msg3, msg4, msg5]` (overlapping with current state)
4. Prepend: `[...data.messages, ...prev]` = `[msg3, msg4, msg5, msg5, msg6, msg7]`

**Result:** `msg5` appears twice in state. The render-time dedup in `chatMessagesToConversationItems()` catches this, but `messages.length` is 6 instead of 5, causing the autoscroll effect to think there are new messages.

### Root Cause 5: Autoscroll Depends on `messages.length`

The autoscroll effect (`ProjectMessageView.tsx:508-534`) uses `messages.length` as its trigger:
```typescript
const hasNewMessages = messages.length > prevMessageCountRef.current;
```

When duplicates inflate `messages.length`:
- Autoscroll fires when it shouldn't (user scrolled up but count changed)
- `prevMessageCountRef` tracks the inflated count, making future comparison unreliable
- Full replacements from polling can decrease `messages.length` (removing duplicates), making `hasNewMessages` false even when new messages exist

### Root Cause 6: ACP/DO ID Mismatch

ACP messages use IDs from the ACP SDK (agent-generated). DO messages use IDs from `ExtractMessages()` (`uuid.NewString()` in Go). These are **different UUIDs for the same logical message**. The merge logic at `ProjectMessageView.tsx:803-806` handles this via timestamp comparison:

```typescript
const acpOnlyItems = acpItems.filter(
  (item) => item.timestamp > latestDoTimestamp && !doIds.has(item.id)
);
```

But when timestamps are close or identical (same millisecond), the `>` comparison can either:
- Include both copies (if ACP timestamp === DO timestamp, `>` fails, message appears only in DO)
- Miss the ACP copy (correct behavior when DO has it)
- Include the ACP copy when it shouldn't (if ACP timestamp is slightly later due to clock skew)

## Impact on Autoscroll and Content Jumps

### Problem 1: Spurious Scroll-to-Bottom

When `messages.length` changes due to duplicates being added/removed by different sources, the autoscroll effect fires. If the user has scrolled up to read earlier messages, a poll-triggered full replacement that changes `messages.length` by even 1 message causes:
- `hasNewMessages = true`
- If `isStuckToBottomRef.current` is true (user was recently at bottom), scrolls to bottom
- User loses their reading position

### Problem 2: Content Jumps During ACP→DO Transition

When `acpGrace` ends (after 10 seconds), the render switches from `<AcpMessages items={acpItems} />` to the merged DO+ACP view. These two views:
- May group messages differently (ACP has real-time chunking; DO has stored chunks)
- Have different item counts (ACP items vs converted ConversationItems)
- The container's `scrollHeight` changes abruptly

This causes a visible "jump" in scroll position because no scroll position preservation runs during this transition (unlike the `loadMore` path which explicitly preserves scroll position).

### Problem 3: Poll-Triggered Re-Renders Reset Scroll Tracking

Every 3 seconds during active sessions, polling may call `setMessages(data.messages)`. Even with fingerprint-based skipping, when the fingerprint changes:
- Full state replacement triggers re-render
- `messages.length` may differ from previous render
- Autoscroll effect runs and may or may not scroll
- The scroll position tracking (`isStuckToBottomRef`) can get out of sync if the container height changes between the scroll event handler and the autoscroll effect

---

## Remediation Plans

### Plan A: Unified Message Store (Map-Based State)

**Core idea:** Replace `useState<ChatMessageResponse[]>` with a `Map<string, ChatMessageResponse>` that all 6 sources write through, plus a derived sorted array for rendering.

**Changes:**

1. **Create `useMessageStore` hook** with:
   - Internal `Map<string, ChatMessageResponse>` keyed by message ID
   - Sorted array derived from map values (by `createdAt` then `sequence`)
   - Single `upsert(messages: ChatMessageResponse[])` method that all sources call
   - `prepend(messages: ChatMessageResponse[])` for load-more that sets a flag to suppress autoscroll
   - `replace(messages: ChatMessageResponse[])` for catch-up/polling that merges instead of overwrites

2. **Modify all 6 sources:**
   - Initial load: `store.replace(data.messages)`
   - WebSocket onMessage: `store.upsert([msg])`
   - Catch-up: `store.replace(catchUpMessages)`
   - Polling: `store.replace(data.messages)` (merge, not overwrite)
   - Load more: `store.prepend(data.messages)`
   - ACP: unchanged (separate overlay)

3. **Autoscroll fix:**
   - Track `lastSeenMaxSequence` instead of `messages.length`
   - Only trigger autoscroll when `maxSequence` increases (genuine new messages)
   - Ignore count changes from dedup/merge

4. **ACP/DO transition fix:**
   - When grace period ends, preserve scroll position (same pattern as load-more)
   - Compare container `scrollHeight` before/after transition

**Pros:**
- Deduplication happens at write time, not render time
- All sources go through one code path
- Autoscroll based on sequence numbers is more reliable than length
- State never contains duplicates

**Cons:**
- Larger refactor — touches all message source integrations
- Map-to-array conversion on every render (can memoize)
- Need to handle optimistic messages (they won't have server IDs yet)

### Plan B: Single Source of Truth (Polling-Only for Persisted Messages)

**Core idea:** Remove WebSocket append as a message source. Use WebSocket only as a signal to trigger immediate re-fetch. Polling becomes the sole path for persisted messages.

**Changes:**

1. **WebSocket `message.new` handler:** Instead of appending to state, set a "dirty" flag that triggers an immediate poll
2. **WebSocket `messages.batch` handler:** Same — trigger immediate poll instead of merging
3. **Catch-up on reconnect:** Keep as-is (full replace from REST)
4. **Polling:** Keep as-is but add "immediate poll" capability triggered by WebSocket events
5. **ACP overlay:** Keep as-is for real-time streaming during prompting

6. **Autoscroll fix:**
   - Since messages only change via polling (full replace), track the last message ID instead of count
   - Scroll to bottom only when a new message ID appears at the end of the array

7. **Reduce poll interval** during active sessions from 3s to 1s to compensate for losing real-time WebSocket updates

**Pros:**
- Dramatically simpler — one source of truth (REST API)
- No race conditions between append and replace
- WebSocket becomes a notification channel, not a data channel
- Deduplication is free (server always returns canonical state)

**Cons:**
- Higher API load (more frequent polling)
- Slightly higher latency for message display (1s poll vs instant WebSocket)
- May feel less responsive during active agent sessions
- Doesn't solve the ACP/DO merge problem

### Plan C: Reducer-Based State Machine with Sequence Tracking

**Core idea:** Replace `useState` with `useReducer` that maintains a normalized message store internally and handles all update strategies as explicit actions with built-in deduplication.

**Changes:**

1. **Define message actions:**
   ```typescript
   type MessageAction =
     | { type: 'LOAD'; messages: ChatMessageResponse[] }
     | { type: 'APPEND'; message: ChatMessageResponse }
     | { type: 'CATCH_UP'; messages: ChatMessageResponse[]; session: ChatSessionResponse }
     | { type: 'POLL_UPDATE'; messages: ChatMessageResponse[] }
     | { type: 'PREPEND'; messages: ChatMessageResponse[] }
     | { type: 'OPTIMISTIC_ADD'; message: ChatMessageResponse }
     | { type: 'OPTIMISTIC_CONFIRM'; optimisticId: string; confirmed: ChatMessageResponse };
   ```

2. **Reducer maintains:**
   - `messagesById: Map<string, ChatMessageResponse>`
   - `sortedMessages: ChatMessageResponse[]` (derived, cached)
   - `highWaterSequence: number` (highest sequence seen — for autoscroll)
   - `optimisticIds: Set<string>` (pending optimistic messages)

3. **Each action type has explicit dedup logic:**
   - `LOAD`: Replace map entirely
   - `APPEND`: Check map before adding; skip if ID exists
   - `CATCH_UP`: Replace map (authoritative) but preserve optimistic messages
   - `POLL_UPDATE`: Merge into map (add new, update existing, don't remove)
   - `PREPEND`: Merge into map (all are "old" messages)
   - `OPTIMISTIC_ADD`: Add with `optimistic-` prefix ID
   - `OPTIMISTIC_CONFIRM`: Remove optimistic, add confirmed

4. **Autoscroll:**
   - New `useAutoScroll` hook that reads `highWaterSequence` from reducer
   - Only scrolls when sequence advances (not when count changes)
   - Separate "user scrolled up" detection with debounced threshold

5. **ACP/DO merge:**
   - Keep existing grace period but reduce from 10s to 3s
   - Add scroll position preservation during ACP→DO transition
   - Use the reducer's `highWaterSequence` to determine "newest DO message" instead of timestamp max

**Pros:**
- Explicit state machine — every transition is documented and testable
- Built-in deduplication at every entry point
- Sequence-based autoscroll is robust against count changes
- Optimistic messages are first-class citizens
- Highly testable (reducer is a pure function)

**Cons:**
- Most complex implementation
- Requires careful migration of all 6 source integrations
- Reducer + derived array could have performance implications for large message lists
- Need to ensure `highWaterSequence` is always monotonically increasing
