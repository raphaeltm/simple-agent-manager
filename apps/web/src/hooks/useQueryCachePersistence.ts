import { persistQueryClient } from '@tanstack/query-persist-client-core';
import { useEffect, useState } from 'react';

import { queryClient } from '../lib/query-client';
import {
  buildQueryPersistStorageKey,
  createIdbQueryPersister,
  QUERY_PERSIST_MAX_AGE_MS,
  QUERY_PERSIST_RESTORE_TIMEOUT_MS,
  QUERY_PERSIST_SCHEMA_VERSION,
  removePersistedQueryCache,
  shouldDehydratePersistedQuery,
} from '../lib/query-persistence';

/**
 * Drives query-cache persistence for the currently authenticated identity.
 *
 * Lives here rather than in a root-level `PersistQueryClientProvider` because
 * `QueryClientProvider` is mounted *outside* `AuthProvider` (`App.tsx`), so the
 * root has no idea who the user is — and the persisted record must be namespaced
 * by user. `AuthProvider` owns the identity transition, so it owns this too.
 *
 * Contract with `AuthProvider`'s existing transition `useLayoutEffect`:
 *  - that layout effect runs first and calls `queryClient.clear()`, so this effect
 *    always restores into an empty cache;
 *  - it passes the *resolved* namespace (`activeCacheNamespace`), never the
 *    in-flight one, so we never write a record under a half-resolved identity.
 *
 * @param namespace resolved identity namespace, or `null` when signed out.
 *   `undefined` means "not resolved yet" — do nothing.
 * @param scope the active `queryScope` (`user.id`), used by the allowlist
 * @returns `true` while the restore for `namespace` is still outstanding. Callers
 *   should gate rendering on this so the first paint can come from cache.
 */
export function useQueryCachePersistence(
  namespace: string | null | undefined,
  scope: string
): boolean {
  const [restoredFor, setRestoredFor] = useState<string | null | undefined>(undefined);

  // `namespace` and `scope` both derive from `user.id`, so they always change
  // together — listing both keeps exhaustive-deps happy without causing an extra
  // resubscribe, and capturing `scope` in the effect closure (rather than a live
  // ref) guarantees the dehydrate predicate can never check a scope that
  // disagrees with the storage key it is writing to.
  useEffect(() => {
    // Identity not resolved yet — AuthProvider is still gating on its own state.
    if (namespace === undefined) return;

    let cancelled = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = () => {
      if (cancelled) return;
      if (settleTimer !== null) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      setRestoredFor(namespace);
    };

    const storageKey = buildQueryPersistStorageKey(namespace);

    // Signed out: nothing to restore and nothing may be written.
    if (!storageKey) {
      settle();
      return () => {
        cancelled = true;
      };
    }

    const persister = createIdbQueryPersister(storageKey);

    const [unsubscribe, restored] = persistQueryClient({
      queryClient,
      persister,
      maxAge: QUERY_PERSIST_MAX_AGE_MS,
      buster: QUERY_PERSIST_SCHEMA_VERSION,
      dehydrateOptions: {
        shouldDehydrateQuery: (query) => shouldDehydratePersistedQuery(query, scope),
        // Mutation state is on the "never persist" list.
        shouldDehydrateMutation: () => false,
      },
    });

    // Rendering is gated on the restore, so a hung or pathologically slow
    // IndexedDB must not hang the app: fail open to an empty in-memory cache.
    settleTimer = setTimeout(settle, QUERY_PERSIST_RESTORE_TIMEOUT_MS);
    void restored.then(settle, settle);

    return () => {
      cancelled = true;
      if (settleTimer !== null) clearTimeout(settleTimer);
      unsubscribe();
      // AuthProvider's transition layout effect already ran `queryClient.clear()`
      // while this subscription was still attached, so a write of the resulting
      // empty snapshot may be queued against the OUTGOING identity's record.
      // Drop it rather than let it blank a cache we may still want.
      persister.cancelPendingWrites();
    };
  }, [namespace, scope]);

  return restoredFor !== namespace;
}

/**
 * Delete the persisted record for an identity that is no longer active.
 *
 * Called by `AuthProvider` on an account switch / sign-out transition, alongside
 * the existing `clearLibraryCache(previousNamespace)`.
 */
export function discardPersistedQueryCache(namespace: string | null | undefined): void {
  void removePersistedQueryCache(namespace);
}
