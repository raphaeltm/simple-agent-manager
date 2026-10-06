import {
  DEFAULT_CHAT_TRANSCRIPT_CACHE_MAX_SESSIONS,
  DEFAULT_CHAT_TRANSCRIPT_CACHE_TTL_MS,
  DEFAULT_CHAT_TRANSCRIPT_PERSIST_MAX_ROWS,
  DEFAULT_QUERY_PERSIST_MAX_AGE_MS,
  DEFAULT_QUERY_PERSIST_RESTORE_TIMEOUT_MS,
  DEFAULT_QUERY_PERSIST_THROTTLE_MS,
} from '@simple-agent-manager/shared';
import type { DehydratedState, Query } from '@tanstack/react-query';

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

/** The persisted operation that holds a chat transcript. */
const CHAT_TRANSCRIPT_OPERATION = 'sessions/messages';

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
 * How long a chat transcript stays cached after it was last loaded or updated:
 * in memory (its `gcTime`) and on disk (older transcript data is not written).
 */
export const CHAT_TRANSCRIPT_CACHE_TTL_MS = readPositiveIntEnv(
  import.meta.env?.VITE_CHAT_TRANSCRIPT_CACHE_TTL_MS,
  DEFAULT_CHAT_TRANSCRIPT_CACHE_TTL_MS
);

/** Most chat transcripts kept at once; opening a chat evicts the least recently updated beyond it. */
export const CHAT_TRANSCRIPT_CACHE_MAX_SESSIONS = readPositiveIntEnv(
  import.meta.env?.VITE_CHAT_TRANSCRIPT_CACHE_MAX_SESSIONS,
  DEFAULT_CHAT_TRANSCRIPT_CACHE_MAX_SESSIONS
);

/**
 * Newest rows of one chat transcript written to disk. Paging back grows a
 * transcript in memory; on disk it keeps only what a cold open would load.
 */
export const CHAT_TRANSCRIPT_PERSIST_MAX_ROWS = readPositiveIntEnv(
  import.meta.env?.VITE_CHAT_TRANSCRIPT_PERSIST_MAX_ROWS,
  DEFAULT_CHAT_TRANSCRIPT_PERSIST_MAX_ROWS
);

/**
 * How old a persisted operation's data may be and still be written to disk.
 * Operations without an entry are bounded by the record's own max age.
 */
const PERSISTED_OPERATION_MAX_AGE_MS: ReadonlyMap<string, number> = new Map([
  [CHAT_TRANSCRIPT_OPERATION, CHAT_TRANSCRIPT_CACHE_TTL_MS],
]);

function persistedDataMaxAgeMs(operation: string): number {
  return PERSISTED_OPERATION_MAX_AGE_MS.get(operation) ?? QUERY_PERSIST_MAX_AGE_MS;
}

/**
 * `gcTime` for queries restored from disk.
 *
 * Hydration builds restored queries from default options, and the app default
 * (five minutes) would drop every restored entry nobody opened within five
 * minutes — and with it the entry's copy on disk, because each write mirrors the
 * in-memory cache. A restored query therefore lives as long as the longest
 * persisted lifetime.
 */
export const RESTORED_QUERY_GC_TIME_MS = Math.max(
  QUERY_PERSIST_MAX_AGE_MS,
  ...PERSISTED_OPERATION_MAX_AGE_MS.values()
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
 *  - `domain/operation` is in {@link PERSISTED_QUERY_OPERATIONS};
 *  - its data is younger than that operation's age limit (chat transcripts:
 *    {@link CHAT_TRANSCRIPT_CACHE_TTL_MS}), so data past it leaves the disk even
 *    while it is still in memory.
 *
 * @param scope the active `queryScope` (`user.id`) — an empty scope persists nothing
 */
export function shouldDehydratePersistedQuery(query: Query, scope: string): boolean {
  if (!scope) return false;
  if (query.state.status !== 'success' || query.state.data === undefined) return false;

  const key = query.queryKey;
  if (!Array.isArray(key) || key.length < 4) return false;

  const [prefix, keyScope, domain, operation] = key;
  if (prefix !== 'auth' || keyScope !== scope) return false;
  if (typeof domain !== 'string' || typeof operation !== 'string') return false;

  const persistedOperation = `${domain}/${operation}`;
  if (!PERSISTED_QUERY_OPERATIONS.has(persistedOperation)) return false;
  return Date.now() - query.state.dataUpdatedAt <= persistedDataMaxAgeMs(persistedOperation);
}

type DehydratedQuery = DehydratedState['queries'][number];

/**
 * What a dehydrated query writes to disk. A chat transcript longer than
 * {@link CHAT_TRANSCRIPT_PERSIST_MAX_ROWS} keeps its newest rows and reports the
 * rest as older history, so a restored chat pages them back in on scroll-up the
 * way a cold open does. Everything else is written as is.
 */
export function persistedQueryForDisk(
  query: DehydratedQuery,
  maxRows: number = CHAT_TRANSCRIPT_PERSIST_MAX_ROWS
): DehydratedQuery {
  const [, , domain, operation] = query.queryKey;
  if (`${String(domain)}/${String(operation)}` !== CHAT_TRANSCRIPT_OPERATION) return query;
  const data = query.state.data as { messages?: unknown; hasMore?: unknown } | undefined;
  if (!data || !Array.isArray(data.messages) || data.messages.length <= maxRows) return query;
  return {
    ...query,
    state: {
      ...query.state,
      data: { ...data, messages: data.messages.slice(-maxRows), hasMore: true },
    },
  };
}
