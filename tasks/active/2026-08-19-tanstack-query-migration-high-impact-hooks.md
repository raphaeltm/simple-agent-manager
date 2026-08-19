# Migrate High-Impact Data-Fetching Hooks to TanStack Query

UI Performance Program — Workstream F (item #4 of SAM idea `01M09SKVNJGJNJY2WGCZ6D89XZ`).

## Problem

`apps/web` has ~54 hand-rolled `useState` + `useCallback` + `useEffect` data-fetching
triplets. Each one re-implements loading/error/refresh state badly and gets none of
what the app's already-configured TanStack Query v5 client provides for free:

- **No request deduplication.** Four API functions are called from many independent
  component-local loaders, so N mounted consumers issue N identical requests:

  | API function | Distinct call sites | Where |
  |---|---|---|
  | `listCredentials` | 7 | `OnboardingChecklist.tsx:43`, `ScalingSettings.tsx:134`, `onboarding/OnboardingContext.tsx:76`, `onboarding/choose-path/ChoosePathWizard.tsx:105`, `pages/Settings.tsx:31`, `project-chat/useProjectChatState.ts:287`, `pages/CreateWorkspace.tsx:158` |
  | `listAgents` | 5 | `ProjectAgentsSection.tsx:57`, `AgentsSection.tsx:42`, `project-onboarding/ProjectOnboardingWizard.tsx:277`, `workspace/useSessionState.ts:77`, `project-chat/useProjectChatState.ts:307` |
  | `listAgentProfiles` | 5 | `triggers/TriggerForm.tsx:99`, `task/TaskSubmitForm.tsx:105`, `project/TaskForm.tsx:52`, `project-chat/useProjectChatState.ts:326`, `hooks/useAgentProfiles.ts:25` |
  | `getTrialStatus` | 3 | `OnboardingChecklist.tsx:46`, `CreateWorkspace.tsx:158`, `project-chat/useProjectChatState.ts:287` |

- **No stale-while-revalidate across mounts.** Unmount/remount (route change,
  `AppShell` breakpoint transition) drops component-held data, so the next mount
  re-fetches behind a spinner.

- **No cache persistence.** Wave 2 shipped IndexedDB persistence
  (`lib/query-persistence.ts`), but it can only persist queries that live in the
  query cache. Hand-rolled loaders are invisible to it.

- **Polls that do not pause on hidden tabs.** `useActiveTasks.ts:45-51` runs a bare
  `setInterval` with no `document.visibilityState` check, violating
  `.claude/rules/60-request-io-and-bundle-budgets.md` ("Polling Hygiene").

- **Mutation → manual reload chains.** `useAgentProfiles.ts:48-75` `await
  fetchProfiles()` after every create/update/delete instead of invalidating a shared
  cache, so sibling consumers of the same data stay stale.

## Research Findings

### What Waves 1 and 2 already built (extend, do not fork — rule 59/24)

- `lib/query-client.ts` — QueryClient with `staleTime: 15_000`,
  `refetchOnWindowFocus: false`, `retry: 1`, plus a documented rendering contract.
- `lib/query-options.ts` — `projectQueryKeys` / `githubQueryKeys` factories and
  `queryOptions()` builders. **The established key shape is
  `['auth', queryScope, domain, operation, ...]`** where `queryScope = user?.id ?? ''`.
- `hooks/useProjectData.ts` — the canonical thin `useQuery` wrapper shape:
  `{ data, loading: isPending && data === undefined, isRefreshing: isFetching && data !== undefined, error, refresh }`.
- `hooks/useVisibilityAwarePoll.ts` — visibility-gated `setInterval` for polls that
  cannot move to TanStack.
- `lib/poll-intervals.ts` — env-overridable `DEFAULT_*` cadence constants.
- `lib/query-persist-config.ts` — the persistence allowlist
  (`PERSISTED_QUERY_OPERATIONS`) and `shouldDehydratePersistedQuery`.
- `tests/test-utils/query-test-utils.tsx` — `renderWithQuery` / `createTestQueryClient`.
- `tests/unit/hooks/useProjectData.test.tsx` — the established behavioural test
  matrix (dedup, remount reuse, SWR during refetch, error suppression with stale
  data, scope isolation). **New migrations must be tested to the same matrix.**

### Verified: TanStack `refetchInterval` already pauses on hidden tabs

Checked against the installed source rather than from memory —
`node_modules/.pnpm/@tanstack+query-core@5.101.2/.../build/modern/queryObserver.js:208-219`:

```js
#updateRefetchInterval(nextInterval) {
  ...
  if (this.options.refetchIntervalInBackground || focusManager.isFocused()) {
    this.#executeFetch();
  }
}
```

and `focusManager.js:isFocused()` returns
`globalThis.document?.visibilityState !== "hidden"`. `refetchIntervalInBackground`
defaults to `false`, so a migrated poll issues **zero** requests while the tab is
hidden. This satisfies rule 60's polling-hygiene requirement by construction — but it
must be proven by a discriminating test, not asserted.

### Existing TanStack usage that is NOT rule-48 §4 compliant

Four surfaces already use `useQuery` but with **unscoped** query keys and hardcoded
intervals:

| File | Key | Interval |
|---|---|---|
| `pages/Nodes.tsx:35-39,62,68,74` | `['nodes','list']`, `['nodes','catalog']` | `10_000` literal |
| `pages/Workspaces.tsx:19-23,36` | `['workspaces',…]` | `10_000` literal |
| `pages/SettingsNotifications.tsx:54` | `['notification-preferences']` | — |
| `pages/AdminDiagnosis.tsx:28` | `['admin-diagnosis', runId]` | — |

**This is not a live cross-account leak** — `AuthProvider.tsx:145` calls
`queryClient.clear()` inside the identity-transition `useLayoutEffect`, and
`AuthProvider.tsx:210` renders `null` (unmounting all consumers) while
`isCacheNamespaceTransitioning`. Unscoped keys are also structurally excluded from
disk persistence, because `shouldDehydratePersistedQuery` requires
`key[0] === 'auth' && key[1] === scope`. The defect is a **missing defence-in-depth
layer and a convention violation**, not an exploitable bug. Scoping them removes the
dependency on `clear()` being correct forever.

### Constraints carried forward from Wave 2's security review

`tasks/backlog/2026-08-07-expand-frontend-query-cache-and-persistence.md` and the
doc comment in `lib/query-persist-config.ts` ban persisting, without a separate
security review: credentials/tokens/connection configuration, chat messages and
agent output, admin errors/diagnoses/logs, node/workspace runtime details, file
contents and signed URLs, and mutation state.

**Consequence for this task: `PERSISTED_QUERY_OPERATIONS` is NOT extended.** Every
query migrated here is either explicitly banned (credentials, agent credentials,
node/workspace runtime detail) or carries user/agent free text (recent-chat topics,
active-task titles). In-memory dedup and SWR are the wins; disk persistence is out of
scope and stays gated behind that review.

### Prior incidents that constrain the design

- `.claude/rules/48-stale-while-revalidate-ui.md` — the settings-page refetch loop.
  Root cause chain: unmemoized context value → loader `useCallback` depending on the
  context object → effect refetch → `toast.error` in the loader's `catch` → loop.
  `pages/Settings.tsx:26-45` is the exact page from that incident and is in scope.
- `.claude/rules/16-no-page-reload-on-mutation.md` — mutations must invalidate, never
  reload.
- `.claude/rules/24` / `.claude/rules/59` — one implementation per operation; extend
  the existing factory pattern rather than inventing a parallel one.
- `.claude/rules/18-file-size-limits.md` — `lib/query-options.ts` will exceed 500
  lines once ~9 domains are added, so it becomes a directory with a barrel `index.ts`
  (the rule's prescribed "Type file" strategy). Importers keep
  `from '../lib/query-options'` unchanged.

## Scope

Thirteen surfaces. Chosen for request volume and UX impact, not for count.

### A. Shared catalogs/lists with many duplicate call sites (dedup wins)

1. `useCredentials()` — replaces 7 `listCredentials` loaders
2. `useAgentCatalog()` — replaces 5 `listAgents` loaders
3. `useAgentProfiles(projectId)` — rewrite; replaces 5 `listAgentProfiles` loaders,
   and its create/update/delete stop chaining `await fetchProfiles()`
4. `useTrialStatus()` — replaces 3 `getTrialStatus` loaders
5. `useProviderCatalog()` — rewrite `hooks/useProviderCatalog.ts`
6. `useAgentCredentials()` — replaces `listAgentCredentials` loaders

### B. Polling loaders (request-volume wins)

7. `useActiveTasks()` — rewrite; 15s dashboard poll, currently no visibility gate
8. `useRecentChats()` — rewrite; 30s sidebar poll with ~50 lines of hand-rolled
   visibility/cancellation bookkeeping that TanStack subsumes

### B2. Confirmed stale-while-revalidate defect (not merely a missed optimisation)

9. `useAllChatSessions()` — rewrite. Its sole consumer `pages/Chats.tsx:39,47`
   renders the list under `{!loading && …}`, so **any refetch blanks the entire chat
   list**. That is a live rule-48 §3 violation. The hook also hand-rolls request
   cancellation and stale-response discarding across three refs (`cancelledRef`,
   `fetchIdRef`, `hasLoadedRef` — `useAllChatSessions.ts:28-30`) that TanStack
   subsumes entirely.

### C. Rule-48 §4 compliance on existing TanStack surfaces

10. `pages/Nodes.tsx` — scope keys, move `10_000` into `poll-intervals.ts`
11. `pages/Workspaces.tsx` — scope keys, move `10_000` into `poll-intervals.ts`.
    Note `Nodes.tsx:33` currently imports `workspacesKeys` **from `Workspaces.tsx`**
    (page-to-page import); relocating both factories into `lib/query-options/`
    removes that coupling.
12. `pages/SettingsNotifications.tsx` — scope key

### D. The rule-48 incident page

13. `pages/Settings.tsx` — credentials shell feeding `SettingsContext`; consumes
    `useCredentials()`, keeps the context value memoized, and gates its spinner on
    "no data yet" rather than "fetch in flight"

**Explicitly out of scope** (documented, not silently dropped): the remaining ~40
loaders — chat message lifecycle (`useSessionLifecycle`, `useAgentChat`), WebSocket
hooks, admin log streams, one-shot form loaders, and `useNodeSystemInfo` /
`useWorkspacePorts` (already visibility-gated by Wave 1 via `useVisibilityAwarePoll`).

## Implementation Checklist

### Query option factories

- [ ] Convert `lib/query-options.ts` → `lib/query-options/` directory with a thin
      barrel `index.ts` re-exporting named symbols (rule 18); move existing
      projects/github content into `projects.ts` / `github.ts` unchanged
- [ ] `credentials.ts` — `credentialQueryKeys`, `credentialsQueryOptions`,
      `agentCredentialsQueryOptions`
- [ ] `agents.ts` — `agentQueryKeys`, `agentCatalogQueryOptions`,
      `agentProfilesQueryOptions`
- [ ] `trial.ts` — `trialQueryKeys`, `trialStatusQueryOptions`
- [ ] `tasks.ts` — `taskQueryKeys`, `activeTasksQueryOptions`
- [ ] `chats.ts` — `chatQueryKeys`, `recentChatsQueryOptions`
- [ ] `infrastructure.ts` — `nodeQueryKeys`, `workspaceQueryKeys`,
      `providerCatalogQueryOptions`
- [ ] `notifications.ts` — `notificationQueryKeys`
- [ ] Every key follows `['auth', queryScope, domain, operation, …]`
- [ ] Every factory takes `queryScope` as its first parameter; no factory can be
      called without one

### Hooks

- [ ] Rewrite `hooks/useActiveTasks.ts` on `useQuery` (`refetchInterval`)
- [ ] Rewrite `hooks/useRecentChats.ts` on `useQuery`; delete the hand-rolled
      visibility/cancellation bookkeeping
- [ ] Rewrite `hooks/useAgentProfiles.ts` on `useQuery` + `useMutation`;
      `onSuccess` → `queryClient.invalidateQueries`, never `await fetchProfiles()`
- [ ] Rewrite `hooks/useProviderCatalog.ts` on `useQuery`
- [ ] Rewrite `hooks/useAllChatSessions.ts` on `useQuery`; delete the three
      cancellation/staleness refs; fix `pages/Chats.tsx` to gate on "no data yet"
- [ ] New `hooks/useCredentials.ts` (credentials + agent credentials)
- [ ] New `hooks/useAgentCatalog.ts`
- [ ] New `hooks/useTrialStatus.ts`
- [ ] Replace `import * as api from '../lib/api'` with named imports in every hook
      touched (namespace imports defeat tree-shaking against the 514-line barrel)
- [ ] All hooks return the `useProjectData` result shape
      (`loading` / `isRefreshing` / `error` / `refresh`)
- [ ] No hook lists a context object (`toast`, auth) in a query dependency, and no
      `queryFn` / `catch` calls `toast.*` (rule 48 §2)

### Call-site migration

- [ ] `pages/Settings.tsx` → `useCredentials()`; `SettingsContext` value memoized;
      spinner gated on `data === undefined`
- [ ] `pages/CreateWorkspace.tsx`, `components/OnboardingChecklist.tsx`,
      `components/ScalingSettings.tsx`, `components/onboarding/OnboardingContext.tsx`,
      `components/onboarding/choose-path/ChoosePathWizard.tsx` → shared hooks
- [ ] `components/AgentsSection.tsx`, `components/ProjectAgentsSection.tsx`,
      `components/project-onboarding/ProjectOnboardingWizard.tsx`,
      `pages/workspace/useSessionState.ts` → `useAgentCatalog()`
- [ ] `components/triggers/TriggerForm.tsx`, `components/task/TaskSubmitForm.tsx`,
      `components/project/TaskForm.tsx` → `useAgentProfiles()`
- [ ] `pages/project-chat/useProjectChatState.ts:286-337` → shared hooks for
      credentials, trial, provider catalog, agent catalog, agent profiles
- [ ] `pages/Nodes.tsx`, `pages/Workspaces.tsx`, `pages/SettingsNotifications.tsx`
      → scoped keys + `poll-intervals.ts` cadences

### Configuration (constitution XI / rule 60)

- [ ] `lib/poll-intervals.ts` gains `NODE_LIST_POLL_MS`, `WORKSPACE_LIST_POLL_MS`,
      `ACTIVE_TASKS_POLL_MS`, `RECENT_CHATS_POLL_MS`, each with a `DEFAULT_*`
      constant and a `VITE_*` override
- [ ] `useRecentChats`'s `VITE_RECENT_CHATS_POLL_MS` / `VITE_RECENT_CHATS_LIMIT`
      keep working (no behaviour change for existing deployments)
- [ ] No new hardcoded interval or limit literals at any call site

### Tests

- [ ] Per migrated hook, the `useProjectData.test.tsx` matrix: dedup across
      concurrent consumers, cache reuse on remount, **data still visible while
      `isRefreshing`**, stale data retained + error suppressed on failed background
      refetch, scope isolation between two user ids
- [ ] Hidden-tab test: `document.visibilityState = 'hidden'` + `focusManager` event,
      advance timers past the interval, assert **zero** additional fetches; then
      restore visibility and assert the poll resumes. Must fail if
      `refetchIntervalInBackground: true` is set
- [ ] Refetch-loop regression: render a migrated surface inside a `ToastProvider`
      whose value identity changes, force a `queryFn` rejection, advance timers, and
      assert the fetch count stays bounded (reproduces the rule-48 incident shape)
- [ ] Mutation test: create/update/delete a profile → assert `invalidateQueries` path
      refreshes sibling consumers and that no manual reload chain runs
- [ ] Scope-isolation canary: seed user-A data, switch `queryScope` to user B, assert
      user-A data never renders
- [ ] Persistence guard: assert `PERSISTED_QUERY_OPERATIONS` still contains only
      `projects/list` and that `shouldDehydratePersistedQuery` returns `false` for
      every newly added key (credentials must never reach disk)
- [ ] Playwright visual audit at 375×667 and 1280×800 for Settings, Dashboard,
      Nodes, Workspaces with normal / long-text / empty / many-item / error data,
      using `assertNoOverflow` from `tests/playwright/audit-helpers.ts` (rule 56)

### Validation

- [ ] `pnpm check:fast`
- [ ] `pnpm typecheck`
- [ ] `npx vitest run` in `apps/web` — full suite green
- [ ] `pnpm build`
- [ ] No source file over 800 lines; `lib/query-options/*` each well under 500

## Acceptance Criteria

1. At least 10 high-impact surfaces read through shared TanStack query factories.
2. `listCredentials`, `listAgents`, `listAgentProfiles`, `getTrialStatus`,
   `getProviderCatalog` each issue **one** request per `staleTime` window regardless
   of how many consumers are mounted — proven by a dedup test asserting call counts.
3. Every authenticated query key added is `['auth', queryScope, …]`, and a test
   proves two scopes never share a cache entry.
4. No migrated surface replaces already-rendered content with a spinner during a
   background refetch — proven per hook by an `isRefreshing`-with-data assertion.
5. Every migrated poll issues zero requests while `document.visibilityState ===
   'hidden'` — proven by a discriminating test.
6. Profile mutations invalidate instead of chaining manual reloads; no
   `window.location.reload()` is introduced.
7. `PERSISTED_QUERY_OPERATIONS` is unchanged; no credential, token, node/workspace
   runtime, or chat-derived payload becomes persistable.
8. Before/after request counts recorded for dashboard load, project-chat open, and
   settings load.
9. Full `apps/web` suite green; `pnpm check:fast` green.

## References

- SAM idea `01M09SKVNJGJNJY2WGCZ6D89XZ` (item #4, Phase 6)
- `tasks/backlog/2026-08-07-expand-frontend-query-cache-and-persistence.md`
- `tasks/archive/2026-08-07-frontend-query-cache-and-rotation-resilience.md`
- `.claude/rules/48-stale-while-revalidate-ui.md`
- `.claude/rules/60-request-io-and-bundle-budgets.md`
- `.claude/rules/16-no-page-reload-on-mutation.md`
- `.claude/rules/24-no-duplicate-ui-controls.md`, `.claude/rules/59-understand-before-adding.md`
- `.claude/rules/18-file-size-limits.md`, `.claude/rules/56-clipped-overflow-is-invisible-to-document-checks.md`
- TanStack Query v5 `useQuery` reference: https://tanstack.com/query/latest/docs/framework/react/reference/useQuery
- TanStack Query v5 persistence plugin: https://tanstack.com/query/v5/docs/framework/react/plugins/persistQueryClient

## Program Mechanics

- Base branch: `sam/read-idea-01m09skvnjgjnjy2wgcz6d89xz-using-bmbgfz` (NOT `main`)
- PR base: same integration branch. **Do not merge** — the program coordinator merges.
- **Do not deploy to or mutate staging** — verification is consolidated at the primary
  integration PR.
- CI does not auto-trigger for PRs targeting the integration branch; trigger manually
  with `gh workflow run ci.yml --ref <branch>`.
