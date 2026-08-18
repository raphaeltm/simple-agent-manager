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

/** Stand-ins for the two banned content classes that ride inside GET /api/projects/:id. */
const CHAT_CONTENT_CANARY = 'user-a-secret-chat-prompt-do-not-persist';
const AGENT_OUTPUT_CANARY = 'agent-authored-activity-message-do-not-persist';

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

    it('refuses projects/detail even though projects/list is allowlisted', () => {
      // The regression this allowlist shape exists for. `projects/detail` shares the
      // `projects` domain with the allowlisted `projects/list`, but GET
      // /api/projects/:id returns recentSessions[].topic — the first 97 chars of the
      // user's first CHAT MESSAGE — and recentActivity[].payload.message, free-text
      // agent output. Both are on the "never persist" list. A domain-level allowlist
      // accepted them; the operation-pair allowlist must not.
      const client = makeClient();
      seed(client, ['auth', USER_A, 'projects', 'detail', 'proj-1'], {
        id: 'proj-1',
        recentSessions: [{ id: 's1', topic: CHAT_CONTENT_CANARY }],
        recentActivity: [{ id: 'a1', payload: { message: AGENT_OUTPUT_CANARY } }],
      });
      expect(
        shouldDehydratePersistedQuery(
          queryFor(client, ['auth', USER_A, 'projects', 'detail', 'proj-1']),
          USER_A
        )
      ).toBe(false);
    });

    it('refuses a key whose first element is not the auth prefix', () => {
      // Discriminating for the `prefix === 'auth'` conjunct, which had no coverage.
      const client = makeClient();
      seed(client, ['public', USER_A, 'projects', 'list'], USER_A_PRIVATE_PROJECT);
      expect(
        shouldDehydratePersistedQuery(
          queryFor(client, ['public', USER_A, 'projects', 'list']),
          USER_A
        )
      ).toBe(false);
    });

    it('refuses a domain-only key with no operation segment', () => {
      const client = makeClient();
      seed(client, ['auth', USER_A, 'projects'], USER_A_PRIVATE_PROJECT);
      expect(
        shouldDehydratePersistedQuery(queryFor(client, ['auth', USER_A, 'projects']), USER_A)
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

    it('never writes chat-derived or agent-authored content to disk', async () => {
      // End-to-end version of the allowlist canary: drive the REAL dehydrate path
      // (not shouldDehydratePersistedQuery in isolation) with a cache holding both
      // an allowlisted list query and a detail query carrying the banned content,
      // then read the raw bytes back out of IndexedDB.
      const storageKey = buildQueryPersistStorageKey(NAMESPACE_A)!;
      const listKey = ['auth', USER_A, 'projects', 'list', { limit: 50 }] as const;
      const detailKey = ['auth', USER_A, 'projects', 'detail', 'proj-1'] as const;

      const client = makeClient();
      seed(client, listKey, USER_A_PRIVATE_PROJECT);
      seed(client, detailKey, {
        id: 'proj-1',
        recentSessions: [{ id: 's1', topic: CHAT_CONTENT_CANARY }],
        recentActivity: [{ id: 'a1', payload: { message: AGENT_OUTPUT_CANARY } }],
      });

      const [unsubscribe, restored] = persistQueryClient({
        queryClient: client,
        persister: createIdbQueryPersister(storageKey, { throttleMs: 0 }),
        buster: QUERY_PERSIST_SCHEMA_VERSION,
        dehydrateOptions: {
          shouldDehydrateQuery: (q) => shouldDehydratePersistedQuery(q, USER_A),
        },
      });
      await restored;
      seed(client, listKey, USER_A_PRIVATE_PROJECT);
      await vi.waitFor(async () => expect(await get(storageKey)).toBeDefined());
      unsubscribe();

      const written = JSON.stringify(await get(storageKey));
      // The allowlisted list survived...
      expect(written).toContain('user-a-confidential-project');
      // ...and neither banned content class is anywhere in the bytes on disk.
      expect(written).not.toContain(CHAT_CONTENT_CANARY);
      expect(written).not.toContain(AGENT_OUTPUT_CANARY);
      expect(written).not.toContain('recentSessions');
      expect(written).not.toContain('recentActivity');
    });

    it('gives two users separate records even for the SAME project id', async () => {
      // The acceptance criterion's "including colliding project IDs" case: the user
      // scope is embedded in BOTH the storage key and the query key, so an
      // identical projectId across accounts cannot collide.
      const sharedProjectId = 'identical-project-id';
      const keyA = buildQueryPersistStorageKey(NAMESPACE_A)!;
      const keyB = buildQueryPersistStorageKey(NAMESPACE_B)!;
      expect(keyA).not.toBe(keyB);

      const listA = ['auth', USER_A, 'projects', 'list', { project: sharedProjectId }] as const;
      const clientA = makeClient();
      seed(clientA, listA, [{ id: sharedProjectId, name: 'user-a-view-of-shared-id' }]);
      const [unsubA, restoredA] = persistQueryClient({
        queryClient: clientA,
        persister: createIdbQueryPersister(keyA, { throttleMs: 0 }),
        buster: QUERY_PERSIST_SCHEMA_VERSION,
        dehydrateOptions: { shouldDehydrateQuery: (q) => shouldDehydratePersistedQuery(q, USER_A) },
      });
      await restoredA;
      seed(clientA, listA, [{ id: sharedProjectId, name: 'user-a-view-of-shared-id' }]);
      await vi.waitFor(async () => expect(await get(keyA)).toBeDefined());
      unsubA();

      const clientB = makeClient();
      const [unsubB, restoredB] = persistQueryClient({
        queryClient: clientB,
        persister: createIdbQueryPersister(keyB, { throttleMs: 0 }),
        buster: QUERY_PERSIST_SCHEMA_VERSION,
      });
      await restoredB;
      unsubB();

      expect(clientB.getQueryCache().getAll()).toHaveLength(0);
      expect(JSON.stringify(clientB.getQueryData(listA) ?? null)).not.toContain(
        'user-a-view-of-shared-id'
      );
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

    it('latches off after a WRITE failure so it stops retrying every cache event', async () => {
      // test-engineer found the `disabled = true` inside flush()'s own catch was
      // never executed: the existing failure test tripped the latch via a READ, so
      // persistClient short-circuited before flush ever ran. This drives the write
      // path directly with a store that only fails on write.
      let writeAttempts = 0;
      const writeOnlyFailingStore = ((_mode: unknown, callback: (store: unknown) => unknown) => {
        // idb-keyval calls the store fn for both get and set; count and reject.
        writeAttempts += 1;
        void callback;
        return Promise.reject(new Error('QuotaExceededError'));
      }) as unknown as UseStore;

      const persister = createIdbQueryPersister('sam-query-cache:v1:user:latch', {
        throttleMs: 0,
        store: writeOnlyFailingStore,
      });

      const snapshot = (n: number) => ({
        timestamp: n,
        buster: QUERY_PERSIST_SCHEMA_VERSION,
        clientState: { mutations: [], queries: [] },
      });

      persister.persistClient(snapshot(1));
      await vi.waitFor(() => expect(writeAttempts).toBeGreaterThan(0));
      const afterFirstFailure = writeAttempts;

      // Every subsequent event must be dropped by the latch, not retried.
      for (let i = 2; i < 8; i += 1) persister.persistClient(snapshot(i));
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(writeAttempts).toBe(afterFirstFailure);
    });

    it('skips an IndexedDB write when the snapshot is unchanged', async () => {
      // persistQueryClientSubscribe re-dehydrates on every cache event app-wide, so
      // unrelated polling (Nodes/Workspaces, 10s) would otherwise write an
      // identical payload every throttle window forever.
      let writes = 0;
      const countingStore = ((mode: unknown, callback: (store: unknown) => unknown) => {
        if (mode === 'readwrite') writes += 1;
        void callback;
        return Promise.resolve();
      }) as unknown as UseStore;

      const persister = createIdbQueryPersister('sam-query-cache:v1:user:dedupe', {
        throttleMs: 0,
        store: countingStore,
      });
      const identical = () => ({
        timestamp: 1,
        buster: QUERY_PERSIST_SCHEMA_VERSION,
        clientState: { mutations: [], queries: [] },
      });

      persister.persistClient(identical());
      await vi.waitFor(() => expect(writes).toBe(1));

      for (let i = 0; i < 5; i += 1) {
        persister.persistClient(identical());
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      expect(writes).toBe(1);
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
