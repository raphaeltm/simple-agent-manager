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
  /** Cloudflare answers the installer's address with a bot challenge. */
  challenged?: boolean;
  /** A 403 HTML page that is not a Cloudflare challenge. */
  forbidden?: boolean;
  apiBuildSha?: string;
  apiBootstrap?: boolean;
  apiMissingSecret?: boolean;
  /** Which Worker the custom domain leads to. */
  domainService?: string;
  /** Which Worker the hostname route leads to; null means there is no such route. */
  routeScript?: string | null;
  workersDevEnabled?: boolean;
  /** Sign-in attempts answered 503 before the secret has reached that edge. */
  unconfiguredStarts?: number;
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
  let unconfiguredStarts = options.unconfiguredStarts ?? 0;
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
      if (url.hostname === 'api.cloudflare.com') {
        const host = new URL(deployedOrigin).hostname;
        const result = (value: unknown) => Response.json({ success: true, result: value });
        if (url.pathname.endsWith('/workers/domains'))
          return result([
            { hostname: 'install.unrelated.example', service: 'sam-installer-self-hosted' },
            { hostname: host, service: options.domainService ?? 'sam-installer-self-hosted' },
          ]);
        if (url.pathname === '/client/v4/zones')
          return result([{ id: 'z'.repeat(32), name: url.searchParams.get('name') }]);
        if (url.pathname.endsWith('/workers/routes'))
          return result([
            { pattern: `*.${host.replace(/^install\./, '')}/*`, script: 'sam-api' },
            ...(options.routeScript === null
              ? []
              : [
                  {
                    pattern: `${host}/*`,
                    script: options.routeScript ?? 'sam-installer-self-hosted',
                  },
                ]),
          ]);
        if (url.pathname.endsWith('/subdomain'))
          return result({ enabled: options.workersDevEnabled ?? true });
        return Response.json({
          success: true,
          result: {
            bindings: [
              { name: 'APP_ORIGIN', type: 'plain_text', text: deployedOrigin },
              {
                name: 'BUILD_SHA',
                type: 'plain_text',
                text: options.apiBuildSha ?? 'd'.repeat(40),
              },
              ...(options.apiBootstrap
                ? []
                : [{ name: 'INSTALL_SOURCE_COMMIT', type: 'plain_text', text: 'd'.repeat(40) }]),
              { name: 'OAUTH_CLIENT_ID', type: 'secret_text' },
              ...(options.apiMissingSecret
                ? []
                : [{ name: 'OAUTH_CLIENT_SECRET', type: 'secret_text' }]),
            ],
          },
        });
      }
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
      if (url.origin !== deployedOrigin) throw new Error(`Unexpected request to ${url.origin}`);
      if (options.challenged || options.forbidden)
        return new Response('<html>Just a moment...</html>', {
          status: 403,
          headers: {
            'content-type': 'text/html; charset=UTF-8',
            ...(options.challenged ? { 'cf-mitigated': 'challenge' } : {}),
          },
        });
      if (url.pathname === '/health')
        return Response.json({
          sha: staleHealthChecks-- > 0 ? 'c'.repeat(40) : (options.sha ?? 'd'.repeat(40)),
          oauthConfigured: options.oauthConfigured ?? true,
        });
      if (url.pathname === '/api/config')
        return Response.json({ fullInstaller: options.fullInstaller ?? true });
      if (url.pathname === '/oauth/start' && init.method === 'POST') {
        if (new Headers(init.headers).get('Origin') !== deployedOrigin)
          return Response.json({ error: 'Forbidden' }, { status: 403 });
        if (unconfiguredStarts-- > 0)
          return Response.json(
            { error: 'Cloudflare sign-in is not configured yet.' },
            { status: 503 }
          );
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
  it('waits for sign-in to be configured at the edge it reaches', async () => {
    expect(await check({ unconfiguredStarts: 2, timeoutMs: '5000' })).toContain('Installer live');
    const starts = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => String(input).endsWith('/oauth/start'));
    expect(starts).toHaveLength(3);
  });
  it('fails when sign-in stays unconfigured past the deadline', async () => {
    await expect(check({ unconfiguredStarts: 1e6, timeoutMs: '30' })).rejects.toThrow(
      'Sign-in did not redirect to Cloudflare (status 503)'
    );
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
describe('an installer address that answers this client with a Cloudflare challenge', () => {
  const publicRequests = () =>
    vi.mocked(fetch).mock.calls.filter(([input]) => String(input).startsWith(ORIGIN));
  it('is verified through the Cloudflare API, and says sign-in was not exercised', async () => {
    const output = await check({ challenged: true });
    expect(output).toContain('Through the Cloudflare API: commit ' + 'd'.repeat(40));
    expect(output).toContain('Sign-in was not exercised');
    expect(output).toContain('its workers.dev address is enabled');
    expect(output).not.toContain('Installer live');
    expect(publicRequests()).toHaveLength(1);
  });
  it.each([
    ['another commit', { apiBuildSha: 'c'.repeat(40) }, `BUILD_SHA=${'c'.repeat(40)}`],
    ['bootstrap mode', { apiBootstrap: true }, 'INSTALL_SOURCE_COMMIT=undefined'],
    ['a missing OAuth secret', { apiMissingSecret: true }, 'oauthSecrets=false'],
  ] as const)('fails when the API shows %s', async (_label, options, message) => {
    await expect(check({ challenged: true, ...options })).rejects.toThrow(message);
  });
  it('checks that a custom domain and its route lead to this installer', async () => {
    const output = await check({ challenged: true, origin: 'https://install.example.com' });
    expect(output).toContain('its custom domain and route lead to this Worker');
    const asked = vi
      .mocked(fetch)
      .mock.calls.map(([input]) => new URL(String(input)))
      .filter((url) => url.hostname === 'api.cloudflare.com')
      .map((url) => url.pathname + url.search);
    expect(asked).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\/workers\/domains\?zone_name=example\.com$/),
        '/client/v4/zones?name=example.com',
        `/client/v4/zones/${'z'.repeat(32)}/workers/routes`,
      ])
    );
  });
  it.each([
    [
      'the custom domain leads to another Worker',
      { domainService: 'sam-api' },
      'customDomain=false route=true',
    ],
    [
      'the hostname route leads to another Worker',
      { routeScript: 'sam-api' },
      'customDomain=true route=false',
    ],
    ['the hostname route is missing', { routeScript: null }, 'customDomain=true route=false'],
  ] as const)('fails when %s', async (_label, options, message) => {
    await expect(
      check({ challenged: true, origin: 'https://install.example.com', ...options })
    ).rejects.toThrow(
      `install.example.com does not lead to installer sam-installer-self-hosted; ${message}`
    );
  });
  it('fails when a challenged workers.dev installer is not enabled there', async () => {
    await expect(check({ challenged: true, workersDevEnabled: false })).rejects.toThrow(
      'is not enabled on workers.dev'
    );
  });
  it('control: a 403 that is not a challenge is still a failure', async () => {
    await expect(check({ forbidden: true })).rejects.toThrow(
      'is not ready; status=403 type=text/html'
    );
  });
  it('control: an installer that answers gets the full check, not the API shortcut', async () => {
    const output = await check();
    expect(output).toContain('Cloudflare accepts its sign-in client and callback');
    expect(output).not.toContain('Through the Cloudflare API');
    expect(publicRequests().length).toBeGreaterThan(2);
  });
});
