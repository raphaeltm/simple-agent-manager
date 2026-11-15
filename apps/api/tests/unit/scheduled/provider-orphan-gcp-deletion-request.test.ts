/**
 * GCP orphan deletion through the real sweep entry point (`runProviderOrphanReconciliation`) and
 * the real `GcpProvider`, against a stateful fake of the Compute API.
 *
 * GCP's `deleteVM` polls the delete operation to completion (tens of seconds), which can never
 * fit the sweep's per-request budget; the sweep therefore sends the delete through
 * `requestVMDeletion`, bound to the exact instance its ownership re-read proved, and counts it as
 * requested rather than destroyed. Found on the self-host test box (R16, 2026-11-15): with one
 * 5 s signal for the whole pass, the delete was aborted before it was sent.
 */
import { GcpProvider, type Provider } from '@simple-agent-manager/providers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { log } from '../../../src/lib/logger';
import { runProviderOrphanReconciliation } from '../../../src/scheduled/provider-orphan-reconciliation';
import { persistError } from '../../../src/services/observability';

const providerState = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@simple-agent-manager/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simple-agent-manager/providers')>();
  return { ...actual, createProvider: vi.fn(() => providerState.current as Provider) };
});
vi.mock('../../../src/services/platform-credentials', () => ({
  // Platform resolution reaches createProvider(), which returns the injected real GcpProvider.
  getPlatformCloudCredential: vi.fn().mockResolvedValue({
    decryptedToken: 'provider-credential',
    provider: 'hetzner',
  }),
}));
vi.mock('../../../src/services/provider-credential-codecs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/provider-credential-codecs')>()),
  buildProviderConfig: vi.fn().mockReturnValue({ provider: 'hetzner', apiToken: 'unused' }),
}));
vi.mock('../../../src/lib/secrets', () => ({
  getCredentialEncryptionKey: vi.fn().mockReturnValue('encryption-key'),
}));
vi.mock('../../../src/services/observability', () => ({
  persistError: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/logger')>()),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('drizzle-orm/d1', () => ({ drizzle: vi.fn(() => ({})) }));

const INSTALLATION = '0123456789abcdef0123456789abcdef';
const ZONE = 'europe-west1-b';
const CREATED = '2026-01-01T00:00:00Z';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const notFound = () => json({ error: { code: 404, message: 'not found' } }, 404);

interface FakeInstance {
  id: string;
  name: string;
  status: string;
  machineType: string;
  zone: string;
  creationTimestamp: string;
  labels: Record<string, string>;
}

function nodeId(n: number): string {
  return `01kx84mcg1yn1tqvwr60b3g${String(n).padStart(3, '0')}`;
}

function ownedInstance(n: number): FakeInstance {
  return {
    id: `9876543210123456${String(n).padStart(3, '0')}`,
    name: `vm-owned-${n}`,
    status: 'TERMINATED',
    machineType: `zones/${ZONE}/machineTypes/e2-micro`,
    zone: `https://www.googleapis.com/compute/v1/projects/project/zones/${ZONE}`,
    creationTimestamp: CREATED,
    labels: {
      'sam-managed': 'true',
      managed: 'simple-agent-manager',
      env: 'production',
      installation: INSTALLATION,
      node: nodeId(n),
      role: 'workspace',
    },
  };
}

interface FakeGcpOptions {
  /** DELETE removes the instance (deletion finished) unless false (still deleting). */
  deleteCompletes?: boolean;
  /** Milliseconds each response waits, honouring the request's abort signal. */
  latency?: { list?: number; get?: number };
  /** Extra milliseconds a GET of this instance id waits (a slow or hung provider read). */
  slowIds?: Record<string, number>;
  /** Rewrite the instance a GET returns (models a change between selection and re-read). */
  onGet?: (instance: FakeInstance, getCount: number) => FakeInstance | null;
}

function waitFor(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    });
  });
}

/** A stateful Compute API: aggregated list, zonal GET by id or name, DELETE by name. */
function installFakeGcp(instances: FakeInstance[], options: FakeGcpOptions = {}) {
  const store = new Map(instances.map((instance) => [instance.id, instance]));
  const gets = new Map<string, number>();
  const deletes: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.pathname.includes('/operations/')) throw new Error('the sweep must not poll');
    if (url.pathname.endsWith('/aggregated/instances')) {
      await waitFor(options.latency?.list ?? 0, init?.signal);
      return json({ items: { [`zones/${ZONE}`]: { instances: [...store.values()] } } });
    }
    const match = url.pathname.match(/\/zones\/([^/]+)\/instances\/([^/]+)$/);
    if (!match) return json({ error: { message: `unexpected ${method} ${url}` } }, 500);
    const [, zone, key] = match;
    const found = [...store.values()].find((i) => i.id === key || i.name === key);
    if (method === 'DELETE') {
      if (!found || zone !== ZONE) return notFound();
      deletes.push(found.name);
      if (options.deleteCompletes !== false) store.delete(found.id);
      return json({ name: `op-${found.id}`, status: 'RUNNING' });
    }
    await waitFor(options.latency?.get ?? 0, init?.signal);
    if (!found || zone !== ZONE) return notFound();
    await waitFor(options.slowIds?.[found.id] ?? 0, init?.signal);
    const count = (gets.get(found.id) ?? 0) + 1;
    gets.set(found.id, count);
    const returned = options.onGet ? options.onGet(found, count) : found;
    if (!returned) {
      store.delete(found.id);
      return notFound();
    }
    return json(returned);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  providerState.current = new GcpProvider('project', async () => 'token', 'us-central1-a');
  return { store, deletes, fetchMock };
}

/** D1 claim lookups: every requested node has no row. Enforces D1's 100-bind ceiling. */
const claimStatements: number[] = [];
function env(overrides: Record<string, string> = {}): Env {
  return {
    ENVIRONMENT: 'production',
    SAM_INSTALLATION_ID: INSTALLATION,
    // No interval marker is ever stored, so every call is an eligible pass.
    KV: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) },
    DATABASE: {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...requestedIds: string[]) => {
          if (requestedIds.length > 100) throw new Error('D1: too many SQL variables');
          if (sql.includes('WITH requested')) claimStatements.push(requestedIds.length);
          return {
            all: vi.fn().mockResolvedValue({
              success: true,
              results: requestedIds.map((requestedId) => ({
                requested_id: requestedId,
                id: null,
                status: null,
                provider_instance_id: null,
              })),
            }),
          };
        }),
      })),
    },
    OBSERVABILITY_DATABASE: {},
    ...overrides,
  } as unknown as Env;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  claimStatements.length = 0;
  vi.mocked(persistError).mockClear();
  vi.mocked(log.error).mockClear();
  vi.mocked(log.info).mockClear();
  vi.mocked(log.warn).mockClear();
});

describe('GCP orphan deletion request — real sweep entry point, real GcpProvider', () => {
  it('requests deletion of a proven orphan, counts it as requested (not destroyed), never polls', async () => {
    const { deletes } = installFakeGcp([ownedInstance(1)]);

    const result = await runProviderOrphanReconciliation(env());

    expect(result).toMatchObject({ deletionRequested: 1, destroyed: 0, errors: 0 });
    expect(deletes).toEqual(['vm-owned-1']);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'provider_orphan.deletion_requested',
      expect.objectContaining({ location: ZONE })
    );
    expect(vi.mocked(persistError)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(persistError).mock.calls[0]?.[1]).toMatchObject({
      message: 'Requested deletion of provider server that no live node row claimed',
      context: { deletion: 'requested', nodeId: nodeId(1) },
    });
  });

  it('INCIDENT (box R16 11:10): list + re-read + delete together exceed one request timeout, each fits alone', async () => {
    // One 5 s signal for the whole pass aborted the delete before it was sent. Scaled down:
    // a 300 ms request timeout; list 160 ms; each zonal GET 30 ms. The re-read walks to the
    // instance's zone (4th GCP_LOCATIONS entry, as on the box): 4 GETs, 120 ms. The delete reads
    // that zone directly and re-checks by id: 2 GETs, 60 ms. Each call fits; together they don't.
    const { deletes } = installFakeGcp([ownedInstance(1)], { latency: { list: 160, get: 30 } });

    const started = Date.now();
    const result = await runProviderOrphanReconciliation(
      env({ NODE_STOPPED_HANDOFF_REQUEST_TIMEOUT_MS: '300' })
    );

    // Precondition: the pass really took longer than one request timeout.
    expect(Date.now() - started).toBeGreaterThan(300);
    expect(result).toMatchObject({ deletionRequested: 1, errors: 0 });
    expect(deletes).toEqual(['vm-owned-1']);
  });

  it.each([
    [
      'node label changed',
      (i: FakeInstance) => ({ ...i, labels: { ...i.labels, node: nodeId(77) } }),
      'skippedAmbiguousOwnership',
    ],
    [
      'creation time changed',
      (i: FakeInstance) => ({ ...i, creationTimestamp: '2026-02-01T00:00:00Z' }),
      'skippedAmbiguousOwnership',
    ],
    [
      'installation label changed',
      (i: FakeInstance) => ({
        ...i,
        labels: { ...i.labels, installation: 'fedcba9876543210fedcba9876543210' },
      }),
      'skippedForeignInstallation',
    ],
  ] as const)(
    'sends nothing when the identity changed between selection and re-read (%s)',
    async (_, change, counter) => {
      const { deletes } = installFakeGcp([ownedInstance(1)], { onGet: (i) => change(i) });

      const result = await runProviderOrphanReconciliation(env());

      expect(deletes).toEqual([]);
      expect(result).toMatchObject({ deletionRequested: 0, destroyed: 0, [counter]: 1 });
      // Liveness: the candidate was selected and re-read; the refusal is what stopped it.
      expect(result.scanned).toBe(1);
    }
  );

  it('takes at most the destroy limit per pass and finishes the rest on the next pass, each once', async () => {
    const instances = [1, 2, 3, 4, 5, 6, 7].map(ownedInstance);
    const { deletes, store } = installFakeGcp(instances);

    const first = await runProviderOrphanReconciliation(env());
    expect(first).toMatchObject({ scanned: 7, deletionRequested: 5, errors: 0 });
    expect(deletes).toHaveLength(5);
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      'provider_orphan.destroy_limit_reached',
      expect.objectContaining({ destroyLimit: 5, remaining: 2 })
    );
    expect(store.size).toBe(2);

    const second = await runProviderOrphanReconciliation(env());
    expect(second).toMatchObject({ scanned: 2, deletionRequested: 2, errors: 0 });
    expect(new Set(deletes).size).toBe(7);
    expect(deletes).toHaveLength(7);
    expect(store.size).toBe(0);
  });

  it('starts no candidate after the sweep budget and leaves them for the next pass', async () => {
    const { deletes } = installFakeGcp([ownedInstance(1), ownedInstance(2)], {
      latency: { list: 20 },
    });

    const starved = await runProviderOrphanReconciliation(
      env({ NODE_STOPPED_HANDOFF_SWEEP_BUDGET_MS: '1' })
    );
    expect(starved).toMatchObject({ scanned: 2, deletionRequested: 0, destroyed: 0, errors: 0 });
    expect(deletes).toEqual([]);
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      'provider_orphan.sweep_budget_reached',
      expect.objectContaining({ remaining: 2 })
    );

    const next = await runProviderOrphanReconciliation(env());
    expect(next).toMatchObject({ deletionRequested: 2, errors: 0 });
    expect(deletes.sort()).toEqual(['vm-owned-1', 'vm-owned-2']);
  });

  it('next pass, instance still present (delete in progress or failed): requested again, no error', async () => {
    const { deletes } = installFakeGcp([ownedInstance(1)], { deleteCompletes: false });

    const first = await runProviderOrphanReconciliation(env());
    const second = await runProviderOrphanReconciliation(env());

    expect(first).toMatchObject({ deletionRequested: 1, errors: 0 });
    expect(second).toMatchObject({ deletionRequested: 1, errors: 0 });
    expect(deletes).toEqual(['vm-owned-1', 'vm-owned-1']);
  });

  it('instance gone between the re-read and the delete: nothing sent, not counted, no error', async () => {
    // The ownership re-read sees the instance; it is gone by the deletion's own lookup.
    const { deletes } = installFakeGcp([ownedInstance(1)], {
      onGet: (i, count) => (count === 1 ? i : null),
    });

    const result = await runProviderOrphanReconciliation(env());

    expect(deletes).toEqual([]);
    expect(result).toMatchObject({ deletionRequested: 0, destroyed: 0, errors: 0 });
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      'provider_orphan.already_absent',
      expect.objectContaining({ nodeId: nodeId(1) })
    );
    expect(vi.mocked(persistError)).not.toHaveBeenCalled();
  });

  it('next pass, instance already gone: not listed, nothing sent, no error', async () => {
    const { deletes } = installFakeGcp([ownedInstance(1)]);

    await runProviderOrphanReconciliation(env());
    const second = await runProviderOrphanReconciliation(env());

    expect(second).toMatchObject({ scanned: 0, deletionRequested: 0, errors: 0 });
    expect(deletes).toEqual(['vm-owned-1']);
  });

  it.each([
    [
      'an ownership label changed',
      (i: FakeInstance) => ({ ...i, labels: { ...i.labels, installation: 'f'.repeat(32) } }),
    ],
    [
      'a different instance id answered',
      (i: FakeInstance) => ({ ...i, id: '1112223334445556667' }),
    ],
  ] as const)(
    'binds the delete to the re-read: sends nothing when, by the delete itself, %s',
    async (_, change) => {
      // GET 1 is the ownership re-read; GET 2+ are the deletion's own reads in the proven zone.
      const { deletes } = installFakeGcp([ownedInstance(1)], {
        onGet: (i, count) => (count === 1 ? i : change(i)),
      });

      const result = await runProviderOrphanReconciliation(env());

      expect(deletes).toEqual([]);
      expect(result).toMatchObject({ deletionRequested: 0, destroyed: 0, errors: 1 });
      expect(vi.mocked(log.error)).toHaveBeenCalledWith(
        'provider_orphan.destroy_failed',
        expect.objectContaining({ error: expect.stringMatching(/refusing to delete it/) })
      );
      expect(vi.mocked(persistError)).not.toHaveBeenCalled();
    }
  );

  it('refuses a re-read that reports no zone instead of binding the delete by id alone', async () => {
    const withoutZone: Partial<FakeInstance> = ownedInstance(1);
    delete withoutZone.zone;
    const { deletes } = installFakeGcp([withoutZone as FakeInstance]);

    const result = await runProviderOrphanReconciliation(env());

    expect(deletes).toEqual([]);
    expect(result).toMatchObject({
      scanned: 1,
      skippedAmbiguousOwnership: 1,
      deletionRequested: 0,
    });
    expect(vi.mocked(log.warn)).not.toHaveBeenCalledWith(
      'provider_orphan.destroying',
      expect.anything()
    );
  });

  it('looks up a backlog above the D1 bind limit in batches and still deletes up to the limit', async () => {
    const instances = Array.from({ length: 105 }, (_, n) => ownedInstance(n + 1));
    const { deletes } = installFakeGcp(instances);

    const result = await runProviderOrphanReconciliation(env());

    expect(claimStatements).toEqual([100, 5]);
    expect(result).toMatchObject({ scanned: 105, deletionRequested: 5, errors: 0 });
    expect(deletes).toHaveLength(5);
  });

  it('a hung re-read costs one request timeout, not the pass: the next candidate is still deleted', async () => {
    const first = ownedInstance(1);
    const { deletes } = installFakeGcp([first, ownedInstance(2)], {
      slowIds: { [first.id]: 2_000 },
    });

    const result = await runProviderOrphanReconciliation(
      env({ NODE_STOPPED_HANDOFF_REQUEST_TIMEOUT_MS: '150' })
    );

    expect(result).toMatchObject({ deletionRequested: 1, errors: 1 });
    expect(deletes).toEqual(['vm-owned-2']);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'provider_orphan.final_ownership_unavailable',
      expect.anything()
    );
  });

  it('stops starting candidates when the sweep budget runs out mid-pass', async () => {
    // Budget 250 ms. Candidate 1 starts at ~20 ms and takes ~360 ms (6 GETs at 60 ms); by then
    // the budget is spent, so candidates 2 and 3 are not started.
    const { deletes } = installFakeGcp([1, 2, 3].map(ownedInstance), {
      latency: { list: 20, get: 60 },
    });

    const result = await runProviderOrphanReconciliation(
      env({ NODE_STOPPED_HANDOFF_SWEEP_BUDGET_MS: '250' })
    );

    expect(result).toMatchObject({ scanned: 3, deletionRequested: 1, errors: 0 });
    expect(deletes).toEqual(['vm-owned-1']);
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      'provider_orphan.sweep_budget_reached',
      expect.objectContaining({ remaining: 2 })
    );
  });
});
