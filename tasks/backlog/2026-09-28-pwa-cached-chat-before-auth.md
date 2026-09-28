# Paint a cached chat before the session check resolves (installed PWA)

Planning task. No production code was written; this file is the design and implementation plan.
Decided by Raphaël on 2026-09-28: when he reopens a chat he has already viewed, show the cached
chat before the sign-in check finishes, so he is in the conversation as fast as possible, in the
installed PWA only. SAM task `01M3KE761KV3V3HKWW1HS5SVHQ`; idea `01M0CSA14BAQH5ATEX04N8C4MA`
("remaining work is the cold PWA reopen"). Baseline read at `main` = `4d929c465`.

## Conclusion

- **Feasible: yes.** The app already detects the installed PWA (`hooks/useIsStandalone.ts`), the
  transcript is already on disk (`sessions/messages` in IndexedDB, PR #2165), and TanStack's
  persist core exposes restore and subscribe as separate steps, which is what a "read the cache
  first, write only after sign-in" design needs.
- **Safe: yes, with five controls** (§Q2). The one thing sign-in tells the client today that it
  cannot know beforehand is _which user's record to open_. A last-identity hint solves that. The
  residual risk is a cached chat visible for about one network round trip on an unlocked personal
  device whose session was revoked in the meantime. That data is already on that device's disk
  today; the change is that it is painted for a moment before the redirect. Nothing is written to
  disk, nothing is sent, and no socket opens until the server confirms the identity.
- **PWA-only: recommended as the default policy, not as the safety mechanism.** Display-mode
  detection is a good "personal device" heuristic and trivially spoofable, so the design must be
  safe in a browser tab too. Ship the mechanism behind `VITE_CHAT_PAINT_BEFORE_AUTH`
  (`standalone` default, `always`, `never`) so widening it later is a config flip.
- **The paint alone is not enough.** The cold-reopen waterfall has three spinners in front of the
  cached transcript, and sign-in is only the first (§Q4). The Project shell and the ProjectChat page
  must also stop gating on unpersisted data, or the change buys nothing.

## Why PR #2165 kept "auth resolves first"

Three reasons, in the record:

1. It was a scope constraint of that task: "Do NOT show a cached copy before the auth check
   finishes. Keep today's gating." (`tasks/archive/2026-09-27-project-chat-instant-switching.md:42`).
2. Mechanically it could not have done otherwise: the persisted record is keyed by the user id that
   the session response returns, so "the restore only starts after the session check because the
   record is keyed by user id" (same file, `:61-66`; `AuthProvider.tsx:111-126`).
3. The audit that preceded it filed "render the last identity's cached content while `get-session`
   revalidates" as "a security trade-off needing a decision" and #2165 recorded that "question (a)
   remains open" (idea `01M0CSA14BAQH5ATEX04N8C4MA`, sections dated 2026-09-27). That decision is
   this task.

The PR discussion itself (`gh pr view 2165 --comments`) contains only bot comments; the reasoning
lives in the task file and the idea.

## Q1. Is PWA-only feasible, and how do we detect the installed PWA?

**Yes.** Detection already exists and is used by three surfaces:

- `apps/web/src/hooks/useIsStandalone.ts:3,10-32`: `matchMedia('(display-mode: standalone)')`
  plus the legacy iOS `navigator.standalone === true`, with a `change` listener.
- Used by `components/WorkspaceCard.tsx:66-71`, `components/node/NodeWorkspaceMiniCard.tsx:14-20`,
  `pages/SettingsNotifications.tsx:65,279`.
- The manifest asks for `"display": "standalone"` (`apps/web/public/manifest.webmanifest:7`), so
  an installed SAM matches that query on Chrome, Edge and Samsung Internet (Android and desktop),
  Safari home-screen apps on iOS and iPadOS, and Safari "Add to Dock" web apps on macOS.
- Tests: `apps/web/tests/unit/hooks/useIsStandalone.test.ts` (false, standalone, iOS,
  change event, cleanup).

Extract the predicate into `lib/display-mode.ts` (`isInstalledDisplayMode()`), have the hook call
it, and widen it for the edge cases below. Keep one predicate; the policy module and the hook must
not each grow their own.

Edge cases the predicate must handle:

| Case                                                    | Today                                                                      | Change                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chrome desktop with Window Controls Overlay enabled     | `display-mode` reports `window-controls-overlay`, so the hook says `false` | Also match `fullscreen`, `minimal-ui`, `window-controls-overlay` (an installed app can report any of the four)                                                                                                                                                                                                                                               |
| Android Trusted Web Activity                            | not detected                                                               | `document.referrer.startsWith('android-app://')`                                                                                                                                                                                                                                                                                                             |
| "Open in browser" from an installed app                 | `false`                                                                    | correct, stays `false`                                                                                                                                                                                                                                                                                                                                       |
| DevTools emulation, or a script overriding `matchMedia` | `true`                                                                     | correct for testing; this is why detection is not a security boundary                                                                                                                                                                                                                                                                                        |
| jsdom (unit tests)                                      | no `matchMedia`; the existing test stubs it                                | keep the stub pattern; the predicate must not throw when `matchMedia` is missing                                                                                                                                                                                                                                                                             |
| Playwright                                              | no first-class emulation                                                   | Chromium: `context.newCDPSession(page)` then `Emulation.setEmulatedMedia({ features: [{ name: 'display-mode', value: 'standalone' }] })`; WebKit: `addInitScript` setting `navigator.standalone`. Both Playwright projects in `apps/web/playwright.config.ts` (375×667 at `:30-33`, 1280×800 at `:53-56`) are Chromium, so CDP covers the required viewports |
| iOS storage partition                                   | n/a                                                                        | A home-screen app on iOS has its own cookie jar and IndexedDB, separate from Safari. Chrome (Android and desktop) shares the profile's cookies and storage with the installed app. In both cases the identity hint and the session cookie live in the **same** partition, which is what §Q2 relies on                                                        |

Detection changes at runtime only when the media query flips (rare); the hook already subscribes.
The policy decision is read once per page load in `AuthProvider`, which is the correct granularity:
a provisional paint is a page-load event.

## Q2. Is it safe?

### What exists today (verified)

- **Storage key** is namespaced per user: `sam-query-cache:v1:user:<encoded user id>`
  (`lib/query-persist-config.ts:98,110,191-194`; namespace from
  `lib/library-cache.ts:49-51`).
- **Write allowlist** re-checks the active scope on every write:
  `shouldDehydratePersistedQuery` requires `key[1] === scope` and `scope !== ''`
  (`query-persist-config.ts:210-224`), and only `library/index`, `projects/list`,
  `sessions/messages` are written (`:88-92`).
- **Restore is gated on the resolved identity**: `AuthProvider.tsx:111-126` derives the namespace
  from `enrichedUser.id`, and `:208-225` renders nothing while the namespace transitions, then a
  spinner while the restore runs. `ProtectedRoute.tsx:20-30` spins while `isLoading`, redirects to
  `/` at `:32-34`.
- **Account switch and sign-out**: the transition layout effect (`AuthProvider.tsx:128-151`) runs
  `cleanupTerminalSecrets`, `broadcastAuthRevocation`, `clearLibraryCache(previous)`,
  `discardPersistedQueryCache(previous)`, then `queryClient.clear()`. `signOut()` sweeps every
  record of every schema version, bounded by a timeout (`lib/auth.ts:59-92`,
  `lib/query-persistence.ts:191-209`). Cross-tab revocation goes over a `BroadcastChannel`
  (`lib/terminal-cleanup.ts:45-85`).
- **Server-side revocation and suspension** are enforced on every API call: the API reads the
  session with `disableCookieCache: true` and runs `assertUserNotSuspended`
  (`apps/api/src/middleware/auth.ts:128,136`; rationale at `apps/api/src/auth.ts:348-366`). The
  client learns about it when `get-session` returns `null`, which `AuthProvider.tsx:82-86` treats
  as a clean sign-out (only a network _error_ keeps the last good session).
- **Persisting chat content** was approved by Raphaël on 2026-08-19 (idea
  `01M0CSA14BAQH5ATEX04N8C4MA`), with "clear on logout and expired token is mandatory". Policy
  `eac31fbb` ("Prefer responsive cached frontend data flows") accepts more browser storage for
  responsiveness provided caches "respect security, user/project isolation, invalidation, and
  logout cleanup". Policy `91fe011f` requires failing closed over insecure fallbacks.
- **Gap already present today**: on a cold start whose first session resolution is `null`
  (expired while the app was closed), the previous user's record is _not_ discarded, because
  `isInitialNamespaceResolution` skips the cleanup branch (`AuthProvider.tsx:132-143`). Only the
  next explicit sign-out sweeps it. The identity hint below closes this gap as a side effect.

### The five controls

1. **Identity hint, not identity trust.** A small localStorage record
   `sam-identity-hint:v1 = { id, name, image, resolvedAt }` (no email, no role, no status) is
   written on **every** resolved sign-in and cleared on every clean `null`, on `signOut()`, and on
   the `auth-revoked` broadcast. It selects _which_ IndexedDB record to open before `get-session`
   answers. It never authorises anything: it is a pointer into a store that any same-origin script
   could already read. It is only honoured if `Date.now() - resolvedAt <= IDENTITY_HINT_MAX_AGE_MS`
   (default: the 24 h record max age; there is no point trusting a hint older than the cache it
   unlocks) and if the policy allows a provisional paint.
2. **Restore-only before confirmation; subscribe only after.** The provisional phase calls
   `persistQueryClientRestore` alone. The write subscription (`persistQueryClientSubscribe`) is
   attached only once the server confirms the same user id. This matters mechanically: the persister
   writes the _whole_ dehydrated snapshot on every cache event (`lib/query-persistence.ts:68-108`),
   so a subscription attached under an unconfirmed scope would write an **empty** snapshot over the
   real record (`shouldDehydratePersistedQuery` filters everything when the scope does not match).
   Both functions are separate exports of `@tanstack/query-persist-client-core@5.101.2`
   (verified from the published `build/modern/persist.d.ts`; today the hook uses the combined
   `persistQueryClient`, `hooks/useQueryCachePersistence.ts:111-128`).
3. **No network as an unconfirmed identity.** A single transport gate, `lib/auth-barrier.ts`,
   is held while the identity is provisional and released (same user) or rejected (different user,
   `null`) at resolution. `lib/api/client.ts:request()` (`:35-42`) awaits it before `fetch`; the
   WebSocket hooks await it before `new WebSocket` (`hooks/useChatWebSocket.ts:155`,
   `hooks/useProjectWebSocket.ts:124`, `hooks/useNotifications.ts:178`). Queued reads resume
   unchanged after confirmation, which is exactly today's "auth first, then fetch" order; the only
   thing that moves earlier is the paint. The better-auth client uses its own fetch
   (`lib/auth.ts:17-20`), so `get-session` is never gated.
   _Why a gate and not per-hook `enabled` flags_: the chat subtree issues requests from at least
   nine places on mount (`useSessionTranscript.ts:67-73` with `refetchOnMount: 'always'`,
   `useSessionLifecycle.ts:64,134-146,304-307,316-328`, `useProjectChatState.ts:137-190,370-435`,
   `Project.tsx:25-32`, `useMessageComments`, `useSessionTools`), and rule 61 says a guard must
   cover every runtime. One predicate, one place.
   _Enumeration required (rule 44)_: `grep -rn 'fetch(' apps/web/src` shows raw `fetch` calls
   outside the client in `lib/api/files.ts` (9), `lib/api/nodes.ts:92`, `lib/api/admin.ts:237`,
   `hooks/useFileTextContent.ts:35`, `components/project-message-view/tool-cards/DocumentCard.tsx:79`,
   `contexts/GlobalAudioContext.tsx:260,292`, `lib/ui-governance.ts:12`, `lib/trial-api.ts:74,142`,
   and telemetry (`lib/analytics.ts:272`, `lib/error-reporter.ts:66`, must stay ungated). The ones
   reachable from the chat subtree or the AppShell (`files.ts`, `useFileTextContent`,
   `DocumentCard`, `GlobalAudioContext`) go through a shared `authenticatedFetch()` that awaits the
   barrier; this also removes nine copies of `fetch(url, { credentials: 'include' })`. Admin, node
   log, boot log, trial and governance calls are outside any route that renders provisionally
   (§Q4, ProtectedRoute opt-in); list them in the PR as "unreachable while provisional". Add an
   `eslint-plugin-sam` rule banning raw `fetch(`/`new WebSocket(` in `apps/web/src` outside the two
   helpers and the telemetry modules, so the guard cannot be bypassed by the next feature.
4. **User-initiated writes are blocked in the UI, not just queued.** While provisional, the
   composer stays mounted (rule 48: never unmount visible content) but disabled with the
   placeholder "Verifying your session…" (`SessionFooter.tsx:120-150`), `handleSendFollowUp` and
   `handleUploadFiles` return early (`useSessionLifecycle.ts:331-380`), the comment composer, the
   header lifecycle actions (interrupt, sleep, archive) and the tool rail are disabled. A queued
   message would otherwise be sent under whichever identity the cookie turns out to be, and the UI
   must never promise delivery it cannot attribute. Reading and scrolling loaded rows work; paging
   older history and jumps wait on the barrier and show their normal loading state.
5. **Resolution outcomes, all of which already exist as transitions:**
   - _Same user_: confirmed; attach the write subscription; release the barrier; refresh the hint.
     No `queryClient.clear()` (the transition effect's early return at `AuthProvider.tsx:129`
     already skips equal namespaces).
   - _`null` (signed out, expired, revoked, suspended)_: existing transition (`:134-145`) runs with
     `previousNamespace` = the hinted namespace, so it now discards that record on a cold start
     too; clear the hint; reject the barrier; `ProtectedRoute` redirects to `/`. The transition
     renders `null` for the commit (`:210`), so no frame of the cached chat survives the
     resolution.
   - _Different user_: same transition path as an account switch: discard the hinted record,
     `queryClient.clear()`, write the new hint, restore and subscribe for the new namespace, release
     a new barrier generation. Existing test "never renders the previous user query cache during a
     direct account switch" (`tests/unit/components/auth-provider.test.tsx:475`) already pins the
     no-frame property for this path; a provisional variant is added (§Q5).
   - _Network error before any confirmation_ (cold start offline or flaky): today this redirects to
     the login page because there is no last good session (`AuthProvider.tsx:89-93`,
     `ProtectedRoute.tsx:32`). Recommended: stay provisional and read-only with a banner
     ("Can't verify your session — retrying"), keep the barrier held, and retry `get-session`
     with backoff; better-auth already refetches on visibility change
     (`tasks/archive/2026-03-24-pwa-auth-race-condition.md`). This is the PWA's offline-read
     mode and a product decision (Decision 3 below).

### Scenario table

| Scenario                                                                                                                | What the person sees                                                                  | Exposure vs today                                                    |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Same user, valid cookie (the normal case)                                                                               | Cached chat at once; composer disabled for ~1 RTT; then live                          | none                                                                 |
| Session expired or revoked server-side, device still unlocked                                                           | Cached chat for ~1 RTT, then login page; record deleted                               | at-a-glance only; the record was readable on disk anyway             |
| Different account signs in on this device (browser tab or PWA)                                                          | Hint rewritten at that sign-in; the PWA opens as the new user                         | none; the transition already handles a switch                        |
| Shared device, prior user's session expired, new person has no account                                                  | Cached chat for ~1 RTT, then login                                                    | same as "expired"; the reason for PWA-only scope                     |
| Provisional user taps send / upload / comment / archive                                                                 | Control disabled with "Verifying your session…"                                       | none (blocked)                                                       |
| Hint present, record missing or evicted                                                                                 | Chat spinner until sign-in, as today                                                  | none                                                                 |
| Hint tampered by same-origin script                                                                                     | Restores a record that script could read directly                                     | none                                                                 |
| Cookie is for B, hint says A (requires the cookie to change without the app resolving it in the same storage partition) | One commit of `null`, then B's view; A's record deleted; nothing written or sent as A | bounded to the paint; §Q2 control 3 keeps requests from running as A |

### Conflict with the local-encryption idea

Idea `01M0CVZ13RBY20J58CXZ8S13ES` ("Encrypt locally cached chat messages with auth-gated key")
proposes a key fetched alongside the auth token. A key that arrives with sign-in **cannot** decrypt
a cache that must paint before sign-in. The two are mutually exclusive unless the key is
device-bound (for example unwrapped by a WebAuthn PRF or platform authenticator, which would also
give a real answer to the shared-device case). Decision 4 below.

### If PWA-only is judged not worth it

The mechanism is the same in a tab. The only argument for the tab is consistency; the argument
against is that browser tabs on shared or borrowed computers are the common shared-device case,
while an installed app on a phone is the personal-device case. Keep `standalone` as the default;
`always` is one env var away and rule 70 applies when flipping it.

## Q3. Where is the chat cache today, and how is it keyed?

| Layer        | Where                                                                                                                                                    | Keyed by                                                                                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| In-memory    | TanStack Query `queryClient` (`lib/query-client.ts:25-33`; `staleTime` 15 s)                                                                             | `['auth', <user id>, 'sessions', 'messages', projectId, sessionId]` (`lib/query-options/chats.ts:43-45`); `gcTime` = `CHAT_TRANSCRIPT_CACHE_TTL_MS` 24 h (`:121`)                          |
| On disk      | IndexedDB via `idb-keyval`, one record per user (`lib/query-persistence.ts:55-157`)                                                                      | `sam-query-cache:v1:user:<id>` (`query-persist-config.ts:191-194`); `maxAge` 24 h, buster `v1`; per-transcript disk cap 500 rows (`:234-249`); at most 20 transcripts (`chats.ts:152-173`) |
| Allowlist    | `PERSISTED_QUERY_OPERATIONS` (`query-persist-config.ts:88-92`)                                                                                           | `library/index`, `projects/list`, `sessions/messages`                                                                                                                                      |
| Restore      | `hooks/useQueryCachePersistence.ts:96-153`, called from `AuthProvider.tsx:123-126` with the resolved namespace                                           | starts only after `get-session`; 250 ms budget (`DEFAULT_QUERY_PERSIST_RESTORE_TIMEOUT_MS`, `packages/shared/src/constants/defaults.ts:334`) then fails open                               |
| Scope source | `hooks/useQueryScope.ts:15-18` returns `user?.id ?? ''`; every query pairs it with `enabled: Boolean(queryScope)`                                        | identity from `useAuth()`                                                                                                                                                                  |
| Not cached   | per-project session list (hand-rolled `loadSessions`, `useProjectChatState.ts:370-435`); `projects/detail` (excluded at `query-persist-config.ts:73-75`) | —                                                                                                                                                                                          |

What has to change:

1. **A synchronous identity source before the session answers**: the hint (§Q2 control 1), read at
   first render by `AuthProvider`. `useQueryScope` keeps returning `user?.id`, and the provisional
   `user` carries the hinted id, so every existing key factory and `enabled` flag works unchanged.
2. **Split restore from subscribe** in `useQueryCachePersistence` (§Q2 control 2). Keep the pure
   policy in `query-persist-config.ts` and the IndexedDB code behind the dynamic import (the bundle
   reason at `useQueryCachePersistence.ts:22-36` still holds; the hint module must be pure and tiny).
3. **Persist `projects/detail`, stripped on disk.** The Project shell gates the whole chat route on
   it (`pages/Project.tsx:39,90-101`). The exclusion (`query-persist-config.ts:48-64,73-75`) was
   about `recentSessions[].topic` and `recentActivity[].payload.message`, chat-derived text; that
   content class was approved on 2026-08-19 and is already on disk as transcripts. Persist the
   operation and drop those two arrays in `persistedQueryForDisk` (extend the existing per-operation
   disk transform at `:234-249`); the web already types them optional
   (`hooks/useProjectData.ts:49`), and `Project.tsx` only needs `name`/`repository`. Bump
   `QUERY_PERSIST_SCHEMA_VERSION` to `v2` (`:100-110` says to, and the key embeds it, so `v1`
   records are simply never read and are swept at the next sign-out). Decision 2.
4. **Optionally persist the per-project session list** (`chats/project-sessions`, factory already
   exists at `chats.ts:91-101`, used only by IdeasPage). Not needed for the first paint on a phone:
   the mobile chat screen shows the message view and header, the list is in
   `MobileSessionDrawer`. Needed for the desktop sidebar to paint from cache. Its owner,
   `useProjectChatState.ts`, is 1073 lines, over the 800-line hard limit, so rule 18 makes a split
   mandatory before touching it. Recommended as a separate follow-up PR.

## Q4. Exact changes: auth gate, routing, chat page

Today's cold-reopen sequence (code-verified, also recorded in the idea):

1. `AuthProvider` renders children; `ProtectedRoute.tsx:20-30` shows "Verifying your session" until
   `get-session` returns.
2. `AuthProvider.tsx:128-151` resolves the namespace, `:123-126` restores IndexedDB (≤ 250 ms).
3. `pages/Project.tsx:93-97` shows "Loading project…" until `GET /api/projects/:id` returns
   (`projects/detail` is not persisted).
4. `pages/project-chat/index.tsx:188-194` shows a full spinner until the hand-rolled session list
   returns (`state.loading && state.sessions.length === 0`).
5. `ProjectMessageView` mounts (`index.tsx:532-540`, keyed per session at
   `components/project-message-view/index.tsx:24`); `SessionMessageView.tsx:333-341` renders at once
   because `session` is seeded from the cached transcript (`useSessionLifecycle.ts:46-52`).

Target sequence in the installed app: shell JS from the service worker's cache (`sw.ts:60-62`),
hint read, IndexedDB restore, chat painted read-only, all before any response; then `get-session`,
confirmation, subscription, queued reads flush, composer enabled.

### A. Auth gate (`components/AuthProvider.tsx`, `components/ProtectedRoute.tsx`)

- `AuthContextValue` gains `identity: 'none' | 'provisional' | 'confirmed'`. `isAuthenticated`
  stays "confirmed only" so `Landing.tsx:27-38` and `SuperadminRoute` (`App.tsx`) are unaffected.
  Provisional `user` is `{ id, name, image, email: '', role: 'user', status: 'active' }`: never
  trust a cached role or status (`isSuperadmin` false, `isApproved` true; the server enforces both,
  and admin routes never render provisionally, see B).
- At first render, if `useSession().isPending`, the hint is valid, and
  `resolvePaintBeforeAuthMode()` allows it, seed `activeCacheNamespace` from the hint, start the
  restore-only phase, hold the barrier, and keep the existing restore gate (`:210-222`) so the first
  paint has the cache. When `get-session` resolves, apply §Q2 control 5.
- Write the hint in the transition effect whenever `nextCacheNamespace` is non-null; clear it when
  null. Register `clearIdentityHint` with `registerTerminalCleanup` (`lib/terminal-cleanup.ts:8`) so
  the cross-tab `auth-revoked` broadcast clears it too. Call it from `signOut()` beside the
  IndexedDB sweep (`lib/auth.ts:77-79`).
- `lastGoodSessionRef` (`:73,79-86`) must only ever hold server-confirmed sessions; the provisional
  card is never written to it.
- `ProtectedRoute`: render children when `identity === 'confirmed'` (as today) **or** when
  `identity === 'provisional'` and `routeAllowsProvisional(location)`; otherwise the spinner. Only
  `/projects/:id/chat/:sessionId` opts in (a cached transcript can exist only for a chat with a
  session id in the URL). Every other route, including admin routes, keeps today's behaviour, which
  is what keeps `SuperadminRoute` from redirecting an admin during the provisional window.
- Keep `AuthProvider.tsx` under 500 lines (264 today): put the identity-phase derivation in
  `components/auth/identity-phase.ts` and the hint in `lib/identity-hint.ts`.

### B. Routing (`App.tsx`)

- No route changes. `ProtectedLayout` (`App.tsx:210-218`) already wraps every protected route in one
  `ProtectedRoute`; the opt-in is by location match inside it. The per-route `Suspense`
  (`:206-208`) means the `ProjectChat` chunk (`:86`) loads without unmounting the shell; in the
  installed app the chunk comes from the service worker's runtime cache (`sw.ts:60-62`,
  `staleWhileRevalidate`) unless a deploy changed hashes.
- Out of scope but noted from the idea: `networkFirstNavigation` (`sw.ts:203-231`) has no timeout, so
  a cold launch on a weak connection waits on the HTML fetch before using the cached shell. Separate
  follow-up; it gates everything above and is independent of auth.

### C. Project shell (`pages/Project.tsx`)

- `projectLoading` (`:39`) is already "pending and no data", so once `projects/detail` is restored
  from disk the shell renders `<Outlet />` (`:109-111`) immediately and refetches in the background
  (the refetch is queued at the barrier; `BackgroundFetchIndicator` shows the bar). No render change
  needed beyond the persistence change in §Q3 item 3.
- `installationsQuery` (`:29-32`) stays unpersisted; `installations` defaults to `[]` and nothing on
  the chat route gates on it.

### D. Chat page (`pages/project-chat/index.tsx`, `useProjectChatState.ts`)

- Remove the page-level gate at `index.tsx:188-194` for the routed session: when
  `state.sessionId` is set, render the layout with `ProjectMessageView` for `activeSessionId`
  (`:142,532-540`) regardless of `state.loading`; the sidebar and drawer show their own loading
  state while the list is in flight. `index.tsx` is 606 lines, over the 500 soft limit, so split it
  first in its own no-behaviour-change commit (rule 18), for example the sidebar/drawer content into
  `ProjectChatSidebar.tsx`.
- `useProjectChatState.ts` is not modified in the minimal path (its `loadSessions` is queued at the
  barrier and runs after confirmation exactly as today). `selectedSourceContext` (`index.tsx`
  after the split) and header lineage are cosmetic and fill in when the list arrives.
- `SessionMessageView.tsx:333-341` keeps its "no session yet" spinner: a cached chat has
  `lc.session` on the first render; an uncached chat shows the spinner until the queued fetch runs
  after confirmation, which is today's behaviour.

### E. Session lifecycle and composer (read-only while provisional)

- `useSessionLifecycle.ts`: `handleSendFollowUp` (`:331`) and the upload path
  (`useSessionFileUpload`, wired at `:58`) return early unless `identity === 'confirmed'`.
  `useChatWebSocket` (`:134-146`) and `useProjectWebSocket`
  await the barrier inside their connect functions (§Q2 control 3), so `enabled` semantics are
  unchanged and a socket cannot open provisionally through any path.
- `SessionFooter.tsx:120-150`: keep `FollowUpInput` mounted, `disabled` while provisional, with the
  placeholder "Verifying your session…" ahead of the existing wake/idle placeholders; disable
  `ReadOnlyFollowUp`'s "new chat" and the header's interrupt/sleep/archive controls
  (`SessionMessageView.tsx:405-418` and `SessionHeader`). Add one `role="status"` text
  "Verifying your session" in the chat header region so the screen-reader sequence stays continuous
  (the reason given at `AuthProvider.tsx:211-215`).
- Comments (`useMessageComments`) and the tool rail (`useSessionTools`) issue requests through
  `request()` and are queued; disable their write controls with the same flag.

### F. Configuration (Principle XI)

| Constant (`packages/shared/src/constants/defaults.ts`)    | Default                                   | Override                                                                 |
| --------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| `DEFAULT_CHAT_PAINT_BEFORE_AUTH_MODE`                     | `'standalone'`                            | `VITE_CHAT_PAINT_BEFORE_AUTH_MODE` = `standalone` \| `always` \| `never` |
| `DEFAULT_IDENTITY_HINT_MAX_AGE_MS`                        | `DEFAULT_QUERY_PERSIST_MAX_AGE_MS` (24 h) | `VITE_IDENTITY_HINT_MAX_AGE_MS`                                          |
| `DEFAULT_SESSION_CONFIRM_RETRY_MS` (only with Decision 3) | `5_000`                                   | `VITE_SESSION_CONFIRM_RETRY_MS`                                          |

Document in `apps/web/.env.example` (beside `:80-94`),
`apps/www/src/content/docs/docs/reference/configuration.md` (table at `:1503-1508`, paragraph at
`:1529-1530`), the `env-reference` skill, and `apps/www/src/content/docs/docs/guides/chat-features.md:289-295`,
whose sentence "is only read after the sign-in check completes" becomes false in the installed app.

### G. Measurement (rule 39)

- Before implementing, record a baseline on staging with the frame-sampling approach from #2165:
  cold reload of a cached chat in standalone emulation, `get-session` held back 2.5 s, time to first
  transcript row. After implementing, the same script must show rows before the `get-session`
  response.
- Add one bounded analytics event via `lib/analytics.ts:350 track()`:
  `chat_cold_open { standalone, provisional, msToFirstRows, msToConfirmed }` so production numbers
  confirm the win on Raphaël's phone.

## Q5. Test plan

Rules that apply: 62 (enter through the real trigger, prove every guard discriminating), 48
(spinners only when there is no data), 28/11 (identity at boundaries), 17 (Playwright at 375×667
and 1280×800).

### Behavioural unit tests (vitest, jsdom, `fake-indexeddb`)

Reuse the harness in `apps/web/tests/unit/components/auth-provider.test.tsx` (`mockUseSession`,
`idbSet`, `TranscriptCacheConsumer`, `transcriptRenderLog`, `:583-742`) and the page harness in
`apps/web/tests/unit/pages/project-chat-switching.test.tsx` (`renderChat`, `productionLikeClient`,
`:203-228`). New file `tests/unit/pages/project-chat-cold-reopen.test.tsx` drives the real
`AuthProvider` → `ProtectedRoute` → router → `Project` shell → `ProjectChat` page with only `lib/api`
and `lib/auth` mocked (vertical slice, rule 35).

1. **Cached-first paint (standalone).** Hint for `u1`, persisted transcript and stripped project
   detail under `user:u1`, `matchMedia` stub reporting standalone, `get-session` deferred. Assert:
   the transcript row is the consumer's first frame (`transcriptRenderLog[0]`), the project shell
   is not spinning, the composer is present and disabled with "Verifying your session…", the
   "Verifying your session" status text is present, and `fetch` has not been called (barrier).
   Resolve the same user: composer enabled, the queued transcript refresh runs once, the write
   subscription writes the record under the same key. Liveness: assert a supplied field rendered.
2. **Not standalone is unchanged.** The existing test "shows a persisted chat transcript only once
   the session check has resolved" (`auth-provider.test.tsx:644`) stays as the control with the
   policy at `standalone` and `matchMedia` reporting a browser tab. Add a variant with the policy
   `always` that paints in a tab, and `never` that does not paint in standalone.
3. **Auth failure evicts.** As (1), then resolve `null`: no transcript row in any frame after the
   resolution index, `Navigate` to `/` rendered (liveness: the login page), the `user:u1` record
   deleted from IndexedDB, the hint cleared, the barrier rejected (queued `request()` promises
   reject with `ApiClientError` status 401) and no IndexedDB write happened during the provisional
   window (record byte-identical before and after).
4. **User switching.** Hint `u1`, records for `u1` and `u2`, resolve `u2`: exactly one `null`
   commit, zero `u1` frames after it, `u1` record deleted, `u2` record restored, hint now `u2`, a
   new barrier generation released. Pair with the owner-path control from (1).
5. **Stale hint.** `resolvedAt` older than `IDENTITY_HINT_MAX_AGE_MS`: spinner as today, no
   restore attempted (spy on the persister).
6. **Hint lifecycle.** Written on initial and subsequent resolutions; cleared on clean `null`,
   on `signOut()` (with the mocked `authClient.signOut` failing, per the sweep's contract at
   `lib/auth.ts:69-79`), and on the `auth-revoked` broadcast (`runLocalCleanup`).
7. **Transport gate.** While held: `request()` does not call `fetch`; `useChatWebSocket` and
   `useProjectWebSocket` do not construct a `WebSocket` (spy) even with `enabled: true`;
   `authenticatedFetch` waits. On release: everything proceeds in order. On reject: rejects.
   Telemetry (`analytics`, `error-reporter`) is never gated.
8. **Writes blocked.** `handleSendFollowUp` and `handleUploadFiles` are no-ops while provisional
   (no optimistic row appended, `appendMessages` not called); the header actions are disabled.
9. **Non-chat route stays gated.** Provisional identity on `/admin/...` and `/dashboard` renders the
   spinner, never children (this is what protects `SuperadminRoute`).
10. **Network error while provisional** (only with Decision 3): stays provisional with the banner,
    no redirect, retries; a later success confirms; a later `null` evicts.
11. **Persistence unit tests.** `tests/unit/lib/query-persistence-allowlist.test.ts`: `projects/detail`
    is written with `recentSessions`/`recentActivity` removed and is restorable; `v1` records are not
    read after the buster bump. `tests/unit/lib/query-persistence.test.ts`: restore-only performs no
    write on cache events.
12. **Display-mode predicate.** Extend `tests/unit/hooks/useIsStandalone.test.ts` for
    `fullscreen`, `minimal-ui`, `window-controls-overlay`, the TWA referrer, and a missing
    `matchMedia`.
13. **Discrimination proof.** Revert each new guard once (hint max-age check, route opt-in,
    restore-only, barrier in `request()`, barrier in each socket hook, send guard, disabled
    composer) and record which named test went red in the PR, as #2165 did for its 28 guards.

### Playwright visual check (375×667 and 1280×800)

New `apps/web/tests/playwright/project-chat-cold-reopen-audit.spec.ts`, modelled on
`project-chat-switching-audit.spec.ts` (route mocks at `:192-215`, delay pattern at `:224`):

- Standalone via CDP `Emulation.setEmulatedMedia` (§Q1). Visit a chat once against the mocked API
  so the record is written, then `page.reload()` with `/api/auth/get-session` held back 3 s.
  Sample every animation frame: the first frame with a transcript row must precede the
  `get-session` response; the composer is disabled with the placeholder; the status text is
  present; after the response the composer enables and the background bar shows the refresh.
- Screenshots at both viewports for: provisional (stress fixtures from the switching audit: 200+
  character unicode title with `<script>` and entities, 1,200-row chat), confirmed, and the `null`
  outcome (login page, no transcript). `assertNoOverflow` on each. Open the images and confirm
  they differ between scenarios (rule 62 §6).
- Controls: the same reload without standalone emulation shows the spinner until the response;
  with the response `null` in standalone, no transcript pixel appears after redirect.
- Staging (final integration step, tasks/README rule 1): token-login with
  `SAM_PLAYWRIGHT_PRIMARY_USER` against `https://api.sammy.party/api/auth/token-login`, open a real
  chat on `app.sammy.party` to populate the record, reload in standalone emulation with
  `page.route` holding `get-session` 2.5 s, frame-sample as above. Also verify a real sign-out
  clears the hint and the record, and a reload afterwards shows the login page with no transcript.
  Nothing is created on staging, so no cleanup.

## Decisions for Raphaël

1. **Policy default.** `standalone` (recommended) vs `always`.
2. **Persist `projects/detail` stripped of `recentSessions`/`recentActivity`.** Needed for the
   Project shell to render from cache; the idea already flagged this as needing his OK.
3. **Offline while provisional.** Keep the cached read-only view with a banner and retry
   (recommended, it is the PWA offline-read mode) vs redirect to login as today.
4. **Local-encryption idea `01M0CVZ13RBY20J58CXZ8S13ES`.** Park it and record the conflict, or
   reshape it as a device-bound key. It cannot ship as written alongside this feature.
5. **Session list to TanStack + persistence** for the desktop sidebar: separate follow-up PR
   (recommended; requires splitting `useProjectChatState.ts` first) vs in scope.

## Implementation checklist

One PR in reviewable commits (a foundation commit is invisible in browser tabs; the chat-path commit
makes it visible), then a follow-up PR for the session list.

### Commit 0: splits and baseline (no behaviour change)

- [ ] Split `pages/project-chat/index.tsx` (606 lines) per rule 18.
- [ ] Extract `isInstalledDisplayMode()` into `lib/display-mode.ts`; `useIsStandalone` calls it.
- [ ] Record the staging baseline (§Q4 G).

### Commit 1: foundation

- [ ] `lib/identity-hint.ts` (pure; read/write/clear; max age; versioned key).
- [ ] `lib/paint-before-auth-policy.ts` (`resolvePaintBeforeAuthMode()`, env parsing).
- [ ] `lib/auth-barrier.ts` (hold/release/reject with generations; `whenConfirmed()`).
- [ ] `request()` awaits the barrier; `authenticatedFetch()` replaces the raw `fetch` calls
      reachable from the chat subtree and AppShell; socket hooks await before `new WebSocket`.
- [ ] `eslint-plugin-sam` rule: no raw `fetch(`/`new WebSocket(` in `apps/web/src` outside the
      helpers and telemetry.
- [ ] `useQueryCachePersistence`: restore-only phase, subscribe-after-confirm phase; provisional
      never subscribes; teardown still cancels pending writes.
- [ ] `AuthProvider`: identity phases, hint seeding, hint maintenance, cleanup registration,
      `lastGoodSessionRef` stays confirmed-only.
- [ ] `ProtectedRoute`: provisional opt-in by route match.
- [ ] `signOut()` clears the hint.
- [ ] Constants, env docs, `env-reference` skill.
- [ ] Tests 2, 5, 6, 7, 9, 12, 13 (partial).

### Commit 2: chat path

- [ ] Persist `projects/detail` stripped on disk; bump `QUERY_PERSIST_SCHEMA_VERSION` to `v2`.
- [ ] Remove the page-level session-list gate for a routed session.
- [ ] Read-only provisional UI: composer, uploads, comments, header actions, status text.
- [ ] Send/upload guards in `useSessionLifecycle`.
- [ ] `chat_cold_open` analytics event.
- [ ] Docs: `chat-features.md` "Switching Between Chats" gains a "Reopening the installed app"
      paragraph; `configuration.md`; changelog skill.
- [ ] Tests 1, 3, 4, 8, 10, 11, 13 (complete); Playwright audit with screenshots in the PR.
- [ ] Specialist reviews: security-auditor (security-sensitive-change), ui-ux-specialist,
      test-engineer, performance-reviewer (bundle: the hint and policy modules are eager, keep them
      tiny; idb-keyval stays behind the dynamic import), architecture-reviewer, constitution-validator,
      doc-sync-validator, env-validator, task-completion-validator.
- [ ] Staging integration verification (§Q5) before merge; production deploy monitored after.

### Follow-up PR

- [ ] Split `useProjectChatState.ts` (1073 lines), move the session list to
      `projectChatSessionsQueryOptions`, persist `chats/project-sessions`, sidebar paints from cache.
- [ ] `sw.ts` navigation timeout with fallback to the cached shell (idea, item 3).

## Acceptance criteria

- [ ] In standalone display mode, reopening a chat viewed within 24 h paints its cached rows before
      `GET /api/auth/get-session` responds (Playwright frame sampling, local and staging, both
      viewports).
- [ ] While provisional: no request other than `get-session` and telemetry leaves the app, no
      WebSocket opens, no IndexedDB write happens, and every write control is disabled with the
      "Verifying your session…" text.
- [ ] `get-session` `null` removes the cached content in the same commit, deletes the hinted record
      and the hint, and lands on the login page; no transcript frame after the resolution.
- [ ] A different confirmed user never sees a frame of the previous user's cache; the previous
      record is deleted; the hint is the new user.
- [ ] Sign-out and the cross-tab revocation broadcast clear the hint; a reload afterwards shows the
      login page with no transcript.
- [ ] In a browser tab with the default policy, behaviour is byte-for-byte today's (existing tests
      at `auth-provider.test.tsx:589-742` still pass unchanged).
- [ ] Every new guard was reverted once and its named test went red; the table is in the PR.
- [ ] Every new window, limit and mode is a `DEFAULT_*` with a `VITE_*` override and is documented.

## References

- `apps/web/src/components/AuthProvider.tsx`, `components/ProtectedRoute.tsx`,
  `hooks/useQueryCachePersistence.ts`, `lib/query-persist-config.ts`, `lib/query-persistence.ts`,
  `lib/auth.ts`, `lib/terminal-cleanup.ts`, `hooks/useQueryScope.ts`, `hooks/useIsStandalone.ts`,
  `lib/pwa.ts`, `src/sw.ts`, `public/manifest.webmanifest`, `App.tsx`, `pages/Project.tsx`,
  `pages/project-chat/index.tsx`, `pages/project-chat/useProjectChatState.ts`,
  `components/project-message-view/{index,SessionMessageView,SessionFooter,useSessionLifecycle,useSessionTranscript}.tsx|ts`,
  `hooks/useChatWebSocket.ts`, `hooks/useProjectWebSocket.ts`, `lib/api/client.ts`
- `apps/api/src/auth.ts:348-366`, `apps/api/src/middleware/auth.ts:105-160`
- `packages/shared/src/constants/defaults.ts:314-352`
- `tasks/archive/2026-09-27-project-chat-instant-switching.md`,
  `tasks/archive/2026-03-24-pwa-auth-race-condition.md`,
  `tasks/archive/2026-08-05-namespace-library-cache-by-user.md`,
  `tasks/backlog/2026-08-07-expand-frontend-query-cache-and-persistence.md`,
  `tasks/backlog/2026-09-27-chat-switch-list-first-paint.md`
- Ideas `01M0CSA14BAQH5ATEX04N8C4MA`, `01M0CVZ13RBY20J58CXZ8S13ES`; policies `eac31fbb`, `91fe011f`
- Rules 18, 28, 35, 39, 44, 48, 61, 62, 70, 74; `apps/web/.claude/rules/17-ui-visual-testing.md`
