import { afterEach, describe, expect, it, vi } from 'vitest';

import { previewInstallation, validateInstallationConfig } from '../src/installation-plan';
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
        result: url.includes('/dns_records?')
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
    expect(plan.conflicts).toHaveLength(4);
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
        result: url.includes('/dns_records?')
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
          result: url.includes('/dns_records?')
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
