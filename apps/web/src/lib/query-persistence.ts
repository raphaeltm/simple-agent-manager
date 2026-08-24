import type { PersistedClient, Persister } from '@tanstack/query-persist-client-core';
import { del, delMany, get, keys, set, type UseStore } from 'idb-keyval';

import {
  buildQueryPersistStorageKey,
  QUERY_PERSIST_KEY_PREFIX,
  QUERY_PERSIST_RESTORE_TIMEOUT_MS,
  QUERY_PERSIST_THROTTLE_MS,
} from './query-persist-config';

/**
 * The IndexedDB half of query-cache persistence.
 *
 * Split from `query-persist-config.ts` so that `idb-keyval` and this module's
 * machinery stay OUT of the eager bundle: only `useQueryCachePersistence` loads
 * this, and only once a signed-in namespace exists. See that hook's doc comment.
 *
 * Re-exports the pure policy surface so existing importers (and tests) can keep
 * treating `query-persistence` as the single entry point.
 */
export {
  buildQueryPersistStorageKey,
  PERSISTED_QUERY_OPERATIONS,
  QUERY_PERSIST_MAX_AGE_MS,
  QUERY_PERSIST_RESTORE_TIMEOUT_MS,
  QUERY_PERSIST_SCHEMA_VERSION,
  QUERY_PERSIST_THROTTLE_MS,
  shouldDehydratePersistedQuery,
} from './query-persist-config';

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
  let lastWrittenPayload: string | null = null;

  const flush = async (): Promise<void> => {
    flushTimer = null;
    const client = pendingClient;
    pendingClient = null;
    if (!client || disabled) return;

    // Skip a write that would not change anything on disk.
    //
    // `persistQueryClientSubscribe` subscribes to the WHOLE query cache and
    // re-dehydrates on every event anywhere in the app — a screen polling two
    // unrelated queries every 10s therefore enqueues a write every throttle
    // window even though nothing in the persisted allowlist changed. Comparing
    // the serialized payload skips the expensive part (structured clone + IDB
    // transaction) for those no-op churn events.
    let payload: string;
    try {
      payload = JSON.stringify(client);
    } catch {
      // Non-serializable snapshot: let idb-keyval's structured clone decide.
      payload = '';
    }
    if (payload !== '' && payload === lastWrittenPayload) return;

    lastWriteAt = Date.now();
    try {
      await set(storageKey, client, store);
      lastWrittenPayload = payload === '' ? null : payload;
    } catch {
      // Quota exceeded, private mode, or a closed connection. Stop writing —
      // retrying on every cache event would only burn cycles.
      disabled = true;
      lastWrittenPayload = null;
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
    await Promise.race([sweep(), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
  } catch {
    // IndexedDB unavailable or rejected — see the doc comment; failing open is safe.
  }
}
