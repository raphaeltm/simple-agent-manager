import { useEffect, useState } from 'react';

import { queryClient } from '../lib/query-client';
// Pure policy/config only — deliberately NOT `./query-persistence`, which pulls in
// idb-keyval. See the doc comment below.
import { QUERY_PERSIST_RESTORE_TIMEOUT_MS } from '../lib/query-persist-config';

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
 * ## This module imports nothing from `lib/query-persistence` at module scope
 *
 * That is deliberate and load-bearing. `AuthProvider` is statically imported by
 * `App.tsx` and wraps the whole router, so anything reachable from here at module
 * scope lands in the eager, always-preloaded bundle — measured at +9.8 kB gzip
 * when `@tanstack/query-persist-client-core` and `idb-keyval` were static
 * imports. Anonymous visitors on `/`, `/try` and `/device` can never benefit from
 * persistence (there is no identity to key a record by), so they must not pay for
 * it. Everything IndexedDB-touching is therefore behind a dynamic `import()` that
 * only runs once a non-null namespace exists.
 *
 * The one thing this hook would otherwise need synchronously is the storage key,
 * and it does not: `buildQueryPersistStorageKey(ns)` returns `null` exactly when
 * `!ns`, so `!namespace` is an equivalent, dependency-free test. The restore
 * budget comes from `query-persist-config`, which is pure.
 *
 * ## Why signed-out sessions are never gated
 *
 * The returned flag gates rendering, and this gate can only ADD latency to first
 * paint: it starts after the session round trip (it needs the identity), and while
 * it is open `ProtectedRoute`'s spinner cannot show, because that spinner lives
 * inside the gated subtree. With no identity there is nothing to restore, so a
 * signed-out session resolves on the very first render and never blanks.
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
  // Seeded from the namespace so a signed-out session is never reported as
  // restoring — no state update, no extra paint, no blank frame for a visitor who
  // has nothing to restore.
  const [restoredFor, setRestoredFor] = useState<string | null | undefined>(() =>
    namespace ? undefined : namespace
  );

  // `namespace` and `scope` both derive from `user.id`, so they always change
  // together — listing both keeps exhaustive-deps happy without causing an extra
  // resubscribe, and capturing `scope` in the effect closure (rather than a live
  // ref) guarantees the dehydrate predicate can never check a scope that
  // disagrees with the storage key it is writing to.
  useEffect(() => {
    // Identity not resolved yet — AuthProvider is still gating on its own state.
    if (namespace === undefined) return;

    // Signed out: nothing to restore and nothing may be written.
    if (!namespace) {
      setRestoredFor(namespace);
      return;
    }

    let cancelled = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let teardown: (() => void) | null = null;

    const settle = () => {
      if (cancelled) return;
      if (settleTimer !== null) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      setRestoredFor(namespace);
    };

    // Rendering is gated on the restore, so a hung or pathologically slow
    // IndexedDB must not hang the app. Armed BEFORE awaiting the dynamic import so
    // a stalled chunk fetch cannot hold the gate open either.
    settleTimer = setTimeout(settle, QUERY_PERSIST_RESTORE_TIMEOUT_MS);

    void (async () => {
      try {
        const [{ persistQueryClient }, persistence] = await Promise.all([
          import('@tanstack/query-persist-client-core'),
          import('../lib/query-persistence'),
        ]);
        if (cancelled) return;

        const storageKey = persistence.buildQueryPersistStorageKey(namespace);
        if (!storageKey) {
          settle();
          return;
        }

        const persister = persistence.createIdbQueryPersister(storageKey);
        const [unsubscribe, restored] = persistQueryClient({
          queryClient,
          persister,
          maxAge: persistence.QUERY_PERSIST_MAX_AGE_MS,
          buster: persistence.QUERY_PERSIST_SCHEMA_VERSION,
          dehydrateOptions: {
            shouldDehydrateQuery: (query) =>
              persistence.shouldDehydratePersistedQuery(query, scope),
            // Mutation state is on the "never persist" list.
            shouldDehydrateMutation: () => false,
          },
        });

        teardown = () => {
          unsubscribe();
          // AuthProvider's transition layout effect already ran
          // `queryClient.clear()` while this subscription was still attached, so a
          // write of the resulting empty snapshot may be queued against the
          // OUTGOING identity's record. Drop it rather than let it blank a cache
          // we may still want.
          persister.cancelPendingWrites();
        };

        // Torn down while the import was in flight.
        if (cancelled) {
          teardown();
          teardown = null;
          return;
        }

        void restored.then(settle, settle);
      } catch {
        // Chunk fetch failed (offline, or a redeploy moved the hash). Persistence
        // is an optimisation — fail open to the normal in-memory cache.
        settle();
      }
    })();

    return () => {
      cancelled = true;
      if (settleTimer !== null) clearTimeout(settleTimer);
      teardown?.();
    };
  }, [namespace, scope]);

  return restoredFor !== namespace;
}

/**
 * Delete the persisted record for an identity that is no longer active.
 *
 * Called by `AuthProvider` on an account switch / sign-out transition, alongside
 * the existing `clearLibraryCache(previousNamespace)`. Fire-and-forget, and
 * dynamically imported for the same bundle reason as above: the record is already
 * unreadable to the next user (namespaced key + scope-checked allowlist), so this
 * is hygiene rather than the isolation boundary.
 */
export function discardPersistedQueryCache(namespace: string | null | undefined): void {
  if (!namespace) return;
  void import('../lib/query-persistence')
    .then((m) => m.removePersistedQueryCache(namespace))
    .catch(() => {
      // Nothing to do — see the doc comment: this is hygiene, not the boundary.
    });
}
