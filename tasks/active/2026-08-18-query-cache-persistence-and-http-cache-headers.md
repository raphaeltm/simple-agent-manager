# Query Cache Persistence + HTTP Cache-Control Headers (UI Perf Workstream E)

Program: SAM UI Performance Plan (idea `01M09SKVNJGJNJY2WGCZ6D89XZ`), plan items **#3** and **#7**.
SAM task: `01M0B812TYM8FN3479HCDAZ6QD`.

Base branch: `sam/read-idea-01m09skvnjgjnjy2wgcz6d89xz-using-bmbgfz` (program integration branch), **not** `main`.

## Problem

**#3 — no query-cache persistence.** `apps/web/src/lib/query-client.ts:25-33` builds an in-memory-only
`QueryClient`. Every full page reload re-fetches the entire world: parse bundle → auth hop → refetch.
Nothing survives a reload or a browser restart.

**#7 — no HTTP caching on API GETs.** Every browser navigation re-fetches from origin even for data
that changes on deploy or once a month. The API sets `Cache-Control` in 22 places, but every one is
`no-store` / `no-cache` / `private` except four unauthenticated static resources
(`index.ts:655` JWKS, `index.ts:664` OIDC discovery, `binary-artifacts.ts:32`, `cli.ts`).

## Research findings

### Endpoint reality check — the brief's candidate list is mostly wrong

The dispatch brief said "verify in code first". Verified; most named paths do not exist:

| Brief said | Reality | Decision |
|---|---|---|
| `GET /api/ai/models` | Does not exist. Web UI uses `GET /api/model-catalog/:agentType` (`routes/model-catalog.ts:12`, session auth, **global** payload, KV-backed w/ 3600s TTL). `GET /ai/v1/models` also exists (`ai-proxy.ts:482`) but is agent-facing w/ callback-token auth. | Cache `/api/model-catalog/:agentType`. Skip `/ai/v1/models` (not a browser surface). |
| `GET /api/platform-config` | Does not exist. Real path is `GET /api/admin/platform-config` (`admin-platform-config.ts:18`) — **superadmin-only**. Public config lives at `/api/config/artifacts-enabled` (`index.ts:625`), `/api/config/vapid-public-key` (`index.ts:631`), `/api/config/login-providers` (`index.ts:639`). | Cache the three **public** `/api/config/*` endpoints. Skip the superadmin one (rare, and admin surfaces should read through). |
| `GET /api/projects/:id` | Exists (`projects/crud.ts:535`) but embeds `recentSessions` (5) + `recentActivity` (10) + live task/workspace counts from the ProjectData DO. **This is semi-real-time.** | **Excluded.** Caching it would show stale chat/activity. Documented as a deliberate exclusion. |
| `GET /api/projects/:id/settings` | **Does not exist at all.** Closest is `GET /api/projects/:id/runtime-config` (`crud.ts:603`), gated on the `secret:read` capability and containing **secrets metadata**. | **Excluded** — credential-adjacent. |
| `GET /api/projects/:id/profiles` | Real path `GET /api/projects/:projectId/agent-profiles` (`agent-profiles.ts:17`). D1-only. Payload is **user-specific**: `services/agent-profiles.ts:84-88` returns project profiles `OR` the *calling user's* global profiles. | Cache, `private` + `Vary: Cookie`. |
| `GET /api/projects/:id/skills` | Real path `GET /api/projects/:projectId/skills` (`skills.ts:16`). Same user-specific `or(project, user-global)` shape at `services/skills.ts:96-100`. | Cache, `private` + `Vary: Cookie`. |

### The cross-tenant hazard that shapes item #7

- `apps/api/src/index.ts:586-602` runs global CORS with **`credentials: true`**.
- `grep -rn "Vary" apps/api/src` → **zero hits**. The API has never emitted a `Vary` header.
- Therefore `Cache-Control: public` on any *authenticated* response is unsafe: a shared cache
  (Cloudflare edge, corporate proxy) could serve user A's `agent-profiles` to user B.
- Even `private` is not sufficient on its own: the browser HTTP cache is per *profile*, not per
  *login*. User A signs out, user B signs in in the same browser → B could be served A's cached
  entry for the same URL.

**Rules adopted:** authenticated GET ⇒ `private` **and** `Vary: Cookie` (session cookie differs per
user ⇒ different cache entry). `public` is permitted **only** on unauthenticated, globally identical
responses, matching the existing JWKS precedent at `index.ts:655`.

### Web-side facts that shape item #3

- `QueryClientProvider` is mounted at `App.tsx:233`, **outside** `AuthProvider` (`App.tsx:235`).
  AuthProvider reaches the client through the module singleton import, not context. So a root-level
  `PersistQueryClientProvider` cannot know the user identity — persistence must be driven from
  inside `AuthProvider`.
- `AuthProvider.tsx:113-131` already owns the identity-transition `useLayoutEffect`: it calls
  `cleanupTerminalSecrets()`, `broadcastAuthRevocation()`, `clearLibraryCache(previousNamespace)`,
  then **`queryClient.clear()` (:125)**, then `setActiveCacheNamespace(...)`. `AuthProvider.tsx:190`
  gates children on `isCacheNamespaceTransitioning`. **Extend this; do not build a parallel
  auth-transition listener** (rules 24 + 59).
- `buildLibraryCacheNamespace(userId)` (`lib/library-cache.ts:49`) → `user:<encodeURIComponent(id)>`
  is the established identity-namespace helper. Reuse it.
- Only **4 of 11** `useQuery` call sites are identity-scoped, all via `lib/query-options.ts:5-19`
  which prefixes `['auth', queryScope, …]` where `queryScope = user?.id ?? ''`. The other 7 are
  **not**: `['nodes','list']`, `['nodes','catalog']`, `['workspaces','list',…]`,
  `['admin-diagnosis', runId]`, `['notification-preferences']`.
- `tasks/backlog/2026-08-07-expand-frontend-query-cache-and-persistence.md` is the design spec for
  this item and carries a hard **"Never Persist Without Separate Security Review"** list: chat
  messages/agent output, credentials/tokens, admin errors/diagnoses/logs, **node/workspace runtime
  details**, file contents/signed URLs, mutation state.
  → The 7 unscoped keys map almost exactly onto that banned list. An allowlist keyed on
  `['auth', <current scope>, <allowed domain>]` therefore excludes all of them *structurally*.
- `tasks/archive/2026-08-05-namespace-library-cache-by-user.md` — the real cross-user browser-cache
  leak incident this must not repeat.
- jsdom has **no IndexedDB** and there is no polyfill installed; `apps/web/tests/setup.ts` mocks only
  `matchMedia` + `ResizeObserver`. IDB tests need `fake-indexeddb`.
- **No app version / build hash reaches the bundle.** `vite.config.ts` has no `define` block; CI
  (`deploy-reusable.yml:622-635`) injects no SHA. The codebase precedent for a cache generation
  marker is the hand-bumped `sam-shell-v3` in `src/sw.ts:8-9`.
- `persistQueryClient` (v5.101.2) returns `[unsubscribe, restorePromise]`; `persistQueryClientRestore`
  already discards persisted data that is expired (`maxAge`), busted (`buster`), or throws.
  `PersistQueryClientRootOptions` has **no** `throttleTime` in v5 — writes must be throttled by the
  persister itself.

### Decisions (documented per the "agents decide best-practice questions autonomously" policy)

1. **IndexedDB, not localStorage.** The brief prefers IDB for size, and `lib/library-cache.ts` already
   competes for the 5 MB localStorage budget hard enough to need LRU eviction
   (`library-cache.ts:findOldestLibraryKey`). Query cache goes in a separate IDB store so it cannot
   evict library index entries. Costs `idb-keyval` + `fake-indexeddb` (dev).
2. **Allowlist = `projects` domain only for v1.** `github.installations` is deliberately excluded as
   connection-configuration-adjacent, pending the separate security review the backlog task demands.
   Project list/detail is the highest-leverage read anyway (dashboard + sidebar + project page).
3. **Buster = hand-bumped `QUERY_PERSIST_SCHEMA_VERSION`**, following the `sw.ts` precedent, rather
   than inventing build-time SHA plumbing the deploy pipeline does not supply.
4. **`GET /api/projects/:id` excluded** from cache headers — it carries DO-sourced recent
   sessions/activity, which is the real-time data the brief says not to cache.

## Implementation checklist

### Item #3 — query cache persistence (apps/web)

- [x] Add deps: `@tanstack/query-persist-client-core@5.101.2` (exact match to `react-query@5.101.2`),
      `idb-keyval`, dev `fake-indexeddb`.
- [x] Shared defaults in `packages/shared/src/constants/defaults.ts`:
      `DEFAULT_QUERY_PERSIST_MAX_AGE_MS`, `DEFAULT_QUERY_PERSIST_THROTTLE_MS`,
      `DEFAULT_QUERY_PERSIST_RESTORE_TIMEOUT_MS`.
- [x] `apps/web/src/lib/query-persistence.ts`:
      - `buildQueryPersistStorageKey(namespace)` → per-identity IDB key.
      - `createIdbPersister(key)` implementing `Persister` with throttled writes and
        **fail-open** try/catch on every method (private mode / disabled IDB ⇒ cache miss, never throw).
      - `shouldDehydratePersistedQuery(query, scope)` — the allowlist. Requires
        `key[0] === 'auth' && key[1] === scope && ALLOWED_DOMAINS.has(key[2])` **and** a successful
        query state.
      - `QUERY_PERSIST_SCHEMA_VERSION` buster; `VITE_*` env overrides for all three timings.
- [x] `apps/web/src/hooks/useQueryCachePersistence.ts` — drives
      `persistQueryClient()` per active namespace; unsubscribes + removes the previous namespace's
      store on transition; bounded restore with timeout; returns `isRestoring`.
- [x] Wire into `AuthProvider` — extend the existing gate so children do not render until restore
      settles; must not regress the existing `queryClient.clear()` transition semantics.
- [x] Clear the persisted store on sign-out in `apps/web/src/lib/auth.ts` (alongside
      `clearLibraryCache()`), deterministically, before navigation.
- [x] Set `gcTime` on the persisted query options only (not globally — global `gcTime` would retain
      admin-diagnosis / node / workspace data in memory).
- [x] Document the new `VITE_*` vars in `apps/web/.env.example` + `vite-env.d.ts`.

### Item #7 — HTTP cache headers (apps/api)

- [x] Shared defaults: `DEFAULT_CACHE_TTL_*` / SWR constants in `packages/shared`.
- [x] `apps/api/src/lib/cache-headers.ts` — named policies + `applyCacheHeaders(c, policy)`.
      `private` policies always emit `Vary: Cookie`. `public` is structurally unavailable to
      authenticated policies.
- [x] Apply to: `/api/config/artifacts-enabled`, `/api/config/vapid-public-key`,
      `/api/config/login-providers` (public); `/api/model-catalog/:agentType` (private, global);
      `/api/projects/:projectId/agent-profiles`, `/api/projects/:projectId/skills` (private, per-user).
- [x] Env vars in `apps/api/src/env.ts` + `.env.example` + public config reference docs.

### Tests

- [x] Persist/restore across a simulated page load (fresh `QueryClient`, same store key).
- [x] Identity isolation: user A's store key ≠ user B's; restoring under B yields nothing.
- [x] Allowlist: `nodes`/`workspaces`/`admin-diagnosis`/`notification-preferences` and a
      foreign-scope `['auth','other-user','projects']` key are never dehydrated.
- [x] `maxAge` expiry and `buster` mismatch both evict.
- [x] IDB failure (throwing store) degrades to in-memory, app still renders.
- [x] AuthProvider account switch removes the previous namespace's persisted store and never renders
      A's data as B.
- [x] Sign-out removes the persisted store.
- [x] API: each targeted endpoint emits the expected `Cache-Control` (+ `Vary: Cookie` where private).
- [x] API: env override changes the emitted TTL.
- [x] **Discriminating guard**: real-time endpoints (chat messages, task status, session/workspace
      state) emit no `Cache-Control`, and **no authenticated endpoint emits `public`**.

## Acceptance criteria

- Persisted query keys are namespaced by authenticated user **and** schema version.
- Logout / expiry / account switch cannot render the previous user's data, including colliding
  project IDs.
- Only allowlisted queries are dehydrated; every entry on the "never persist" list is excluded.
- Persistence failure (private mode, quota, parse error) degrades silently to in-memory cache.
- Targeted API GETs carry conservative, env-configurable SWR cache headers.
- No authenticated response is ever marked `public`; every `private` response carries `Vary: Cookie`.
- Real-time endpoints are untouched.

## Program constraints

- PR base = the integration branch. **Do not merge** — the coordinator merges.
- **Staging intentionally skipped** by explicit instruction (project policy: "Skip staging when
  explicitly requested for /do work"). Verification consolidated at the primary integration PR.
- `performance-reviewer` + `cloudflare-specialist` local reviews required.

## References

- `.claude/rules/48-stale-while-revalidate-ui.md`, `.claude/rules/60-request-io-and-bundle-budgets.md`
- `.claude/rules/24-no-duplicate-ui-controls.md`, `.claude/rules/59-understand-before-adding.md`
- `.claude/rules/20-cross-origin-cors.md`, `.claude/rules/03-constitution.md` (Principle XI)
- TanStack persistence: https://tanstack.com/query/v5/docs/framework/react/plugins/persistQueryClient
