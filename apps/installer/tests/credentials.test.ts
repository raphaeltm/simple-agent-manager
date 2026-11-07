import { afterEach, describe, expect, it, vi } from 'vitest';

import { createInstallationCredentials, installationCredentialBuckets } from '../src/credentials';
import realCatalog from './fixtures-permission-groups.json';
const config = {
  accountId: 'a'.repeat(32),
  zoneId: 'b'.repeat(32),
  zoneName: 'example.com',
  baseDomain: 'sam.example.com',
  ownerEmail: 'owner@example.com',
  sourceCommit: 'c'.repeat(40),
};
const installation = 'sam-maintenance-1234567890abcdef';
// Real Cloudflare account-token permission catalog (names and scopes only),
// captured 2026-11-06. is_selectable is caller-relative in the live API, so the
// fixture marks every group selectable, as for a bootstrap grant that holds them.
// Using the real names is what catches a required group that does not exist
// ('Containers Write' and 'AI Gateway Edit' did not).
const catalog = (realCatalog.groups as { name: string; scopes: string[] }[]).map(
  (entry, index) => ({
    ...entry,
    id: (index + 1).toString(16).padStart(32, '0'),
    is_selectable: true,
  })
);
const group = (name: string, scope = 'com.cloudflare.api.account') =>
  catalog.find((entry) => entry.name === name && entry.scopes.includes(scope))!;
const bucketGroup = group('Workers R2 Storage Bucket Item Write', 'com.cloudflare.edge.r2.bucket');
interface Stored {
  id: string;
  name: string;
  policies: unknown[];
}
function fixture(
  mode?: 'timeout-once' | 'runtime-fails' | 'invalid-value' | 'delete-fails',
  groups: typeof catalog = catalog
) {
  const tokens = new Map<string, Stored>();
  const plans: Array<{ name: string; policies: unknown[] }> = [];
  const deleted: string[] = [];
  let count = 0;
  let timedOut = false;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/permission_groups')) return Response.json({ success: true, result: groups });
    if (init?.method === 'DELETE') {
      const id = url.split('/').at(-1)!;
      if (mode === 'delete-fails') return Response.json({ success: false }, { status: 403 });
      deleted.push(id);
      tokens.delete(id);
      return Response.json({ success: true, result: { id } });
    }
    if (init?.method === 'POST') {
      const plan = JSON.parse(String(init.body)) as { name: string; policies: unknown[] };
      plans.push(plan);
      if (mode === 'runtime-fails' && plan.name.endsWith('-runtime'))
        return Response.json({ success: false }, { status: 403 });
      const id = (++count).toString(16).padStart(32, '0');
      tokens.set(id, { ...plan, id });
      if (mode === 'timeout-once' && !timedOut) {
        timedOut = true;
        throw new Error('bootstrap-secret value-lost');
      }
      return Response.json({
        success: true,
        result: {
          id,
          ...(mode === 'invalid-value' || mode === 'delete-fails'
            ? {}
            : { value: `private-value-${id}` }),
        },
      });
    }
    return Response.json({ success: true, result: [...tokens.values()] });
  });
  vi.stubGlobal('fetch', fetch);
  return { tokens, plans, deleted, fetch };
}
afterEach(() => vi.unstubAllGlobals());
describe('installation credential principals', () => {
  it('uses selectable scoped catalog groups, runtime TLS/AI capabilities and bucket-scoped S3 credentials', async () => {
    const f = fixture();
    const journal: string[][] = [];
    const credentials = await createInstallationCredentials(
      'bootstrap-secret',
      config,
      installation,
      {
        journal: async (ids) => {
          journal.push(ids);
        },
      }
    );
    expect(credentials.tokenIds).toHaveLength(3);
    expect(journal.map((ids) => ids.length)).toEqual([1, 2, 3]);
    expect(credentials.r2SecretAccessKey).toMatch(/^[a-f0-9]{64}$/);
    const serialize = JSON.stringify(f.plans);
    expect(serialize).not.toContain('bootstrap-secret');
    expect(serialize).not.toContain('com.cloudflare.api.account.*');
    const statePlan = f.plans.find((plan) => plan.name.endsWith('-state'))!;
    const bucketNames = await installationCredentialBuckets(config, installation);
    expect(statePlan.policies).toEqual([
      {
        effect: 'allow',
        permission_groups: [{ id: bucketGroup.id }],
        resources: Object.fromEntries(
          bucketNames.map((name) => [
            `com.cloudflare.edge.r2.bucket.${config.accountId}_default_${name}`,
            '*',
          ])
        ),
      },
    ]);
    const runtime = JSON.stringify(f.plans.find((plan) => plan.name.endsWith('-runtime')));
    expect(runtime).toContain(
      group('SSL and Certificates Write', 'com.cloudflare.api.account.zone').id
    );
    for (const name of ['Workers AI Write', 'AI Gateway Run', 'Workers Containers Write'])
      expect(runtime).toContain(group(name).id);
    expect(serialize).not.toMatch(/API Tokens|OAuth/);
  });
  // Observed on staging 2026-11-06: an OAuth grant saw Workers Scripts Write and
  // Account Settings Read as not selectable although both were granted.
  const markedUnselectable = (names: string[]) =>
    catalog.map((entry) =>
      names.includes(entry.name) ? { ...entry, is_selectable: false } : entry
    );
  it('lets Cloudflare token creation decide when groups are only marked not selectable', async () => {
    const f = fixture(
      undefined,
      markedUnselectable(['Workers Scripts Write', 'Account Settings Read'])
    );
    const credentials = await createInstallationCredentials(
      'bootstrap-secret',
      config,
      installation
    );
    expect(credentials.tokenIds).toHaveLength(3);
    expect(JSON.stringify(f.plans)).toContain(group('Workers Scripts Write').id);
  });
  it('reports the refused token, its status and the not-selectable groups when creation is refused', async () => {
    const f = fixture('runtime-fails', markedUnselectable(['Workers Scripts Write', 'D1 Write']));
    const error = await createInstallationCredentials('private', config, installation).catch(
      (caught: unknown) => caught as Error
    );
    expect(error.message).toContain(
      'Cloudflare did not create the runtime account token (HTTP 403)'
    );
    expect(error.message).toContain(
      'Cloudflare marked these not selectable for this grant: Workers Scripts Write, D1 Write'
    );
    expect(f.deleted).toHaveLength(1);
  });
  it.each(['missing', 'wrong-scope'])(
    'fails before mutation on %s permission evidence',
    async (mode) => {
      const required = group('Workers Scripts Write');
      const groups = structuredClone(catalog).filter(
        (entry) => mode !== 'missing' || entry.id !== required.id
      );
      const target = groups.find((entry) => entry.id === required.id);
      if (mode === 'wrong-scope') target!.scopes = ['com.cloudflare.api.user'];
      const fetch = vi.fn(async () => Response.json({ success: true, result: groups }));
      vi.stubGlobal('fetch', fetch);
      await expect(createInstallationCredentials('private', config, installation)).rejects.toThrow(
        'permission unavailable'
      );
      expect(fetch).toHaveBeenCalledOnce();
    }
  );
  it('reconciles a committed POST whose response was lost before retrying', async () => {
    const f = fixture('timeout-once');
    const journal: string[][] = [];
    const result = await createInstallationCredentials('bootstrap-secret', config, installation, {
      journal: async (ids) => {
        journal.push([...ids]);
      },
    });
    expect(f.deleted).toEqual(['1'.padStart(32, '0')]);
    expect(f.tokens.size).toBe(3);
    expect(result.tokenIds).not.toContain('1'.padStart(32, '0'));
    expect(journal[0]).toEqual(['1'.padStart(32, '0')]);
    expect(journal[1]).toEqual([]);
  });
  it('cleans up a known token ID even when its response has no usable value', async () => {
    const f = fixture('invalid-value');
    const journal: string[][] = [];
    await expect(
      createInstallationCredentials('private', config, installation, {
        journal: async (ids) => {
          journal.push([...ids]);
        },
      })
    ).rejects.toThrow('Could not provision installation credentials');
    expect(f.deleted).toHaveLength(1);
    expect(f.tokens.size).toBe(0);
    expect(journal.at(-1)).toEqual([]);
  });
  it('reconciles prior exact-name principals after a session restart without reusing unavailable values', async () => {
    const f = fixture();
    const first = await createInstallationCredentials('private', config, installation);
    const second = await createInstallationCredentials('private', config, installation);
    expect(f.deleted.sort()).toEqual([...first.tokenIds].sort());
    expect(second.tokenIds.some((id) => first.tokenIds.includes(id))).toBe(false);
    expect(f.tokens.size).toBe(3);
  });

  it('retains unresolved cleanup IDs in the durable journal', async () => {
    const f = fixture('delete-fails');
    const journal: string[][] = [];
    await expect(
      createInstallationCredentials('private', config, installation, {
        journal: async (ids) => {
          journal.push([...ids]);
        },
      })
    ).rejects.toThrow('Could not provision installation credentials');
    expect(f.tokens.size).toBe(1);
    expect(journal.at(-1)).toEqual(['1'.padStart(32, '0')]);
  });
  it('cleans up earlier principals on later failure without touching unrelated tokens', async () => {
    const f = fixture('runtime-fails');
    const unrelatedId = 'f'.repeat(32);
    f.tokens.set(unrelatedId, { id: unrelatedId, name: 'unrelated-service', policies: [] });
    await expect(createInstallationCredentials('private', config, installation)).rejects.toThrow(
      'Could not provision installation credentials'
    );
    expect([...f.tokens.keys()]).toEqual([unrelatedId]);
    expect(f.deleted).not.toContain(unrelatedId);
  });
  it('refuses to delete an exact-name token with unrelated policies', async () => {
    const f = fixture();
    const unrelatedId = 'f'.repeat(32);
    f.tokens.set(unrelatedId, {
      id: unrelatedId,
      name: `${installation}-deployment`,
      policies: [],
    });
    await expect(createInstallationCredentials('private', config, installation)).rejects.toThrow(
      'Could not provision installation credentials'
    );
    expect(f.plans).toHaveLength(0);
    expect(f.deleted).toHaveLength(0);
    expect(f.tokens.has(unrelatedId)).toBe(true);
  });
});

it('keeps pre-existing journal IDs across a failed retry before their plan can be reconciled', async () => {
  const f = fixture('runtime-fails');
  const old = 'f'.repeat(32),
    snapshots: string[][] = [];
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE' && url.endsWith(old))
      return Response.json({ success: false }, { status: 403 });
    return original(url, init);
  });
  await expect(
    createInstallationCredentials('bootstrap-secret', config, installation, {
      initialTokenIds: [old],
      journal: async (ids) => {
        snapshots.push([...ids]);
      },
    })
  ).rejects.toThrow();
  expect(snapshots[0]).toContain(old);
  expect(snapshots.at(-1)).toEqual([old]);
});
it('aborts provisioning while keeping a separate live signal for owned-principal cleanup', async () => {
  const f = fixture(),
    work = new AbortController(),
    cleanup = new AbortController();
  const original = f.fetch.getMockImplementation()!;
  let posted = false;
  f.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const result = await original(url, init);
    if (init?.method === 'POST' && !posted) {
      posted = true;
      work.abort();
    }
    if (init?.method === 'DELETE') expect(init.signal?.aborted).toBe(false);
    return result;
  });
  await expect(
    createInstallationCredentials('bootstrap-secret', config, installation, {
      signal: work.signal,
      cleanupSignal: cleanup.signal,
    })
  ).rejects.toThrow();
  expect(f.plans).toHaveLength(1);
  expect(f.deleted).toEqual(['1'.padStart(32, '0')]);
});
