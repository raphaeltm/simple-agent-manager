/**
 * Barrel for the app's TanStack Query key factories and `queryOptions` builders.
 *
 * Split from the original single `lib/query-options.ts` once the migration of the
 * hand-rolled loaders pushed it past the 500-line ceiling in
 * `.claude/rules/18-file-size-limits.md`. Importers keep writing
 * `from '../lib/query-options'` and resolve here, so the split is invisible to
 * every call site.
 *
 * ## The one invariant every module here must hold
 *
 * Authenticated query keys are `['auth', queryScope, domain, operation, …]`, where
 * `queryScope` is `user?.id ?? ''` (see `AuthProvider`). This is not a stylistic
 * convention — `shouldDehydratePersistedQuery` in `lib/query-persist-config.ts`
 * parses the key **positionally** (`key[0]` must be `'auth'`, `key[1]` must equal
 * the currently authenticated scope, `key[2]/key[3]` are matched against the
 * persistence allowlist). A key that deviates from the shape silently becomes
 * unpersistable and loses its scope isolation.
 *
 * ## Adding a key does NOT make it persisted
 *
 * Persistence is opt-in through `PERSISTED_QUERY_OPERATIONS`, which is currently
 * `{'projects/list'}` and is deliberately not extended by these modules. Everything
 * defined here beyond the project list is on the never-persist-without-security-
 * review list in `tasks/backlog/2026-08-07-expand-frontend-query-cache-and-persistence.md`:
 * credentials and tokens, node/workspace runtime detail, and chat-derived free text
 * (recent-chat topics, task titles). Read the endpoint's real response body before
 * proposing an allowlist entry — the response *type* can hide free-text fields, as
 * the `projects/detail` case documented in `query-persist-config.ts` shows.
 */

export {
  agentCatalogQueryOptions,
  agentCredentialsQueryOptions,
  agentProfilesQueryOptions,
  agentQueryKeys,
} from './agents';
export {
  allChatsQueryOptions,
  chatQueryKeys,
  type ChatSessionSummary,
  recentChatsQueryOptions,
} from './chats';
export { credentialQueryKeys, credentialsQueryOptions } from './credentials';
export { githubInstallationsQueryOptions, githubQueryKeys } from './github';
export {
  nodeListQueryOptions,
  nodeQueryKeys,
  providerCatalogQueryOptions,
  workspaceListQueryOptions,
  workspaceQueryKeys,
} from './infrastructure';
export { notificationPreferencesQueryOptions, notificationQueryKeys } from './notifications';
export {
  projectDetailQueryOptions,
  projectListQueryOptions,
  projectQueryKeys,
} from './projects';
export { activeTasksQueryOptions, taskQueryKeys } from './tasks';
export { trialQueryKeys, trialStatusQueryOptions } from './trial';
export { triggerQueryKeys, triggersQueryOptions } from './triggers';
