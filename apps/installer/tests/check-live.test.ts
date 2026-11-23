import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../scripts/git-head.mjs', () => ({ checkedOutCommit: () => 'd'.repeat(40) }));
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
  /** Where Cloudflare sends the sign-in request; null sends no Location. */
  cloudflare?: string | null;
  /** Health responses that still report the previous commit. */
  staleHealthChecks?: number;
  timeoutMs?: string;
  pollMs?: string;
  origin?: string;
  /** Where the installer sends the sign-in; null sends no Location. */
  startLocation?: string | null;
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
  vi.stubEnv('INSTALLER_READY_TIMEOUT_MS', options.timeoutMs ?? '0');
  vi.stubEnv('INSTALLER_READY_POLL_MS', options.pollMs ?? '1');
  let staleHealthChecks = options.staleHealthChecks ?? 0;
  const deployedOrigin = options.origin ?? ORIGIN;
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
          result: { bindings: [{ name: 'APP_ORIGIN', type: 'plain_text', text: deployedOrigin }] },
        });
      if (url.hostname === 'dash.cloudflare.com')
        return new Response(null, {
          status: 302,
          headers:
            options.cloudflare === null
              ? {}
              : {
                  Location:
                    options.cloudflare ?? 'https://dash.cloudflare.com/login?login_challenge=x',
                },
        });
      if (url.origin !== ORIGIN) throw new Error(`Unexpected request to ${url.origin}`);
      if (url.pathname === '/health')
        return Response.json({
          sha: staleHealthChecks-- > 0 ? 'c'.repeat(40) : (options.sha ?? 'd'.repeat(40)),
          oauthConfigured: options.oauthConfigured ?? true,
        });
      if (url.pathname === '/api/config')
        return Response.json({ fullInstaller: options.fullInstaller ?? true });
      if (url.pathname === '/oauth/start' && init.method === 'POST') {
        if (new Headers(init.headers).get('Origin') !== ORIGIN)
          return Response.json({ error: 'Forbidden' }, { status: 403 });
        return new Response(null, {
          status: options.startStatus ?? 303,
          headers:
            options.startLocation === null
              ? {}
              : { Location: options.startLocation ?? authorize.toString() },
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
  it('keeps polling until the new version is being served', async () => {
    expect(await check({ staleHealthChecks: 2, timeoutMs: '5000' })).toContain('Installer live');
  });
  it('gives up at its timeout even when the poll interval is far longer', async () => {
    await expect(
      check({ sha: 'c'.repeat(40), timeoutMs: '30', pollMs: '2147483647' })
    ).rejects.toThrow('is not ready');
  });
  it('reports what it last saw when the installer never converges', async () => {
    await expect(check({ sha: 'c'.repeat(40) })).rejects.toThrow(
      `expected=${'d'.repeat(40)} sha=${'c'.repeat(40)} oauthConfigured=true fullInstaller=true`
    );
  });
  it.each([
    [
      'the installer redirecting somewhere other than Cloudflare',
      { startLocation: 'https://evil.example/oauth2/auth?client_id=x' },
      'client and callback',
    ],
    [
      'the installer sending no redirect',
      { startLocation: null },
      'did not redirect to Cloudflare',
    ],
    ['Cloudflare sending no redirect', { cloudflare: null }, 'did not answer the sign-in request'],
    [
      'Cloudflare sending the request to an unknown page',
      { cloudflare: 'https://dash.cloudflare.com/somewhere-new' },
      'instead of its login page',
    ],
    [
      'a deployed address that is not a plain https origin',
      { origin: 'https://user@host.example/path' },
      'no deployed address',
    ],
    ['a non-numeric timeout', { timeoutMs: 'soon' }, 'INSTALLER_READY_TIMEOUT_MS must be'],
  ] as const)('fails on %s', async (_label, options, message) => {
    await expect(check(options)).rejects.toThrow(message);
  });
  it('never sends the API token to the installer or to Cloudflare’s sign-in', async () => {
    await check();
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.length).toBeGreaterThan(3);
    for (const [input, init] of calls) {
      const authorization = new Headers((init as RequestInit | undefined)?.headers).get(
        'Authorization'
      );
      expect(authorization).toBe(
        new URL(String(input)).hostname === 'api.cloudflare.com' ? 'Bearer DEPLOY_TOKEN' : null
      );
    }
  });
});
