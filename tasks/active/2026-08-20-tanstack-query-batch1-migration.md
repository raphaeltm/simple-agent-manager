# TanStack Query Batch 1 Data-Fetching Migration

## Problem

SAM idea `01M0E14DMF42M4RGYEE3RXMA03` identifies 60+ remaining web data-fetching
surfaces that still use hand-rolled `useState` + `useCallback` + `useEffect`
loaders or custom polling. Those loaders miss the app's established TanStack Query
benefits: shared request deduplication, stale-while-revalidate rendering, scoped
cache keys, mutation invalidation, and visibility-aware polling.

This task executes the idea's Batch 1 HIGH-severity scope only. The full 60+
surface migration is too large for one safe PR, and the idea itself recommends
batching.

## Already-done check

- `main` already includes adjacent frontend query/cache work:
  - PR #1858: TanStack Query persistence and HTTP cache controls.
  - PR #1860: a different high-impact hook migration set, recorded in
    `tasks/archive/2026-08-19-tanstack-query-migration-high-impact-hooks.md`.
  - PR #1868: integration merge for caching work.
- PR #1860 is still open against its integration branch, but its implementation
  commit is reachable from the current branch through PR #1868.
- Direct inspection of this idea's Batch 1 targets shows the requested work is not
  already complete. These files still contain hand-rolled data fetching in current
  code:
  - `apps/web/src/hooks/useWorkspacePorts.ts`
  - `apps/web/src/hooks/useLibraryIndex.ts`
  - `apps/web/src/hooks/useNotifications.ts`
  - `apps/web/src/components/CredentialHealthNavItem.tsx`
  - `apps/web/src/components/GlobalCommandPalette.tsx`
  - `apps/web/src/components/debug/FailureCard.tsx`
  - `apps/web/src/components/triggers/TriggerDropdown.tsx`
  - `apps/web/src/components/project-message-view/useSessionTimeline.ts`
  - `apps/web/src/pages/ProjectCreate.tsx`
  - `apps/web/src/pages/IdeasPage.tsx`
  - `apps/web/src/pages/IdeaDetailPage.tsx`
  - `apps/web/src/pages/project-chat/useProjectSkills.ts`
  - `apps/web/src/hooks/useAvailableCommands.ts`

## Research findings

- TanStack Query is already app-wide in `apps/web/src/lib/query-client.ts` with a
  stale-while-revalidate rendering contract.
- Query keys live in `apps/web/src/lib/query-options/`; authenticated keys must
  start with `['auth', queryScope, domain, operation, ...]` because persistence and
  account-switch isolation parse that shape positionally.
- `useQueryScope()` in `apps/web/src/hooks/useQueryScope.ts` is the canonical user
  scope. Queries must be disabled when the scope or required resource ids are blank.
- Persistence is allowlisted in `apps/web/src/lib/query-persist-config.ts`. Batch 1
  must not make credentials, notifications, chat/session summaries, task details,
  runtime details, file contents, signed URLs, or admin/debug payloads persistable
  without a separate security review.
- Existing migrated hooks such as `useProjectList`, `useAgentProfiles`,
  `useRecentChats`, and `useAllChatSessions` preserve their public return shapes
  while mapping Query state into `loading`, `isRefreshing`, `error`, and `refresh`.
- Existing query factories already cover some Batch 1 endpoints:
  `projectListQueryOptions`, `nodeListQueryOptions`, `allChatsQueryOptions`,
  `githubInstallationsQueryOptions`, `triggersQueryOptions`, and
  `agentProfilesQueryOptions`.
- Related prior incidents/rules:
  - `.claude/rules/48-stale-while-revalidate-ui.md`: never blank visible content on
    background refetch; prefer TanStack Query for modified fetch surfaces.
  - `.claude/rules/60-request-io-and-bundle-budgets.md`: polling must pause in
    hidden tabs and intervals/limits must be configurable.
  - `.claude/rules/16-no-page-reload-on-mutation.md`: mutations update React state
    or invalidate queries, not page reloads.
  - `.claude/rules/24-no-duplicate-ui-controls.md` and
    `.claude/rules/59-understand-before-adding.md`: extend existing query factories
    instead of adding duplicate data-fetching paths.
  - `.claude/rules/18-file-size-limits.md`: split query-option modules if line
    counts approach the limit.

## Implementation checklist

### Query option factories

- [ ] Add or extend query factories for workspace ports, library index/list sweep,
      notifications, project credential health, task events/detail/sessions,
      session timeline resources, project artifacts config, skills, and cached
      commands.
- [ ] Reuse existing factories for projects, nodes, all chats, GitHub installations,
      triggers, and agent profiles where they already fit.
- [ ] Keep every authenticated key user-scoped and keep `PERSISTED_QUERY_OPERATIONS`
      unchanged unless explicitly justified and reviewed.

### Hook/component migrations

- [ ] Migrate `useWorkspacePorts.ts` from `useVisibilityAwarePoll` to `useQuery`
      with `refetchInterval` and hidden-tab pause semantics.
- [ ] Migrate `useLibraryIndex.ts` from localStorage-backed state to Query-backed
      acquisition while preserving the hook's public contract.
- [ ] Migrate `useNotifications.ts` initial notification/unread reads and
      mark-read/dismiss mutations to Query/Mutation while preserving the WebSocket
      update path.
- [ ] Migrate `CredentialHealthNavItem.tsx` to Query.
- [ ] Migrate `GlobalCommandPalette.tsx` to Query-backed projects, nodes, and chats.
- [ ] Migrate `FailureCard.tsx` events-on-expand to Query.
- [ ] Migrate `TriggerDropdown.tsx` to the existing triggers query key.
- [ ] Migrate `useSessionTimeline.ts` to Query-backed messages, activity events, and
      progress notifications.
- [ ] Migrate `ProjectCreate.tsx` GitHub installations and artifact flag reads to
      Query.
- [ ] Migrate `IdeasPage.tsx` idea sweep and chat-session reads to Query.
- [ ] Migrate `IdeaDetailPage.tsx` idea detail and linked-session reads to Query.
- [ ] Migrate `useProjectSkills.ts` to Query.
- [ ] Migrate `useAvailableCommands.ts` to Query while preserving its cache-save API.

### Tests and validation

- [ ] Add/adjust unit tests for deduplication, cached-data reuse, stale data during
      refresh, initial-load errors, scope isolation, polling pause, query invalidation,
      and WebSocket cache updates where relevant.
- [ ] Add/adjust persistence guard tests so newly added Batch 1 keys are not
      dehydrated unless explicitly allowlisted.
- [ ] Run focused web tests for touched hooks/components.
- [ ] Run required UI Playwright visual audits for changed web surfaces.
- [ ] Run full `/do` validation: lint, typecheck, test, build.
- [ ] Run required specialist reviews before staging/PR.

## Acceptance criteria

1. All 13 Batch 1 targets route their REST reads through TanStack Query or
   `useMutation`, with documented exceptions only for WebSocket/SSE/local-only state.
2. Existing public hook/component contracts remain compatible for current call sites.
3. Authenticated query keys added by this task are user-scoped via `useQueryScope()`.
4. Background refetches keep already-rendered content visible.
5. Polling migrations use Query `refetchInterval` and do not refetch in hidden tabs.
6. Notification and trigger/skill/profile-style mutations update or invalidate the
   shared Query cache instead of refreshing only local state.
7. Query persistence remains allowlisted; newly added sensitive/free-text/runtime keys
   are not persisted by default.
8. Focused tests, local visual audit, full validation, staging verification, CI, and
   production deploy monitoring complete according to `/do`.

## References

- SAM idea `01M0E14DMF42M4RGYEE3RXMA03`
- `tasks/archive/2026-08-19-tanstack-query-migration-high-impact-hooks.md`
- `tasks/archive/2026-08-07-frontend-query-cache-and-rotation-resilience.md`
- `tasks/active/2026-08-19-server-side-kv-caching.md`
- `tasks/active/2026-08-19-browser-side-conversation-caching.md`
- `.claude/rules/48-stale-while-revalidate-ui.md`
- `.claude/rules/60-request-io-and-bundle-budgets.md`
- `.claude/rules/16-no-page-reload-on-mutation.md`
- `.claude/rules/24-no-duplicate-ui-controls.md`
- `.claude/rules/59-understand-before-adding.md`
- `.claude/rules/17-ui-visual-testing.md`
