import { afterEach, describe, expect, it, vi } from 'vitest';

import { previewAdoption } from '../src/adoption-plan';
import { installationCredentialBuckets } from '../src/credentials';
import { previewInstallation, validateInstallationConfig } from '../src/installation-plan';

const config = {
  accountId: 'a'.repeat(32),
  zoneId: 'b'.repeat(32),
  zoneName: 'example.com',
  baseDomain: 'example.com',
  ownerEmail: 'Owner@example.com',
  sourceCommit: 'c'.repeat(40),
};
afterEach(() => vi.unstubAllGlobals());

/** A Cloudflare account that already runs SAM: its API route, state bucket and zone. */
function account(
  options: {
    routes?: Array<{ pattern: string; script?: string }>;
    buckets?: string[];
  } = {}
) {
  const routes = options.routes ?? [
    { pattern: 'api.example.com/*', script: 'sam-api-prod' },
    { pattern: '*.example.com/*', script: 'sam-api-prod' },
  ];
  const buckets = new Set(options.buckets ?? ['sam-pulumi-state']);
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    const bucket = /\/r2\/buckets\/([^/?]+)$/.exec(url)?.[1];
    if (bucket)
      return buckets.has(bucket)
        ? Response.json({ success: true, result: { name: bucket } })
        : Response.json({ success: false, errors: [{ code: 10006 }] }, { status: 404 });
    if (url.includes('/workers/routes')) return Response.json({ success: true, result: routes });
    if (url.includes('/workers/subdomain'))
      return Response.json({ success: true, result: { subdomain: 'existing' } });
    return Response.json({
      success: true,
      result: {
        id: config.zoneId,
        name: config.zoneName,
        account: { id: config.accountId },
        status: 'active',
      },
    });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('taking over an existing SAM', () => {
  it('finds the deployment from its API route and its fork-style state bucket, reading only', async () => {
    const fetch = account();
    const plan = await previewAdoption('private', config);
    expect(plan.conflicts).toEqual([]);
    expect(plan.adoption).toEqual({
      prefix: 'sam',
      environment: 'production',
      stateBucket: 'sam-pulumi-state',
    });
    expect(plan.workersDev).toEqual({ action: 'preserve', subdomain: 'existing' });
    expect(plan.ownerEmail).toBe('owner@example.com');
    expect(fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    // The same takeover reviewed again produces the same approval fingerprint.
    expect((await previewAdoption('private', plan)).fingerprint).toBe(plan.fingerprint);
  });

  it('falls back to an installer-style state bucket and keeps a non-production stack name', async () => {
    account({
      routes: [{ pattern: 'api.example.com/*', script: 'sam-api-staging' }],
      buckets: ['sam-pulumi-state-staging'],
    });
    const plan = await previewAdoption('private', config);
    expect(plan.adoption).toEqual({
      prefix: 'sam',
      environment: 'staging',
      stateBucket: 'sam-pulumi-state-staging',
    });
  });

  it.each([
    ['no API route', [], 'no SAM API Worker routed at api.example.com'],
    [
      'a Worker that is not SAM',
      [{ pattern: 'api.example.com/*', script: 'someone-elses-worker' }],
      'api.example.com is not served by a SAM API Worker',
    ],
    [
      'two Workers',
      [
        { pattern: 'api.example.com/*', script: 'sam-api-prod' },
        { pattern: 'api.example.com/*', script: 'other-api-prod' },
      ],
      'more than one Worker routed at api.example.com',
    ],
  ])('reports %s as a conflict, so nothing can be approved', async (_name, routes, reason) => {
    account({ routes });
    const plan = await previewAdoption('private', config);
    expect(plan.adoption).toBeUndefined();
    expect(plan.conflicts).toEqual([{ name: reason, type: 'adoption' }]);
  });

  it('reports a deployment whose state bucket cannot be found (a secondary installation)', async () => {
    // staging2 keeps its state in staging's bucket; it must not be adoptable by name guessing.
    account({
      routes: [{ pattern: 'api.example.com/*', script: 'sam2-api-staging2' }],
      buckets: ['sam-pulumi-state'],
    });
    const plan = await previewAdoption('private', config);
    expect(plan.adoption).toBeUndefined();
    expect(plan.conflicts[0]?.type).toBe('adoption');
  });

  it('scopes storage credentials to the adopted deployment’s buckets, not installer names', async () => {
    const adopted = validateInstallationConfig({
      ...config,
      adoption: { prefix: 'sam', environment: 'production', stateBucket: 'sam-pulumi-state' },
    });
    expect(await installationCredentialBuckets(adopted, 'sam-maintenance-1')).toEqual([
      'sam-pulumi-state',
      'sam-prod-assets',
      'sam-maintenance-1-builds',
    ]);
    // Control: a new installation keeps its derived names.
    const fresh = await installationCredentialBuckets(
      validateInstallationConfig(config),
      'sam-maintenance-1'
    );
    expect(fresh[0]).toMatch(/^s[a-f0-9]{6}-pulumi-state-production$/);
  });

  it('keeps an ordinary review from carrying a takeover, and rejects malformed targets', async () => {
    account();
    await expect(
      previewInstallation('private', {
        ...config,
        adoption: { prefix: 'sam', environment: 'production', stateBucket: 'sam-pulumi-state' },
      })
    ).rejects.toThrow('previewAdoption');
    for (const adoption of [
      { prefix: 'Bad Prefix', environment: 'production', stateBucket: 'sam-pulumi-state' },
      { prefix: 'sam', environment: 'prod;rm', stateBucket: 'sam-pulumi-state' },
      { prefix: 'sam', environment: 'production', stateBucket: 'Bad_Bucket' },
    ])
      expect(() => validateInstallationConfig({ ...config, adoption })).toThrow('takeover');
  });
});

it('accepts every name length a fork deployment may have (prefix up to 40, environment up to 63)', async () => {
  const prefix = `a${'b'.repeat(38)}c`; // 40, the fork workflow's maximum
  const environment = `e${'n'.repeat(61)}v`; // 63
  account({
    routes: [{ pattern: 'api.example.com/*', script: `${prefix}-api-${environment}` }],
    buckets: [`${prefix}-pulumi-state`],
  });
  const plan = await previewAdoption('private', config);
  expect(plan.adoption).toEqual({ prefix, environment, stateBucket: `${prefix}-pulumi-state` });
  expect(() =>
    validateInstallationConfig({
      ...config,
      adoption: { prefix: `${prefix}d`, environment, stateBucket: `${prefix}-pulumi-state` },
    })
  ).toThrow('takeover');
});
