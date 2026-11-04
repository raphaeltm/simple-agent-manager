# Cold chat load: serial waterfall and moving loading indicators

Idea: 01M6M94PACKCMZPHHC2BHCW0FJ. Task: 01M6MDAM3258GXTRDM1TB6QQYZ.

## Problem

Cold-opening `/projects/:id/chat/:sessionId` shows 3–4 spinners in different places and
the transcript appears ~10 s (desktop) / ~13 s (mobile) after navigation on staging.

## Research findings (staging capture 2026-11-04, library /investigations/chat-cold-load/)

Desktop request timeline (ms from navigation): document+eager JS to ~2.5 s; auth
2559–3157; project shell chunk; project detail 3904–5427; session list 5637–6987;
selected transcript 7086–9841. Mobile: auth 3881–5955; project 6514–9956; list
10285–11486; transcript 11488–12949.

1. Startup/asset cost (~2.5–3.8 s before auth begins) and get-session latency are not
   part of the chat waterfall; out of scope.
2. Auth end → project request start costs 0.56–0.75 s because the project detail
   query only starts when the `Project` shell chunk has loaded (`pages/Project.tsx`).
3. `Project.tsx` does not mount the chat outlet until project detail returns; the chat
   page needs project fields (multiplayer scope, new-chat defaults in `useState`
   initialisers), so the gate stays, but nothing the transcript needs depends on it.
4. `project-chat/index.tsx` returns a full-page spinner while the session list loads,
   so `ProjectMessageView` (and its transcript query) mounts only after the list —
   although the URL already names the session.
5. Spinner geometry differs at every boundary: auth (viewport centre), RouteFallback
   (`py-16`, top), project (`flex-1` centre, md + label), list (centre),
   transcript (`p-8`, top). After the project loads, a nested route fallback shows
   for ~300 ms while `React.lazy` resolves the already-loaded chat chunk.
6. Transient "cloud account" onboarding question during cold load:
   `useSetupStatus.loading` turns false when ANY of its three reads lands
   (credentials ~1.5 s before GitHub installations), so `OnboardingProvider` decides
   setup is incomplete and opens the overlay, then closes it.
7. Server: `GET /api/projects/:id` already parallelises its D1 reads and only reads
   ProjectData with `include=recent`; no measured server enrichment cost justifies a
   server change or a bundled endpoint.
8. Warm (persisted) transcripts still wait for project detail (not persisted because
   it contains chat topics) — recorded as remaining opportunity in the idea.

## Implementation checklist

- [ ] Start project detail, the initial session list and the URL-selected transcript
      when the project route mounts (alongside the chunk preloads in `App.tsx`)
- [ ] Initial session-list load consumes the prefetched list once (bounded reuse
      window, configurable), later loads go to the network as before
- [ ] Render the session view while the list loads when the URL names a session;
      sidebar shows a loading line instead of "No chats yet" while loading
- [ ] One centred loading pane for route fallback, project loading, list loading and
      transcript loading; project child routes use it without reveal delay
- [ ] `useSetupStatus.loading` stays true until all three reads settle
- [ ] Tests: prefetch helper (path parsing, scope isolation), chat renders transcript
      before list resolves (deferred), consume-once list handoff, setup-status
      partial-load, loading pane geometry
- [ ] Playwright visual audit (mobile/desktop) of loading states
- [ ] Staging before/after cold capture (timings + spinner positions)

## Acceptance criteria

- [ ] Selected transcript request starts at the same time as project detail on a cold
      deep link (no longer after the session list)
- [ ] Transcript visible earlier on staging cold load, mobile and desktop
- [ ] Spinner stays in one position within the app shell during cold chat load
- [ ] No transient onboarding question during cold load for a set-up user
- [ ] Query keys remain user-scoped; cached data freshness semantics unchanged
