import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { log } from '../../../src/lib/logger';
import {
  cleanupAppRouteDNSRecords,
  createNodeBackendDNSRecord,
  deleteAppRouteDNSRecord,
  upsertAppRouteDNSRecord,
} from '../../../src/services/dns';

function env() {
  return {
    CF_API_TOKEN: 'cf-token',
    CF_ZONE_ID: 'zone-1',
    DNS_TTL_SECONDS: '120',
    BASE_DOMAIN: 'example.com',
  } as any;
}

/**
 * A fake Cloudflare DNS zone keyed by record name.
 *
 * Shared by the two fan-out tests so the interleaving decides the winner rather than a
 * pre-scripted call sequence. Both differ only in their seed and in one lookup hook, so
 * factoring this out makes that difference visible instead of burying it in two
 * near-identical 40-line mocks.
 *
 * `onLookup` models a stale read: returning `[]` once for a name that IS in the store
 * reproduces "the record existed by create-time but not at lookup-time", which is the exact
 * TOCTOU window the tolerance exists for.
 */
type FakeRecord = { id: string; name: string; type: string; content: string };

function fakeCloudflareZone(options?: {
  seed?: FakeRecord[];
  idPrefix?: string;
  onLookup?: (name: string) => FakeRecord[] | null;
}) {
  const store = new Map<string, FakeRecord>();
  for (const record of options?.seed ?? []) store.set(record.name, record);
  const prefix = options?.idPrefix ?? 'dns';
  let nextId = 1;

  const fetchMock = vi.fn(async (url: any, init: any) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    // Yield so concurrent callers genuinely interleave across the await boundary.
    await Promise.resolve();

    if (method === 'GET') {
      const name = u.searchParams.get('name')!;
      const override = options?.onLookup?.(name);
      if (override) return new Response(JSON.stringify({ result: override }), { status: 200 });
      const hit = store.get(name);
      return new Response(JSON.stringify({ result: hit ? [hit] : [] }), { status: 200 });
    }

    if (method === 'POST') {
      const body = JSON.parse(init.body);
      if (store.has(body.name)) {
        // Cloudflare enforces uniqueness; the loser gets 81058.
        return new Response(
          JSON.stringify({ errors: [{ code: 81058, message: 'An identical record already exists.' }] }),
          { status: 400 }
        );
      }
      const rec = { id: `${prefix}-${nextId++}`, name: body.name, type: 'A', content: body.content };
      store.set(body.name, rec);
      return new Response(JSON.stringify({ result: { id: rec.id } }), { status: 200 });
    }

    if (method === 'PUT') {
      // Route by record id, not a catch-all, so a future third case cannot silently pass by
      // matching the wrong record.
      const id = u.pathname.split('/').pop()!;
      const rec = [...store.values()].find((r) => r.id === id);
      if (!rec) {
        return new Response(
          JSON.stringify({ errors: [{ code: 81044, message: 'Record not found.' }] }),
          { status: 404 }
        );
      }
      rec.content = JSON.parse(init.body).content;
      return new Response(JSON.stringify({ result: { id: rec.id } }), { status: 200 });
    }
    throw new Error(`unexpected method ${method}`);
  });

  return { store, fetchMock };
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('upsertAppRouteDNSRecord', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates grey-cloud A records for HTTP-01 ACME', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { id: 'dns-new' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(upsertAppRouteDNSRecord('r1-web.apps.example.com', '203.0.113.10', env()))
      .resolves.toBe('dns-new');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, createInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(createInit.body)).toEqual({
      type: 'A',
      name: 'r1-web.apps.example.com',
      content: '203.0.113.10',
      ttl: 120,
      proxied: false,
    });
  });

  it('updates existing app route records idempotently', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: [{ id: 'dns-existing', name: 'r1-web.apps.example.com', type: 'A', content: '198.51.100.2', proxied: false }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { id: 'dns-existing' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(upsertAppRouteDNSRecord('r1-web.apps.example.com', '203.0.113.10', env()))
      .resolves.toBe('dns-existing');

    const [url, updateInit] = fetchMock.mock.calls[1]!;
    expect(String(url)).toContain('/dns_records/dns-existing');
    expect(updateInit.method).toBe('PUT');
    expect(JSON.parse(updateInit.body)).toMatchObject({
      content: '203.0.113.10',
      proxied: false,
    });
  });

  // Regression: production wedge originally found on the DefangLabs install
  // 2026-09-05, and confirmed reachable on this install (sam-prod
  // deployment_release_events shows `deployment.apply.fetch_started` at exactly
  // 2x `deployment.apply.started`). Two overlapping
  // GET /api/nodes/:id/deploy-release requests each run the whole handler, which
  // upserts every route via Promise.all. Both observed "no record", both POSTed,
  // and Cloudflare rejected the loser with 81058 "An identical record already
  // exists." That threw, 500'd the release fetch, and the node never received its
  // payload — so the deployment stalled before any DNS/cert work.
  describe('concurrent create race (Cloudflare duplicate-record codes)', () => {
    for (const code of [81057, 81058]) {
      it(`recovers when a concurrent caller wins the create (code ${code})`, async () => {
        const fetchMock = vi.fn()
          // 1. our lookup: nothing yet
          .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
          // 2. our create: the other caller got there first
          .mockResolvedValueOnce(new Response(JSON.stringify({
            errors: [{ code, message: 'An identical record already exists.' }],
          }), { status: 400 }))
          // 3. re-resolve: now we can see the winner's record
          .mockResolvedValueOnce(new Response(JSON.stringify({
            result: [{ id: 'dns-winner', name: 'r1-web.apps.example.com', type: 'A', content: '203.0.113.10', proxied: false }],
          }), { status: 200 }))
          // 4. update it in place
          .mockResolvedValueOnce(new Response(JSON.stringify({ result: { id: 'dns-winner' } }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(upsertAppRouteDNSRecord('r1-web.apps.example.com', '203.0.113.10', env()))
          .resolves.toBe('dns-winner');

        expect(fetchMock).toHaveBeenCalledTimes(4);
        const [retryUrl, retryInit] = fetchMock.mock.calls[3]!;
        expect(String(retryUrl)).toContain('/dns_records/dns-winner');
        expect(retryInit.method).toBe('PUT');
        expect(JSON.parse(retryInit.body)).toMatchObject({
          type: 'A',
          content: '203.0.113.10',
          proxied: false,
        });
      });
    }

    // The sibling asymmetry, deliberately resolved the other way. The node-backend
    // conflict lookup uses `requireUnique` and lets an ambiguous zone surface the
    // original conflict, because it resolves an id the caller PERSISTS. Here nothing
    // is persisted and this upsert gates a node's whole release fetch, so failing it
    // would reinstate the 500-wedge this function exists to remove. It converges the
    // first match and records the anomaly instead (rule 75 §1 vs §8).
    it('converges the first match and records the anomaly when the zone holds several', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          result: [
            { id: 'dns-current', name: 'r1-web.apps.example.com', type: 'A', content: '203.0.113.10', proxied: false },
            { id: 'dns-stale-migration', name: 'r1-web.apps.example.com', type: 'A', content: '198.51.100.7', proxied: false },
          ],
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ result: { id: 'dns-current' } }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      // Liveness: the upsert still succeeds, which is the whole point — a stale
      // sibling record must not wedge the deployment.
      await expect(upsertAppRouteDNSRecord('r1-web.apps.example.com', '203.0.113.10', env()))
        .resolves.toBe('dns-current');
      expect(fetchMock.mock.calls[1]![1].method).toBe('PUT');

      // And the anomaly is recorded with both record ids so the stale one is findable.
      expect(warnSpy).toHaveBeenCalledWith(
        'dns.app_route_ambiguous_records',
        expect.objectContaining({
          hostname: 'r1-web.apps.example.com',
          matchCount: 2,
          recordIds: ['dns-current', 'dns-stale-migration'],
        })
      );
    });

    // Control: a single match must NOT log the anomaly, or the warning is noise.
    it('does not record an anomaly for the ordinary single-record case', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          result: [{ id: 'dns-only', name: 'r1-web.apps.example.com', type: 'A', content: '198.51.100.2', proxied: false }],
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ result: { id: 'dns-only' } }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(upsertAppRouteDNSRecord('r1-web.apps.example.com', '203.0.113.10', env()))
        .resolves.toBe('dns-only');
      expect(warnSpy).not.toHaveBeenCalledWith('dns.app_route_ambiguous_records', expect.anything());
    });

    // Discriminating control for the `!existing` guard specifically. Without this,
    // deleting `!existing &&` from the predicate — a one-token diff that widens the
    // tolerance to the update path — leaves the whole suite green. Rule 75 §4 makes
    // create-path-only a hard requirement; this is what enforces it.
    it('does NOT retry when the UPDATE path returns a duplicate code', async () => {
      const fetchMock = vi.fn()
        // lookup finds an existing record, so this is the PUT path
        .mockResolvedValueOnce(new Response(JSON.stringify({
          result: [{ id: 'dns-existing', name: 'r1-web.apps.example.com', type: 'A', content: '198.51.100.2', proxied: false }],
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          errors: [{ code: 81058, message: 'An identical record already exists.' }],
        }), { status: 400 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(upsertAppRouteDNSRecord('r1-web.apps.example.com', '203.0.113.10', env()))
        .rejects.toThrow('An identical record already exists.');

      // Exactly one lookup + one PUT. A third call would mean the update path retried.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]![1].method).toBe('PUT');
    });

    // Discriminating control: a different-type collision is a real
    // misconfiguration. Retrying cannot fix it, so it must still surface.
    it('still throws on a different-type collision (81053), which retrying cannot fix', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          errors: [{ code: 81053, message: 'An A, AAAA, or CNAME record with that host already exists.' }],
        }), { status: 400 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(upsertAppRouteDNSRecord('r1-web.apps.example.com', '203.0.113.10', env()))
        .rejects.toThrow('An A, AAAA, or CNAME record with that host already exists.');

      // No retry attempted.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    // Discriminating control: unrelated failures must not be swallowed.
    it('still throws on an unrelated create failure (auth error)', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          errors: [{ code: 10000, message: 'Authentication error' }],
        }), { status: 403 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(upsertAppRouteDNSRecord('r1-web.apps.example.com', '203.0.113.10', env()))
        .rejects.toThrow('Authentication error');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    // Regression: `code` is parsed as unknown, not `v.optional(v.number())`.
    // Valibot's optional() only bypasses a missing key, so a null/stringified code
    // would fail the whole error entry, get swallowed by the parse catch, and
    // replace Cloudflare's real message with a generic fallback — degrading errors
    // for every caller of readCloudflareError, not just this one.
    for (const [label, code] of [['null', null], ['stringified', '81058']] as const) {
      it(`preserves the real Cloudflare message when code is ${label}`, async () => {
        const fetchMock = vi.fn()
          .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
          .mockResolvedValueOnce(new Response(JSON.stringify({
            errors: [{ code, message: 'Rate limited by Cloudflare' }],
          }), { status: 429 }));
        vi.stubGlobal('fetch', fetchMock);

        // Real message survives, and a non-numeric code is never treated as retryable.
        await expect(upsertAppRouteDNSRecord('r1-web.apps.example.com', '203.0.113.10', env()))
          .rejects.toThrow('Rate limited by Cloudflare');
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
    }

    // Bounded: a record that keeps duplicating must not loop forever.
    it('retries at most once, then surfaces the duplicate error', async () => {
      const duplicate = () => new Response(JSON.stringify({
        errors: [{ code: 81058, message: 'An identical record already exists.' }],
      }), { status: 400 });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
        .mockResolvedValueOnce(duplicate())
        // re-resolve still sees nothing (winner deleted it again)
        .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
        .mockResolvedValueOnce(duplicate());
      vi.stubGlobal('fetch', fetchMock);

      await expect(upsertAppRouteDNSRecord('r1-web.apps.example.com', '203.0.113.10', env()))
        .rejects.toThrow('An identical record already exists.');

      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    // The real incident shape: two overlapping deploy-release handler invocations
    // upsert the SAME hostname concurrently. Driven against a shared fake CF record
    // store rather than a pre-scripted call sequence, so the interleaving — not the
    // script — decides who wins, and both callers must converge on one record id.
    it('two concurrent callers for the SAME hostname converge on one record', async () => {
      const HOST = 'r1-web.apps.example.com';
      const { store, fetchMock } = fakeCloudflareZone();
      vi.stubGlobal('fetch', fetchMock);

      const ids = await Promise.all([
        upsertAppRouteDNSRecord(HOST, '203.0.113.10', env()),
        upsertAppRouteDNSRecord(HOST, '203.0.113.10', env()),
      ]);

      // Neither call threw, both agree on the single record, and exactly one exists.
      expect(ids[0]).toBe(ids[1]);
      expect(store.size).toBe(1);
      expect(store.get(HOST)!.content).toBe('203.0.113.10');
    });

    // The Promise.all fan-out over DIFFERENT hostnames, as deploy-release-callback
    // does it: one member losing the race must not reject the batch that gates the
    // node's release payload.
    it('a losing route does not fail the Promise.all batch that gates the release fetch', async () => {
      const WINNER: FakeRecord = {
        id: 'dns-b-winner',
        name: 'r2-api.apps.example.com',
        type: 'A',
        content: '203.0.113.10',
      };
      // r2 is already claimed by a concurrent caller, but our FIRST lookup for it races ahead
      // of that write, so our caller believes it is absent and takes the create path.
      const stale = new Set<string>();
      const { fetchMock } = fakeCloudflareZone({
        seed: [WINNER],
        idPrefix: 'dns-a',
        onLookup: (name) => {
          if (name === WINNER.name && !stale.has(name)) {
            stale.add(name);
            return [];
          }
          return null;
        },
      });
      vi.stubGlobal('fetch', fetchMock);

      const ids = await Promise.all([
        upsertAppRouteDNSRecord('r1-web.apps.example.com', '203.0.113.10', env()),
        upsertAppRouteDNSRecord(WINNER.name, '203.0.113.10', env()),
      ]);

      expect(ids[0]).toBe('dns-a-1');
      expect(ids[1]).toBe(WINNER.id);
    });
  });
});

describe('deleteAppRouteDNSRecord', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('finds the record by name and deletes it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: [{ id: 'dns-1', name: 'r1-web.apps.example.com', type: 'A' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteAppRouteDNSRecord('r1-web.apps.example.com', env())).resolves.toBe(true);

    const [deleteUrl, deleteInit] = fetchMock.mock.calls[1]!;
    expect(String(deleteUrl)).toContain('/dns_records/dns-1');
    expect(deleteInit.method).toBe('DELETE');
  });

  it('is a no-op when no matching record exists', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteAppRouteDNSRecord('r1-web.apps.example.com', env())).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tolerates a record deleted concurrently (404 on delete)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: [{ id: 'dns-gone', name: 'r1-web.apps.example.com', type: 'A' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteAppRouteDNSRecord('r1-web.apps.example.com', env())).resolves.toBe(true);
  });
});

describe('cleanupAppRouteDNSRecords', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('deletes every matching record and returns the count actually removed', async () => {
    const fetchMock = vi.fn()
      // hostname 1: found + deleted
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: [{ id: 'dns-1', name: 'r1-web-3000-env.apps.example.com', type: 'A' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      // hostname 2: not found (no-op)
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const deleted = await cleanupAppRouteDNSRecords(
      ['r1-web-3000-env.apps.example.com', 'r2-api-8081-env.apps.example.com'],
      env(),
    );

    expect(deleted).toBe(1);
  });

  it('skips a failing record and continues deleting the rest', async () => {
    const fetchMock = vi.fn()
      // hostname 1: search fails -> error swallowed, count unaffected
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      // hostname 2: found + deleted
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: [{ id: 'dns-2', name: 'r2-api-8081-env.apps.example.com', type: 'A' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const deleted = await cleanupAppRouteDNSRecords(
      ['r1-web-3000-env.apps.example.com', 'r2-api-8081-env.apps.example.com'],
      env(),
    );

    expect(deleted).toBe(1);
  });

  it('returns zero for an empty hostname list without touching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(cleanupAppRouteDNSRecords([], env())).resolves.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// The sibling create in the same module (rule 75 §6). Two paths create this record —
// node provisioning (services/node-provisioning.ts) and the heartbeat backfill
// (routes/node-lifecycle.ts) — and the loser's failure mode is worse than the app-route
// one was: node-lifecycle.ts only stamps nodes.error_message and leaves
// backend_dns_record_id NULL, so every later heartbeat retries the same losing POST
// forever, and node deletion (which deletes by that id) orphans the real record.
describe('createNodeBackendDNSRecord', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const WINNER = {
    id: 'dns-winner',
    name: 'node-1.vm.example.com',
    type: 'A',
    content: '203.0.113.10',
    proxied: true,
  };

  it('creates the orange-clouded backend record on the happy path', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { id: 'dns-node' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createNodeBackendDNSRecord('NODE-1', '203.0.113.10', env())).resolves.toBe('dns-node');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({
      type: 'A',
      name: 'node-1.vm',
      proxied: true,
    });
  });

  it('resolves the winner when a concurrent caller already created it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errors: [{ code: 81058, message: 'An identical record already exists.' }],
      }), { status: 400 }))
      // lookup by the full backend hostname finds the winner, same IP
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: [WINNER] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    // Returning the id is what lets the caller persist backend_dns_record_id,
    // which is what stops the forever-retry and the delete-time orphan.
    await expect(createNodeBackendDNSRecord('NODE-1', '203.0.113.10', env())).resolves.toBe('dns-winner');
    expect(String(fetchMock.mock.calls[1]![0])).toContain('name=node-1.vm.example.com');
    // Content already matches, so no corrective PATCH.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('converges the IP when the winning record points elsewhere (81057)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errors: [{ code: 81057, message: 'Record already exists.' }],
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: [{ ...WINNER, id: 'dns-stale', content: '198.51.100.9' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { id: 'dns-stale' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createNodeBackendDNSRecord('NODE-1', '203.0.113.10', env())).resolves.toBe('dns-stale');
    const [updateUrl, updateInit] = fetchMock.mock.calls[2]!;
    expect(String(updateUrl)).toContain('/dns_records/dns-stale');
    expect(JSON.parse(updateInit.body)).toMatchObject({ content: '203.0.113.10' });
  });

  // Control: an unrelated failure must still surface, with no lookup attempted.
  it('still throws on an unrelated create failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errors: [{ code: 10000, message: 'Authentication error' }],
      }), { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createNodeBackendDNSRecord('NODE-1', '203.0.113.10', env()))
      .rejects.toThrow('Authentication error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Control: 81053 is a different-type collision, not a lost race. Retrying cannot
  // fix it, so it must surface with no lookup attempted.
  it('still throws on a different-type collision (81053)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errors: [{ code: 81053, message: 'An A, AAAA, or CNAME record with that host already exists.' }],
      }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createNodeBackendDNSRecord('NODE-1', '203.0.113.10', env()))
      .rejects.toThrow('An A, AAAA, or CNAME record with that host already exists.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // A failed lookup must not mask the original conflict with a confusing error.
  it('surfaces the original conflict when the winner cannot be resolved', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errors: [{ code: 81058, message: 'An identical record already exists.' }],
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createNodeBackendDNSRecord('NODE-1', '203.0.113.10', env()))
      .rejects.toThrow('An identical record already exists.');
  });

  // Control for the `requireUnique` lookup. Cloudflare permits several A records for
  // one name (round-robin), and adopting "the first" would persist one id while
  // orphaning the rest. An ambiguous zone must surface the original conflict.
  it('surfaces the original conflict when the zone holds more than one matching record', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errors: [{ code: 81058, message: 'An identical record already exists.' }],
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: [WINNER, { ...WINNER, id: 'dns-second', content: '198.51.100.9' }],
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createNodeBackendDNSRecord('NODE-1', '203.0.113.10', env()))
      .rejects.toThrow('An identical record already exists.');
  });

  // `recoverExisting` is the durable provisioning retry path. It refuses a
  // pre-existing record that is not exactly this allocation's, and a conflict that
  // lands AFTER that pre-check must be held to the same standard. These two cases
  // are the reason the conflict recovery is not an unconditional PATCH: without the
  // `recoverExisting` branch, the second one would silently repoint a foreign
  // allocation at this node's IP (rules 63 / 71).
  describe('recoverExisting (durable provisioning retry)', () => {
    it('adopts the winner when its identity matches the recovered allocation', async () => {
      const fetchMock = vi.fn()
        // pre-check lookup: nothing yet
        .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
        // our create loses the race
        .mockResolvedValueOnce(new Response(JSON.stringify({
          errors: [{ code: 81058, message: 'An identical record already exists.' }],
        }), { status: 400 }))
        // conflict lookup: the winner is exactly our allocation
        .mockResolvedValueOnce(new Response(JSON.stringify({ result: [WINNER] }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(createNodeBackendDNSRecord('NODE-1', '203.0.113.10', env(), undefined, true))
        .resolves.toBe('dns-winner');
      // Three calls: no corrective PATCH on the durable path.
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('refuses a winner whose IP differs instead of repointing it', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          errors: [{ code: 81057, message: 'Record already exists.' }],
        }), { status: 400 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          result: [{ ...WINNER, content: '198.51.100.9' }],
        }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(createNodeBackendDNSRecord('NODE-1', '203.0.113.10', env(), undefined, true))
        .rejects.toThrow('Existing backend DNS identity differs from the recovered allocation');
      // No PATCH: the durable path must not converge a foreign allocation.
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('refuses a grey-clouded winner, which would break the Worker-to-VM path', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          errors: [{ code: 81058, message: 'An identical record already exists.' }],
        }), { status: 400 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          result: [{ ...WINNER, proxied: false }],
        }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(createNodeBackendDNSRecord('NODE-1', '203.0.113.10', env(), undefined, true))
        .rejects.toThrow('Existing backend DNS identity differs from the recovered allocation');
    });

    // Liveness control: the pre-check path still short-circuits before any create.
    it('still short-circuits on the pre-check when the record already exists', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ result: [WINNER] }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(createNodeBackendDNSRecord('NODE-1', '203.0.113.10', env(), undefined, true))
        .resolves.toBe('dns-winner');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  // An aborted request must see the abort, not a DNS error it cannot act on: the
  // conflict lookup swallows failures to preserve the original conflict message, and
  // that must not swallow a cancellation.
  it('propagates an abort raised during the conflict lookup', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      if ((init?.method ?? 'GET') === 'POST') {
        return new Response(JSON.stringify({
          errors: [{ code: 81058, message: 'An identical record already exists.' }],
        }), { status: 400 });
      }
      controller.abort(new Error('provider request cancelled'));
      throw controller.signal.reason;
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(createNodeBackendDNSRecord('NODE-1', '203.0.113.10', env(), controller.signal))
      .rejects.toThrow('provider request cancelled');
  });
});
