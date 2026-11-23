import { afterEach, describe, expect, it, vi } from 'vitest';

const capture = vi.hoisted(() => ({
  calls: [] as { path: string; method: string; authorization: string | null }[],
  run: vi.fn(() => ({ status: 0 })),
  logs: [] as string[],
}));
vi.mock('node:child_process', () => ({ spawnSync: capture.run }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  capture.calls = [];
  capture.logs = [];
  capture.run.mockClear();
});
const ACCOUNT = 'a'.repeat(32);
const ORIGIN = 'https://sam-installer-self-hosted.acme.workers.dev';
interface Client {
  client_id: string;
  client_name: string;
  client_uri: string;
}
interface Options {
  /** False when the installer Worker is already gone. */
  worker?: boolean;
  clients?: Client[];
  removeClient?: string;
  environment?: string;
  oauthDenied?: boolean;
}
const ours: Client = {
  client_id: 'ours',
  client_name: 'sam-installer-self-hosted',
  client_uri: ORIGIN,
};
async function remove(options: Options = {}) {
  vi.spyOn(process, 'chdir').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation((line: string) => {
    capture.logs.push(line);
  });
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'DEPLOY_TOKEN');
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', ACCOUNT);
  vi.stubEnv('INSTALLER_ENVIRONMENT', options.environment ?? '');
  vi.stubEnv('REMOVE_OAUTH_CLIENT', options.removeClient ?? '');
  vi.stubEnv('OAUTH_REGISTRATION_TOKEN', '');
  let clients = options.clients ?? [ours];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const method = init.method || 'GET';
      capture.calls.push({
        path,
        method,
        authorization: new Headers(init.headers).get('Authorization'),
      });
      if (path.endsWith('/settings')) {
        if (options.worker === false) return Response.json({ success: false }, { status: 404 });
        return Response.json({
          success: true,
          result: { bindings: [{ name: 'APP_ORIGIN', type: 'plain_text', text: ORIGIN }] },
        });
      }
      if (path.includes('/oauth_clients')) {
        if (options.oauthDenied)
          return Response.json(
            { success: false, errors: [{ message: 'PRIVATE UPSTREAM BODY' }] },
            { status: 403 }
          );
        if (method === 'DELETE') {
          clients = clients.filter((client) => !path.endsWith(`/${client.client_id}`));
          return Response.json({ success: true, result: {} });
        }
        return Response.json({ success: true, result: clients });
      }
      throw new Error('Unexpected removal API endpoint');
    })
  );
  await import('../scripts/remove.mjs');
}
const deleted = () =>
  capture.calls.filter((call) => call.method === 'DELETE').map((call) => call.path);
const wranglerArguments = () => capture.run.mock.calls.map((call) => (call as unknown[])[1]);
describe('removing an own-account installer', () => {
  it('deletes the installer Worker and keeps its OAuth client by default', async () => {
    await remove();
    expect(wranglerArguments()).toEqual([
      [
        expect.stringMatching(/\/node_modules\/wrangler\/bin\/wrangler\.js$/),
        'delete',
        '--name',
        'sam-installer-self-hosted',
        '--force',
      ],
    ]);
    expect(capture.calls.some((call) => call.path.includes('/oauth_clients'))).toBe(false);
    expect(capture.logs.join('\n')).toContain('Kept the OAuth client');
    expect(capture.logs.join('\n')).toContain('REMOVE_OAUTH_CLIENT=true');
  });
  it('deletes the OAuth client only when asked, and only this installer’s', async () => {
    await remove({
      removeClient: 'true',
      clients: [
        ours,
        // Same name on another address, and another installer: neither is this one.
        {
          client_id: 'elsewhere',
          client_name: 'sam-installer-self-hosted',
          client_uri: 'https://install.example.com',
        },
        { client_id: 'staging', client_name: 'sam-installer-staging', client_uri: ORIGIN },
      ],
    });
    expect(deleted()).toEqual([`/client/v4/accounts/${ACCOUNT}/oauth_clients/ours`]);
    expect(capture.run).toHaveBeenCalledOnce();
  });
  it.each(['1', 'yes', 'TRUE'])(
    'does not treat %s as a request to delete the client',
    async (value) => {
      await remove({ removeClient: value });
      expect(deleted()).toEqual([]);
    }
  );
  it('is safe to run again once the Worker is gone', async () => {
    await remove({ worker: false });
    expect(capture.run).not.toHaveBeenCalled();
    expect(capture.logs.join('\n')).toContain(
      'No installer Worker named sam-installer-self-hosted'
    );
  });
  it('still removes the leftover client by name after the Worker is gone', async () => {
    await remove({ worker: false, removeClient: 'true' });
    expect(deleted()).toEqual([`/client/v4/accounts/${ACCOUNT}/oauth_clients/ours`]);
  });
  it('refuses to guess between several same-named clients once the address is unknown', async () => {
    await expect(
      remove({
        worker: false,
        removeClient: 'true',
        clients: [ours, { ...ours, client_id: 'other', client_uri: 'https://install.example.com' }],
      })
    ).rejects.toThrow('Several OAuth clients');
    expect(deleted()).toEqual([]);
  });
  it('checks OAuth access before deleting the Worker, and names the permission', async () => {
    await expect(remove({ removeClient: 'true', oauthDenied: true })).rejects.toThrow(
      '"OAuth Client Write"'
    );
    expect(capture.run).not.toHaveBeenCalled();
  });
  it('acts on the named environment and never on an installation service', async () => {
    await remove({
      environment: 'staging',
      removeClient: 'true',
      clients: [{ client_id: 'staging', client_name: 'sam-installer-staging', client_uri: ORIGIN }],
    });
    expect(wranglerArguments()[0]).toEqual(
      expect.arrayContaining(['delete', '--name', 'sam-installer-staging'])
    );
    for (const call of capture.calls) expect(call.path).not.toContain('sam-maintenance');
    expect(capture.logs.join('\n')).toContain(
      'Installations made with this installer were not changed'
    );
  });
  it('requires a token and account ID', async () => {
    vi.spyOn(process, 'chdir').mockImplementation(() => {});
    vi.stubEnv('CLOUDFLARE_API_TOKEN', '');
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', ACCOUNT);
    await expect(import('../scripts/remove.mjs')).rejects.toThrow('CLOUDFLARE_API_TOKEN');
  });
});
