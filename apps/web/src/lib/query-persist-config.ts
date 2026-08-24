import {
  DEFAULT_QUERY_PERSIST_MAX_AGE_MS,
  DEFAULT_QUERY_PERSIST_RESTORE_TIMEOUT_MS,
  DEFAULT_QUERY_PERSIST_THROTTLE_MS,
} from '@simple-agent-manager/shared';
import type { Query } from '@tanstack/react-query';

/**
 * Pure configuration and policy for query-cache persistence.
 *
 * Deliberately free of any IndexedDB import. `AuthProvider` is statically imported
 * by `App.tsx`, so anything it can reach at module scope ships in the eager
 * bundle; keeping the key builder, the timing constants and the allowlist here
 * lets those callers stay cheap while `query-persistence.ts` (which pulls in
 * `idb-keyval`) is loaded only for signed-in sessions.
 *
 * Persistence for an allowlisted slice of the TanStack Query cache.
 *
 * Why IndexedDB and not localStorage: `lib/library-cache.ts` already competes for
 * the ~5 MB localStorage budget hard enough to need its own LRU eviction
 * (`findOldestLibraryKey`). Putting the query cache in a separate IDB store means
 * it can never evict library index entries, and gives headroom as the allowlist
 * grows.
 *
 * ## Security model
 *
 * Two independent layers, either of which alone prevents cross-user leakage:
 *
 * 1. **Storage key namespacing** — the IDB key embeds the authenticated user
 *    namespace (`buildLibraryCacheNamespace`), so two accounts never share a
 *    record. `AuthProvider` additionally deletes the previous namespace's record
 *    on every identity transition.
 * 2. **Dehydration allowlist** — {@link shouldDehydratePersistedQuery} only ever
 *    persists keys shaped `['auth', <the current user's scope>, <allowed domain>]`.
 *    A key belonging to another scope cannot be written even if it is somehow
 *    resident in the cache.
 *
 * The allowlist is deliberately narrow. `tasks/backlog/2026-08-07-expand-frontend-
 * query-cache-and-persistence.md` bans persisting chat messages/agent output,
 * credentials/tokens, admin errors and diagnoses, node/workspace runtime details,
 * file contents/signed URLs, and mutation state without a separate security
 * review. Chat messages/agent output have since been approved for local
 * persistence by the project owner for the project-chat session message cache.
 *
 * ## The allowlist matches on CONTENT, not just key shape
 *
 * An earlier revision allowlisted the whole `projects` domain, reasoning that every
 * banned surface uses an *unscoped* key (`['nodes',…]`, `['workspaces',…]`,
 * `['admin-diagnosis',…]`, `['notification-preferences']`) and is therefore
 * excluded structurally. That reasoning was incomplete and shipped a real leak:
 * `projectQueryKeys.detail` is ALSO `['auth', scope, 'projects', …]`, and
 * `GET /api/projects/:id` returns `recentSessions[].topic` — literally the first 97
 * characters of the user's first chat message (`project-data/messages.ts`) — plus
 * `recentActivity[].payload.message`, free-text agent output. Both are on the
 * banned list. The response type hides it: `projects/crud.ts` returns those fields
 * through an `as ProjectDetailResponse & {…}` cast, so they are invisible to
 * TypeScript.
 *
 * So the allowlist keys on the full `domain/operation` pair, and every entry must
 * be justified by what the endpoint actually RETURNS. Read the handler's real
 * response body before adding one; the query key will not tell you.
 */

/** Query-key `domain/operation` pairs (`key[2]/key[3]`) approved for persistence.
 *
 * Adding an entry writes that endpoint's response to the user's disk and requires
 * the security review described above.
 *
 * Deliberately excluded:
 *  - `projects/detail` — `getProject` embeds chat-derived session topics and
 *    agent-authored activity text (see above).
 *  - `github/installations` — installation identifiers are connection
 *    configuration, which the backlog task lists as review-gated.
 *
 * `projects/list` is included because `ProjectSummary` is names, counts and
 * timestamps only — no free-text user or agent content.
 *
 * `library/index` is included only for the stripped client-side project-library
 * global index. Its query factory removes `extractedTextPreview` before data enters
 * the query cache, and this replaces the existing user-namespaced localStorage
 * global-index cache rather than introducing a new persisted data class.
 *
 * TODO: Future — encrypt cached messages locally with auth-gated key — see idea 01M0CVZ13RBY20J58CXZ8S13ES
 */
export const PERSISTED_QUERY_OPERATIONS: ReadonlySet<string> = new Set([
  'library/index',
  'projects/list',
  'sessions/messages',
]);

/** Prefix for every persisted query-cache record. */
export const QUERY_PERSIST_KEY_PREFIX = 'sam-query-cache';

/**
 * Generation marker for the persisted payload. Bump whenever the dehydrated shape
 * or the allowlist changes so previously written records are discarded instead of
 * hydrated into a cache that no longer understands them.
 *
 * Hand-maintained on purpose, following the `sam-shell-v3` precedent in
 * `src/sw.ts`: no build hash or version string reaches the web bundle today
 * (`vite.config.ts` has no `define` block and CI injects no SHA), so a derived
 * buster would have to be invented rather than read.
 */
export const QUERY_PERSIST_SCHEMA_VERSION = 'v1';

function readPositiveIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** How long a persisted record may be restored after it was written. */
export const QUERY_PERSIST_MAX_AGE_MS = readPositiveIntEnv(
  import.meta.env?.VITE_QUERY_PERSIST_MAX_AGE_MS,
  DEFAULT_QUERY_PERSIST_MAX_AGE_MS
);

/** Minimum gap between IndexedDB writes. */
export const QUERY_PERSIST_THROTTLE_MS = readPositiveIntEnv(
  import.meta.env?.VITE_QUERY_PERSIST_THROTTLE_MS,
  DEFAULT_QUERY_PERSIST_THROTTLE_MS
);

/** Upper bound on the initial restore before we fail open to an empty cache. */
export const QUERY_PERSIST_RESTORE_TIMEOUT_MS = readPositiveIntEnv(
  import.meta.env?.VITE_QUERY_PERSIST_RESTORE_TIMEOUT_MS,
  DEFAULT_QUERY_PERSIST_RESTORE_TIMEOUT_MS
);

/**
 * IndexedDB key for a user namespace. Returns `null` for an absent namespace, so
 * an unauthenticated session persists nothing at all.
 *
 * @param namespace the value from `buildLibraryCacheNamespace(userId)`
 */
export function buildQueryPersistStorageKey(namespace: string | null | undefined): string | null {
  if (!namespace) return null;
  return `${QUERY_PERSIST_KEY_PREFIX}:${QUERY_PERSIST_SCHEMA_VERSION}:${namespace}`;
}

/**
 * The dehydration allowlist.
 *
 * A query is persisted only when ALL hold:
 *  - it succeeded and actually has data (never persist errors or in-flight state);
 *  - its key is `['auth', scope, domain, operation, …]`;
 *  - `scope` is the *currently authenticated* scope, not merely some scope;
 *  - `domain/operation` is in {@link PERSISTED_QUERY_OPERATIONS}.
 *
 * @param scope the active `queryScope` (`user.id`) — an empty scope persists nothing
 */
export function shouldDehydratePersistedQuery(query: Query, scope: string): boolean {
  if (!scope) return false;
  if (query.state.status !== 'success' || query.state.data === undefined) return false;

  const key = query.queryKey;
  if (!Array.isArray(key) || key.length < 4) return false;

  const [prefix, keyScope, domain, operation] = key;
  return (
    prefix === 'auth' &&
    typeof keyScope === 'string' &&
    keyScope === scope &&
    typeof domain === 'string' &&
    typeof operation === 'string' &&
    PERSISTED_QUERY_OPERATIONS.has(`${domain}/${operation}`)
  );
}
