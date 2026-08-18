# UI Performance Program — Workstream D: chat/client quick wins

**Program idea**: `01M09SKVNJGJNJY2WGCZ6D89XZ` (SAM UI Performance Plan)
**Scope**: plan items #8, #10, and the named subset of #11.
**Integration branch**: `sam/read-idea-01m09skvnjgjnjy2wgcz6d89xz-using-bmbgfz` (PR base — NOT `main`).
**Sibling workstreams (do not touch)**: `apps/api` auth middleware, `apps/api` DO round-trips,
`apps/web` route code splitting (`App.tsx`, `vite.config.ts`, `MarkdownRenderer`).

## Problem

Three independent client-side waste sources in the SAM web app:

1. **Item #8 — redundant session poll.** `useProjectChatState.ts` runs a 30s
   `setInterval(loadSessions, SESSION_SYNC_INTERVAL_MS)` with no liveness or visibility
   gate. `loadSessions` issues `listChatSessions(limit=100)` **and**
   `listProjectTasks(limit=200)` on every tick — even while the ProjectData DO WebSocket
   is `connected` and already applying real-time deltas, and even while the tab is hidden.
2. **Item #10 — unmemoized `handlePlayAudio`.** `AcpConversationItemView` rebuilds the
   `onPlayAudio` closure on every render, so `React.memo` on `MessageBubble` never holds.
   During streaming every visible agent bubble re-runs `react-markdown` + `remark-gfm`
   on every `text_delta` token.
3. **Item #11 (partial) — hand-rolled polls run in hidden tabs.** `Node.tsx` (two 10s
   intervals), `useWorkspaceCore.ts`, `useNodeSystemInfo.ts`, `useWorkspacePorts.ts` all
   poll unconditionally regardless of `document.visibilityState`.

## Research findings

### Item #8 — verified against code (line numbers confirmed 2026-08-18)

- `apps/web/src/pages/project-chat/useProjectChatState.ts:420-425` — the ungated interval.
  Deps are `[loading, loadSessions]`; the body is a bare `void loadSessions()`.
- `useProjectChatState.ts:361-389` — `loadSessions` does `listChatSessions` +
  (fire-and-forget) `listProjectTasks`. It already implements stale-while-revalidate
  (`hasLoadedRef` gates `setIsRefreshing`, never `setLoading`), so rule 48 is satisfied by
  the existing code and must not be regressed.
- `useProjectChatState.ts:406-410` — `useProjectWebSocket` already supplies
  `onReconnected: loadSessions`. **The reconnect catch-up direction already exists**; the
  gap is the disconnect direction and the hidden→visible direction.
- `useProjectChatState.ts:412` — `realtimeDegraded = connectionState === 'disconnected'`,
  confirming the tri-state `connecting | connected | disconnected`. Pausing must key on
  `=== 'connected'` only, so `connecting` still polls.
- Reference pattern: `apps/web/src/components/project-message-view/useSessionLifecycle.ts:405-409`
  — "Degraded fallback while the DO WebSocket is unavailable" returns early when
  `session.status === 'active' && connectionState === 'connected'`. (Note: the file is at
  `components/project-message-view/`, not `pages/project-chat/` as the brief stated.)
- `SESSION_SYNC_INTERVAL_MS` is defined in `pages/project-chat/types.ts:27-31` with a
  `DEFAULT_SESSION_SYNC_INTERVAL_MS` constant and a `VITE_SESSION_SYNC_INTERVAL_MS`
  override — already constitution-compliant, no new constant needed.

### Item #10 — verified against code

- `apps/web/src/components/project-message-view/AcpConversationItemView.tsx:110-125` builds
  `handlePlayAudio` inline; passed at line 154 to `AcpMessageBubble`.
- `packages/acp-client/src/components/MessageBubble.tsx:273` — `React.memo(...)` with the
  default shallow prop comparison, so a fresh `onPlayAudio` identity defeats it.
  `MessageBubble` also has `agentComponents = useMemo(..., [onFileClick, renderMermaid])`,
  so a broken memo additionally rebuilds the react-markdown component map.
- **Every other prop reaching `MessageBubble` is already stable** — verified:
  - `onFileClick` → `useSessionLifecycle.ts:199` `useCallback(..., [])`.
  - `onLoadToolContent` → `project-message-view/index.tsx:368` `useCallback(..., [projectId, sessionId])`.
  - `ttsApiUrl` → `getTtsUrl()` module-level cached string.
  - `text` / `timestamp` / `streaming` / `animated` — only change for the streaming bubble.
  This makes `onPlayAudio` the *sole* memo-breaker, so the fix is fully discriminating.
- **Dependency honesty**: `globalAudio` (the whole context value,
  `contexts/GlobalAudioContext.tsx:438`) is `useMemo`'d but its deps include live playback
  state (`currentTime`, `state`), so it changes on a timer while audio plays. Depending on
  it would re-break the memo. The correct dep is `globalAudio.startPlayback`
  (`GlobalAudioContext.tsx:207`, deps `[abortFetches, clearTimeInterval, createAudioElement,
  startTimeInterval]`; only `createAudioElement` is non-empty-dep, keyed on `playbackRate`)
  — stable except on an explicit user rate change.
- `item.text` for a *non-streaming* bubble is stable, so keeping it in the dep list costs
  nothing; the streaming bubble re-renders anyway because its `text` prop changed.

### Item #11 — verified against code

| Site | Line | Interval | Notes |
|---|---|---|---|
| `pages/Node.tsx` | 67-71 | 10s `loadNode` | also does the initial load |
| `pages/Node.tsx` | 74-88 | 10s `fetchEvents` | gated on `node.status === 'running'` |
| `pages/workspace/useWorkspaceCore.ts` | 285-301 | 10s `fetchEvents` | gated on url+token+isRunning |
| `hooks/useNodeSystemInfo.ts` | 63 | `POLL_INTERVAL_MS` | has `mountedRef`/`hasLoadedRef` SWR guards |
| `hooks/useWorkspacePorts.ts` | 79 | `POLL_INTERVAL_MS` | has `cancelled` + consecutive-failure guards |

- **EXPLICITLY OUT OF SCOPE**: `hooks/useActiveTasks.ts` — a later program wave migrates it
  to TanStack Query, which pauses on hidden tabs automatically.
- Prior art for the pattern already in-repo: `hooks/useRecentChats.ts:96-129` (stop the
  interval while hidden, refresh on `visibilitychange` → visible) and
  `hooks/usePushSubscription.ts:157-163`. Rule 24 / rule 59 therefore require a **single
  shared hook** rather than a sixth hand-rolled copy.

### Rules consulted

- `.claude/rules/48-stale-while-revalidate-ui.md` — spinners gate only on "no data yet";
  refetch must never unmount visible content; no effect loops.
- `.claude/rules/16-no-page-reload-on-mutation.md` — no reload patterns.
- `.claude/rules/06-technical-patterns.md` — React Interaction-Effect Analysis is mandatory
  for every effect touched.
- `.claude/rules/60-request-io-and-bundle-budgets.md` — "Polling Hygiene": intervals must be
  env-configurable with a `DEFAULT_*` constant and must stop when `document.hidden`. This
  task implements exactly that clause. Note its "new fetch surfaces use TanStack Query"
  clause applies to *new* surfaces — this task explicitly must not migrate anything.
- `.claude/rules/24-no-duplicate-ui-controls.md` / `.claude/rules/59-understand-before-adding.md`
  — search before adding; one canonical implementation.
- `.claude/rules/17-ui-visual-testing.md` + `.claude/rules/56-clipped-overflow-is-invisible-to-document-checks.md`
  — Playwright audit at 375px/1280px via `assertNoOverflow` (which also runs the
  clipped-overflow walk).
- `.claude/rules/02-quality-gates.md` — behavioral tests only (render + simulate + assert);
  source-contract tests banned; regression tests must be proven discriminating.

## Design decisions

1. **One shared hook**, `apps/web/src/hooks/useVisibilityAwarePoll.ts`, exporting
   `useDocumentVisible()` and `useVisibilityAwarePoll(callback, intervalMs, { enabled, paused })`.
   Rationale: five call sites would otherwise duplicate the same listener/teardown logic
   (rule 24). Semantics modelled on the existing `useRecentChats` pattern.
2. **Latest-ref callback.** The poll callback is held in a ref updated in a bare `useEffect`,
   so the callback's identity is *not* an effect dependency and a changing callback can never
   restart or re-fire the timer (rule 06 — this is the loop-prevention mechanism).
3. **Catch-up is elapsed-gated, not unconditional.** On a transition back to active the hook
   refreshes immediately iff `Date.now() - lastPollAt >= intervalMs`. This bounds staleness at
   exactly one interval (the poll's own contract) while preventing a fetch storm from rapid
   alt-tabbing, and it still catches up correctly when a browser freezes background timers
   entirely. No new tunable constant is introduced (Principle XI).
4. **`paused` vs `enabled`.** `enabled: false` means the poll should not exist at all
   (unmounted preconditions). `paused: true` means transiently suppressed (WS connected).
   Both suppress ticks; both arm the elapsed-gated catch-up on release.
5. **`useRecentChats` / `usePushSubscription` are NOT migrated** onto the shared hook in this
   PR — they are outside the named workstream file set and sibling agents are editing
   `apps/web` concurrently. Tracked as a follow-up backlog task instead of left silent.

## Implementation checklist

- [x] Create `apps/web/src/hooks/useVisibilityAwarePoll.ts` (`useDocumentVisible` +
      `useVisibilityAwarePoll`) with the latest-ref + elapsed-gated-catch-up semantics.
- [x] Item #8: replace the ungated interval in `useProjectChatState.ts` with
      `useVisibilityAwarePoll(loadSessions, SESSION_SYNC_INTERVAL_MS, { enabled: !loading, paused: connectionState === 'connected' })`.
- [x] Item #10: `useCallback` `handlePlayAudio` in `AcpConversationItemView.tsx` keyed on
      `[startPlayback, audioId, audioText]`, hoisting `globalAudio.startPlayback` so the
      whole context value is not a dependency. Hook must be called unconditionally.
- [x] Item #11a: `Node.tsx` — both 10s intervals via the shared hook.
- [x] Item #11b: `useWorkspaceCore.ts` — workspace-events interval via the shared hook.
- [x] Item #11c: `useNodeSystemInfo.ts` — via the shared hook, preserving `mountedRef` /
      `hasLoadedRef` / `isRefreshing` stale-while-revalidate behaviour.
- [x] Item #11d: `useWorkspacePorts.ts` — via the shared hook, preserving the
      consecutive-failure tolerance and stale-port retention.
- [x] Confirm `useActiveTasks.ts` is untouched.
- [x] Behavioral test: `useVisibilityAwarePoll` — fires when active, skips when
      `paused`, skips when hidden, catches up on hidden→visible and on unpause, does not
      catch up when under one interval has elapsed, never restarts on callback identity change.
- [x] Behavioral test: `useProjectChatState` session poll — no `listChatSessions` tick while
      `connectionState === 'connected'`; ticks while `disconnected`; skips while hidden.
- [x] Behavioral test (discriminating): `MessageBubble` render count does not increase for
      non-streaming bubbles across a streaming update. Must fail on pre-fix code.
- [x] Playwright audit of project chat at 375px and 1280px incl. an active-streaming
      scenario, with `assertNoOverflow`.
- [x] File the follow-up backlog task for migrating `useRecentChats` / `usePushSubscription`.
- [x] `pnpm lint`, `pnpm typecheck`, targeted `pnpm test`, `pnpm build` for `apps/web`.

## Review-driven additions (specialist review, 2026-08-18)

Five local reviewers ran against the branch. Three HIGH findings were real and are fixed
in-branch; the rest were addressed or explicitly deferred with rationale.

- [x] **HIGH (performance-reviewer + task-completion-validator, independently reproduced)** —
      every item-#11 call site double-fetched when its precondition became true more than one
      interval after mount (the normal VM-boot case): the caller's own precondition effect
      fired AND the hook's elapsed-gated catch-up fired. Fixed by restarting the freshness
      clock inside `useVisibilityAwarePoll` when `enabled` flips true (the caller owns that
      fetch); `paused`/visibility deliberately keep counting so the hidden-tab and
      WS-disconnect catch-ups survive. Regression test at the `useNodeSystemInfo` call site,
      proven discriminating (1 vs 2 fetches).
- [x] **HIGH (ui-ux-specialist)** — pausing the session poll whenever
      `connectionState === 'connected'` deleted its documented self-heal role.
      `connectionState` tracks socket open/close only; `useProjectWebSocket` discards
      malformed frames silently and there is no sequence number or gap detector, so a dropped
      delta would have left the sidebar wrong for the whole connection lifetime. Fixed by
      adding a slow reconciliation cadence (`SESSION_RECONCILE_INTERVAL_MS`, default 10min)
      active only while connected — self-heal preserved at ~1/20th the request rate.
- [x] **HIGH (performance-reviewer)** — the 2s provisioning poll (same file, item #8) and the
      chat-detail fallback poll in `components/project-message-view/useSessionLifecycle.ts`
      were still ungated on visibility. Both now gate via the shared `useDocumentVisible`.
      Scope note: `useSessionLifecycle.ts` is outside the brief's named file list; taken
      because it is the direct twin of item #8 in the same feature and is not owned by any
      sibling workstream.
- [x] **MEDIUM (task-completion-validator)** — `useWorkspaceCore.ts` has a *second* 5s
      workspace-state poll that the original research under-enumerated. Now gated (preserving
      the ref indirection that fixed React error #185).
- [x] **LOW** — `useNodeSystemInfo` lacked the stale-response generation guard its sibling
      `useWorkspacePorts` received; `useWorkspacePorts` flipped `loading` on every poll
      (rule 48); `Node.tsx`'s detail poll now passes `enabled` like every other call site;
      documented the `playbackRate` caveat in `startPlayback`'s dependency chain.
- [x] **Test coverage (test-engineer HIGH ×2)** — the item-#11 call sites had zero behavioral
      coverage and the `generationRef` swap in `useWorkspacePorts` had none. Added
      `tests/unit/hooks/useNodeSystemInfo.test.ts` (new file — the hook had never had one) and
      extended `useWorkspacePorts.test.ts` with stale-response and hidden-tab cases. Added
      `intervalMs`-change, compound-transition, unmount-mid-flight, and realistic-`onFileClick`
      cases.
- [~] **MEDIUM (architecture-reviewer) — DEFERRED**: migrate `useRecentChats` onto the shared
      hook. Declined in-branch under the explicit program instruction to stay inside the
      workstream's named files; tracked in
      `tasks/backlog/2026-08-18-consolidate-hand-rolled-visibility-polls.md`, which now also
      names `useWorkspaceNavigation`'s git-status poll and the per-call-site
      `visibilitychange` listener count.
- [~] **MEDIUM (architecture-reviewer) — DECLINED**: absorb the callers' "fire on enable"
      effects into the hook via an `immediate` option. Technically incorrect: those effects
      also re-fire on fetch-callback identity change (e.g. `Node.tsx` when `id` changes while
      `enabled` stays true). An active-transition-only `immediate` would silently drop the
      reload when navigating between nodes. Rationale recorded here and in the PR.

## Acceptance criteria

- [x] With the ProjectData WebSocket `connected` and the tab visible, no request is issued at
      the 30s fallback cadence; only the 10min reconciliation runs. (test)
- [x] Exactly one of the two session cadences is ever active. (test)
- [x] A poll whose precondition becomes true long after mount fetches exactly once, not
      twice. (test, discriminating)
- [x] A response for a superseded target (node id / workspace id / stopped workspace) never
      overwrites current data. (test)
- [x] With the WebSocket `disconnected` and the tab visible, the 30s poll still fires. (test)
- [x] With the tab hidden, neither the session poll nor any of the four item-#11 polls fire. (test)
- [x] Returning to a visible tab after ≥ one interval triggers exactly one immediate
      refresh, and under one interval triggers none. (test)
- [x] A streaming `text_delta` update does not re-render already-settled `MessageBubble`s;
      the test fails against the pre-fix (inline closure) implementation. (test, discriminating)
- [x] No visible content is unmounted and no spinner is shown during any refetch (rule 48).
- [x] Project chat renders without horizontal or clipped overflow at 375px and 1280px,
      including while streaming. (Playwright)
- [x] `useActiveTasks.ts` is unmodified.

## References

- Idea `01M09SKVNJGJNJY2WGCZ6D89XZ`
- `.claude/rules/60-request-io-and-bundle-budgets.md` (Polling Hygiene)
- `.claude/rules/48-stale-while-revalidate-ui.md`
- `.claude/rules/06-technical-patterns.md` (React Interaction-Effect Analysis)
- `.claude/rules/17-ui-visual-testing.md`, `.claude/rules/56-clipped-overflow-is-invisible-to-document-checks.md`

## Post-mortem / process note

Not a bug fix — this is a performance program slice, so no incident post-mortem applies.
The class of waste being removed (a poll that duplicates an already-live push channel, and a
memo defeated by one unstable prop) is now covered by rule 60's Polling Hygiene clause; the
shared `useVisibilityAwarePoll` hook exists so future poll sites cannot reintroduce the
hidden-tab variant by hand.
