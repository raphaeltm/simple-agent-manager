import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isValidOwnerEmail,
  previewInstallation,
  validateInstallationConfig,
} from '../src/installation-plan';
const config = {
  accountId: 'a'.repeat(32),
  zoneId: 'b'.repeat(32),
  zoneName: 'example.com',
  baseDomain: 'sam.example.com',
  ownerEmail: 'Owner@example.com',
  sourceCommit: 'c'.repeat(40),
};
afterEach(() => vi.unstubAllGlobals());
describe('installation approval', () => {
  it('validates immutable source and strict zone containment', () => {
    expect(validateInstallationConfig(config).ownerEmail).toBe('owner@example.com');
    expect(() => validateInstallationConfig({ ...config, baseDomain: 'badexample.com' })).toThrow();
    expect(() => validateInstallationConfig({ ...config, sourceCommit: 'main' })).toThrow();
  });
  it('checks actual zone ownership and lists exact-hostname DNS conflicts before mutation', async () => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) =>
      Response.json({
        success: true,
        result:
          url.includes('/dns_records?') || url.includes('/workers/routes')
            ? [{ name: 'api.sam.example.com', type: 'CNAME' }]
            : url.includes('/workers/subdomain')
              ? { subdomain: 'existing' }
              : {
                  id: config.zoneId,
                  name: config.zoneName,
                  account: { id: config.accountId },
                  status: 'active',
                },
      })
    );
    vi.stubGlobal('fetch', fetch);
    const plan = await previewInstallation('private', config);
    expect(plan.hostnames).toEqual([
      'api.sam.example.com',
      'app.sam.example.com',
      'preview.sam.example.com',
      '*.sam.example.com',
    ]);
    expect(plan.conflicts.filter((conflict) => conflict.type === 'CNAME')).toHaveLength(4);
    expect(plan.workersDev).toEqual({ action: 'preserve', subdomain: 'existing' });
    expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });
  it('rejects an account mismatch from the authoritative zone response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          success: true,
          result: {
            id: config.zoneId,
            name: config.zoneName,
            account: { id: 'd'.repeat(32) },
            status: 'active',
          },
        })
      )
    );
    await expect(previewInstallation('private', config)).rejects.toThrow('authorized account');
  });
  it('previews missing account addresses without mutation and retains approval after creation', async () => {
    let current = '';
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/workers/subdomain'))
        return Response.json({ success: true, result: { subdomain: current } });
      return Response.json({
        success: true,
        result:
          url.includes('/dns_records?') || url.includes('/workers/routes')
            ? []
            : {
                id: config.zoneId,
                name: config.zoneName,
                account: { id: config.accountId },
                status: 'active',
              },
      });
    });
    vi.stubGlobal('fetch', fetch);
    const before = await previewInstallation('private', config);
    expect(before.workersDev).toEqual({ action: 'create', subdomain: `sam-${config.accountId}` });
    current = before.workersDev.subdomain;
    const after = await previewInstallation('private', config);
    expect(after.workersDev.action).toBe('preserve');
    expect(after.fingerprint).toBe(before.fingerprint);
    current = 'different';
    expect((await previewInstallation('private', config)).fingerprint).not.toBe(before.fingerprint);
  });
  it('treats only a missing address as absent and never an authorization failure', async () => {
    let status = 404;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/workers/subdomain'))
          return Response.json(
            { success: false, errors: [{ code: 1000, message: 'unavailable' }] },
            { status }
          );
        return Response.json({
          success: true,
          result:
            url.includes('/dns_records?') || url.includes('/workers/routes')
              ? []
              : {
                  id: config.zoneId,
                  name: config.zoneName,
                  account: { id: config.accountId },
                  status: 'active',
                },
        });
      })
    );
    expect((await previewInstallation('private', config)).workersDev.action).toBe('create');
    status = 403;
    await expect(previewInstallation('private', config)).rejects.toThrow();
  });
});

it('checks email syntax with bounded linear scanning and preserves the existing accepted forms', () => {
  for (const value of ['owner@example.com', 'a+b@example.com', 'a@.example.com', 'a@b..com'])
    expect(isValidOwnerEmail(value)).toBe(true);
  for (const value of [
    '',
    null,
    42,
    'a@@b.com',
    'a@b',
    'a@b.',
    '@b.com',
    'a @b.com',
    'a@' + '.'.repeat(10000),
  ])
    expect(isValidOwnerEmail(value)).toBe(false);
  const previous = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const alphabet = ['a', '@', '.', ' '];
  for (let number = 0; number < 4096; number++) {
    let value = '',
      bits = number;
    for (let index = 0; index < 6; index++) {
      value += alphabet[bits % 4];
      bits = Math.floor(bits / 4);
    }
    expect(isValidOwnerEmail(value), value).toBe(previous.test(value));
  }
});
describe('edge certificate coverage', () => {
  const zone = {
    id: config.zoneId,
    name: config.zoneName,
    account: { id: config.accountId },
    status: 'active',
  };
  function cloudflareWith(packs: (() => Response) | unknown[]) {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/ssl/certificate_packs'))
        return typeof packs === 'function'
          ? packs()
          : Response.json({ success: true, result: packs });
      return Response.json({
        success: true,
        result:
          url.includes('/dns_records?') || url.includes('/workers/routes')
            ? []
            : url.includes('/workers/subdomain')
              ? { subdomain: 'existing' }
              : zone,
      });
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }
  const universal = [{ status: 'active', hosts: ['example.com', '*.example.com'] }];
  const certificateConflicts = (plan: { conflicts: { name: string; type: string }[] }) =>
    plan.conflicts.filter((conflict) => conflict.type === 'certificate').map((c) => c.name);
  it('installs at the zone apex without consulting certificates', async () => {
    const fetch = cloudflareWith(universal);
    const plan = await previewInstallation('private', { ...config, baseDomain: 'example.com' });
    expect(plan.conflicts).toEqual([]);
    expect(fetch.mock.calls.some(([url]) => url.includes('/ssl/'))).toBe(false);
  });
  it('blocks a nested domain that only the free universal certificate covers', async () => {
    cloudflareWith(universal);
    expect(certificateConflicts(await previewInstallation('private', config))).toEqual([
      'api.sam.example.com',
      'preview.sam.example.com',
      '*.sam.example.com',
    ]);
  });
  it('accepts a nested domain with an active advanced certificate for its names', async () => {
    cloudflareWith([
      ...universal,
      { status: 'active', hosts: ['sam.example.com', '*.sam.example.com'] },
    ]);
    expect(certificateConflicts(await previewInstallation('private', config))).toEqual([]);
  });
  it('fails closed when certificates cannot be read', async () => {
    cloudflareWith(() =>
      Response.json({ success: false, errors: [{ code: 9109 }] }, { status: 403 })
    );
    expect(certificateConflicts(await previewInstallation('private', config))).toHaveLength(3);
  });
});
describe('workers route conflicts', () => {
  it('blocks a leftover route with a pattern SAM creates and ignores unrelated routes', async () => {
    const zone = {
      id: config.zoneId,
      name: config.zoneName,
      account: { id: config.accountId },
      status: 'active',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        Response.json({
          success: true,
          result: url.includes('/workers/routes')
            ? [
                { pattern: '*.vm.example.com/*', script: null },
                { pattern: 'blog.example.com/*', script: 'blog' },
              ]
            : url.includes('/dns_records?')
              ? []
              : url.includes('/workers/subdomain')
                ? { subdomain: 'existing' }
                : zone,
        })
      )
    );
    const plan = await previewInstallation('private', { ...config, baseDomain: 'example.com' });
    expect(plan.conflicts).toEqual([{ name: '*.vm.example.com/*', type: 'route' }]);
  });
});
