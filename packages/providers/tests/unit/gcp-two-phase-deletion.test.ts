/**
 * GCP two-phase deletion: `requestVMDeletion` sends the DELETE without polling and hands the
 * caller a ticket before anything leaves; `getVMDeletionStatus` reads GCP's own delete operations
 * for that exact instance id. Fixtures mint a fresh Response per call (rule 72).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GcpProvider } from '../../src/gcp';
import { ProviderError } from '../../src/types';

const PROJECT = 'test-project';
const INSTANCE = {
  id: '1861759100528809252',
  name: 'node-01m7c16pwq0k14gykn0y1p016q',
  status: 'RUNNING',
  machineType: 'zones/europe-west1-b/machineTypes/e2-medium',
  zone: 'https://www.googleapis.com/compute/v1/projects/test-project/zones/europe-west1-b',
  creationTimestamp: '2026-11-14T03:22:00Z',
  labels: { 'sam-managed': 'true' },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function notFound(): Response {
  return json({ error: { code: 404, message: 'not found', status: 'NOT_FOUND' } }, 404);
}

function deleteOp(overrides: Record<string, unknown> = {}) {
  return {
    name: 'operation-1',
    operationType: 'delete',
    status: 'DONE',
    targetId: INSTANCE.id,
    ...overrides,
  };
}

type FetchHandler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

function installFetch(handler: FetchHandler) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(new URL(String(input)), init)
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** Instance lookup: the instance lives in europe-west1-b; every other zone is 404. */
function lookupResponse(url: URL): Response | null {
  if (
    url.pathname.endsWith(`/zones/europe-west1-b/instances/${INSTANCE.id}`) ||
    url.pathname.endsWith(`/zones/europe-west1-b/instances/${INSTANCE.name}`)
  ) {
    return json(INSTANCE);
  }
  if (url.pathname.includes('/instances/') && !url.pathname.includes('/operations')) {
    return notFound();
  }
  if (url.pathname.endsWith('/aggregated/instances')) return json({ items: {} });
  return null;
}

describe('GcpProvider two-phase deletion', () => {
  const originalFetch = globalThis.fetch;
  const tokenProvider = vi.fn().mockResolvedValue('test-gcp-token');
  let provider: GcpProvider;

  beforeEach(() => {
    provider = new GcpProvider(PROJECT, tokenProvider, 'us-central1-a');
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('requestVMDeletion', () => {
    it('hands the ticket to beforeSend before the DELETE, sends one DELETE and never polls', async () => {
      const order: string[] = [];
      const fetchMock = installFetch((url, init) => {
        if (init?.method === 'DELETE') {
          order.push('delete');
          return json({ name: 'operation-1', status: 'RUNNING' });
        }
        if (url.pathname.includes('/operations/')) throw new Error('must not poll');
        return lookupResponse(url) ?? notFound();
      });

      const result = await provider.requestVMDeletion(INSTANCE.id, undefined, {
        beforeSend: async (ticket) => {
          order.push('beforeSend');
          expect(JSON.parse(ticket)).toEqual({
            v: 1,
            provider: 'gcp',
            project: PROJECT,
            zone: 'europe-west1-b',
            instanceId: INSTANCE.id,
            instanceName: INSTANCE.name,
          });
        },
      });

      expect(order).toEqual(['beforeSend', 'delete']);
      expect(result.state).toBe('requested');
      const deletes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');
      expect(deletes).toHaveLength(1);
      expect(String(deletes[0]?.[0])).toContain(
        `/projects/${PROJECT}/zones/europe-west1-b/instances/${INSTANCE.name}`
      );
    });

    it('re-reads the instance by numeric id after beforeSend and refuses a renamed instance', async () => {
      let renamed = false;
      const fetchMock = installFetch((url, init) => {
        if (init?.method === 'DELETE') return json({ name: 'operation-1', status: 'RUNNING' });
        if (renamed && url.pathname.endsWith(`/instances/${INSTANCE.id}`)) {
          return json({ ...INSTANCE, name: 'someone-elses-name' });
        }
        return lookupResponse(url) ?? notFound();
      });

      await expect(
        provider.requestVMDeletion(INSTANCE.id, undefined, {
          beforeSend: async () => {
            renamed = true;
          },
        })
      ).rejects.toThrow(/changed identity/);
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
      // The re-read addressed the exact instance by id, not by its (reusable) name.
      expect(
        fetchMock.mock.calls.filter(([u]) =>
          String(u).endsWith(`/zones/europe-west1-b/instances/${INSTANCE.id}`)
        ).length
      ).toBeGreaterThanOrEqual(2);
    });

    it('never reports absent while the instance still resolves by name (id lookup not honoured)', async () => {
      let idUnsupported = false;
      const fetchMock = installFetch((url, init) => {
        if (init?.method === 'DELETE') return json({ name: 'operation-1', status: 'RUNNING' });
        if (idUnsupported && url.pathname.endsWith(`/instances/${INSTANCE.id}`)) return notFound();
        return lookupResponse(url) ?? notFound();
      });

      await expect(
        provider.requestVMDeletion(INSTANCE.id, undefined, {
          beforeSend: async () => {
            idUnsupported = true;
          },
        })
      ).rejects.toThrow(/resolves by name but not by id/);
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    });

    it('reports absent, sending nothing, when the instance is gone by the re-read', async () => {
      let gone = false;
      const fetchMock = installFetch((url, init) => {
        if (init?.method === 'DELETE') return json({ name: 'operation-1', status: 'RUNNING' });
        if (gone) {
          return url.pathname.endsWith('/aggregated/instances') ? json({ items: {} }) : notFound();
        }
        return lookupResponse(url) ?? notFound();
      });

      await expect(
        provider.requestVMDeletion(INSTANCE.id, undefined, {
          beforeSend: async () => {
            gone = true;
          },
        })
      ).resolves.toEqual({ state: 'absent' });
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    });

    it('sends nothing when beforeSend throws', async () => {
      const fetchMock = installFetch((url, init) => {
        if (init?.method === 'DELETE') return json({ name: 'operation-1', status: 'RUNNING' });
        return lookupResponse(url) ?? notFound();
      });

      await expect(
        provider.requestVMDeletion(INSTANCE.id, undefined, {
          beforeSend: async () => {
            throw new Error('write-ahead failed');
          },
        })
      ).rejects.toThrow('write-ahead failed');
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    });

    it('reports absent, with no DELETE and no ticket, when the lookup finds nothing', async () => {
      const beforeSend = vi.fn();
      const fetchMock = installFetch((url) =>
        url.pathname.endsWith('/aggregated/instances') ? json({ items: {} }) : notFound()
      );

      await expect(
        provider.requestVMDeletion(INSTANCE.id, undefined, { beforeSend })
      ).resolves.toEqual({ state: 'absent' });
      expect(beforeSend).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    });

    it('stops before the DELETE once the caller aborts', async () => {
      const controller = new AbortController();
      const fetchMock = installFetch((url, init) => {
        if (init?.method === 'DELETE') return json({ name: 'operation-1', status: 'RUNNING' });
        return lookupResponse(url) ?? notFound();
      });

      await expect(
        provider.requestVMDeletion(
          INSTANCE.id,
          { signal: controller.signal },
          {
            beforeSend: async () => {
              controller.abort(new Error('deadline'));
            },
          }
        )
      ).rejects.toThrow('deadline');
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    });
  });

  describe('getVMDeletionStatus', () => {
    const ticket = JSON.stringify({
      v: 1,
      provider: 'gcp',
      project: PROJECT,
      zone: 'europe-west1-b',
      instanceId: INSTANCE.id,
      instanceName: INSTANCE.name,
    });

    it('queries the zone delete operations filtered to this exact instance id', async () => {
      const fetchMock = installFetch(() => json({ items: [deleteOp()] }));

      await expect(provider.getVMDeletionStatus(ticket)).resolves.toEqual({ state: 'deleted' });
      const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(url.pathname).toBe(`/compute/v1/projects/${PROJECT}/zones/europe-west1-b/operations`);
      expect(url.searchParams.get('filter')).toBe(
        `(operationType = "delete") (targetId = "${INSTANCE.id}")`
      );
    });

    it.each([
      ['in_progress', [deleteOp({ status: 'RUNNING' })], { state: 'in_progress' }],
      ['pending', [deleteOp({ status: 'PENDING' })], { state: 'in_progress' }],
      ['not_requested when GCP has no delete operation', [], { state: 'not_requested' }],
      [
        'deleted when a later attempt succeeded after a failure',
        [
          deleteOp({ name: 'op-a', error: { errors: [{ code: 'INTERNAL', message: 'x' }] } }),
          deleteOp({ name: 'op-b' }),
        ],
        { state: 'deleted' },
      ],
      [
        'failed when every delete failed',
        [deleteOp({ error: { errors: [{ code: 'RESOURCE_IN_USE', message: 'busy' }] } })],
        { state: 'failed', message: 'RESOURCE_IN_USE: busy', providerCode: 'RESOURCE_IN_USE' },
      ],
    ])('%s', async (_name, items, expected) => {
      installFetch(() => json({ items }));
      await expect(provider.getVMDeletionStatus(ticket)).resolves.toEqual(expected);
    });

    it('follows empty filtered pages to the delete operation', async () => {
      const fetchMock = installFetch((url) =>
        url.searchParams.get('pageToken') === 'p2'
          ? json({ items: [deleteOp()] })
          : json({ items: [], nextPageToken: 'p2' })
      );
      await expect(provider.getVMDeletionStatus(ticket)).resolves.toEqual({ state: 'deleted' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('stops at the page that shows the delete, even if more pages follow', async () => {
      const fetchMock = installFetch(() => json({ items: [deleteOp()], nextPageToken: 'more' }));
      await expect(provider.getVMDeletionStatus(ticket)).resolves.toEqual({ state: 'deleted' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('never reads an unfinished page walk as not requested', async () => {
      installFetch(() => json({ items: [], nextPageToken: 'again' }));
      await expect(provider.getVMDeletionStatus(ticket)).rejects.toBeInstanceOf(ProviderError);
    });

    it('ignores operations for another instance even if the server filter returned them', async () => {
      installFetch(() => json({ items: [deleteOp({ targetId: '999' })] }));
      await expect(provider.getVMDeletionStatus(ticket)).resolves.toEqual({
        state: 'not_requested',
      });
    });

    it('ignores non-delete operations for the instance', async () => {
      installFetch(() => json({ items: [deleteOp({ operationType: 'stop' })] }));
      await expect(provider.getVMDeletionStatus(ticket)).resolves.toEqual({
        state: 'not_requested',
      });
    });

    it('answers wrong_scope, without any request, for a ticket from another project', async () => {
      const fetchMock = installFetch(() => json({ items: [deleteOp()] }));
      const other = new GcpProvider('another-project', tokenProvider, 'us-central1-a');
      await expect(other.getVMDeletionStatus(ticket)).resolves.toEqual({ state: 'wrong_scope' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ['not JSON', 'not-json'],
      ['wrong provider', JSON.stringify({ ...JSON.parse(ticket), provider: 'hetzner' })],
      ['zone with a path', JSON.stringify({ ...JSON.parse(ticket), zone: 'a/../b' })],
      ['non-numeric id', JSON.stringify({ ...JSON.parse(ticket), instanceId: '1") OR ("' })],
    ])('rejects a malformed ticket (%s) before any request', async (_name, bad) => {
      const fetchMock = installFetch(() => json({ items: [deleteOp()] }));
      await expect(provider.getVMDeletionStatus(bad)).rejects.toBeInstanceOf(ProviderError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('surfaces an API failure as an error, never as a status', async () => {
      installFetch(() => json({ error: { code: 503, message: 'unavailable' } }, 503));
      await expect(provider.getVMDeletionStatus(ticket)).rejects.toBeInstanceOf(ProviderError);
    });
  });
});
