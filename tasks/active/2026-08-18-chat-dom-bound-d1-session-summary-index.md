# Chat message DOM bound + D1 session summary index (UI Perf items #9 + #12)

- **Program**: SAM UI Performance Plan — idea `01M09SKVNJGJNJY2WGCZ6D89XZ`, Workstream G.
- **Item #12 prior art**: idea `01KRQTNPZPFQ8JJ2JZ5C53FAKR`.
- **Base branch**: `sam/read-idea-01m09skvnjgjnjy2wgcz6d89xz-using-bmbgfz` (Wave 1: #1849/#1850/#1851).
- **Constraints**: do NOT merge (coordinator merges); do NOT deploy/mutate staging (verification is
  consolidated at the primary integration PR — policy 71).

---

## Problem

Two claims in the brief were checked against the code before any work started (rule 05 / rule 39).
**One was false and one was stale.** The scope below follows the evidence, not the prose.

### Item #9 — "the project chat renders ALL messages into the DOM": FALSE

`apps/web/src/components/project-message-view/index.tsx:555-613` already renders the conversation
through `<Virtuoso>` with `overscan={200}` (px). Rendered rows are already bounded to
≈ viewport + 200 px, not O(messages). The plan idea's own "What's already good" section says the
same thing. Brief options A (virtualize), B (last-N + Load earlier) and C (DOM recycling) all target
a problem that does not exist, and **option B would re-open a closed incident** — see below.

The genuine defects on this surface are:

| # | Defect | Evidence |
|---|--------|----------|
| 9a | `components={{ Header: () => (…) }}` creates a **new component type on every render**, so React unmounts and remounts the whole header subtree (spacer + "Load earlier" button) on every parent render — during streaming that is every token | `index.tsx:590-612` |
| 9b | `itemContent` is an inline arrow → new identity every render → every windowed row re-renders | `index.tsx:566` |
| 9c | `AcpConversationItemView` is not `React.memo`-wrapped; the memo boundary sits one level lower (`MessageBubble`), so the wrapper and its `switch` re-run for every windowed row on every render | `AcpConversationItemView.tsx:91` |
| 9d | **`ChatTimelineDrawer` renders EVERY entry unvirtualized** (`entries.map(...)`), and `useSessionTimeline` fills it with two **uncapped** `for(;;)` paging loops that page to exhaustion | `ChatTimelineDrawer.tsx:114`, `useSessionTimeline.ts:36-51,62-75` |

**9d is the real O(N) DOM sink** for long conversations and is where the DOM-count win lives.

#### Rejected: lowering `DEFAULT_CHAT_SESSION_MESSAGE_MAX`

`packages/shared/src/constants/defaults.ts:64-82` documents that the 50 000 full-conversation initial
load exists *specifically* so the timeline jump index map is complete — it is the fix for the
"dead click" jump bug (CLAUDE.md changelog `chat-full-load-timeline-jump`; rule 17's 2026-07-03
virtualized-list incident). Lowering it, or switching to "render only the last N", would regress a
previously fixed bug. Rejected on evidence; the full load stays.

### Item #12 — "denormalize session summaries to D1": the cross-project half is ALREADY SHIPPED

- `0049_session_summaries.sql` already created `session_summaries` + both indexes.
- `durable-objects/project-data/session-summary-sync.ts` already write-through syncs it, driven by
  `scheduleSummarySync()` (5 s debounce, `DO_SUMMARY_SYNC_DEBOUNCE_MS`) from 12 DO mutation sites.
- `routes/chats.ts` already serves `GET /api/chats` and `/api/chats/recent` from D1, and
  `useRecentChats` / `useAllChatSessions` already have no fan-out.

The remaining gap — and what the brief actually describes — is the **per-project chat sidebar list**,
which the prior-art idea explicitly left on the DO ("What This Does NOT Change"). It still calls
`listSessions` on the ProjectData DO on every project load and every poll:

- Route: `apps/api/src/routes/chat.ts:138-163` (`GET /api/projects/:projectId/sessions`)
- DO: `durable-objects/project-data/sessions.ts:179-243` — one COUNT + one page query, **plus an
  N+1 attention-marker lookup per row** (`sessions.ts:359-366` → `attention.ts:346-371`)
- Client: `useProjectChatState.ts:367-370`, driven from mount, WS reconnect, and two
  visibility-aware poll timers (`:437`, `:441`) plus six event-driven refetches

The existing index cannot serve that read today. Blocking gaps found:

1. **`created_by_user_id` is not synced at all** — the sidebar needs it for `scope=my`, `isMine` and
   the creator chip (`SessionItem.tsx:17-19`).
2. **Attention markers are not synced** — `getAttentionState` (`chat-session-utils.ts:129-131`) gives
   `attention.kind === 'needs_input'` the highest precedence. Markers also **expire by wall clock**,
   so a denormalized copy must carry `expires_at` and be re-evaluated at read time (rule 53: never
   treat a time-sensitive value as still true just because nothing wrote to it).
3. **Coverage is partial by construction** — the sync only takes sessions with
   `updated_at > now-24h` and `LIMIT 200` (`session-summary-sync.ts:26-36`), so D1 is not a complete
   per-project mirror and cannot produce a correct `total`.
4. **Three writers never trigger a sync** (rule 44 gap): `markAgentCompleted` (`index.ts:520-523`),
   `linkSessionToWorkspace` (`index.ts:381-390`), and the reconciliation `failSession`
   (`reconciliation-dead-target.ts:48`, whose hooks object carries no sync callback).

## Out of scope (filed as a SAM idea instead — policy 72)

`session-summary-sync.ts:20-23` sets `session_summaries.user_id` to the **project owner**, not the
session creator, while `routes/chats.ts` filters `WHERE user_id = ?`. In a shared/multiplayer project
a member's own sessions never appear in their recent-chats and the owner sees other members' sessions
as their own. This is pre-existing, and fixing the filter changes product-visible behaviour
(policy 5 escalation class (a)), so it is filed as an idea rather than silently changed here. This
task adds the `created_by_user_id` column the fix will need.

---

## Design

### Item #9

- Hoist the Virtuoso `components` object and `itemContent` behind `useMemo`/`useCallback` so the
  header subtree stops remounting and windowed rows stop re-rendering on unrelated parent renders.
- Wrap `AcpConversationItemView` in `React.memo`.
- Virtualize `ChatTimelineDrawer` with `Virtuoso` (same library, same patterns as the message list),
  keeping the date separators, the jump callbacks and the empty/loading states intact.
- Bound the two `useSessionTimeline` paging loops with a configurable max-pages constant
  (`DEFAULT_CHAT_TIMELINE_MAX_PAGES`, build-time override `VITE_CHAT_TIMELINE_MAX_PAGES`), mirroring
  the existing `DEFAULT_CHAT_LOAD_UNTIL_MAX_PAGES` precedent.

### Item #12

**Additive migration `0117`** (rule 31 — `ALTER TABLE ADD COLUMN` + `CREATE TABLE` only, never
`DROP TABLE`; `session_summaries` is a CASCADE child of `projects`/`users`, so recreation is
forbidden anyway):

- `session_summaries`: add `created_by_user_id TEXT`, `attention_kind TEXT`,
  `attention_expires_at INTEGER`, `synced_at INTEGER`.
- New `session_index_coverage(project_id PK, synced_at, session_count, complete)` — the per-project
  freshness + completeness record that gates the fast path. A dedicated table rather than more
  columns on `projects` keeps the concern separable.

**Sync** (`session-summary-sync.ts`): index the whole project (bounded by a configurable
`DEFAULT_SESSION_INDEX_MAX_ROWS`) instead of the 24 h / 200 window, carry creator + unresolved
attention marker (kind + expiry), and write the coverage row with `complete = count < max`.

**Read** (`services/session-summary-index.ts`, new): a D1 list read that returns rows in the exact
`listSessions` shape, with **per-row isolation** (rule 50 — one malformed row is skipped and warn-
logged, never fatal). Attention is re-evaluated against `Date.now()` at read time.

**Route** (`chat.ts`): D1 fast path **only when the coverage row proves it can answer exactly** —
fresh within a configurable TTL, and either complete or holding enough rows for the requested
window. Otherwise fall through to the DO, unchanged. The gate fails closed.

Field-mapping detail that must not be got wrong: the DO list shape sets `lastMessageAt = updated_at`
(`row-schemas/sessions.ts:27-50`), **not** the `last_message_at` column that `session_summaries` also
carries. The D1 mapper must use `updated_at` for `lastMessageAt` or the two paths diverge.

---

## Implementation checklist

### Item #9 — chat DOM bound

- [x] Stabilise Virtuoso `components` identity (kill the per-render header remount) —
      `ChatListHeader` is module-scope, varying data threaded via Virtuoso's `context` prop
- [x] `useCallback` the `itemContent` renderer
- [x] `React.memo` on `AcpConversationItemView`
- [x] Virtualize `ChatTimelineDrawer` entry list with Virtuoso, preserving date separators + jumps
      (extracted `TimelineStem` in `packages/ui` so the stem still spans the full scroll extent
      instead of being re-implemented — rule 26)
- [x] Add `DEFAULT_CHAT_TIMELINE_MAX_PAGES` and bound both `useSessionTimeline` paging loops
      (plus a non-advancing-cursor guard, which the page cap alone would not catch)
- [x] Behavioral test: header subtree is not remounted across parent re-renders — asserts DOM node
      IDENTITY, and **verified discriminating** (fails on the inline-`components` form)
- [x] Behavioral test: timeline paging is bounded under an always-`hasMore` server and under a
      non-advancing cursor, and still drains a normal finite history
- [x] Existing rule-17 jump test still passes: `scrollToIndex` receives the exact 0-based
      `conversationItems` index, not the `firstItemIndex` offset
- [x] Playwright audit: project chat + timeline drawer, long conversation, 375 px and 1280 px,
      `assertNoOverflow`, DOM counts captured. 12/12 green at both viewports.
      **Measured (400-message conversation, ~300-entry timeline):** conversation rows 3–7 of 400
      (already virtualized, unchanged); timeline drawer **12–13 rows, previously all ~300**. Row
      count stays flat after scrolling, so the bound is the steady state and not just first paint.
      The audit needed a 120 s per-test budget — it mounts the heaviest fixture in the suite and then
      full-page-screenshots it.

### Item #12 — D1 session summary index

- [x] Migration `0117` (additive only) + drizzle schema update
- [x] `pnpm quality:migration-safety` passes (143 FK relationships scanned, 0 violations)
- [x] Extend the DO sync: full-project coverage, creator, `created_at`, attention, coverage row
- [x] Wire `scheduleSummarySync()` into `markAgentCompleted`, `linkSessionToWorkspace` and the
      reconciliation `failSession` path (rule 44 enumeration)
- [x] New D1 read service with per-row isolation
- [x] `chat.ts` D1 fast path behind the coverage gate, DO fallback otherwise
- [x] DO `listSessions` self-heals the index, so a fallback re-primes the fast path
- [x] All new limits/TTLs are env-configurable with `DEFAULT_*` constants (Principle XI)
- [x] File the `user_id` attribution SAM idea → `01M0BB9CEDS0MF49A116VF960H`

**Attention expiry — deliberately NOT re-evaluated at read time.** `getAttentionSummary`
(`attention.ts:346-371`) returns the newest UNRESOLVED marker *regardless of* `expires_at`; expiry is
processed separately by the DO alarm. Filtering on expiry in the D1 read would therefore make the two
paths disagree, which is the one thing this design cannot afford. The index mirrors the DO's
semantics exactly instead. (This replaces the "+ expiry re-evaluation" line originally planned above
— the plan was written before reading `getAttentionSummary`.)

### Tests

- [x] **Equivalence**: field-by-field parity across 16 keys between the real DO `listSessions` and
      the D1 read, over a real Durable Object (`tests/workers/session-summary-index-sync.test.ts`)
- [x] **Gate**: missing / incomplete / stale coverage each fall back to the DO, asserted at the route
      by spying on the DO service (`tests/unit/routes/chat-sessions-d1-fast-path.test.ts`)
- [x] **Per-row isolation**: good/bad/good → good rows returned + warn logged, no throw; all-bad →
      empty, no throw; corrupt attention blob keeps the row minus its badge; a pre-0117 legacy row
      is still readable
- [x] **Project scoping against a real SQL engine** (rule 28): cross-project attack fixture paired
      with a same-project owner control; **verified discriminating** — deleting `project_id = ?`
      fails both
- [x] **Writer coverage**: `markAgentCompleted`, `linkSessionToWorkspace` and `stopSession` each
      reach the index, over a real DO

## Acceptance criteria

1. Long conversations render a bounded number of DOM rows in both the message list and the timeline
   drawer; the bound is asserted by a test, and before/after counts are reported in the PR.
2. Scroll-to-bottom during streaming, jump-to-message from the timeline, and "Load earlier" all still
   work, each covered by a behavioral test.
3. The per-project sidebar session list is served from D1 when the coverage gate proves equivalence,
   and from the DO otherwise; both paths return the same shape.
4. The new D1 read tolerates a malformed row and cannot leak another project's sessions.
5. The migration is additive, passes the migration-safety gate, and drops nothing.
6. `pnpm lint && pnpm typecheck && pnpm test && pnpm build` are green.

## Specialist review outcomes (Phase 5)

Four local reviewers ran. Two independently reached the same conclusion about item #12: the read path
got faster and the write path got substantially more expensive, and the write path was the bigger
number. That was correct, and it is the most useful thing this review produced.

| Finding | Severity | Resolution |
|---|---|---|
| Self-heal placed inside the shared `listSessions` RPC — false for 7 of its 8 callers; account-map fans out over 200 projects, admin backfill over every project in the deployment | CRITICAL ×2 reviewers | Dedicated `primeSessionIndex` RPC, called only from the one caller that observed a miss, skipped for over-cap projects |
| Whole-project mirror on every debounce fire (the old 24 h window was accidentally delta-shaped) | CRITICAL ×2 | Delta sync since the last successful watermark; full mirror only on first sync / after incomplete coverage. Regression test proven discriminating |
| Over-cap projects can never regain `complete`, so they pay full write cost forever for zero read benefit | CRITICAL | Circuit breaker — record coverage, stop mirroring |
| No mutex around the sync's read→write critical section (rule 45) | HIGH | Promise-chain lock with the read inside it; the test double drives the LOCKED path so a concurrency test cannot pass via a bypass |
| "Fast path" is not fewer round trips — the DO's count/page are in-process SQLite (1 DO hop vs 2 D1 hops) | HIGH ×2 | Claim corrected in code; count+page parallelized. The real win is avoiding a single-threaded DO wake + its N+1 attention lookup |
| Reconciliation dead-target writer had wiring but no test (rule 44) | HIGH | Test added at the real `processReconciliationCandidates`, proven discriminating, plus a no-hook control |
| Timeline drawer lost its vertical padding (measured flush at y=54 px in a real browser) | MEDIUM | Restored |
| `React.memo` on `AcpConversationItemView` does NOT hold during streaming — item identity is rebuilt per token | MEDIUM | Comment corrected to state the real scope rather than claim the streaming case |
| New env vars undocumented (rule 01) | MEDIUM | Added to `apps/api/.env.example`, `apps/web/.env.example`, `configuration.md` |
| Stem gradient is now viewport-anchored, not content-anchored; comment said "visually identical" | LOW | Comment corrected |
| Duplicate Virtuoso mock | LOW | `project-message-view.test.tsx` consolidated onto the shared helper |
| Keyboard Tab cannot reach off-window rows in any virtualized list | MEDIUM | Filed as idea `01M0BJYZXG4BKE1T6ZCESTBGTZ` — pre-existing for the conversation list, newly inherited by the drawer, and a cross-surface accessibility decision rather than a tweak to one component |

The task-completion-validator also flagged the Playwright audit as failing; that reading came from
output captured **before** the `components.List` measurement fix. Re-verified after every subsequent
change: 12/12 green at both viewports.

## CI

`ci.yml` is scoped to `pull_request: branches: [main]`, so a PR targeting the program integration
branch gets **no automatic CI** — only `Run benchmarks` fires. CI was therefore dispatched manually
against the head branch. Consequence: `Preflight Evidence` and `Specialist Review Evidence` are
SKIPPED on a `workflow_dispatch` run because they read the `pull_request` event payload. Both were
validated locally against a synthesized event and pass; they will evaluate for real when this content
reaches a PR targeting `main`.

Run [32200201517](https://github.com/raphaeltm/simple-agent-manager/actions/runs/32200201517) failed
**one** job — the file-size gate, with `apps/api/src/routes/chat.ts` at 801 lines against rule 18's
800-line ceiling. Fixed by splitting the session-list handler into
`apps/api/src/routes/chat-session-list.ts` (chat.ts 801 → 702, new file 118) rather than shaving a
line: the D1-index fast path and its DO fallback are a self-contained concern with their own failure
semantics, so that is the seam rule 18 asks for. No behaviour change; API suite still 7708/7708.

## References

- Rules: 02, 05, 17 (virtualized-list), 26, 28, 31, 39, 42, 44, 45, 47, 50, 53, 56, 59, 60
- `.claude/rules/60-request-io-and-bundle-budgets.md` — the I/O budget this work is measured against
