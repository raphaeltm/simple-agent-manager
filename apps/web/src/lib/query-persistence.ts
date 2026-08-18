import {
  DEFAULT_QUERY_PERSIST_MAX_AGE_MS,
  DEFAULT_QUERY_PERSIST_RESTORE_TIMEOUT_MS,
  DEFAULT_QUERY_PERSIST_THROTTLE_MS,
} from '@simple-agent-manager/shared';
import type { PersistedClient, Persister } from '@tanstack/query-persist-client-core';
import type { Query } from '@tanstack/react-query';
import { del, delMany, get, keys, set, type UseStore } from 'idb-keyval';

/**
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
 * review. Because every one of those surfaces uses an *unscoped* query key
 * (`['nodes',…]`, `['workspaces',…]`, `['admin-diagnosis',…]`,
 * `['notification-preferences']`), requiring the `['auth', scope, …]` shape
 * excludes them structurally rather than by a hand-maintained denylist.
 */

/** Query-key domains (`key[2]`) approved for persistence.
 *
 * Adding a domain here persists that data to disk on the user's device — it
 * requires the security review described above. `github` (installation lists) is
 * deliberately NOT included: installation identifiers are connection
 * configuration, which the backlog task lists as review-gated. */
const PERSISTED_QUERY_DOMAINS: ReadonlySet<string> = new Set(['projects']);

/** Prefix for every persisted query-cache record. */
const QUERY_PERSIST_KEY_PREFIX = 'sam-query-cache';

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
export function buildQueryPersistStorageKey(
  namespace: string | null | undefined
): string | null {
  if (!namespace) return null;
  return `${QUERY_PERSIST_KEY_PREFIX}:${QUERY_PERSIST_SCHEMA_VERSION}:${namespace}`;
}

/**
 * The dehydration allowlist.
 *
 * A query is persisted only when ALL hold:
 *  - it succeeded and actually has data (never persist errors or in-flight state);
 *  - its key is `['auth', scope, domain, …]`;
 *  - `scope` is the *currently authenticated* scope, not merely some scope;
 *  - `domain` is in {@link PERSISTED_QUERY_DOMAINS}.
 *
 * @param scope the active `queryScope` (`user.id`) — an empty scope persists nothing
 */
export function shouldDehydratePersistedQuery(query: Query, scope: string): boolean {
  if (!scope) return false;
  if (query.state.status !== 'success' || query.state.data === undefined) return false;

  const key = query.queryKey;
  if (!Array.isArray(key) || key.length < 3) return false;

  const [prefix, keyScope, domain] = key;
  return (
    prefix === 'auth' &&
    typeof keyScope === 'string' &&
    keyScope === scope &&
    typeof domain === 'string'
  );
}

/**
 * A `Persister` backed by IndexedDB.
 *
 * Every method is fail-open: IndexedDB is unavailable in some private-browsing
 * modes and can reject on quota. A storage failure must degrade to "no persisted
 * cache", never to a broken app, so failures resolve rather than throw and a
 * failed write disables further writes for the lifetime of the persister.
 */
export interface CancellablePersister extends Persister {
  /**
   * Drop any throttled write that has not landed yet.
   *
   * Needed because `AuthProvider` calls `queryClient.clear()` during an identity
   * transition while the *previous* identity's subscription is still attached
   * (React runs effect cleanup on the following commit). Without this, the
   * resulting empty snapshot could land on the previous user's record after we
   * have already detached, blanking a cache they would otherwise get back on
   * their next sign-in.
   */
  cancelPendingWrites(): void;
}

export function createIdbQueryPersister(
  storageKey: string,
  options: { throttleMs?: number; store?: UseStore } = {}
): CancellablePersister {
  const throttleMs = options.throttleMs ?? QUERY_PERSIST_THROTTLE_MS;
  const store = options.store;

  let disabled = false;
  let pendingClient: PersistedClient | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let lastWriteAt = 0;

  const flush = async (): Promise<void> => {
    flushTimer = null;
    const client = pendingClient;
    pendingClient = null;
    if (!client || disabled) return;
    lastWriteAt = Date.now();
    try {
      await set(storageKey, client, store);
    } catch {
      // Quota exceeded, private mode, or a closed connection. Stop writing —
      // retrying on every cache event would only burn cycles.
      disabled = true;
    }
  };

  return {
    /**
     * Throttled write. TanStack v5 removed `throttleTime` from
     * `persistQueryClient`, and the subscriber fires on every cache event, so
     * without this a busy screen would issue an IDB write per keystroke-ish
     * update. Always coalesces to the most recent snapshot.
     */
    persistClient(client: PersistedClient): void {
      if (disabled) return;
      pendingClient = client;
      if (flushTimer !== null) return;
      const elapsed = Date.now() - lastWriteAt;
      const delay = elapsed >= throttleMs ? 0 : throttleMs - elapsed;
      flushTimer = setTimeout(() => void flush(), delay);
    },

    async restoreClient(): Promise<PersistedClient | undefined> {
      if (disabled) return undefined;
      try {
        return await get<PersistedClient>(storageKey, store);
      } catch {
        disabled = true;
        return undefined;
      }
    },

    async removeClient(): Promise<void> {
      pendingClient = null;
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      try {
        await del(storageKey, store);
      } catch {
        // Nothing recoverable — the record either never existed or IDB is gone.
      }
    },

    cancelPendingWrites(): void {
      pendingClient = null;
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
    },
  };
}

/**
 * Delete the persisted record for a namespace without constructing a persister.
 *
 * Used by sign-out and by identity transitions, where the goal is only to make
 * the previous user's record unreadable.
 */
export async function removePersistedQueryCache(
  namespace: string | null | undefined
): Promise<void> {
  const storageKey = buildQueryPersistStorageKey(namespace);
  if (!storageKey) return;
  try {
    await del(storageKey);
  } catch {
    // Best effort: the record is already unreachable to the next user because the
    // storage key is namespaced and the allowlist re-checks the active scope.
  }
}

/**
 * Delete every persisted query-cache record, for every identity and every schema
 * version.
 *
 * Sign-out has no user context to namespace by (mirroring the no-argument
 * `clearLibraryCache()` it runs beside), and it is the one moment where sweeping
 * records from *all* generations — including ones written by an older
 * {@link QUERY_PERSIST_SCHEMA_VERSION} — is unambiguously correct.
 *
 * Bounded by `timeoutMs`: sign-out must not be able to hang behind IndexedDB.
 * Leaving a record behind is not a leak (the key is namespaced, and the allowlist
 * re-checks the active scope on write), so failing open here is safe.
 */
export async function removeAllPersistedQueryCaches(
  timeoutMs: number = QUERY_PERSIST_RESTORE_TIMEOUT_MS,
  store?: UseStore
): Promise<void> {
  const sweep = async (): Promise<void> => {
    const allKeys = await keys(store);
    const ours = allKeys.filter(
      (key): key is string =>
        typeof key === 'string' && key.startsWith(`${QUERY_PERSIST_KEY_PREFIX}:`)
    );
    if (ours.length > 0) await delMany(ours, store);
  };

  try {
    await Promise.race([
      sweep(),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    // IndexedDB unavailable or rejected — see the doc comment; failing open is safe.
  }
}
