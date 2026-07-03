# Load full conversation on chat open + fix timeline jump-to-message dead click

SAM idea: `01KWKZMB2AQ12AVFJ9VZB7CK4E`

## Problem

In project chat, clicking a timeline entry is supposed to scroll the chat to that
message. But the timeline fetches **all** user messages independently
(`useSessionTimeline.ts` paginates to completion), while the jump index map
(`index.tsx` `messageIndexMap`) is built **only from the currently-loaded chat
window** (`lc.messages`). Any message not yet loaded resolves to
`messageIndex = -1`, and `handleJumpToMessage` (`index.tsx:213-217`) returns
early — a silent dead click with no feedback. Only `user_message` entries are
clickable at all; `progress_notification` and `system_event` entries are
display-only.

The root simplification the user wants: **load the full conversation on session
open** so the index map is always complete (kills the dead click), removes the
windowed-loading mental model, and lets us drop most pagination complexity. Keep
a size-capped fallback to pagination only for the rare oversized tail.

## Research findings

### Storage / loading model (verified in code)
- `chat_messages` = raw STREAMING TOKENS (one row per token), cap
  `DEFAULT_MAX_MESSAGES_PER_SESSION = 100000` (`messages.ts:19`).
  `chat_messages_grouped` = materialized full messages, built only when a session
  STOPS (`materialization.ts`), used for FTS search. Display grouping happens
  client-side (`types.ts:chatMessagesToConversationItems`).
- Read path `getMessages` (`messages.ts:331`) reads raw `chat_messages` tokens,
  DESC, with a **30 MiB RPC size guard** that trims oldest rows and sets
  `hasMore=true` (`messages.ts:320,368`). This guard IS the natural "size cap".
- Page size = `DEFAULT_CHAT_SESSION_MESSAGE_LIMIT = 500`
  (`packages/shared/src/constants/defaults.ts:62`), compact mode on by default
  (strips tool content, lazy-loaded on expand). `getSessionMessageLimit`
  (`chat.ts:121`) currently uses this ONE constant as BOTH the unspecified
  default AND the max clamp.
- Client initial load: `useSessionLifecycle.loadSession` calls `getChatSession`
  with NO limit → server default (500) → `setMessages(data.messages)` +
  `setHasMore`. `loadMore` paginates backwards (`before`) prepending, adjusting
  `firstItemIndex` (Virtuoso prepend-stable, `VIRTUAL_START=100000`).
- **3s poll fallback** (`useSessionLifecycle.ts:270`) and WS `onCatchUp`
  (`:151`) call `getChatSession` with NO limit and `mergeMessages(..., 'replace')`.

### Critical gotcha (already partially mitigated)
- Backlog `tasks/backlog/2026-05-05-fix-chat-message-loading-regression.md`
  documented poll/catch-up discarding earlier-loaded messages. `mergeReplace`
  (`merge-messages.ts:113`) has SINCE been fixed to preserve prev messages older
  than the incoming window, and poll/`onCatchUp` no longer call `setHasMore`. So
  a fully-loaded conversation SURVIVES polling **as long as the poll fetch size
  stays small** — if we raise the global default limit, the 3s poll would
  re-fetch the entire conversation every 3s. Therefore we MUST decouple the
  initial full-load size from the poll/loadMore page size.

### Production sizing (sam-prod `session_summaries.message_count` = raw token rows)
- 1,525 sessions; avg 1,711; p50 698; p90 4,963; p99 10,286; **max 30,228**.
- 60% >500 tokens (multi-page today); only 1.2% (18) >10k. Compact rows are
  small (~150 B) → even a 30k-token session ≈ ~4.5 MB, well under the 30 MiB
  guard. A ceiling comfortably above the observed max loads ~100% of real
  sessions in one request; the guard + `hasMore` "Load earlier" button is the
  fallback for anything larger.

### Timeline / items
- `TimelineEntry` (`timeline-types.ts`): `user_message` has
  `messageId`/`messageIndex`; `progress_notification` and `system_event` carry a
  `timestamp` but no message anchor.
- `ConversationItem` has stable `id` (first msg id of group) + `timestamp`
  (`types.ts:149`) — usable for the index map, nearest-timestamp jump, and
  highlight. `messageIndexMap` (`index.tsx:201`) already maps every loaded
  user-message id → Virtuoso index.
- Message rows render in `index.tsx` Virtuoso `itemContent` wrapped in
  `<div className="sam-message-entry px-4 pb-3">`. Chat CSS lives in
  `apps/web/src/index.css` (`.sam-scroll-button` block ~line 212) — add the
  highlight keyframe there.

## Design

1. **Decouple initial full-load from poll/page size (server).** Split
   `getSessionMessageLimit` into an unspecified-default (small, poll/loadMore) and
   a max clamp (large, full-load). Add `DEFAULT_CHAT_SESSION_MESSAGE_MAX` (shared)
   and a NEW env `CHAT_SESSION_MESSAGE_MAX` for the ceiling. Keep existing
   `DEFAULT_CHAT_SESSION_MESSAGE_LIMIT`/`CHAT_SESSION_MESSAGE_LIMIT` as the
   default page size (backward compatible — do NOT repurpose it).
2. **Full load on open (client).** `loadSession` requests
   `limit: DEFAULT_CHAT_SESSION_MESSAGE_MAX`; server clamps to its max → whole
   conversation in one request for ~100% of sessions. `hasMore=false` → no "Load
   earlier" button, complete index map, no dead clicks. Oversized/guard-trimmed
   sessions keep `hasMore=true` → existing "Load earlier" fallback.
3. **Keep poll cheap (client).** Poll passes an explicit small `limit`
   (`DEFAULT_CHAT_SESSION_MESSAGE_LIMIT`). `mergeReplace` preserves the fully
   loaded history.
4. **Robust jump (defensive, for the guard-trimmed tail).** If a jumped-to
   message isn't loaded, load older pages until present (bounded), then scroll —
   so even the oversized fallback never dead-clicks. Implemented via a
   pending-jump effect + a `loadUntil(timestamp)` on the hook.
5. **Flash the jumped-to message** so the jump is legible.
6. **Anchor non-message timeline entries.** `progress_notification` /
   `system_event` entries jump to the nearest message by timestamp.

## Implementation checklist

- [x] shared: add `DEFAULT_CHAT_SESSION_MESSAGE_MAX` in
      `packages/shared/src/constants/defaults.ts`; export from `constants/index.ts`.
- [x] api: add `CHAT_SESSION_MESSAGE_MAX?` to `apps/api/src/env.ts` (+ `.env.example`).
- [x] api: refactor `getSessionMessageLimit` in `chat.ts` — unspecified default =
      `CHAT_SESSION_MESSAGE_LIMIT`/`DEFAULT_CHAT_SESSION_MESSAGE_LIMIT`; max clamp =
      `CHAT_SESSION_MESSAGE_MAX`/`DEFAULT_CHAT_SESSION_MESSAGE_MAX`;
      return `min(requested ?? default, max)`.
- [x] web: `useSessionLifecycle.loadSession` requests
      `limit: DEFAULT_CHAT_SESSION_MESSAGE_MAX`.
- [x] web: poll (`useSessionLifecycle.ts:270`) requests explicit small
      `limit: DEFAULT_CHAT_SESSION_MESSAGE_LIMIT`.
- [x] web: add `loadUntil(timestamp)` to `useSessionLifecycle` (loops `loadMore`
      while oldest-loaded `createdAt` > timestamp AND `hasMore`, bounded).
- [x] web: `index.tsx` — pending-jump effect + `handleJumpToMessage(entry)` that
      scrolls when loaded or `loadUntil` then scrolls; `handleJumpToTimestamp(ts)`
      for context entries (nearest item by timestamp).
- [x] web: `index.tsx` — `highlightedItemId` state; pass to Virtuoso `itemContent`
      wrapper (`sam-message-highlight` class on match), auto-clear ~2s.
- [x] web: `ChatTimelineDrawer.tsx` — make `progress_notification` and
      `system_event` entries clickable (call jump-by-timestamp); keep user_message
      → jump-by-message. Update prop signature (`onJump(entry)`).
- [x] web: `apps/web/src/index.css` — add `@keyframes` + `.sam-message-highlight`.
- [x] Tests (see below).
- [x] Docs: `env-reference` (add `CHAT_SESSION_MESSAGE_MAX`), CLAUDE.md Recent
      Changes, `.env.example`.
- [x] Playwright visual audit of timeline drawer (all entry kinds clickable) +
      highlight, mobile 375 + desktop 1280, overflow assertion.

## Tests

- [x] api unit: `getSessionMessageLimit` — unspecified → default (small);
      requested below max → requested; requested above max → clamped to max;
      env overrides for both default and max.
- [x] web unit: `mergeReplace` preserves full history when poll returns a small
      recent window (regression for the poll-clobber gotcha) — extend existing
      merge-messages tests with a "10k loaded, poll returns latest 500" case.
- [x] web behavioral: `ChatTimelineDrawer` renders and clicking a
      `progress_notification` / `system_event` entry calls the jump handler
      (interactive-element requirement, Rule 02).
- [x] web behavioral: jump resolves for a message present in the map (scroll
      invoked) and, when absent, triggers load-until then scroll.
- [x] buildSessionTimeline: coverage updated for the new signature (no messageIndex); asserts messageId + timestamp anchoring.

## Acceptance criteria

- [x] Opening a session loads the full conversation in one request for typical
      sessions (no "Load earlier messages" button for ≤ ceiling / ≤30 MiB).
- [x] Clicking ANY timeline entry (user message, status update, activity) scrolls
      the chat to the relevant message — never a silent no-op.
- [x] The jumped-to message briefly highlights.
- [x] The 3s poll does NOT re-fetch the whole conversation and does NOT discard
      loaded history.
- [x] Oversized/guard-trimmed sessions still work via the "Load earlier" fallback
      and jump still resolves (load-until).
- [x] Ceiling + poll size are env-configurable (`CHAT_SESSION_MESSAGE_MAX`,
      `CHAT_SESSION_MESSAGE_LIMIT`) — no hardcoded operational limits.
- [ ] Staging verified end-to-end via Playwright (Phase 6). Local Playwright visual audit already passes.

## Staging verification post-mortem (2026-07-03) — jump dead-click on virtualized sessions

**What broke:** On staging, clicking a timeline entry closed the drawer but did
NOT scroll the chat to the message and did NOT flash the highlight — the exact
dead-click this task set out to fix, still present for real sessions.

**Root cause:** `itemIndexById` (`index.tsx`) mapped `item.id → lc.firstItemIndex + i`
(the `firstItemIndex`-offset ABSOLUTE coordinate ≈ `VIRTUAL_START` + i ≈ 100000).
`scrollAndHighlight` passed that value straight to react-virtuoso's
`scrollToIndex`, which operates on the **0-based data-array** coordinate (see the
codebase's other calls: `scrollToIndex({ index: 'LAST' })` and
`{ index: conversationItems.length - 1 }`). Passing ~100000 is out of range →
Virtuoso never scrolls → the target row stays virtualized-out → the highlight,
set on an unmounted row, never renders.

**Why it wasn't caught:** The `react-virtuoso` test mock renders EVERY row (jsdom
has no layout engine) and ignored the forwarded ref, so `scrollToIndex` was a
no-op and the highlight always attached regardless of the index passed. The unit
tests asserted highlight presence, which passes even with the wrong coordinate.
The drawer Playwright audit mocked `onJump`, so it never exercised the real
`scrollToIndex` path either.

**Class of bug:** Virtualization-hidden coordinate mismatch — a jsdom mock that
renders all items masks a real virtual-window bug. Any "scroll/jump to item"
feature is exposed to this.

**Fix:** `itemIndexById` now maps `item.id → i` (0-based data index);
`scrollToIndex` receives the correct coordinate. Commit on this branch.

**Process/test fix:** The `react-virtuoso` mock in `project-message-view.test.tsx`
now exposes `scrollToIndex` via `useImperativeHandle` and captures its argument.
New regression test asserts the jump calls `scrollToIndex` with the 0-based index
(`1`) and that no call uses the absolute `VIRTUAL_START` coordinate. Verified the
test FAILS on the pre-fix code (`expected [ 100001 ] to include 1`).

## References
- Rule 02 (interactive-element behavioral tests), Rule 06 (React interaction-effect
  analysis — jump vs. auto-scroll effects), Rule 16 (no reload on mutation),
  Rule 17 (visual testing), Rule 26 (project-chat-first), Rule 35 (vertical slice).
- `tasks/backlog/2026-05-05-fix-chat-message-loading-regression.md` (poll/merge history).
