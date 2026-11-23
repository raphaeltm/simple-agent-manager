import { afterEach, describe, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => vi.fn(() => ({ status: 0, stdout: `${'d'.repeat(40)}\n` })));
vi.mock('node:child_process', () => ({ spawnSync: run }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});
const ORIGIN = 'https://sam-installer-self-hosted.acme.workers.dev';
interface Options {
  sha?: string;
  oauthConfigured?: boolean;
  fullInstaller?: boolean;
  redirectUri?: string;
  clientId?: string;
  startStatus?: number;
  /** Where Cloudflare sends the sign-in request. */
  cloudflare?: string;
}
async function check(options: Options = {}) {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => {
    logs.push(line);
  });
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'DEPLOY_TOKEN');
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'a'.repeat(32));
  vi.stubEnv('INSTALLER_ENVIRONMENT', '');
  vi.stubEnv('GITHUB_SHA', '');
  vi.stubEnv('INSTALLER_READY_TIMEOUT_MS', '0');
  const authorize = new URL('https://dash.cloudflare.com/oauth2/auth');
  authorize.search = new URLSearchParams({
    client_id: options.clientId ?? 'client',
    redirect_uri: options.redirectUri ?? `${ORIGIN}/oauth/callback`,
  }).toString();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.cloudflare.com')
        return Response.json({
          success: true,
          result: { bindings: [{ name: 'APP_ORIGIN', type: 'plain_text', text: ORIGIN }] },
        });
      if (url.hostname === 'dash.cloudflare.com')
        return new Response(null, {
          status: 302,
          headers: {
            Location: options.cloudflare ?? 'https://dash.cloudflare.com/login?login_challenge=x',
          },
        });
      if (url.origin !== ORIGIN) throw new Error(`Unexpected request to ${url.origin}`);
      if (url.pathname === '/health')
        return Response.json({
          sha: options.sha ?? 'd'.repeat(40),
          oauthConfigured: options.oauthConfigured ?? true,
        });
      if (url.pathname === '/api/config')
        return Response.json({ fullInstaller: options.fullInstaller ?? true });
      if (url.pathname === '/oauth/start' && init.method === 'POST') {
        if (new Headers(init.headers).get('Origin') !== ORIGIN)
          return Response.json({ error: 'Forbidden' }, { status: 403 });
        return new Response(null, {
          status: options.startStatus ?? 303,
          headers: { Location: authorize.toString() },
        });
      }
      throw new Error(`Unexpected installer path ${url.pathname}`);
    })
  );
  await import('../scripts/check-live.mjs');
  return logs.join('\n');
}
describe('live check of a deployed installer', () => {
  it('passes when the installer runs the checked-out commit and Cloudflare accepts its sign-in', async () => {
    expect(await check()).toContain(`Installer live at ${ORIGIN}`);
  });
  it.each([
    ['a stale commit', { sha: 'c'.repeat(40) }, 'is not ready'],
    ['missing OAuth secrets', { oauthConfigured: false }, 'is not ready'],
    ['bootstrap mode', { fullInstaller: false }, 'is not ready'],
    [
      'a callback on another address',
      { redirectUri: 'https://install.example.com/oauth/callback' },
      'client and callback',
    ],
    ['no client', { clientId: '' }, 'client and callback'],
    ['sign-in not redirecting', { startStatus: 200 }, 'client and callback'],
    [
      'Cloudflare rejecting the callback',
      { cloudflare: 'https://dash.cloudflare.com/oauth/error?error=invalid_request' },
      'did not accept this installer’s sign-in request (invalid_request)',
    ],
    [
      'Cloudflare rejecting the client',
      { cloudflare: 'https://dash.cloudflare.com/oauth/error?error=invalid_client' },
      'invalid_client',
    ],
  ] as const)('fails on %s', async (_label, options, message) => {
    await expect(check(options)).rejects.toThrow(message);
  });
});
