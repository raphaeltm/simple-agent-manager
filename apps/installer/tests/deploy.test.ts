import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

const capture = vi.hoisted(() => ({
  writes: [] as string[],
  calls: [] as {
    path: string;
    method: string;
    body: Record<string, unknown>;
    authorization: string | null;
  }[],
  run: vi.fn(() => ({ status: 0 })),
  events: [] as string[],
}));
vi.mock('node:child_process', () => ({ spawnSync: capture.run }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  writeFile: vi.fn(async (_path: string, data: string) => {
    capture.writes.push(data);
    capture.events.push('write-config');
  }),
  unlink: vi.fn(async () => {}),
}));
// Fixture IDs verified against live GET /oauth/scopes on 2026-10-28. In
// particular Workers AI uses ai.*, Pages uses page.*, and token creation uses
// account-api-tokens.write; permission-group display names are not scope IDs.
const fullScopes = [
  'account-settings.read',
  'account-api-tokens.write',
  'workers-scripts.write',
  'workers-scripts.read',
  'workers-kv-storage.write',
  'workers-r2.write',
  'containers.write',
  'd1.write',
  'page.write',
  'workers-routes.write',
  'dns.write',
  'zone.read',
  'ssl-and-certificates.write',
  'ai.read',
  'ai.write',
  'aig.read',
  'aig.run',
  'aig.write',
  'workers-observability.read',
];
const bootstrapScopes = ['account-settings.read', 'workers-scripts.edit'];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  capture.writes = [];
  capture.calls = [];
  capture.events = [];
  capture.run.mockClear();
});
interface Options {
  existing?: 'bootstrap' | 'full';
  ready?: boolean;
  mode?: string;
  managementDenied?: boolean;
  registrationToken?: string;
  sha?: string;
  missingScope?: boolean;
}
async function deploy(options: Options = {}) {
  vi.spyOn(process, 'chdir').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'DEPLOY_TOKEN');
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'a'.repeat(32));
  vi.stubEnv('BASE_DOMAIN', 'sammy.party');
  vi.stubEnv('INSTALLER_ENVIRONMENT', 'staging');
  vi.stubEnv('INSTALLER_MODE', options.mode || 'preserve');
  vi.stubEnv('OAUTH_CLIENT_ID', '');
  vi.stubEnv('OAUTH_CLIENT_SECRET', '');
  vi.stubEnv('OAUTH_REGISTRATION_TOKEN', options.registrationToken || '');
  vi.stubEnv('GITHUB_SHA', options.sha ?? 'b'.repeat(40));
  const ready = options.ready ?? !!options.existing;
  let client: Record<string, unknown> | undefined = options.existing
    ? {
        client_id: 'existing',
        client_name: 'sam-installer-staging',
        client_uri: 'https://install.sammy.party',
        scopes: options.existing === 'full' ? [...fullScopes] : [...bootstrapScopes],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        redirect_uris: ['https://install.sammy.party/oauth/callback'],
        token_endpoint_auth_method: 'client_secret_post',
      }
    : undefined;
  const secretNames = ready ? ['OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET'] : [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname,
        method = init.method || 'GET',
        body = init.body ? JSON.parse(String(init.body)) : {};
      const authorization = new Headers(init.headers).get('Authorization');
      capture.calls.push({ path, method, body, authorization });
      capture.events.push(`${method} ${path}`);
      if (
        options.managementDenied &&
        (path.includes('/oauth_clients') || path === '/client/v4/oauth/scopes')
      )
        return Response.json(
          { success: false, errors: [{ message: 'SECRET PRIVATE UPSTREAM BODY' }] },
          { status: 403 }
        );
      let result: unknown;
      if (path.endsWith('/settings')) {
        if (!options.existing) return Response.json({ success: false }, { status: 404 });
        result = {
          bindings: [
            {
              name: 'OAUTH_SCOPES',
              type: 'plain_text',
              text: (options.existing === 'full' ? fullScopes : bootstrapScopes).join(' '),
            },
            ...(options.existing === 'full'
              ? [{ name: 'INSTALL_SOURCE_COMMIT', type: 'plain_text', text: 'c'.repeat(40) }]
              : []),
            ...secretNames.map((name) => ({ name, type: 'secret_text' })),
          ],
        };
      } else if (path === '/client/v4/oauth/scopes')
        result = [...fullScopes, ...bootstrapScopes]
          .filter((scope) => !(options.missingScope && scope === 'account-api-tokens.write'))
          .map((id) => ({ id }));
      else if (path.endsWith('/oauth_clients')) {
        if (method === 'GET') result = client ? [client] : [];
        else {
          client = { ...body, client_id: 'new', client_secret: 'SECRET' };
          result = client;
        }
      } else if (path.includes('/oauth_clients/')) {
        if (method === 'PATCH') client = { ...client, ...body };
        result = client;
      } else if (path.endsWith('/secrets')) {
        if (method === 'PUT') {
          if (!secretNames.includes(String(body.name))) secretNames.push(String(body.name));
          result = {};
        } else result = secretNames.map((name) => ({ name }));
      } else throw new Error('Unexpected deployment API endpoint');
      return Response.json({ success: true, result });
    })
  );
  await import('../scripts/deploy.mjs');
}
const config = () => JSON.parse(capture.writes[0] ?? '{}');
describe('publisher-controlled installer deployment', () => {
  it('creates a fresh private bootstrap client and never persists credentials to disk or CLI arguments', async () => {
    expect(
      JSON.parse(await readFile('wrangler.json', 'utf8')).durable_objects.bindings[0].name
    ).toBe('SESSIONS');
    await deploy();
    expect(config().vars.INSTALL_SOURCE_COMMIT).toBeUndefined();
    expect(config().vars.SOURCE_URL).toContain(`/tree/${'b'.repeat(40)}/apps/installer`);
    expect(config().routes).toEqual([
      { pattern: 'install.sammy.party', custom_domain: true },
      { pattern: 'install.sammy.party/*', zone_name: 'sammy.party' },
    ]);
    const created = capture.calls.find(
      (call) => call.path.endsWith('/oauth_clients') && call.method === 'POST'
    );
    expect(created?.body).toMatchObject({
      grant_types: ['authorization_code'],
      token_endpoint_auth_method: 'client_secret_post',
    });
    expect(capture.calls.some((call) => call.body.visibility === 'public')).toBe(false);
    expect(capture.writes.join('')).not.toMatch(/DEPLOY_TOKEN|SECRET/);
    expect(JSON.stringify(capture.run.mock.calls.map((call) => call[1]))).not.toMatch(
      /DEPLOY_TOKEN|SECRET/
    );
    expect(capture.events.indexOf('write-config')).toBeLessThan(
      capture.events.findIndex((entry) => entry.includes('/oauth_clients'))
    );
  });
  it('redeploys an actually ready unchanged configuration without OAuth management permissions', async () => {
    await deploy({ existing: 'bootstrap', managementDenied: true });
    expect(capture.run).toHaveBeenCalledOnce();
    expect(
      capture.calls.some(
        (call) => call.path.includes('/oauth_clients') || call.path.endsWith('/oauth/scopes')
      )
    ).toBe(false);
    expect(capture.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
  });
  it('validates full consent and updates the private client before enabling the pinned source', async () => {
    await deploy({ existing: 'bootstrap', mode: 'full' });
    expect(config().vars.INSTALL_SOURCE_COMMIT).toBe('b'.repeat(40));
    expect(config().vars.OAUTH_SCOPES.split(' ')).toEqual(fullScopes);
    const patch = capture.calls.find((call) => call.method === 'PATCH');
    expect(patch?.body.scopes).toEqual(fullScopes);
    expect(patch?.body).not.toHaveProperty('visibility');
    expect(capture.events.findIndex((entry) => entry.startsWith('PATCH '))).toBeLessThan(
      capture.events.indexOf('write-config')
    );
  });
  it('preserves full mode/scopes on automatic redeploy and repins to the deployed commit', async () => {
    await deploy({ existing: 'full', managementDenied: true });
    expect(config().vars.INSTALL_SOURCE_COMMIT).toBe('b'.repeat(40));
    expect(config().vars.OAUTH_SCOPES.split(' ')).toEqual(fullScopes);
    expect(capture.calls.some((call) => call.path.includes('/oauth_clients'))).toBe(false);
  });
  it('explicit bootstrap mode removes full-mode pin and reconciles reduced client consent', async () => {
    await deploy({ existing: 'full', mode: 'bootstrap' });
    expect(config().vars.INSTALL_SOURCE_COMMIT).toBeUndefined();
    expect(config().vars.OAUTH_SCOPES.split(' ')).toEqual(bootstrapScopes);
    expect(capture.calls.find((call) => call.method === 'PATCH')?.body.scopes).toEqual(
      bootstrapScopes
    );
  });
  it('blocks full enablement before publishing when management permission or a live scope is missing', async () => {
    await expect(
      deploy({ existing: 'bootstrap', mode: 'full', managementDenied: true })
    ).rejects.toThrow('permissions');
    expect(capture.run).not.toHaveBeenCalled();
    expect(capture.writes).toHaveLength(0);
  });
  it('rejects unsupported consent identifiers before enabling full mode', async () => {
    await expect(deploy({ mode: 'full', missingScope: true })).rejects.toThrow('catalog');
    expect(capture.run).not.toHaveBeenCalled();
  });
  it('keeps fresh bootstrap asset deployment while still failing OAuth readiness honestly', async () => {
    await expect(deploy({ managementDenied: true })).rejects.toThrow('permissions');
    expect(capture.run).toHaveBeenCalledOnce();
    expect(config().vars.INSTALL_SOURCE_COMMIT).toBeUndefined();
    expect(capture.writes.join('')).not.toContain('PRIVATE UPSTREAM');
  });
  it('uses optional registration authority only on OAuth endpoints and never passes it to Wrangler', async () => {
    await deploy({
      existing: 'bootstrap',
      mode: 'full',
      registrationToken: 'REGISTRATION_PRIVATE',
    });
    for (const call of capture.calls)
      expect(call.authorization).toBe(
        call.path.includes('/oauth_clients') || call.path.endsWith('/oauth/scopes')
          ? 'Bearer REGISTRATION_PRIVATE'
          : 'Bearer DEPLOY_TOKEN'
      );
    expect(capture.writes.join('')).not.toContain('REGISTRATION_PRIVATE');
    expect(capture.run.mock.calls[0]?.[2]?.env).not.toHaveProperty('OAUTH_REGISTRATION_TOKEN');
  });
  it('requires an immutable publisher commit for full mode', async () => {
    await expect(deploy({ mode: 'full', sha: 'main' })).rejects.toThrow('immutable');
    expect(capture.run).not.toHaveBeenCalled();
  });
});
