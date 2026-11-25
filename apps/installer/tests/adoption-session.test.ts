import { afterEach, expect, it, vi } from 'vitest';

import { InstallerSession } from '../src/session';
import type { Env, Session } from '../src/types';
import realCatalog from './fixtures-permission-groups.json';

const accountId = 'a'.repeat(32);
const zoneId = 'b'.repeat(32);
const passphrase = 'existing-deploy-state-passphrase';
const catalog = (realCatalog.groups as { name: string; scopes: string[] }[]).map(
  (entry, index) => ({
    ...entry,
    id: (index + 1).toString(16).padStart(32, '0'),
    is_selectable: true,
  })
);
afterEach(() => vi.unstubAllGlobals());

/**
 * A real installer session in full mode, against a fake Cloudflare account that already runs SAM.
 * Everything the installer sends to Cloudflare is recorded.
 */
function world(buckets = ['sam-pulumi-state', 'sam-prod-assets']) {
  const values = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: vi.fn(async (key: string) => values.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        values.set(key, structuredClone(value));
      }),
      deleteAll: vi.fn(async () => values.clear()),
      delete: vi.fn(async (key: string) => values.delete(key)),
      deleteAlarm: vi.fn(async () => {}),
      setAlarm: vi.fn(),
    },
    id: { toString: () => 'e'.repeat(64) },
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
  } as unknown as DurableObjectState;
  const env = {
    APP_ORIGIN: 'https://install.example.com',
    OAUTH_CLIENT_ID: 'client',
    OAUTH_CLIENT_SECRET: 'SECRET',
    OAUTH_SCOPES: 'account-settings.read workers-scripts.write',
    SESSION_TTL_SECONDS: '900',
    BUILD_SHA: 'test',
    SOURCE_URL: 'https://example.com/source',
    DOCS_URL: 'https://example.com/docs',
    INSTALL_SOURCE_COMMIT: 'c'.repeat(40),
    ASSETS: { fetch: async () => new Response('assets') },
  } as unknown as Env;
  const session = new InstallerSession(ctx, env);
  values.set('session', {
    expires: Date.now() + 900000,
    tokenExpires: Date.now() + 900000,
    token: 'TOKEN',
    state: '',
    verifier: '',
    accounts: [{ id: accountId, name: 'My account' }],
    zones: [{ id: zoneId, name: 'example.com', account: { id: accountId } }],
  } satisfies Session);
  const tokens: Array<{ name: string; policies: unknown[] }> = [];
  let upload: Record<string, unknown> | undefined;
  const ok = (result: unknown) => Response.json({ success: true, result });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/tokens/permission_groups')) return ok(catalog);
      if (url.endsWith(`/accounts/${accountId}/tokens`) && method === 'POST') {
        tokens.push(JSON.parse(String(init?.body)));
        return ok({
          id: tokens.length.toString(16).padStart(32, '0'),
          value: `value-${tokens.length}`,
        });
      }
      if (url.includes(`/accounts/${accountId}/tokens`)) return ok([]);
      if (url.endsWith(`/zones/${zoneId}`))
        return ok({
          id: zoneId,
          name: 'example.com',
          account: { id: accountId },
          status: 'active',
        });
      if (url.includes('/dns_records?'))
        return ok(url.includes('name=api.') ? [{ name: 'api.example.com', type: 'A' }] : []);
      if (url.endsWith('/workers/routes'))
        return ok([{ pattern: 'api.example.com/*', script: 'sam-api-prod' }]);
      if (url.endsWith('/workers/subdomain')) return ok({ subdomain: 'existing' });
      const bucket = /\/r2\/buckets\/([^/?]+)$/.exec(url)?.[1];
      if (bucket)
        return buckets.includes(bucket)
          ? ok({ name: bucket })
          : Response.json({ success: false, errors: [{ code: 10006 }] }, { status: 404 });
      if (url.endsWith('/r2/buckets')) return ok({ buckets: [] });
      if (url.endsWith('/settings'))
        return Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
      if (/\/workers\/scripts\/sam-maintenance-[a-f0-9]+$/.test(url) && method === 'PUT') {
        const metadata = (init?.body as FormData).get('metadata') as Blob;
        upload = JSON.parse(await metadata.text());
        return ok({});
      }
      if (url.endsWith('/containers/applications')) return ok(method === 'GET' ? [] : {});
      if (url.endsWith('/subdomain')) return ok({});
      throw new Error(`unexpected ${method} ${url}`);
    })
  );
  const call = (path: string, body: unknown) =>
    session.fetch(
      new Request(`https://session${path}`, { method: 'POST', body: JSON.stringify(body) })
    );
  return { values, tokens, call, upload: () => upload };
}
const settings = {
  accountId,
  zoneId,
  zoneName: 'example.com',
  baseDomain: 'example.com',
  ownerEmail: 'owner@example.com',
};

it('takes over an existing SAM: the passphrase reaches only the service’s secrets', async () => {
  const w = world();
  expect((await w.call('/preview', { ...settings, adopt: true })).status).toBe(400);
  const preview = await w.call('/preview', {
    ...settings,
    adopt: true,
    statePassphrase: passphrase,
  });
  expect(preview.status).toBe(200);
  const { plan } = (await preview.json()) as { plan: Record<string, unknown> };
  expect(plan.adoption).toEqual({
    prefix: 'sam',
    environment: 'production',
    stateBucket: 'sam-pulumi-state',
  });
  expect(JSON.stringify(plan)).not.toContain(passphrase);

  const install = await w.call('/install', {
    accountId,
    confirmed: true,
    fingerprint: plan.fingerprint,
  });
  expect(install.status).toBe(200);
  const bindings = (w.upload()?.bindings ?? []) as Array<{
    type: string;
    name: string;
    text?: string;
  }>;
  const binding = (name: string) => bindings.find((entry) => entry.name === name);
  expect(binding('PULUMI_CONFIG_PASSPHRASE')).toMatchObject({
    type: 'secret_text',
    text: passphrase,
  });
  const config = JSON.parse(String(binding('INSTALLATION_CONFIG')?.text));
  expect(config.adoption).toEqual(plan.adoption);
  // Plain-text bindings are readable in the dashboard; the passphrase is never one of them.
  for (const entry of bindings.filter((item) => item.type === 'plain_text'))
    expect(entry.text ?? '').not.toContain(passphrase);
  // The storage credential reaches the existing deployment's buckets, not installer names.
  const storage = JSON.stringify(w.tokens.find((token) => token.name.endsWith('-state')));
  expect(storage).toContain('_default_sam-pulumi-state');
  expect(storage).toContain('_default_sam-prod-assets');
  expect(storage).not.toMatch(/_default_s[a-f0-9]{6}-pulumi-state/);
  // Handing off to the service drops the installer's own copy of the passphrase.
  expect((w.values.get('session') as Session).adoptionPassphrase).toBe(passphrase);
  expect((await w.call('/handoff', {})).status).toBe(200);
  const after = w.values.get('session') as Session;
  expect(after.adoptionPassphrase).toBeUndefined();
  expect(JSON.stringify(after)).not.toContain(passphrase);
});

it('control: an ordinary review of a domain that already runs SAM is blocked, with no passphrase kept', async () => {
  const w = world();
  const preview = await w.call('/preview', { ...settings, statePassphrase: passphrase });
  const { plan } = (await preview.json()) as { plan: { conflicts: unknown[]; adoption?: unknown } };
  expect(plan.adoption).toBeUndefined();
  expect(plan.conflicts.length).toBeGreaterThan(0);
  expect((w.values.get('session') as Session).adoptionPassphrase).toBeUndefined();
});

it('takes over a deployment with its own state bucket name, re-checked at install', async () => {
  const w = world(['team-deploy-state', 'sam-prod-assets']);
  const request = { ...settings, adopt: true, statePassphrase: passphrase };
  // Control: without the name the takeover cannot be approved.
  const unnamed = (await (await w.call('/preview', request)).json()) as {
    plan: { conflicts: unknown[] };
  };
  expect(unnamed.plan.conflicts).toHaveLength(1);
  expect((await w.call('/preview', { ...request, stateBucket: '../zones' })).status).toBe(400);

  const preview = await w.call('/preview', { ...request, stateBucket: 'team-deploy-state' });
  expect(preview.status).toBe(200);
  const { plan } = (await preview.json()) as {
    plan: { fingerprint: string; conflicts: unknown[]; adoption: { stateBucket: string } };
  };
  expect(plan.conflicts).toEqual([]);
  expect(plan.adoption.stateBucket).toBe('team-deploy-state');
  // Install reviews the approved plan again; the named bucket must still be the one it checks.
  const install = await w.call('/install', {
    accountId,
    confirmed: true,
    fingerprint: plan.fingerprint,
  });
  expect(install.status).toBe(200);
  const bindings = (w.upload()?.bindings ?? []) as Array<{ name: string; text?: string }>;
  const config = JSON.parse(
    String(bindings.find((entry) => entry.name === 'INSTALLATION_CONFIG')?.text)
  );
  expect(config.adoption.stateBucket).toBe('team-deploy-state');
  const storage = JSON.stringify(w.tokens.find((token) => token.name.endsWith('-state')));
  expect(storage).toContain('_default_team-deploy-state');
  expect(storage).not.toContain('_default_sam-pulumi-state');
});

it.each([
  ['the named state bucket is gone', 'team-deploy-state', () => ['sam-prod-assets']],
  [
    'a second conventional state bucket appeared',
    undefined,
    () => ['sam-pulumi-state', 'sam-pulumi-state-production', 'sam-prod-assets'],
  ],
])('refuses to install when, since the review, %s', async (_name, stateBucket, after) => {
  const buckets = stateBucket
    ? [stateBucket, 'sam-prod-assets']
    : ['sam-pulumi-state', 'sam-prod-assets'];
  const w = world(buckets);
  const preview = await w.call('/preview', {
    ...settings,
    adopt: true,
    statePassphrase: passphrase,
    ...(stateBucket ? { stateBucket } : {}),
  });
  const { plan } = (await preview.json()) as {
    plan: { fingerprint: string; conflicts: unknown[] };
  };
  expect(plan.conflicts).toEqual([]);
  buckets.splice(0, buckets.length, ...after());
  const install = await w.call('/install', {
    accountId,
    confirmed: true,
    fingerprint: plan.fingerprint,
  });
  expect(install.status).toBe(409);
  expect(w.upload()).toBeUndefined();
  expect(w.tokens).toEqual([]);
});

it('accepts whatever non-empty passphrase the existing deployment uses, and nothing else', async () => {
  const w = world();
  const request = { ...settings, adopt: true };
  // A takeover cannot strengthen a stack that is already encrypted with a short passphrase.
  const short = await w.call('/preview', { ...request, statePassphrase: 'p' });
  expect(short.status).toBe(200);
  const { plan } = (await short.json()) as { plan: { conflicts: unknown[]; adoption?: unknown } };
  expect(plan.conflicts).toEqual([]);
  expect(plan.adoption).toBeDefined();
  expect((w.values.get('session') as Session).adoptionPassphrase).toBe('p');
  for (const statePassphrase of ['', 'x'.repeat(1025), 7, undefined])
    expect((await w.call('/preview', { ...request, statePassphrase })).status).toBe(400);
});
