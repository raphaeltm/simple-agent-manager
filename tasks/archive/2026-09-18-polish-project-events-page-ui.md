# Polish the project Events page UI

**SAM task**: `01M2T2FRM6CWK3A4V8ZPCS3Z3Z`
**Branch**: `sam/polish-project-events-page-cs3z3z`
**Scope**: `apps/web/` only. No API routes, services, or backend changes. No new npm dependencies.

## Problem

`/projects/:id/events` shipped inside a large backend-correctness feature branch
(PR #2075, eventing). Every panel works and is wired to real endpoints, but the surface
never got a dedicated UI pass:

- The four navigation tabs are bare text buttons with no indication of how much is in each
  section, so a user cannot tell whether a section is worth opening.
- Every section shares one generic empty state ("Nothing here yet. New records will appear
  after they are created.") that explains neither what the section holds nor how records get
  created. Subscriptions and Channels are populated *only* by agents through MCP tools, so a
  user staring at the generic copy has no way to learn that.
- `StateBadge` renders every state with identical neutral styling, so `failed`, `active` and
  `expired` are visually indistinguishable. A correct state-to-tone mapping already exists in
  `apps/web/src/components/admin/ProjectEventInspector.tsx` (`stateTone()`), unused by this page.
- Schedules move through `pending → processing → admitted/expired/failed` on their own. The
  panel only refreshes when the user presses Refresh, so progress is invisible.
- Section headings have no iconography, the session-scope banner is styled the same as an
  ordinary card, and long agent-authored text needs a re-check for mobile overflow.

## Research findings

### Files and current behavior

| File | Relevant detail |
| --- | --- |
| `apps/web/src/pages/ProjectEvents.tsx` | `sections` const drives a `<nav aria-label="Event sections">` of `Button`s with `aria-pressed`. Only the active section's panel is mounted (`{section === 'x' && <Panel/>}`). |
| `apps/web/src/components/project-events/EventUi.tsx` | Owns `QueryState` (pending → error → empty → children) and `StateBadge`. Empty branch is a hardcoded dashed `<p>`. |
| `SubscriptionsPanel.tsx` | Key `['auth', scope, 'events', projectId, 'subscriptions', sessionId, state]`. Returns `{subscriptions, hasMore, limit}`. |
| `SchedulesPanel.tsx` | Key `[…, 'schedules', sessionId, cursor]`. Returns `{schedules, nextCursor}`. |
| `StandingWatchesPanel.tsx` | Key `[…, 'watches', sessionId, cursor]`. Returns `{watches, nextCursor}`. |
| `ChannelsPanel.tsx` | Key `[…, 'channels', cursor]` (no `sessionId` — channels are always project-wide). Returns `{channels, nextCursor}`. |
| `SubscriptionDeliveryHistory.tsx` | Passes `empty={false}` to `QueryState` and hand-rolls its own empty `<p>` inside the children. |
| `apps/web/src/components/admin/ProjectEventInspector.tsx` | `stateTone()` at line 58 — the canonical state→tone mapping. Its neutral arm uses `bg-surface-secondary`, for which **no `--color-surface-secondary` token exists** in `apps/web/src/app.css`; it is a dead Tailwind class that renders no background. |
| `apps/web/src/lib/poll-intervals.ts` | Canonical, env-overridable poll cadences. Documents that TanStack `refetchInterval` already pauses on a hidden tab via `focusManager.isFocused()`, provided `refetchIntervalInBackground` stays `false`. |
| `apps/web/src/lib/query-client.ts` | Global defaults: `staleTime: 15_000`, `refetchOnWindowFocus: false`, `retry: 1`. `refetchIntervalInBackground` is NOT enabled globally — verified. |
| `apps/web/tests/playwright/project-events-audit.spec.ts` | 793 lines, 10 tests, already covers stress/empty/many/error/viewer scenarios. Its empty test asserts the literal string `'Nothing here yet.'` and every tab click uses `getByRole('button', { name: label, exact: true })`. |

### Complete state vocabulary reaching `StateBadge`

Gathered from `packages/shared/src/types/project-events.ts`,
`project-event-schedules.ts`, and
`apps/api/src/durable-objects/project-data/project-event-schedules-recovery.ts`
(execution status is an open `string` that can be a synthetic value, a delivery
state, **or** a task status):

- Subscriptions: `active`, `cancelled`, `expired`
- Schedules: `pending`, `processing`, `admitted`, `cancelled`, `expired`, `failed`, `ambiguous`
- Watches: `active`, `paused`, `revoked`
- Delivery batches: `pending`, `recorded_not_injected`, `delivered`, `acked`, `failed`, `ambiguous`, `expired`, `cancelled`
- Schedule execution: `unavailable`, `not_started`, plus any delivery state, plus any task status (`draft`, `ready`, `queued`, `delegated`, `in_progress`, `completed`, `failed`, `cancelled`)
- Admin inspector adds: `accepted`, `matched`, `batch_created`, `record_only`, `queued_for_prompt_delivery`, `runtime_steer`, `runtime_interrupt`, `spawn_task`, `retry`, `unauthorized`, `unsupported`, `critical`, `error`

A shared mapping must cover the union of both surfaces, and must have a defined fallback.

### Design decisions taken during research

1. **Counts come from the TanStack cache, never from new fetches.** Only the active panel is
   mounted, so adding page-level queries for all four sections would 4x the request count on
   every visit (`.claude/rules/60`) and would contradict "unvisited sections show no count".
   The cache is read reactively through `useSyncExternalStore` over
   `queryClient.getQueryCache().subscribe`, which is the sanctioned TanStack escape hatch and
   introduces no `useEffect` (`.claude/rules/06` interaction-effect analysis,
   `.claude/rules/48`). No such hook exists in the repo today — searched
   `useSyncExternalStore` / `getQueryCache` / `getQueriesData`, zero hits.
2. **A count with more pages available must not read as a total.** Schedules/watches/channels
   paginate and subscriptions returns `hasMore`, so the badge renders `4+` when more records
   exist rather than claiming `4`.
3. **`stateTone()` is extracted, not copied.** Copying it into `EventUi` would fork the mapping
   (`.claude/rules/24`, `.claude/rules/59` "extend, don't fork", policy 5cb362e8 DRY). It moves
   to `apps/web/src/lib/event-state-tone.ts` and both surfaces consume it. The admin neutral arm
   switches from the dead `bg-surface-secondary` to `bg-inset`, which is a real token — the
   admin inspector is therefore a changed surface and needs its own screenshots.
4. **Empty states stay inline and dashed, not `@simple-agent-manager/ui`'s `EmptyState`.** That
   component is `max-w-md mx-auto` + `glass-surface` and is used for *page-level* empties
   (`Projects`, `Dashboard`, `Chats`, `Workspaces`). Inline dashed section empties are the
   established local convention (`ProjectTriggers`, `NodeWorkspacesSection`,
   `DeploymentVolumesPanel`, `ComputePoolOfferingsManager`, `WebhookTriggerPanel`). This
   evolves `QueryState`'s existing dashed panel rather than adding a parallel component.
5. **`QueryState`'s empty content becomes a required prop.** Making it required is what stops a
   future call site from silently regressing to generic copy; all six call sites must supply
   their own.
6. **The tab accessible name will change** once a count is inside the button. The audit spec's
   `{ name: label, exact: true }` locators must move to a nav-scoped `tab()` helper, and the
   count needs an `sr-only` gloss so the name reads "Subscriptions 4 loaded", not "Subscriptions 4".
7. **Polling cadence is env-overridable**, per `.claude/rules/60` and constitution Principle XI —
   a bare `refetchInterval: 30_000` literal would violate both.

### Post-mortems / rules reviewed

- `.claude/rules/17-ui-visual-testing.md` (scoped `apps/web`) — mandatory audit, both viewports,
  per-surface PR evidence with `#### Surface:` headings; conditional assertions banned.
- `.claude/rules/62-tests-must-observe-the-real-trigger.md` — do not hand-feed the value under
  test; enter through the real trigger; every new guard must be proven discriminating.
- `.claude/rules/60-request-io-and-bundle-budgets.md` — poll intervals configurable + pause on
  hidden tab; do not add per-request I/O.
- `.claude/rules/48-stale-while-revalidate-ui.md` — never unmount content on refetch; memoize
  context values.
- `.claude/rules/24` / `.claude/rules/59` — search for an existing implementation and extend it.
- `.claude/rules/01-doc-sync.md` — a new env var must land in `.env.example` and
  `configuration.md` in the same commit.

## Implementation checklist

### Shared foundations
- [ ] Add `apps/web/src/lib/event-state-tone.ts`: `EventStateTone` union, `eventStateTone(state)`
      covering the full vocabulary above with a documented neutral fallback, and
      `EVENT_STATE_TONE_CLASS` using only tokens that exist in `app.css`.
- [ ] Rewrite `ProjectEventInspector.stateTone()` to delegate to the shared module; delete the
      local `switch`. Confirm no other copy of the mapping exists.
- [ ] Add `PROJECT_SCHEDULES_POLL_MS` (default 30 s, `VITE_PROJECT_SCHEDULES_POLL_MS` override)
      to `apps/web/src/lib/poll-intervals.ts`, following the existing `resolveIntervalMs` pattern.

### Count badges
- [ ] Add `useEventSectionCounts` reading the query cache via `useSyncExternalStore`, returning
      `{ count, hasMore }` per section or `undefined` when a section has never loaded.
      Snapshot must be referentially stable or React throws.
- [ ] Render the badge inside each nav `Button`: visible `{count}{hasMore ? '+' : ''}` marked
      `aria-hidden`, plus an `sr-only` gloss so the accessible name stays meaningful.
- [ ] Verify an unvisited section renders no badge and issues no request.

### Empty states
- [ ] Add `EventEmptyState` (icon + heading + description) to `EventUi.tsx`, keeping the dashed
      inline panel language.
- [ ] Change `QueryState`'s empty branch to render a **required** `emptyState: ReactNode` prop.
- [ ] Supply the four specified section copies verbatim, plus copy for channel history and
      delivery history.
- [ ] Migrate `SubscriptionDeliveryHistory` off `empty={false}` + hand-rolled empty onto the
      real `empty`/`emptyState` props.

### State badge colors
- [ ] `StateBadge` consumes `eventStateTone`; keeps a border so tone is not the only signal
      (`.claude/rules/04` — "clear non-color-only status communication"; the label text already
      names the state).

### Schedules auto-refresh
- [ ] Add `refetchInterval: PROJECT_SCHEDULES_POLL_MS` to the Schedules query. Do **not** set
      `refetchIntervalInBackground` (leaving it false is what pauses polling on a hidden tab).
- [ ] Confirm the refetch keeps rendered cards mounted (`QueryState` gates on `isPending`, not
      `isFetching`) so `.claude/rules/48` still holds.

### Visual polish
- [ ] lucide icons: `Radio` (Subscriptions), `Clock` (Schedules), `Eye` (Watches),
      `MessageSquare` (Channels) beside each section heading and in each empty state.
- [ ] Make the session-scope banner visually distinct (accent tint + icon + border), not a plain
      glass card.
- [ ] Re-check spacing/margins at 375 px and confirm long filter values, prompts and channel
      messages still wrap.

### Documentation
- [ ] Document `VITE_PROJECT_SCHEDULES_POLL_MS` in `apps/web/.env.example` and
      `apps/www/src/content/docs/docs/reference/configuration.md`.

### Tests
- [ ] Unit: `eventStateTone` — one case per tone incl. every schedule/watch/subscription/delivery
      state, plus the unknown-state fallback.
- [ ] Unit: `useEventSectionCounts` — populated cache yields a count; unvisited section yields
      `undefined`; `hasMore`/`nextCursor` yields the `+` form; snapshot identity is stable across
      unrelated cache events.
- [ ] Unit/behavioral: Schedules panel passes the resolved poll constant as `refetchInterval` and
      never enables `refetchIntervalInBackground`.
- [ ] Playwright: update the empty test to assert the four section-specific copies (this is the
      discriminating assertion for the empty-state change).
- [ ] Playwright: assert count badges appear for a visited section, persist after switching tabs,
      and are absent for a never-visited section.
- [ ] Playwright: assert the tone class actually differs between a `failed` and an `active` badge
      (proves the mapping is wired, not just present).
- [ ] Playwright: replace `{ name: label, exact: true }` tab locators with a nav-scoped helper.
- [ ] Run the full audit at 375x667 and 1280x800 for the events page **and** the admin events page.

## Acceptance criteria

1. Each visited section's tab shows a count badge; a never-visited section shows none and
   triggers no network request for that section.
2. A section with more records than are loaded shows `N+`, never a bare `N`.
3. Each of the four sections renders its own specified empty-state copy, with an icon.
4. `active`/`delivered`/`acked`/`admitted`/`completed` render with the success tone;
   `pending`/`processing`/`queued`/`in_progress` info; `paused`/`ambiguous`/`retry` warning;
   `failed`/`error` danger; `cancelled`/`expired`/`revoked` neutral — on both the Events page and
   the admin inspector, from one shared mapping.
5. The Schedules list refetches every 30 s (override: `VITE_PROJECT_SCHEDULES_POLL_MS`), pauses
   while the tab is hidden, and never unmounts rendered cards while refetching.
6. Section headings and empty states carry the specified lucide icons; the session-scope banner is
   visually distinct from ordinary cards.
7. No horizontal overflow and no clipped overflow at 375 px on any tab, in normal, long-text,
   empty, many-item and error scenarios.
8. `pnpm lint && pnpm typecheck && pnpm test && pnpm build` all pass.
9. No backend file changed; no dependency added.

## References

- `.claude/rules/17-ui-visual-testing.md`, `.claude/rules/04-ui-standards.md` (scoped `apps/web`)
- `.claude/rules/60-request-io-and-bundle-budgets.md`, `.claude/rules/48-stale-while-revalidate-ui.md`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`, `.claude/rules/24`, `.claude/rules/59`
- `.claude/rules/01-doc-sync.md`, `.claude/rules/03-constitution.md` (Principle XI)

---

_Archived 2026-09-23 by the weekly queue reconciliation. This work shipped: it landed on `main` via PR #2098 (`Polish Events page: icons, state colors, empty states, auto-refresh (#2098)`). Its checklist reads 0/25 — most of those boxes are stale, but NOT all of them. The headline work is live (`apps/web/src/lib/event-state-tone.ts`, semantic state colours, icons, count badges, per-section empty states, auto-refresh). One item genuinely did not ship: `PROJECT_SCHEDULES_POLL_MS` was never added, and `SchedulesPanel.tsx:324` still polls on a bare `refetchInterval: 30_000` — which this task's own research section predicted would violate `.claude/rules/60` and Principle XI. Tracked in `tasks/backlog/2026-09-23-schedules-panel-hardcoded-poll-interval.md`. Full evidence and method: `tasks/archive/2026-09-23-weekly-queue-reconciliation.md`._
