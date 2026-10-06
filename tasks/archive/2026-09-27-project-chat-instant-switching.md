# Project chat switching is instant: 24 h transcript cache, newest-first loading

SAM task: `01M3HKS2PFXTGM2F2VM4BDN0KY` · output branch `sam/project-chat-switching-instant-bdn0ky`
Idea: `01M0CSA14BAQH5ATEX04N8C4MA` (Raphaël's caching direction, 2026-08-19; switching repro, 2026-09-27)

## Problem

Raphaël (2026-09-26): switching between chats in a project has a noticeable loading delay, "even if
it was a session I just visited ... it's waiting for the revalidation instead of just switching".

Reproduced in a real browser (idea `01M0CSA14BAQH5ATEX04N8C4MA`, 2026-09-27 later section):

| Step                            | Message pane 400 ms after the click                                  |
| ------------------------------- | -------------------------------------------------------------------- |
| First visit to B (uncached)     | **A's title and messages** while B does a full fetch                 |
| A again, after 6 min unobserved | **B's title and messages** while A does a full fetch (cache evicted) |

Three causes, all code-verified:

1. **Transcripts leave memory after 5 minutes.** `sessions/messages` has no `gcTime` override
   (`lib/query-options/chats.ts` `chatSessionMessagesQueryOptions`), so TanStack's default 5-minute
   `gcTime` drops an unobserved transcript, and the next persisted write drops it from IndexedDB too
   (the persisted copy mirrors the in-memory cache; `useQueryCachePersistence.ts`). Restored
   transcripts get the same 5-minute `gcTime` (no `hydrateOptions`).
2. **An uncached switch keeps the previous chat on screen.** `ProjectMessageView` is not keyed by
   session, and `useSessionLifecycle.ts` mirrors query data into local `useState` in an effect that
   returns early while the new session has no data (`useSessionLifecycle.ts:375-417`). So `session`
   and `messages` keep the previous chat until the fetch lands; the full spinner at `index.tsx:519`
   only fires with no messages at all. Even a cached switch paints one frame of the old chat, because
   the mirror runs after paint.
3. **The cold fetch asks for 50,000 messages.** `limit: DEFAULT_CHAT_SESSION_MESSAGE_MAX`
   (`useSessionLifecycle.ts:101`, `chats.ts:107`).

## Scope (from the task)

1. Keep recent chats cached for 24 h in memory and in persisted storage; the window is a configurable
   constant with a `DEFAULT_*`.
2. Switch immediately: render the target chat's cached transcript at once, never the previous chat;
   stale-while-revalidate (refetches never unmount visible content).
3. Load newest first: the initial load requests the most recent page; older history pages in on
   scroll-up. Reuse the existing API and `message-paging` helpers.
4. Do NOT show a cached copy before the auth check finishes. Keep today's gating.
5. First, split `project-message-view/index.tsx` (877 lines) in its own no-behavior-change commit.

Build on PR #2159 (`2967a6cfa`, reopen-within-staleTime reconciliation). Do not regress it.

## Research findings

### API (no server change needed)

- `GET /api/projects/:projectId/sessions/:sessionId` (`apps/api/src/routes/chat.ts:149`) already
  serves newest-first pages: no cursor → `ORDER BY created_at DESC ... LIMIT n+1`, reversed to
  transcript order, `hasMore` = older rows exist (`durable-objects/project-data/messages.ts:352`,
  `formatMessageRows`). `before` pages older, `after` drains forward (asc).
- The client already uses exactly this for the fallback poll and reconnect catch-up
  (`limit: DEFAULT_CHAT_SESSION_MESSAGE_LIMIT` = 500), and `loadMore` pages with `before`.
- `CHAT_SESSION_MESSAGE_MAX` stays as the server clamp; only its "the initial load requests this"
  documentation becomes false (shared `defaults.ts`, `chat-message-query.ts`, `env.ts`,
  `apps/api/.env.example`, env-reference skill).

### Persistence and auth gating (keep as is)

- `AuthProvider` renders nothing until the identity namespace resolves, then a spinner while the
  IndexedDB restore runs (`AuthProvider.tsx:208-221`); `ProtectedRoute` spins while the session is
  pending. The restore only starts after the session check because the record is keyed by user id.
  So no cached transcript can render before auth. This change must not touch that gate (scope 4).
- Persist `maxAge` is already 24 h (`DEFAULT_QUERY_PERSIST_MAX_AGE_MS`), but it is the age of the
  whole record, refreshed on every write. Per-transcript retention is governed by `gcTime`.
- `persistQueryClient` accepts `hydrateOptions`; TanStack `hydrate()` builds restored queries with
  `options.defaultOptions.queries` (verified in `@tanstack/query-core@5.101.2/src/hydration.ts`).
- The persister stringifies the whole dehydrated client on every throttled write
  (`query-persistence.ts:80-87`). Longer retention means more transcripts per write, so the cache
  needs a count bound (idea 08-19 plan step 4, and "purged as it grows too large"; policy eac31fbb
  "modest, bounded" storage).

### Previous decisions this builds on or revises

- 2026-07-03 (`tasks/archive/2026-07-03-chat-full-load-timeline-jump.md`): the chat loaded the full
  conversation so the timeline jump index was complete. The jump keeps working without it: jumps
  already page back through `loadUntil`/`fetchHistoryUntil` when the target is not loaded.
- 2026-08-19 (idea above): `key={sessionId}` was removed because each remount meant a cold 50,000-row
  refetch. With the transcript served synchronously from the query cache, a remount is cheap, and a
  per-session key is the one construction that guarantees nothing from the previous chat (transcript,
  agent activity, pending jumps, in-flight sends) can render or act in the next one. The
  reintroduced key lives INSIDE `ProjectMessageView`, so every caller gets per-session isolation.

### Newest-first consequences (every consumer of "the transcript is fully loaded")

- Timeline jump: already server-backed (`useSessionTimeline` fetches user messages itself) and pages
  back through `loadUntil(timestamp)`. OK.
- Comment jumps pass the COMMENT's time (`SessionCommentsDrawer.tsx:142`, `ProjectComments.tsx:59`)
  or `Date.now()` (desktop rail, `index.tsx:549`). With a partial transcript an older anchor would
  resolve to the nearest message by that time, not the anchored message (a silent wrong jump). A jump
  to a specific message must page back until that message id is loaded.
- Comment inbox labels an anchor's role from loaded messages (`index.tsx:159`); an unloaded anchor
  would read "on the agent's reply". Unknown role must render a neutral label.
- `FloatingHeader` already guards its first-prompt title fallback on `!hasMore`. OK.

### Pre-existing bug in the code being restructured (fix here, with a test)

- The mirror effect re-runs on every cache write (every streamed WebSocket row calls
  `setQueryData`), re-hydrating the load-time `state` snapshot. A session loaded while idle flips
  `agentActivity` back to `idle` on the first streamed row after a `prompting` signal, and stops the
  verify-decay timer. Verified with a throwaway hook test on `aa354f983` (expected not idle, got
  idle). The dock's 1 s stabilizer hides it while tokens flow; it shows during pauses. Fix: hydrate
  server-reported `session`/`state` only when the server reports new ones (reference change), never
  on local writes.

### Other effects of the per-session key

- `useSessionTools` fetches report config once per mount (`useSessionTools.ts:108-115`); the Report
  rail action is hidden until it resolves. With a keyed view that is a refetch and a visible
  Report-icon flicker on every switch → move to TanStack Query (cached).
- The composer draft lives in `useSessionLifecycle` state. Today it leaks into the next chat; with the
  key it would be discarded. Keep drafts per session for the page's lifetime instead.
- The session-change reset effect (`useSessionLifecycle.ts:367-373`) becomes dead → remove.
- The header "Refreshing messages" spinner (`SessionHeader.tsx:323`, fed by `lc.loading`) can only
  render while the previous chat is on screen: with the key, `loading` implies no session and no
  header. Remove the dead prop. The global `BackgroundFetchIndicator` already shows a subtle bar
  while a cached transcript refreshes (policy eac31fbb).

### File size (rule 18)

- `project-message-view/index.tsx` 877 lines (hard limit) → split first, own commit.
- `useSessionLifecycle.ts` 787 lines and this change edits it → extract the transcript layer and the
  degraded poll in a separate no-behavior-change commit before the feature commit.

## Design

- `DEFAULT_CHAT_TRANSCRIPT_CACHE_TTL_MS` (24 h) and `DEFAULT_CHAT_TRANSCRIPT_CACHE_MAX_SESSIONS` (20)
  in shared defaults; `VITE_*` overrides resolved in one web config module.
- Transcript query options own loading: `gcTime` = TTL; `queryFn` = forward delta for a cached
  transcript (#2159, unchanged semantics) else the newest page only.
- Persistence: a persisted query is written only while its data is younger than its operation's max
  age (transcripts: TTL); restored queries get a `gcTime` that covers the persisted lifetime.
- Count bound: opening a transcript evicts the least recently updated unobserved transcripts beyond
  the max. Never evicts what is on screen.
- `ProjectMessageView` = per-session keyed view + per-session composer drafts.
- Transcript hook reads messages from the query cache (instant on the first render of a keyed view);
  all writers go through the cache; server snapshots hydrate only on reference change.
- Scroll-up paging via Virtuoso `startReached` (the "Load earlier messages" button stays as the
  visible and keyboard path).

## Implementation checklist

### Commit 1 — split `index.tsx` (no behavior change) — `54043f5a8`

- [x] Extract jump machinery → `useConversationJump.ts`
- [x] Extract optimistic user-message animation tracking → `useAnimatedUserMessages.ts`
- [x] Extract status banners, conversation pane, and footer into components (`SessionStatusBanners.tsx`, `ConversationPane.tsx`, `SessionFooter.tsx`)
- [x] `index.tsx` under 500 lines; drop the FILE SIZE EXCEPTION comment
- [x] Lint, typecheck, and the existing message-view tests pass unchanged

### Commit 2 — split `useSessionLifecycle.ts` (no behavior change) — `77372abba`

- [x] Extract transcript layer → `useSessionTranscript.ts`
- [x] Extract degraded fallback poll → `useFallbackSessionPoll.ts`
- [x] Existing lifecycle, resume, recovery, and message-view tests pass unchanged

### Commit 3+ — feature — `b56369417`

- [x] Shared constants + web config module (TTL, max sessions), `vite-env.d.ts`
- [x] Transcript query options: `gcTime`, newest-page cold load, forward-delta refresh (moved from the hook, same semantics)
- [x] Persistence: per-operation max age in the dehydrate filter; `hydrateOptions` gcTime
- [x] Count-bounded eviction of unobserved transcripts on open
- [x] Keyed per-session view + per-session drafts
- [x] Transcript hook reads from the query cache; server snapshots hydrate on reference change (fixes the activity reset)
- [x] Scroll-up paging (`startReached`) with an in-flight guard; keep the button
- [x] Jumps to a specific message page back until that id is loaded (`fetchHistoryUntil` target)
- [x] Comment inbox: unknown anchor role → neutral label
- [x] Report config → TanStack Query
- [x] Remove dead code: session-change reset effect, header `loading` spinner prop, `setError`, the size-eviction TODO
- [x] Docs: shared defaults, `chat-message-query.ts`, `env.ts`, API `.env.example`, web `.env.example`, `configuration.md`, env-reference skill

### Tests (real triggers, deferred ordering; rule 62) — `cca066ed9`

- [x] Page-level: selecting a cached chat renders its transcript on the first commit with no frame of the previous chat while its refresh is pending
- [x] Page-level: selecting an uncached chat never shows the previous chat; newest page renders
- [x] Page-level: a message persisted while away appears after switching back (#2159 guard at the switch), with production-like `staleTime`
- [x] Page-level: a chat left more than the default gcTime ago is still instant (test client gcTime 0)
- [x] Page-level: drafts are per chat; report config is not refetched per switch
- [x] Newest-first: cold open requests one page; scroll-up (`startReached`) prepends the older page with the `before` cursor; `firstItemIndex` accounting
- [x] Jump to an unloaded comment anchor pages back until the anchor loads and scrolls to its 0-based index
- [x] Hook: a streamed row after a `prompting` signal keeps the agent working
- [x] Persistence: TTL dehydrate filter; restored transcript outlives the default 5-minute gcTime; eviction keeps the most recent and never the observed
- [x] Auth: a persisted transcript is not rendered before the session check resolves, and renders on the first frame after
- [x] Revert each guard once; record which test went red (table below)

### Visual + staging

- [x] Playwright audit at 375x667 and 1280x800: long chat, empty chat, many sessions, long titles; switch flows; scroll paging; no overflow; screenshots opened and reviewed
- [x] Staging: switched between several real chats on app.sammy.party (runs at eb178fe31 and at the
      final build de85778ec, desktop and mobile). Cold open reads 500 rows, not 50,000, with no older
      page on open. Older history pages in on real scroll-up. An uncached switch shows the chat's own
      spinner, never the previous chat (baseline: 25–98 frames of it). A cached return shows the header
      in 64–158 ms. A chat left 6.5 min, reopened with reads held back 2.5 s, paints from cache. A
      timeline jump to the first of 3,691 rows lands on it. Console errors are only the pre-existing
      404s for deleted workspaces and reaped tasks, identical on the pre-change build and tracked in
      `tasks/backlog/2026-09-08-ended-chat-requests-deleted-workspace.md` and
      `tasks/backlog/2026-09-09-chat-requests-reaped-task-404.md`.

### Review follow-ups (Phase 5) — `6ad8502ec`, `7e6836242`

- [x] UI (HIGH): scroll-up paging only once the reader scrolls up (wheel, swipe, ArrowUp/PageUp/Home; the list position is not enough — on staging a chat opened away from the bottom because its newest message is taller than the screen). Virtuoso fires
      `startReached` whenever the first row renders, and a page of tool calls folds into a few
      rows, so an ungated open paged a tool-heavy chat's whole history in (reproduced in
      Playwright: two unrequested `before` loads)
- [x] UI (MEDIUM): focus handoff to the next chat's title when an in-chat link opens another
      chat (`session-focus-handoff.tsx`)
- [x] UI (LOW): freshly sent messages detected by id, not position (prepends, remounts)
- [x] Tests (HIGH): uncached-switch error state
- [x] Tests (MEDIUM): drafts across an in-flight send (`sending` / `delivered` / `failed`); a
      send that failed while away keeps its text
- [x] Tests (MEDIUM): eviction runs when a chat opens; `loadMore` failure recovers; reconnect
      catch-up keeps socket rows that land mid-drain (and a replace merge keeps rows newer
      than the window)
- [x] Performance (MEDIUM): per-transcript row cap on disk (`CHAT_TRANSCRIPT_PERSIST_MAX_ROWS`,
      default the 500-row page)
- [x] Security (LOW): an account switch discards drafts (test); precise draft docs wording
- [x] Architecture: dead `mergeSessionDetailMessages` removed; `TimelineJumpTarget` aliases
      `HistoryTarget`; explicit `SessionTranscript` interface; `WorkspaceChatView` duplication
      filed as `tasks/backlog/2026-09-27-workspace-chat-view-transcript-cache.md`
- [x] Docs: stale API clamp-test comment; deleted-workspace 404 source noted in
      `tasks/backlog/2026-09-08-ended-chat-requests-deleted-workspace.md`

## Acceptance criteria

- [x] A chat used within the last 24 h (configurable) opens from memory or IndexedDB without waiting for the network, and refreshes in the background.
- [x] Selecting a chat never renders the previous chat's title or messages, cached or not.
- [x] The cold load requests one page (default 500 rows); older history loads on scroll-up.
- [x] A message persisted while the chat was closed appears after reopening/switching back.
- [x] No cached transcript renders before the auth check resolves.
- [x] The transcript cache is bounded by age and count.
- [x] `project-message-view/index.tsx` is split in its own commit with no behavior change.

## Implementation notes

- **The keyed view needs a mounted-list gate for jumps.** An uncached chat mounts Virtuoso one
  render after its data arrives, so a deep-link jump fired on data arrival hit a null list ref.
  `useConversationJump` takes `listReady` and waits for it (guard G14).
- **The prepend anchor is derived, not effect-driven.** TanStack delivers cache updates to React
  via `setTimeout(0)`, so a cache write and a React state update are not one commit.
  `usePrependAnchor` derives `firstItemIndex` from the message list during render (guard G13).
- **Restored queries need their own `gcTime`.** A restored query nobody has reopened yet has no
  observer, so it takes its `gcTime` from the hydrate default options, not from the query options.
  The first G12 test observed the chat and could not see the difference; the auth test now asserts
  the `gcTime` of an unopened restored chat.
- **Test fixtures:** the test client's default `gcTime` is 0 (stands in for the 5-minute default),
  so tests reach a cached state by visiting chats, not by seeding the cache. Consecutive assistant
  rows merge into one display item, so paging fixtures use user rows.
- **A jump into history that is not loaded yet must confirm it landed.** With the whole transcript
  loaded, a jump never had to page first. Now it does, and in a real browser the scroll to the target
  was undone by Virtuoso's own prepend compensation, which shifted the list by the height of the rows
  that had just arrived. Playwright caught it; jsdom renders every row and cannot. The pending jump now
  scrolls instantly, waits two frames, checks the target row (`data-index`) is on screen, and
  re-scrolls until it stays there for two checks (bounded).
- **The paging gate keys on the reader's input, not the list position.** The first cut enabled
  `startReached` once Virtuoso reported "not at bottom". On staging, a tool-heavy chat whose newest
  message is taller than the screen opened with the scroll-to-bottom button showing and no reader
  action, so that gate was open at mount. It did not cascade only because the first rows were not
  rendered. `useReaderScrolledUp` in `ConversationPane.tsx` now waits for a wheel scroll up, a
  swipe down, or ArrowUp/PageUp/Home.
- `chats.ts` was already unformatted on `main`; only the changed lines were formatted (format
  ratchet), not the whole file.
- `packages/shared/src/constants/index.ts` (694 lines) is a pure named re-export barrel; the two
  added lines are exports. `SessionHeader.tsx` shrank from 611 to 599 lines (dead prop removed).

## Guard revert evidence (rule 62)

Each guard was reverted on its own with the rest of the change in place, the web suite was run, and
the guard was restored. Harness: `.tmp/guards/run_guards.py` (not committed).

| Guard                                                                 | Reverted in                                       | Test(s) that went red                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 per-session key                                                    | `project-message-view/index.tsx`                  | switching: cached switch paints in the switching commit; uncached switch never shows the previous chat; drafts per chat                                                                                                                                   |
| G2 transcript `gcTime`                                                | `lib/query-options/chats.ts`                      | switching: cached switch; Report tool not refetched                                                                                                                                                                                                       |
| G3 `refetchOnMount: 'always'` (#2159)                                 | `useSessionTranscript.ts`                         | switching: cached switch shows what arrived meanwhile; lifecycle: refreshes a fresh cached transcript within staleTime                                                                                                                                    |
| G4 newest-page cold load                                              | `lib/message-paging.ts`                           | switching: uncached switch; history: opens on the newest page; lifecycle: requests only the newest page                                                                                                                                                   |
| G5 cached report config                                               | `useSessionTools.ts`                              | switching: Report tool not refetched                                                                                                                                                                                                                      |
| G6 per-session drafts                                                 | `session-drafts.tsx`                              | switching: drafts per chat                                                                                                                                                                                                                                |
| G7 `startReached` paging                                              | `ConversationPane.tsx`                            | history: pages older history in at the top                                                                                                                                                                                                                |
| G8 jump pages until message id                                        | `lib/message-paging.ts`                           | history: comment jump into unloaded history; message-paging: pages past the target time until the id loads; reads nothing when loaded                                                                                                                     |
| G9 hydrate server snapshots only                                      | `useSessionLifecycle.ts`                          | lifecycle: keeps a working agent working after a streamed row                                                                                                                                                                                             |
| G10 dehydrate age filter                                              | `lib/query-persist-config.ts`                     | retention: stops writing a transcript older than the window                                                                                                                                                                                               |
| G11a eviction cap                                                     | `lib/query-options/chats.ts`                      | retention: keeps the most recent, evicts the rest; never evicts on-screen/opening                                                                                                                                                                         |
| G11b eviction pins                                                    | `lib/query-options/chats.ts`                      | retention: never evicts a transcript on screen, or the one being opened                                                                                                                                                                                   |
| G12 restored-query `gcTime`                                           | `hooks/useQueryCachePersistence.ts`               | auth: persisted transcript only after the session check (gcTime of the unopened restored chat)                                                                                                                                                            |
| G13 derived prepend anchor                                            | `useSessionTranscript.ts`                         | message view: decrements `firstItemIndex` by the row delta; history: newest page then older                                                                                                                                                               |
| G14 jump waits for mounted list                                       | `useConversationJump.ts`                          | message view: both deep-link GROUP-row jump tests                                                                                                                                                                                                         |
| G15 unloaded anchor role unknown                                      | `SessionMessageView.tsx`                          | history: comment jump into unloaded history                                                                                                                                                                                                               |
| Auth gate (`ProtectedRoute` renders children while pending)           | `components/ProtectedRoute.tsx`                   | auth: persisted transcript only after the session check                                                                                                                                                                                                   |
| G16 `startReached` only after the reader scrolls up                   | `ConversationPane.tsx`                            | history: newest page then older (unset until the reader scrolls up, even when Virtuoso reports not-at-bottom; red for both the earlier at-bottom gate and no gate); Playwright: tool-heavy chat opens on one page (pre-fix run: two extra `before` loads) |
| G17 focus handoff                                                     | `SessionMessageView.tsx`                          | focus: in-chat link moves focus to the next chat's title (control: an outside switch keeps focus)                                                                                                                                                         |
| G18 draft `sending`                                                   | `session-drafts.tsx`                              | switching: never offers a message still on its way again                                                                                                                                                                                                  |
| G19 draft `delivered` clears only unchanged text                      | `session-drafts.tsx`                              | switching: delivery keeps a newer draft                                                                                                                                                                                                                   |
| G20 draft `failed` keeps the text                                     | `session-drafts.tsx`                              | switching: a send failed while away is ready to retry                                                                                                                                                                                                     |
| G21 error branch of the load gate                                     | `SessionMessageView.tsx`                          | switching: shows why an uncached chat failed to load                                                                                                                                                                                                      |
| G22 catch-up keeps rows written meanwhile                             | `useSessionTranscript.ts`                         | lifecycle: a socket row survives a catch-up draining a gap                                                                                                                                                                                                |
| G23 replace keeps rows newer than the window                          | `lib/merge-messages.ts`                           | merge-messages: preserves messages newer than the window                                                                                                                                                                                                  |
| G24 eviction on open                                                  | `useSessionTranscript.ts`                         | lifecycle: trims cached transcripts when a chat opens                                                                                                                                                                                                     |
| G25 `loadMore` releases its in-flight guard                           | `useSessionTranscript.ts`                         | lifecycle: recovers from a failed older-page load                                                                                                                                                                                                         |
| G26 disk row cap                                                      | `lib/query-persistence.ts`                        | retention: writes only the newest rows of a long transcript                                                                                                                                                                                               |
| G27 drafts inside the signed-in subtree                               | test tree (provider hoisted above `AuthProvider`) | auth: an account switch discards drafts                                                                                                                                                                                                                   |
| G28 sent messages detected by id                                      | `useAnimatedUserMessages.ts` (original hook)      | animated: no re-fade on reopen; prepends are not new                                                                                                                                                                                                      |
| G29 jump into loaded history re-scrolls until the row stays on screen | `useConversationJump.ts` (scroll once)            | history: scrolls again until a row that arrived with older history stays on screen; Playwright: comment jump lands on message 10 (original code: never lands; two-frame deferral: 5/12 runs failed; verified landing: 16/16)                              |

## References

- `apps/web/.claude/rules/48-stale-while-revalidate-ui.md`, `.claude/rules/62-tests-must-observe-the-real-trigger.md`, `.claude/rules/18-file-size-limits.md`
- `tasks/archive/2026-09-26-chat-reopen-within-stale-time-misses-messages.md`, `tasks/archive/2026-09-26-chat-recent-window-merge-can-leave-gap.md`
- `tasks/archive/2026-07-03-chat-full-load-timeline-jump.md`
