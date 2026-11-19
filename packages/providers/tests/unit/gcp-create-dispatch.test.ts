/**
 * GCP createVM proves when it never sent the insert. A durable allocation records "a create may
 * exist" before createVM and afterwards only reconciles; an error from the token exchange or
 * firewall ensure must therefore say no VM was requested, or the intent can never create again.
 * Errors from the insert itself (and later) must stay uncertain.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isProviderCreateNotDispatched } from '../../src';
import { GcpProvider } from '../../src/gcp';

const API = 'https://compute.googleapis.com/compute/v1/projects/test-project';
const ZONE = 'europe-west1-b';

interface Fake {
  firewallPostStatus?: number;
  insertStatus?: number;
}

function installFakeCompute(fake: Fake) {
  const requests: string[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const target = String(url);
    const method = init.method ?? 'GET';
    requests.push(`${method} ${target}`);
    const fail = (status: number) =>
      new Response(JSON.stringify({ error: { code: status, message: `HTTP ${status}` } }), {
        status,
      });
    if (target.endsWith('/global/firewalls') && method === 'POST') {
      return fail(fake.firewallPostStatus ?? 409);
    }
    if (target === `${API}/zones/${ZONE}/instances` && method === 'POST') {
      return fake.insertStatus
        ? fail(fake.insertStatus)
        : new Response(JSON.stringify({ name: 'op', status: 'DONE' }));
    }
    return fail(404);
  }) as typeof fetch;
  return requests;
}

function createWith(tokenProvider = vi.fn().mockResolvedValue('token')) {
  return new GcpProvider('test-project', tokenProvider, ZONE).createVM({
    name: 'node-gcp',
    size: 'large',
    location: ZONE,
    userData: '#cloud-config',
    instanceType: 'e2-standard-4',
  });
}

async function thrown(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected createVM to throw');
}

describe('GCP createVM create-dispatch proof', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('marks a token exchange failure as not dispatched, with no request sent', async () => {
    const requests = installFakeCompute({});
    const err = await thrown(createWith(vi.fn().mockRejectedValue(new Error('sts 503'))));
    expect(isProviderCreateNotDispatched(err)).toBe(true);
    expect(requests.some((r) => r.startsWith('POST') && r.endsWith('/instances'))).toBe(false);
  });

  it('marks a firewall ensure failure as not dispatched, before any insert', async () => {
    const requests = installFakeCompute({ firewallPostStatus: 403 });
    const err = await thrown(createWith());
    expect(isProviderCreateNotDispatched(err)).toBe(true);
    // Liveness: the firewall request really ran and failed.
    expect(requests.some((r) => r === `POST ${API}/global/firewalls`)).toBe(true);
    expect(requests.some((r) => r === `POST ${API}/zones/${ZONE}/instances`)).toBe(false);
  });

  it('leaves an insert failure uncertain: the request was sent', async () => {
    const requests = installFakeCompute({ insertStatus: 503 });
    const err = await thrown(createWith());
    expect(requests).toContain(`POST ${API}/zones/${ZONE}/instances`);
    expect(isProviderCreateNotDispatched(err)).toBe(false);
  });

  it('leaves a failure after the insert uncertain (operation and instance reads)', async () => {
    installFakeCompute({});
    // The insert succeeds; the follow-up instance read 404s in this fake.
    const err = await thrown(createWith());
    expect(isProviderCreateNotDispatched(err)).toBe(false);
  });
});
