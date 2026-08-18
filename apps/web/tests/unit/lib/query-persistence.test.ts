import { persistQueryClient } from '@tanstack/query-persist-client-core';
import { QueryClient } from '@tanstack/react-query';
import { clear, get, keys, set, type UseStore } from 'idb-keyval';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildQueryPersistStorageKey,
  createIdbQueryPersister,
  QUERY_PERSIST_SCHEMA_VERSION,
  removeAllPersistedQueryCaches,
  removePersistedQueryCache,
  shouldDehydratePersistedQuery,
} from '../../../src/lib/query-persistence';

const USER_A = 'user-a';
const USER_B = 'user-b';
const NAMESPACE_A = `user:${USER_A}`;
const NAMESPACE_B = `user:${USER_B}`;

/** A project payload used as the cross-user canary. */
const USER_A_PRIVATE_PROJECT = [{ id: 'proj-1', name: 'user-a-confidential-project' }];

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

/** Seed a successful query so it is eligible for dehydration. */
function seed(client: QueryClient, key: readonly unknown[], data: unknown): void {
  client.setQueryData(key, data);
}

/** The single query object the cache holds for `key`. */
function queryFor(client: QueryClient, key: readonly unknown[]) {
  const query = client.getQueryCache().find({ queryKey: key });
  if (!query) throw new Error(`no query cached for ${JSON.stringify(key)}`);
  return query;
}

/**
 * A `UseStore` whose every transaction rejects — models private-browsing mode or
 * a quota failure. idb-keyval takes an optional custom store on every call, so
 * this needs no global IndexedDB patching (patching `indexedDB.open` would wedge
 * idb-keyval's memoized default store for the rest of the file).
 */
function rejectingStore(): UseStore {
  return (() => Promise.reject(new Error('IndexedDB unavailable'))) as unknown as UseStore;
}

/** A `UseStore` that never settles — models a hung IndexedDB. */
function hangingStore(): UseStore {
  return (() => new Promise<never>(() => {})) as unknown as UseStore;
}

describe('query-persistence', () => {
  beforeEach(async () => {
    await clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('buildQueryPersistStorageKey', () => {
    it('namespaces the record by identity and schema version', () => {
      expect(buildQueryPersistStorageKey(NAMESPACE_A)).toBe(
        `sam-query-cache:${QUERY_PERSIST_SCHEMA_VERSION}:${NAMESPACE_A}`
      );
    });

    it('gives two identities two different records', () => {
      expect(buildQueryPersistStorageKey(NAMESPACE_A)).not.toBe(
        buildQueryPersistStorageKey(NAMESPACE_B)
      );
    });

    it('returns null when there is no authenticated identity', () => {
      // A null key is what stops a signed-out session persisting anything at all.
      expect(buildQueryPersistStorageKey(null)).toBeNull();
      expect(buildQueryPersistStorageKey(undefined)).toBeNull();
      expect(buildQueryPersistStorageKey('')).toBeNull();
    });
  });

  describe('shouldDehydratePersistedQuery — the allowlist', () => {
    it('persists an allowlisted query owned by the active scope', () => {
      const client = makeClient();
      seed(client, ['auth', USER_A, 'projects', 'list', { limit: 50 }], USER_A_PRIVATE_PROJECT);
      expect(
        shouldDehydratePersistedQuery(
          queryFor(client, ['auth', USER_A, 'projects', 'list', { limit: 50 }]),
          USER_A
        )
      ).toBe(true);
    });

    it('refuses a query belonging to a DIFFERENT scope', () => {
      // The load-bearing cross-user assertion: even if user B's cache somehow
      // holds a user-A-scoped entry, it must never reach disk.
      const client = makeClient();
      seed(client, ['auth', USER_A, 'projects', 'list'], USER_A_PRIVATE_PROJECT);
      expect(
        shouldDehydratePersistedQuery(
          queryFor(client, ['auth', USER_A, 'projects', 'list']),
          USER_B
        )
      ).toBe(false);
    });

    it('refuses everything when there is no active scope', () => {
      const client = makeClient();
      seed(client, ['auth', USER_A, 'projects', 'list'], USER_A_PRIVATE_PROJECT);
      expect(
        shouldDehydratePersistedQuery(queryFor(client, ['auth', USER_A, 'projects', 'list']), '')
      ).toBe(false);
    });

    // Every one of these is on the "never persist without a separate security
    // review" list in tasks/backlog/2026-08-07-expand-frontend-query-cache-and-
    // persistence.md. They are excluded structurally: none carries the
    // ['auth', <scope>, …] shape.
    it.each([
      ['node runtime details', ['nodes', 'list']],
      ['node provider catalog', ['nodes', 'catalog']],
      ['workspace runtime details', ['workspaces', 'list', '']],
      ['admin diagnosis output', ['admin-diagnosis', 'run-1']],
      ['per-user notification preferences', ['notification-preferences']],
    ])('refuses %s', (_label, key) => {
      const client = makeClient();
      seed(client, key, { secret: 'do-not-persist' });
      expect(shouldDehydratePersistedQuery(queryFor(client, key), USER_A)).toBe(false);
    });

    it('refuses an auth-scoped domain that is not on the allowlist', () => {
      // `github` installations are deliberately excluded pending security review.
      const client = makeClient();
      seed(client, ['auth', USER_A, 'github', 'installations'], [{ id: 1 }]);
      expect(
        shouldDehydratePersistedQuery(
          queryFor(client, ['auth', USER_A, 'github', 'installations']),
          USER_A
        )
      ).toBe(false);
    });

    it('refuses a query that failed rather than persisting an error state', async () => {
      const client = makeClient();
      await client
        .fetchQuery({
          queryKey: ['auth', USER_A, 'projects', 'list'],
          queryFn: () => Promise.reject(new Error('boom')),
          retry: false,
        })
        .catch(() => undefined);
      expect(
        shouldDehydratePersistedQuery(
          queryFor(client, ['auth', USER_A, 'projects', 'list']),
          USER_A
        )
      ).toBe(false);
    });
  });

  describe('persist → restore across a simulated page load', () => {
    it('restores allowlisted data into a brand-new QueryClient', async () => {
      const storageKey = buildQueryPersistStorageKey(NAMESPACE_A)!;
      const key = ['auth', USER_A, 'projects', 'list', { limit: 50 }] as const;

      // --- page load 1: populate and persist ---
      const first = makeClient();
      seed(first, key, USER_A_PRIVATE_PROJECT);
      const [unsubscribe, restored] = persistQueryClient({
        queryClient: first,
        persister: createIdbQueryPersister(storageKey, { throttleMs: 0 }),
        buster: QUERY_PERSIST_SCHEMA_VERSION,
        dehydrateOptions: {
          shouldDehydrateQuery: (q) => shouldDehydratePersistedQuery(q, USER_A),
        },
      });
      await restored;
      // Nudge the cache so the subscriber writes, then let the 0ms flush land.
      seed(first, key, USER_A_PRIVATE_PROJECT);
      await vi.waitFor(async () => expect(await get(storageKey)).toBeDefined());
      unsubscribe();

      // --- page load 2: fresh client, nothing in memory ---
      const second = makeClient();
      expect(second.getQueryData(key)).toBeUndefined();

      const [unsubscribe2, restored2] = persistQueryClient({
        queryClient: second,
        persister: createIdbQueryPersister(storageKey, { throttleMs: 0 }),
        buster: QUERY_PERSIST_SCHEMA_VERSION,
      });
      await restored2;
      unsubscribe2();

      expect(second.getQueryData(key)).toEqual(USER_A_PRIVATE_PROJECT);
    });

    it("does not restore user A's record into user B's session", async () => {
      const keyA = buildQueryPersistStorageKey(NAMESPACE_A)!;
      const keyB = buildQueryPersistStorageKey(NAMESPACE_B)!;
      const queryKey = ['auth', USER_A, 'projects', 'list'] as const;

      const a = makeClient();
      seed(a, queryKey, USER_A_PRIVATE_PROJECT);
      const [unsubA, restoredA] = persistQueryClient({
        queryClient: a,
        persister: createIdbQueryPersister(keyA, { throttleMs: 0 }),
        buster: QUERY_PERSIST_SCHEMA_VERSION,
        dehydrateOptions: { shouldDehydrateQuery: (q) => shouldDehydratePersistedQuery(q, USER_A) },
      });
      await restoredA;
      seed(a, queryKey, USER_A_PRIVATE_PROJECT);
      await vi.waitFor(async () => expect(await get(keyA)).toBeDefined());
      unsubA();

      // User B signs in: different storage key, so the restore finds nothing.
      const b = makeClient();
      const [unsubB, restoredB] = persistQueryClient({
        queryClient: b,
        persister: createIdbQueryPersister(keyB, { throttleMs: 0 }),
        buster: QUERY_PERSIST_SCHEMA_VERSION,
      });
      await restoredB;
      unsubB();

      expect(b.getQueryData(queryKey)).toBeUndefined();
      expect(b.getQueryCache().getAll()).toHaveLength(0);
    });
  });

  describe('eviction', () => {
    it('discards a record older than maxAge', async () => {
      const storageKey = buildQueryPersistStorageKey(NAMESPACE_A)!;
      const queryKey = ['auth', USER_A, 'projects', 'list'] as const;

      await set(storageKey, {
        timestamp: Date.now() - 60_000,
        buster: QUERY_PERSIST_SCHEMA_VERSION,
        clientState: {
          mutations: [],
          queries: [
            {
              queryKey,
              queryHash: JSON.stringify(queryKey),
              state: {
                data: USER_A_PRIVATE_PROJECT,
                dataUpdateCount: 1,
                dataUpdatedAt: Date.now() - 60_000,
                error: null,
                errorUpdateCount: 0,
                errorUpdatedAt: 0,
                fetchFailureCount: 0,
                fetchFailureReason: null,
                fetchMeta: null,
                isInvalidated: false,
                status: 'success',
                fetchStatus: 'idle',
              },
            },
          ],
        },
      });

      const client = makeClient();
      const [unsubscribe, restored] = persistQueryClient({
        queryClient: client,
        persister: createIdbQueryPersister(storageKey, { throttleMs: 0 }),
        buster: QUERY_PERSIST_SCHEMA_VERSION,
        maxAge: 1_000, // record is 60s old — well past
      });
      await restored;
      unsubscribe();

      expect(client.getQueryData(queryKey)).toBeUndefined();
      // Expired records are deleted, not merely skipped.
      expect(await get(storageKey)).toBeUndefined();
    });

    it('discards a record written under a different schema version', async () => {
      const storageKey = buildQueryPersistStorageKey(NAMESPACE_A)!;
      const queryKey = ['auth', USER_A, 'projects', 'list'] as const;

      await set(storageKey, {
        timestamp: Date.now(),
        buster: 'v0-previous-schema',
        clientState: { mutations: [], queries: [] },
      });

      const client = makeClient();
      const [unsubscribe, restored] = persistQueryClient({
        queryClient: client,
        persister: createIdbQueryPersister(storageKey, { throttleMs: 0 }),
        buster: QUERY_PERSIST_SCHEMA_VERSION,
      });
      await restored;
      unsubscribe();

      expect(client.getQueryData(queryKey)).toBeUndefined();
      expect(await get(storageKey)).toBeUndefined();
    });
  });

  describe('failure resilience', () => {
    it('treats an unreadable store as a cache miss instead of throwing', async () => {
      const storageKey = buildQueryPersistStorageKey(NAMESPACE_A)!;
      await set(storageKey, { poisoned: true });

      const persister = createIdbQueryPersister(storageKey, { throttleMs: 0 });
      const client = makeClient();

      // A malformed record must not reject the restore or crash hydration.
      const [unsubscribe, restored] = persistQueryClient({
        queryClient: client,
        persister,
        buster: QUERY_PERSIST_SCHEMA_VERSION,
      });
      await expect(restored).resolves.toBeUndefined();
      unsubscribe();
      expect(client.getQueryCache().getAll()).toHaveLength(0);
    });

    it('degrades to a cache miss when the store itself rejects', async () => {
      // Models private-browsing / disabled-IndexedDB: every store access throws.
      const storageKey = buildQueryPersistStorageKey(NAMESPACE_A)!;
      const persister = createIdbQueryPersister(storageKey, {
        throttleMs: 0,
        store: rejectingStore(),
      });

      await expect(persister.restoreClient()).resolves.toBeUndefined();
      await expect(persister.removeClient()).resolves.toBeUndefined();

      // A rejected write must not throw out of the void-returning persistClient.
      expect(() =>
        persister.persistClient({
          timestamp: Date.now(),
          buster: QUERY_PERSIST_SCHEMA_VERSION,
          clientState: { mutations: [], queries: [] },
        })
      ).not.toThrow();

      // A healthy persister is unaffected — failure is per-persister, not global.
      const healthy = createIdbQueryPersister(storageKey, { throttleMs: 0 });
      await expect(healthy.restoreClient()).resolves.toBeUndefined();
    });

    it('coalesces throttled writes to the latest snapshot', async () => {
      const storageKey = buildQueryPersistStorageKey(NAMESPACE_A)!;
      const persister = createIdbQueryPersister(storageKey, { throttleMs: 20 });

      const snapshot = (n: number) => ({
        timestamp: n,
        buster: QUERY_PERSIST_SCHEMA_VERSION,
        clientState: { mutations: [], queries: [] },
      });

      // Three cache events inside one throttle window must yield one write.
      persister.persistClient(snapshot(1));
      persister.persistClient(snapshot(2));
      persister.persistClient(snapshot(3));

      await vi.waitFor(async () =>
        expect((await get<{ timestamp: number }>(storageKey))?.timestamp).toBe(3)
      );
    });

    it('cancelPendingWrites drops a queued snapshot so it cannot blank a record', async () => {
      // Guards the AuthProvider transition ordering: queryClient.clear() runs
      // while the outgoing identity is still subscribed, queuing an empty
      // snapshot. That write must not land after we detach.
      const storageKey = buildQueryPersistStorageKey(NAMESPACE_A)!;
      await set(storageKey, {
        timestamp: 1,
        buster: QUERY_PERSIST_SCHEMA_VERSION,
        clientState: { mutations: [], queries: [] },
      });

      const persister = createIdbQueryPersister(storageKey, { throttleMs: 30 });
      persister.persistClient({
        timestamp: 999,
        buster: QUERY_PERSIST_SCHEMA_VERSION,
        clientState: { mutations: [], queries: [] },
      });
      persister.cancelPendingWrites();

      // Wait past the throttle window; the cancelled write must never land.
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect((await get<{ timestamp: number }>(storageKey))?.timestamp).toBe(1);
    });
  });

  describe('teardown', () => {
    it('removePersistedQueryCache deletes only the given identity', async () => {
      const keyA = buildQueryPersistStorageKey(NAMESPACE_A)!;
      const keyB = buildQueryPersistStorageKey(NAMESPACE_B)!;
      await set(keyA, { a: true });
      await set(keyB, { b: true });

      await removePersistedQueryCache(NAMESPACE_A);

      expect(await get(keyA)).toBeUndefined();
      expect(await get(keyB)).toBeDefined();
    });

    it('removeAllPersistedQueryCaches sweeps every identity and schema version', async () => {
      await set(buildQueryPersistStorageKey(NAMESPACE_A)!, { a: true });
      await set(buildQueryPersistStorageKey(NAMESPACE_B)!, { b: true });
      await set(`sam-query-cache:v0:${NAMESPACE_A}`, { legacy: true });
      await set('sam-library:user:other', { unrelated: true });

      await removeAllPersistedQueryCaches();

      const remaining = await keys();
      expect(remaining.filter((k) => String(k).startsWith('sam-query-cache:'))).toHaveLength(0);
      // Only our own records are swept — the library cache is untouched.
      expect(remaining).toContain('sam-library:user:other');
    });

    it('removeAllPersistedQueryCaches resolves even when the sweep never settles', async () => {
      // Sign-out awaits this, so it must not be able to hang behind IndexedDB.
      // Discriminating: without the internal timeout race this never resolves and
      // the test times out.
      const started = Date.now();
      await expect(removeAllPersistedQueryCaches(25, hangingStore())).resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });
});
