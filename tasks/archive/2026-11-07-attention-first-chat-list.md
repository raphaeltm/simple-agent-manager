# Attention-first project chat session list

## Problem

The project chat session list (desktop sidebar, Zen peek panel, Focus strip, mobile drawer) has one
placement rule: `isStaleSession` moves any non-sleeping session with no message for three hours
into a collapsed **Older** bucket. Observed in production 2026-11-06:

- An `active` session idle for ~6h (a background dev server kept it alive) vanished into Older.
- A sleeping session with an unresolved `wake_failed` attention marker had no prominence at all.

Raphaël approved the recommended direction A from the design proposal
(`/design/chat-list-priority.md` in the project Library, task `01M6SJC0WHWFSXDYA5SB59B0DD`):
**Needs attention → Awake → Sleeping → History**, then asked for it to be shipped to production.

## Research findings

- `apps/web/src/pages/project-chat/useSessionFilters.ts` builds Recent/Older from
  `isStaleSession` plus a "stopped retry/fork" rule; consumed by `useProjectChatState.ts`
  (desktop sidebar + Zen peek via `ProjectChatSidebar.tsx`, Focus strip via `index.tsx`) and
  separately by `MobileSessionDrawer.tsx`.
- `apps/web/src/lib/chat-session-utils.ts`: `getSessionState` (active/idle/sleeping/terminated)
  and `getAttentionState` (needs_input/wake_failed precedence). `isStaleSession` is also used
  by `apps/web/src/pages/Chats.tsx` (cross-project page) — out of scope, keep it.
- Row rendering (`SessionList` → `SessionTreeItem` → `SessionItem`) already shows the status
  icon/label per row (Needs input, Wake failed, Running, Idle, Sleeping, Stopped…), so sections
  need no extra per-row badge.
- Task-status enrichment: `SessionTreeItem` merges `taskInfoMap` task status into the session;
  the list API also embeds `task.status`. Grouping must use the same enriched view so a
  terminal task lands in History.
- API `GET /api/projects/:projectId/sessions` (`apps/api/src/routes/chat-session-list.ts`) serves
  from the D1 `session_summaries` index (`services/session-summary-index.ts`) or falls back to
  the ProjectData DO; order `COALESCE(last_message_at, created_at, started_at) DESC, id DESC`,
  client limit 100. Regrouping only the newest 100 cannot surface an older awake or blocked
  session (design doc caveat). Both paths already support a `status` filter.
- Attention markers are carried by both paths (`attention_json` on the index, N+1 in the DO).
  `wake_failed` markers sit on `sleeping` sessions; `needs_input` on `active` ones — so
  including every `active` + `sleeping` session covers every attention marker in practice.
- Mobile opener: `ShellScreenAction` in `components/shell/MobileAppBar.tsx` has no badge.
- Docs describing the old behavior: `apps/www/.../guides/session-troubleshooting.md` ("moves into
  the collapsed Older group"), `guides/chat-features.md` "Switching Between Chats" and search note.
- Knowledge: Raphaël mostly uses his phone; compact controls; flat rows (no nested retries/forks);
  conversation recency within groups — archive/lifecycle must not promote a row.
- Signals not available today (admission_state, runtime freshness) are deferred: the incident
  sessions are both covered by existing attention/lifecycle signals.

## Implementation checklist

- [x] `chat-session-utils.ts`: `getSessionSection()` (attention/awake/sleeping/history) using
      `needs_input`/`wake_failed` markers (via `getAttentionState`, so section and row label
      always agree; expiry is left to the server), then `getSessionState`
- [x] Replace `useSessionFilters` Recent/Older with four sections; within a section order by
      last activity desc, id desc; search filters all sections and expands them
- [x] Shared `SessionSections` renderer used by `ProjectChatSidebar` and `MobileSessionDrawer`
      (Needs attention + Awake always open; Sleeping open by default; History collapsed with count)
- [x] Focus strip shows non-History sessions in section order
- [x] Mobile app-bar chat-list button shows the needs-attention count
- [x] API: `include=live` on the session list returns every `active`/`sleeping` session in scope
      that fell outside the page (offset 0, no status filter), on both the D1-index and DO paths
- [x] Client sends `include=live` for the sidebar list (initial prefetch + reloads)
- [x] Tests: section placement (6h-idle active → Awake; sleeping wake_failed → Needs attention;
      terminal task → History; stale marker on a stopped session → History), rendered sidebar/drawer behavior, API
      include=live on index and DO paths with an out-of-page session
- [x] Update docs (session-troubleshooting, chat-features)
- [x] Playwright visual audit 375px / 1280px

## Acceptance criteria

- [x] A session `active` with no message for 6h appears under **Awake**, visible without expanding
- [x] A sleeping session with a `wake_failed` marker appears first under **Needs attention**
- [x] Stopped/failed/completed sessions are under a collapsed **History** with a count
- [x] An awake session older than the newest 100 rows still appears in the list
- [x] Phone: the chat-list button shows how many sessions need attention
- [x] Search still finds sessions in every section

## Implementation notes

- Folded History/Sleeping still render the open chat's row, so a chat that stops while you
  watch it (or a deep link to a finished one) never disappears (UI review HIGH).
- `include=live` on the D1 path is one `ROW_NUMBER() OVER (PARTITION BY status)` query,
  capped at `limit` per status, skipped when `session_index_coverage.session_count <= limit`,
  indexed by migration 0225, and isolated so a failure serves the page alone. On the DO
  fallback it is two `listSessions` calls only when the page reports `hasMore`, also isolated.
- Task-outcome chunks now run in parallel; the creator lookup is chunked under D1's
  100-bind limit (the response can now exceed 100 rows).
- Round trips for the list GET on a large project (D1 path): membership 1 + coverage 1 +
  count/page/live 3 (one hop) + task outcomes 1–3 (one hop) + creators 1–3 (one hop) ≈ 7–9
  queries in 5 sequential hops; small projects unchanged at 6.
- Re-reviewed the expired Prettier debt baseline with the same values as PR #2558 so CI runs.
- Deferred (not needed for the two incidents): admission_state and runtime-freshness signals
  from the design doc's API gap table.
