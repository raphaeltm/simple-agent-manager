import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

const capture = vi.hoisted(() => ({
  writes: [] as string[],
  calls: [] as { path: string; method: string; body: Record<string, unknown> }[],
  run: vi.fn(() => ({ status: 0 })),
}));
vi.mock('node:child_process', () => ({ spawnSync: capture.run }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    writeFile: vi.fn(async (_path: string, data: string) => {
      capture.writes.push(data);
    }),
    unlink: vi.fn(async () => {}),
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  capture.writes = [];
  capture.calls = [];
  capture.run.mockClear();
});
async function deploy(existing: boolean) {
  vi.spyOn(process, 'chdir').mockImplementation(() => {});
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'DEPLOY_TOKEN');
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'a'.repeat(32));
  vi.stubEnv('BASE_DOMAIN', 'sammy.party');
  vi.stubEnv('INSTALLER_ENVIRONMENT', 'staging');
  vi.stubEnv('OAUTH_CLIENT_ID', '');
  vi.stubEnv('OAUTH_CLIENT_SECRET', '');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname,
        method = init.method || 'GET',
        body = init.body ? JSON.parse(String(init.body)) : {};
      capture.calls.push({ path, method, body });
      const result = path.endsWith('/oauth_clients')
        ? method === 'GET'
          ? existing
            ? [
                {
                  client_id: 'existing',
                  client_name: 'sam-installer-staging',
                  client_uri: 'https://install.sammy.party',
                },
              ]
            : []
          : { client_id: 'new', client_secret: 'SECRET' }
        : method === 'GET'
          ? [{ name: 'OAUTH_CLIENT_ID' }, { name: 'OAUTH_CLIENT_SECRET' }]
          : {};
      return Response.json({ success: true, result });
    })
  );
  await import('../scripts/deploy.mjs');
}
describe('deployment configuration and reruns', () => {
  it('parses the real template and creates private OAuth credentials without persisting secrets to disk', async () => {
    expect(
      JSON.parse(await readFile('wrangler.json', 'utf8')).durable_objects.bindings[0].name
    ).toBe('SESSIONS');
    vi.stubEnv('GITHUB_SHA', 'b'.repeat(40));
    await deploy(false);
    const config = JSON.parse(capture.writes[0]!);
    expect(config.vars.SOURCE_URL).toContain(`/tree/${'b'.repeat(40)}/apps/installer`);
    expect(config.vars.DOCS_URL).toBe('/self-host.html');
    expect(config.vars.APP_ORIGIN).toBe('https://install.sammy.party');
    expect(config.routes[0].pattern).toBe('install.sammy.party');
    expect(config.routes[1]).toEqual({
      pattern: 'install.sammy.party/*',
      zone_name: 'sammy.party',
    });
    expect(capture.writes.join('')).not.toContain('SECRET');
    expect(capture.writes.join('')).not.toContain('DEPLOY_TOKEN');
    expect(
      capture.calls.find((c) => c.path.endsWith('/oauth_clients') && c.method === 'POST')?.body
        .grant_types
    ).toEqual(['authorization_code']);
    expect(capture.calls.some((c) => c.body.visibility === 'public')).toBe(false);
    expect(capture.calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
  });
  it('reuses an existing client and preserves its non-readable secret on subsequent deployment', async () => {
    await deploy(true);
    expect(capture.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(capture.calls.filter((c) => c.method === 'PUT').map((c) => c.body.name)).toEqual([
      'OAUTH_CLIENT_ID',
    ]);
  });
});
