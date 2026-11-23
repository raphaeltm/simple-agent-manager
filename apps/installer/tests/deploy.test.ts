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
  gitHead: '',
  unlinks: 0,
  events: [] as string[],
}));
vi.mock('node:child_process', () => ({ spawnSync: capture.run }));
// The real resolver is covered by git-head.test.ts and by the staging recipe run.
vi.mock('../scripts/git-head.mjs', () => ({ checkedOutCommit: () => capture.gitHead }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  writeFile: vi.fn(async (_path: string, data: string) => {
    capture.writes.push(data);
    capture.events.push('write-config');
  }),
  unlink: vi.fn(async () => {
    capture.unlinks++;
  }),
}));
// Fixture IDs verified against live GET /oauth/scopes on 2026-10-28 (the three email
// scopes on 2026-11-08; cloudflared Write on 2026-11-10). In
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
  'zone-settings.write',
  'email-routing-rule.write',
  'email-sending.write',
  'artifacts.read',
  'artifacts.write',
  'teams-connector-cloudflared.write',
];
const bootstrapScopes = ['account-settings.read', 'workers-scripts.write'];
// Shipped before 2026-11-06; workers-scripts.edit (Workers Editor) cannot create Workers.
const editorBootstrapScopes = ['account-settings.read', 'workers-scripts.edit'];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  capture.writes = [];
  capture.calls = [];
  capture.events = [];
  capture.unlinks = 0;
  capture.run.mockReset();
  capture.run.mockImplementation(() => ({ status: 0 }));
});
interface Options {
  existing?: 'bootstrap' | 'full' | 'legacy-full' | 'editor-bootstrap';
  ready?: boolean;
  mode?: string;
  managementDenied?: boolean;
  registrationToken?: string;
  sha?: string;
  missingScope?: boolean | string;
  laggingSecretReads?: number;
  secretsNeverVisible?: boolean;
  orphanClient?: boolean;
  /** BASE_DOMAIN; '' deploys without one. */
  domain?: string;
  /** INSTALLER_ENVIRONMENT; '' uses the self-hosted default. */
  environment?: string;
  /** APP_ORIGIN of an already deployed installer. */
  existingOrigin?: string;
  existingArtifactBaseUrl?: string;
  artifactBaseUrl?: string;
  /** The checked-out commit; null means there is no checkout. */
  gitHead?: string | null;
  /** Status of the upstream commit check; 'offline' rejects the request; 'hang' never answers. */
  upstream?: number | 'offline' | 'hang';
  /** Cloudflare API calls never answer. */
  hangingApi?: boolean;
  /** Account workers.dev subdomain; null means the account has none. */
  subdomain?: string | null;
  workersDenied?: boolean;
  /** Client creations Cloudflare answers with 500 after the installer is published. */
  failedClientCreations?: number;
  /** A failed creation that nevertheless left a client behind. */
  failedCreationLeavesClient?: boolean;
  /** How a failed creation fails: an HTTP status (default 500), a dropped connection, or a
   * refusal with no JSON body. */
  creationFailure?: number | 'offline' | 'empty-403';
  /** Freeze the clock and advance it by this much on each failed creation. */
  clockStepMs?: number;
  createTimeoutMs?: string;
  /** Supply OAUTH_CLIENT_ID without its secret. */
  clientIdOnly?: boolean;
  /** Extra bindings on the deployed installer. */
  extraBindings?: { name: string; type: string; text?: string }[];
  wranglerStatus?: number;
  liveTimeoutMs?: string;
  env?: Record<string, string>;
  /** Health responses that fail before the published installer answers. */
  unservedHealthChecks?: number;
}
const ACCOUNT = 'a'.repeat(32);
/** A request that never answers: it ends only when the caller's own timeout aborts it. */
const untilAborted = (init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
const wranglerRuns = () => capture.run.mock.calls;
const existingScopes = (existing: Options['existing']) =>
  existing === 'legacy-full'
    ? fullScopes.filter((scope) => scope !== 'teams-connector-cloudflared.write')
    : existing === 'full'
      ? fullScopes
      : existing === 'editor-bootstrap'
        ? editorBootstrapScopes
        : bootstrapScopes;
async function deploy(options: Options = {}) {
  vi.spyOn(process, 'chdir').mockImplementation(() => {});
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'DEPLOY_TOKEN');
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', ACCOUNT);
  vi.spyOn(console, 'log').mockImplementation((line: string) => {
    capture.events.push(`log ${line}`);
  });
  capture.gitHead = options.gitHead === null ? '' : (options.gitHead ?? 'd'.repeat(40));
  vi.stubEnv('BASE_DOMAIN', options.domain ?? 'sammy.party');
  vi.stubEnv('INSTALLER_ENVIRONMENT', options.environment ?? 'staging');
  vi.stubEnv('ARTIFACT_BASE_URL', options.artifactBaseUrl ?? '');
  vi.stubEnv('INSTALLER_LIVE_POLL_MS', '1');
  vi.stubEnv('INSTALLER_MODE', options.mode || 'preserve');
  vi.stubEnv('OAUTH_CLIENT_ID', options.orphanClient ? 'existing' : '');
  vi.stubEnv(
    'OAUTH_CLIENT_SECRET',
    options.orphanClient && !options.clientIdOnly ? 'OPERATOR_SECRET' : ''
  );
  vi.stubEnv('OAUTH_CLIENT_CREATE_TIMEOUT_MS', options.createTimeoutMs ?? '');
  vi.stubEnv('INSTALLER_LIVE_TIMEOUT_MS', options.liveTimeoutMs ?? '');
  capture.run.mockImplementation(() => ({ status: options.wranglerStatus ?? 0 }));
  vi.stubEnv('OAUTH_REGISTRATION_TOKEN', options.registrationToken || '');
  vi.stubEnv('GITHUB_SHA', options.sha ?? 'b'.repeat(40));
  vi.stubEnv('OAUTH_SECRETS_POLL_MS', '1');
  vi.stubEnv('OAUTH_SECRETS_VISIBLE_TIMEOUT_MS', options.secretsNeverVisible ? '0' : '30000');
  let laggingSecretReads = options.laggingSecretReads ?? 0;
  let unservedHealthChecks = options.unservedHealthChecks ?? 0;
  let failedClientCreations = options.failedClientCreations ?? 0;
  let clock = 1_700_000_000_000;
  if (options.clockStepMs) vi.spyOn(Date, 'now').mockImplementation(() => clock);
  vi.stubEnv('OAUTH_CLIENT_CREATE_RETRY_MS', '1');
  const workerName = `sam-installer-${(options.environment ?? 'staging') || 'self-hosted'}`;
  const deployedOrigin = options.existingOrigin ?? 'https://install.sammy.party';
  const ready = options.ready ?? !!options.existing;
  let client: Record<string, unknown> | undefined =
    options.existing || options.orphanClient
      ? {
          client_id: 'existing',
          client_name: workerName,
          client_uri: deployedOrigin,
          scopes: [...existingScopes(options.existing ?? 'bootstrap')],
          grant_types: ['authorization_code'],
          response_types: ['code'],
          redirect_uris: [`${deployedOrigin}/oauth/callback`],
          token_endpoint_auth_method: 'client_secret_post',
        }
      : undefined;
  const secretNames = ready ? ['OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET'] : [];
  const oauthResult = (path: string, method: string, body: Record<string, unknown>) => {
    let result: unknown;
    if (path === '/client/v4/oauth/scopes')
      result = [...fullScopes, ...bootstrapScopes]
        .filter(
          (scope) =>
            scope !==
            (options.missingScope === true ? 'account-api-tokens.write' : options.missingScope)
        )
        .map((id) => ({ id }));
    else if (path.endsWith('/oauth_clients')) {
      if (method === 'GET') result = client ? [client] : [];
      // Cloudflare refused creation while the logo/policy URLs on a not yet
      // published installer origin were unreachable (production, 2026-11-08).
      else if (wranglerRuns().length === 0)
        return Response.json({ success: false }, { status: 500 });
      else if (failedClientCreations-- > 0) {
        if (options.failedCreationLeavesClient) client = { ...body, client_id: 'half-made' };
        clock += options.clockStepMs ?? 0;
        if (options.creationFailure === 'offline') throw new Error('socket hang up');
        if (options.creationFailure === 'empty-403') return new Response('', { status: 403 });
        return Response.json(
          { success: false, errors: [{ code: 1001 }] },
          { status: options.creationFailure ?? 500 }
        );
      } else {
        client = { ...body, client_id: 'new', client_secret: 'SECRET' };
        result = client;
      }
    } else if (path.includes('/oauth_clients/')) {
      if (method === 'PATCH') client = { ...client, ...body };
      result = client;
    }
    return result;
  };
  const workerSettings = () => {
    if (!options.existing) return Response.json({ success: false }, { status: 404 });
    return {
      bindings: [
        { name: 'APP_ORIGIN', type: 'plain_text', text: deployedOrigin },
        ...(options.existingArtifactBaseUrl
          ? [
              {
                name: 'ARTIFACT_BASE_URL',
                type: 'plain_text',
                text: options.existingArtifactBaseUrl,
              },
            ]
          : []),
        {
          name: 'OAUTH_SCOPES',
          type: 'plain_text',
          text: existingScopes(options.existing).join(' '),
        },
        ...(options.existing === 'full' || options.existing === 'legacy-full'
          ? [{ name: 'INSTALL_SOURCE_COMMIT', type: 'plain_text', text: 'c'.repeat(40) }]
          : []),
        ...secretNames.map((name) => ({ name, type: 'secret_text' })),
        ...(options.extraBindings ?? []),
      ],
    };
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const { hostname, pathname: path } = new URL(url);
      if (hostname === 'raw.githubusercontent.com') {
        capture.events.push(`upstream ${init.method} ${path}`);
        if (options.upstream === 'offline') throw new Error('offline');
        if (options.upstream === 'hang') return untilAborted(init);
        return new Response(null, { status: options.upstream ?? 200 });
      }
      if (hostname !== 'api.cloudflare.com') {
        capture.events.push(`served ${hostname}${path}`);
        return new Response('{}', { status: unservedHealthChecks-- > 0 ? 503 : 200 });
      }
      if (options.hangingApi) return untilAborted(init);
      // The real API serves these only under this account, with a bearer token.
      if (path !== '/client/v4/oauth/scopes' && !path.startsWith(`/client/v4/accounts/${ACCOUNT}/`))
        return Response.json({ success: false }, { status: 404 });
      if (!/^Bearer \S+$/.test(new Headers(init.headers).get('Authorization') ?? ''))
        return Response.json({ success: false }, { status: 401 });
      const method = init.method || 'GET',
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
      if (options.workersDenied && path.includes('/workers/'))
        return Response.json({ success: false }, { status: 403 });
      let result: unknown;
      if (path.endsWith('/workers/subdomain')) {
        if (method !== 'GET') return Response.json({ success: false }, { status: 405 });
        if (options.subdomain === null) return Response.json({ success: false }, { status: 404 });
        result = { subdomain: options.subdomain ?? 'acme' };
      } else if (path.endsWith('/settings')) {
        const settings = workerSettings();
        if (settings instanceof Response) return settings;
        result = settings;
      } else if (path.includes('/oauth_clients') || path === '/client/v4/oauth/scopes') {
        result = oauthResult(path, method, body);
        if (result instanceof Response) return result;
      } else if (path.endsWith('/secrets')) {
        if (method === 'PUT') {
          if (body.type !== 'secret_text' || typeof body.text !== 'string' || !body.text)
            return Response.json({ success: false }, { status: 400 });
          if (!secretNames.includes(String(body.name))) secretNames.push(String(body.name));
          result = {};
        } else if (options.secretsNeverVisible || laggingSecretReads-- > 0) result = [];
        else result = secretNames.map((name) => ({ name }));
      } else throw new Error('Unexpected deployment API endpoint');
      return Response.json({ success: true, result });
    })
  );
  // Last, so a test can override anything the harness sets above.
  for (const [key, value] of Object.entries(options.env ?? {})) vi.stubEnv(key, value);
  await import('../scripts/deploy.mjs');
}
const config = () => JSON.parse(capture.writes[0] ?? '{}');
describe('publisher-controlled installer deployment', () => {
  it('creates a fresh private bootstrap client and never persists credentials to disk or CLI arguments', async () => {
    expect(
      JSON.parse(await readFile('wrangler.json', 'utf8')).durable_objects.bindings[0].name
    ).toBe('SESSIONS');
    await deploy({ mode: 'bootstrap' });
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
    expect(capture.run.mock.calls[0]?.[0]).toBe(process.execPath);
    expect(capture.run.mock.calls[0]?.[1]?.[0]).toMatch(
      /\/apps\/installer\/node_modules\/wrangler\/bin\/wrangler\.js$/
    );
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
  it('adds tunnel consent to a preserved older full installer before publishing new source', async () => {
    await deploy({ existing: 'legacy-full' });
    expect(config().vars.INSTALL_SOURCE_COMMIT).toBe('b'.repeat(40));
    expect(config().vars.OAUTH_SCOPES.split(' ')).toEqual(fullScopes);
    expect(capture.calls.find((call) => call.method === 'PATCH')?.body.scopes).toEqual(fullScopes);
    expect(capture.events.findIndex((entry) => entry.startsWith('PATCH '))).toBeLessThan(
      capture.events.indexOf('write-config')
    );
  });
  it('does not repin an older full installer when tunnel consent cannot be reconciled', async () => {
    await expect(deploy({ existing: 'legacy-full', managementDenied: true })).rejects.toThrow(
      'permissions'
    );
    expect(capture.run).not.toHaveBeenCalled();
    expect(capture.writes).toHaveLength(0);
  });
  it('requires the verified cloudflared scope in the live catalog before the full upgrade', async () => {
    await expect(
      deploy({ existing: 'legacy-full', missingScope: 'teams-connector-cloudflared.write' })
    ).rejects.toThrow('catalog');
    expect(capture.run).not.toHaveBeenCalled();
    expect(capture.writes).toHaveLength(0);
  });
  it('explicit bootstrap mode removes full-mode pin and reconciles reduced client consent', async () => {
    await deploy({ existing: 'full', mode: 'bootstrap' });
    expect(config().vars.INSTALL_SOURCE_COMMIT).toBeUndefined();
    expect(config().vars.OAUTH_SCOPES.split(' ')).toEqual(bootstrapScopes);
    expect(capture.calls.find((call) => call.method === 'PATCH')?.body.scopes).toEqual(
      bootstrapScopes
    );
  });
  it('upgrades a preserved Workers Editor bootstrap consent before publishing', async () => {
    await deploy({ existing: 'editor-bootstrap' });
    expect(config().vars.INSTALL_SOURCE_COMMIT).toBeUndefined();
    expect(config().vars.OAUTH_SCOPES.split(' ')).toEqual(bootstrapScopes);
    const patch = capture.calls.find((call) => call.method === 'PATCH');
    expect(patch?.body.scopes).toEqual(bootstrapScopes);
    expect(capture.events.findIndex((entry) => entry.startsWith('PATCH '))).toBeLessThan(
      capture.events.indexOf('write-config')
    );
  });
  it('control: a preserved current bootstrap consent is left untouched', async () => {
    await deploy({ existing: 'bootstrap', managementDenied: true });
    expect(config().vars.OAUTH_SCOPES.split(' ')).toEqual(bootstrapScopes);
    expect(capture.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });
  it('refuses to publish the Editor upgrade without OAuth management permission', async () => {
    await expect(deploy({ existing: 'editor-bootstrap', managementDenied: true })).rejects.toThrow(
      'permissions'
    );
    expect(capture.run).not.toHaveBeenCalled();
    expect(capture.writes).toHaveLength(0);
  });
  it('waits for a lagging secrets list instead of failing a completed full enablement', async () => {
    await deploy({ existing: 'bootstrap', mode: 'full', laggingSecretReads: 2 });
    const reads = capture.calls.filter(
      (call) => call.method === 'GET' && call.path.endsWith('/secrets')
    );
    expect(reads).toHaveLength(3);
    expect(config().vars.INSTALL_SOURCE_COMMIT).toBe('b'.repeat(40));
  });
  it('control: still fails readiness when the OAuth secrets never appear', async () => {
    await expect(
      deploy({ existing: 'bootstrap', mode: 'full', secretsNeverVisible: true })
    ).rejects.toThrow('readiness was not established');
  });
  it('blocks full enablement before publishing when management permission or a live scope is missing', async () => {
    await expect(
      deploy({ existing: 'bootstrap', mode: 'full', managementDenied: true })
    ).rejects.toThrow('permissions');
    expect(capture.run).not.toHaveBeenCalled();
    expect(capture.writes).toHaveLength(0);
  });
  it('creates a fresh full-mode client only after the installer and its assets are published', async () => {
    await deploy({ mode: 'full' });
    expect(config().vars.INSTALL_SOURCE_COMMIT).toBe('b'.repeat(40));
    expect(config().vars.OAUTH_SCOPES.split(' ')).toEqual(fullScopes);
    const listed = capture.events.findIndex((entry) => entry.endsWith('/oauth_clients'));
    const created = capture.events.indexOf(`POST /client/v4/accounts/${ACCOUNT}/oauth_clients`);
    expect(listed).toBeGreaterThanOrEqual(0);
    expect(listed).toBeLessThan(capture.events.indexOf('write-config'));
    expect(created).toBeGreaterThan(capture.events.indexOf('write-config'));
    expect(capture.calls.find((call) => call.method === 'POST')?.body.scopes).toEqual(fullScopes);
    expect(capture.calls.filter((call) => call.method === 'PUT')).toHaveLength(2);
  });
  it('updates an operator-supplied leftover client only after a fresh installer is published', async () => {
    await deploy({ mode: 'full', orphanClient: true });
    const patched = capture.events.findIndex((entry) => entry.startsWith('PATCH '));
    expect(patched).toBeGreaterThan(capture.events.indexOf('write-config'));
    expect(capture.calls.find((call) => call.method === 'PATCH')?.body.scopes).toEqual(fullScopes);
    expect(capture.calls.some((call) => call.method === 'POST')).toBe(false);
    expect(capture.calls.filter((call) => call.method === 'PUT')).toHaveLength(2);
  });
  it('blocks a fresh full deployment before publishing when management access is denied', async () => {
    await expect(deploy({ mode: 'full', managementDenied: true })).rejects.toThrow('permissions');
    expect(capture.run).not.toHaveBeenCalled();
  });
  it('rejects unsupported consent identifiers before enabling full mode', async () => {
    await expect(deploy({ mode: 'full', missingScope: true })).rejects.toThrow('catalog');
    expect(capture.run).not.toHaveBeenCalled();
  });
  it('keeps fresh bootstrap asset deployment while still failing OAuth readiness honestly', async () => {
    await expect(deploy({ mode: 'bootstrap', managementDenied: true })).rejects.toThrow(
      'permissions'
    );
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
    expect(capture.events.some((entry) => entry.startsWith('upstream '))).toBe(false);
  });
});
const selfHosted = { environment: '', domain: '', sha: '' } as const;
const SELF_ORIGIN = 'https://sam-installer-self-hosted.acme.workers.dev';
const logged = () => capture.events.filter((entry) => entry.startsWith('log ')).join('\n');
const published = () => wranglerRuns().length > 0;
describe('own-account installer deployment (the documented command)', () => {
  it('with only a token and account ID, deploys a full installer on workers.dev pinned to the checked-out commit', async () => {
    await deploy(selfHosted);
    expect(config().name).toBe('sam-installer-self-hosted');
    expect(config().workers_dev).toBe(true);
    expect(config().preview_urls).toBe(false);
    expect(config().routes).toBeUndefined();
    expect(config().vars.APP_ORIGIN).toBe(SELF_ORIGIN);
    expect(config().vars.INSTALL_SOURCE_COMMIT).toBe('d'.repeat(40));
    expect(config().vars.BUILD_SHA).toBe('d'.repeat(40));
    expect(config().vars.OAUTH_SCOPES.split(' ')).toEqual(fullScopes);
    expect(config().vars.ARTIFACT_BASE_URL).toBe(
      'https://github.com/raphaeltm/simple-agent-manager/releases/latest/download'
    );
    const created = capture.calls.find(
      (call) => call.path.endsWith('/oauth_clients') && call.method === 'POST'
    );
    expect(created?.body).toMatchObject({
      client_name: 'sam-installer-self-hosted',
      client_uri: SELF_ORIGIN,
      redirect_uris: [`${SELF_ORIGIN}/oauth/callback`],
      scopes: fullScopes,
    });
    expect(capture.calls.some((call) => call.body.visibility === 'public')).toBe(false);
    expect(logged()).toContain(`Installer ready: ${SELF_ORIGIN}`);
    expect(logged()).toContain('Sign in with Cloudflare');
  });
  it('checks the pinned commit against the upstream repository before publishing', async () => {
    await deploy(selfHosted);
    const checked = capture.events.indexOf(
      `upstream HEAD /raphaeltm/simple-agent-manager/${'d'.repeat(40)}/scripts/deploy/installer-protocol.json`
    );
    expect(checked).toBeGreaterThanOrEqual(0);
    expect(checked).toBeLessThan(capture.events.indexOf('write-config'));
  });
  it('stops before publishing when the checked-out commit is not upstream', async () => {
    await expect(deploy({ ...selfHosted, upstream: 404 })).rejects.toThrow(
      `Commit ${'d'.repeat(40)} is not in raphaeltm/simple-agent-manager`
    );
    expect(published()).toBe(false);
    expect(capture.writes).toHaveLength(0);
    expect(capture.calls.some((call) => call.method !== 'GET')).toBe(false);
  });
  it.each([500, 'offline'] as const)(
    'stops before publishing when the upstream check cannot be made (%s)',
    async (upstream) => {
      await expect(deploy({ ...selfHosted, upstream })).rejects.toThrow('Could not check commit');
      expect(published()).toBe(false);
      expect(capture.writes).toHaveLength(0);
    }
  );
  it('stops with instructions when there is no checkout and no GITHUB_SHA', async () => {
    await expect(deploy({ ...selfHosted, gitHead: null })).rejects.toThrow(
      'Could not read the checked-out commit'
    );
    expect(published()).toBe(false);
  });
  it('an explicit GITHUB_SHA wins over the checkout', async () => {
    await deploy({ ...selfHosted, sha: 'e'.repeat(40) });
    expect(config().vars.INSTALL_SOURCE_COMMIT).toBe('e'.repeat(40));
    expect(config().vars.BUILD_SHA).toBe('e'.repeat(40));
  });
  it('stops with instructions when the account has no workers.dev address', async () => {
    await expect(deploy({ ...selfHosted, subdomain: null })).rejects.toThrow(
      'no workers.dev address yet'
    );
    expect(published()).toBe(false);
    expect(capture.writes).toHaveLength(0);
  });
  it('BASE_DOMAIN still serves a new installer at install.<domain>', async () => {
    await deploy({ ...selfHosted, domain: 'example.com' });
    expect(config().workers_dev).toBe(false);
    expect(config().vars.APP_ORIGIN).toBe('https://install.example.com');
    expect(config().routes).toEqual([
      { pattern: 'install.example.com', custom_domain: true },
      { pattern: 'install.example.com/*', zone_name: 'example.com' },
    ]);
    expect(capture.calls.some((call) => call.path.endsWith('/workers/subdomain'))).toBe(false);
  });
  it('redeploying without BASE_DOMAIN keeps an installer on its custom domain', async () => {
    await deploy({
      ...selfHosted,
      existing: 'full',
      existingOrigin: 'https://install.example.com',
    });
    expect(config().vars.APP_ORIGIN).toBe('https://install.example.com');
    expect(config().workers_dev).toBe(false);
    expect(config().routes).toEqual([
      { pattern: 'install.example.com', custom_domain: true },
      { pattern: 'install.example.com/*', zone_name: 'example.com' },
    ]);
    expect(capture.calls.some((call) => call.path.endsWith('/workers/subdomain'))).toBe(false);
    expect(capture.calls.some((call) => call.path.includes('/oauth_clients'))).toBe(false);
  });
  it('redeploying keeps a workers.dev installer and its OAuth client', async () => {
    await deploy({ ...selfHosted, existing: 'full', existingOrigin: SELF_ORIGIN });
    expect(config().vars.APP_ORIGIN).toBe(SELF_ORIGIN);
    expect(config().workers_dev).toBe(true);
    expect(config().vars.INSTALL_SOURCE_COMMIT).toBe('d'.repeat(40));
    expect(capture.calls.some((call) => call.path.includes('/oauth_clients'))).toBe(false);
  });
  it('an existing bootstrap installer keeps its mode and says how to change it', async () => {
    await deploy({ ...selfHosted, existing: 'bootstrap', existingOrigin: SELF_ORIGIN });
    expect(config().vars.INSTALL_SOURCE_COMMIT).toBeUndefined();
    expect(logged()).toContain('INSTALLER_MODE=full');
  });
  it('waits for the published installer to answer before creating its OAuth client', async () => {
    await deploy({ ...selfHosted, unservedHealthChecks: 2 });
    const served = capture.events
      .map((entry, index) =>
        entry === 'served sam-installer-self-hosted.acme.workers.dev/health' ? index : -1
      )
      .filter((index) => index >= 0);
    expect(served).toHaveLength(3);
    expect(served[0]).toBeGreaterThan(capture.events.indexOf('write-config'));
    expect(served[2]).toBeLessThan(
      capture.events.indexOf(`POST /client/v4/accounts/${ACCOUNT}/oauth_clients`)
    );
  });
});
describe('prebuilt artifact location', () => {
  it('an explicit URL wins over the deployed one', async () => {
    await deploy({
      existing: 'full',
      existingArtifactBaseUrl: 'https://old.example/artifacts',
      artifactBaseUrl: 'https://new.example/artifacts',
    });
    expect(config().vars.ARTIFACT_BASE_URL).toBe('https://new.example/artifacts');
  });
  it('an unset URL keeps what the deployed installer has', async () => {
    await deploy({ existing: 'full', existingArtifactBaseUrl: 'https://old.example/artifacts' });
    expect(config().vars.ARTIFACT_BASE_URL).toBe('https://old.example/artifacts');
  });
  it('an installer deployed without one gains the release default on redeploy', async () => {
    await deploy({ existing: 'full' });
    expect(config().vars.ARTIFACT_BASE_URL).toBe(
      'https://github.com/raphaeltm/simple-agent-manager/releases/latest/download'
    );
  });
  // builder.test.ts proves the builder hands only an https value to the build.
  it('"none" is stored so every installation builds from source', async () => {
    await deploy({
      existing: 'full',
      existingArtifactBaseUrl: 'https://old.example/artifacts',
      artifactBaseUrl: 'none',
    });
    expect(config().vars.ARTIFACT_BASE_URL).toBe('none');
  });
  it('a later deploy without the variable keeps the build-from-source choice', async () => {
    await deploy({ existing: 'full', existingArtifactBaseUrl: 'none' });
    expect(config().vars.ARTIFACT_BASE_URL).toBe('none');
  });
  it('"default" returns to SAM’s latest release', async () => {
    await deploy({ existing: 'full', existingArtifactBaseUrl: 'none', artifactBaseUrl: 'default' });
    expect(config().vars.ARTIFACT_BASE_URL).toBe(
      'https://github.com/raphaeltm/simple-agent-manager/releases/latest/download'
    );
  });
  it('rejects a URL carrying credentials or a query', async () => {
    await expect(
      deploy({ existing: 'full', artifactBaseUrl: 'https://user@example.com/a?b' })
    ).rejects.toThrow('ARTIFACT_BASE_URL');
    expect(published()).toBe(false);
  });
});
describe('refused Cloudflare calls name the permission to add', () => {
  it('Workers Scripts Write, before anything is published', async () => {
    await expect(deploy({ ...selfHosted, workersDenied: true })).rejects.toThrow(
      '"Workers Scripts Write"'
    );
    expect(published()).toBe(false);
    expect(capture.writes).toHaveLength(0);
  });
  it('OAuth Client Write, before anything is published', async () => {
    await expect(deploy({ ...selfHosted, managementDenied: true })).rejects.toThrow(
      '"OAuth Client Write"'
    );
    expect(published()).toBe(false);
    expect(capture.writes).toHaveLength(0);
  });
  it('never repeats the upstream response body', async () => {
    const failure = await deploy({ ...selfHosted, managementDenied: true }).catch(
      (error: Error) => error
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('Account → OAuth Client → Edit');
    expect(String(failure)).not.toContain('PRIVATE UPSTREAM');
  });
});
describe('creating the OAuth client after a first publish', () => {
  const creations = () =>
    capture.calls.filter((call) => call.path.endsWith('/oauth_clients') && call.method === 'POST');
  it('retries while Cloudflare cannot yet reach the new installer, and creates one client', async () => {
    await deploy({ ...selfHosted, failedClientCreations: 3 });
    expect(creations()).toHaveLength(4);
    expect(capture.calls.filter((call) => call.method === 'PUT')).toHaveLength(2);
    expect(logged()).toContain(`Installer ready: ${SELF_ORIGIN}`);
  });
  it('gives up once the configured time has passed and reports Cloudflare’s error code', async () => {
    await expect(
      deploy({ ...selfHosted, failedClientCreations: 99, createTimeoutMs: '0' })
    ).rejects.toThrow('Cloudflare POST failed (500, Cloudflare code 1001)');
    expect(creations()).toHaveLength(1);
    expect(logged()).not.toContain('Installer ready');
  });
  it('retries while time remains and stops at the deadline', async () => {
    // Each failure takes 10 s of a 25 s budget: attempts at 0, 10 and 20 s, none at 30 s.
    await expect(
      deploy({
        ...selfHosted,
        failedClientCreations: 99,
        createTimeoutMs: '25000',
        clockStepMs: 10_000,
      })
    ).rejects.toThrow('Cloudflare POST failed (500');
    expect(creations()).toHaveLength(3);
  });
  it('does not retry a refusal that arrives without a JSON body', async () => {
    await expect(
      deploy({ ...selfHosted, failedClientCreations: 99, creationFailure: 'empty-403' })
    ).rejects.toThrow(
      'Cloudflare refused POST (403). Check the API token’s permissions'.replace('’', "'")
    );
    expect(creations()).toHaveLength(1);
  });
  it('reports a client left behind by the last failed attempt instead of losing it', async () => {
    await expect(
      deploy({
        ...selfHosted,
        failedClientCreations: 1,
        failedCreationLeavesClient: true,
        createTimeoutMs: '0',
      })
    ).rejects.toThrow('OAuth secret missing');
    expect(creations()).toHaveLength(1);
  });
  it('retries a dropped connection after confirming no client was created', async () => {
    await deploy({ ...selfHosted, failedClientCreations: 1, creationFailure: 'offline' });
    expect(creations()).toHaveLength(2);
    expect(logged()).toContain(`Installer ready: ${SELF_ORIGIN}`);
  });
  it('reports a client created by a request whose response was lost', async () => {
    await expect(
      deploy({
        ...selfHosted,
        failedClientCreations: 1,
        creationFailure: 'offline',
        failedCreationLeavesClient: true,
      })
    ).rejects.toThrow('OAuth secret missing');
    expect(creations()).toHaveLength(1);
  });
  it('does not retry a creation Cloudflare refuses', async () => {
    await expect(
      deploy({ ...selfHosted, failedClientCreations: 99, creationFailure: 403 })
    ).rejects.toThrow('"OAuth Client Write"');
    expect(creations()).toHaveLength(1);
  });
  it('never creates a second client when a failed creation left one behind', async () => {
    await expect(
      deploy({ ...selfHosted, failedClientCreations: 1, failedCreationLeavesClient: true })
    ).rejects.toThrow('OAuth secret missing');
    expect(creations()).toHaveLength(1);
  });
});
describe('what the deploy writes', () => {
  const secretWrites = () =>
    capture.calls
      .filter((call) => call.method === 'PUT' && call.path.endsWith('/secrets'))
      .map((call) => call.body);
  it('stores the new client’s id and secret as Worker secrets', async () => {
    await deploy(selfHosted);
    expect(secretWrites()).toEqual([
      { name: 'OAUTH_CLIENT_ID', text: 'new', type: 'secret_text' },
      { name: 'OAUTH_CLIENT_SECRET', text: 'SECRET', type: 'secret_text' },
    ]);
  });
  it('stores an operator-supplied client’s secret', async () => {
    await deploy({ mode: 'full', orphanClient: true });
    expect(secretWrites()).toEqual([
      { name: 'OAUTH_CLIENT_ID', text: 'existing', type: 'secret_text' },
      { name: 'OAUTH_CLIENT_SECRET', text: 'OPERATOR_SECRET', type: 'secret_text' },
    ]);
  });
  it('keeps the stored secret when only an existing client’s scopes change', async () => {
    await deploy({ existing: 'bootstrap', mode: 'full' });
    expect(capture.calls.some((call) => call.method === 'PATCH')).toBe(true);
    expect(secretWrites()).toEqual([
      { name: 'OAUTH_CLIENT_ID', text: 'existing', type: 'secret_text' },
    ]);
  });
  it('never hands OAuth credentials to Wrangler', async () => {
    await deploy({ mode: 'full', orphanClient: true, registrationToken: 'REGISTRATION_PRIVATE' });
    const environment = (wranglerRuns()[0] as unknown as [string, string[], { env: object }])[2]
      .env;
    expect(environment).toHaveProperty('CLOUDFLARE_API_TOKEN', 'DEPLOY_TOKEN');
    for (const name of ['OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET', 'OAUTH_REGISTRATION_TOKEN'])
      expect(environment).not.toHaveProperty(name);
  });
  it('carries over deployed settings but never a secret-named plain binding', async () => {
    await deploy({
      existing: 'full',
      extraBindings: [
        { name: 'SESSION_TTL_SECONDS', type: 'plain_text', text: '600' },
        { name: 'OAUTH_CLIENT_SECRET', type: 'plain_text', text: 'LEAKED_PLAIN' },
        { name: 'OAUTH_REGISTRATION_TOKEN', type: 'plain_text', text: 'LEAKED_REGISTRATION' },
      ],
    });
    expect(config().vars.SESSION_TTL_SECONDS).toBe('600');
    expect(capture.writes.join('')).not.toMatch(/LEAKED/);
  });
  it('a failed publish creates no client, writes no secrets, and removes its config file', async () => {
    await expect(deploy({ ...selfHosted, wranglerStatus: 1 })).rejects.toThrow(
      'Wrangler command failed'
    );
    expect(capture.calls.some((call) => call.method !== 'GET')).toBe(false);
    expect(capture.writes).toHaveLength(1);
    expect(capture.unlinks).toBe(1);
  });
  it('bootstrap mode pins no commit and asks upstream nothing', async () => {
    await deploy({ ...selfHosted, mode: 'bootstrap', gitHead: null });
    expect(config().vars.BUILD_SHA).toBe('self-hosted');
    expect(config().vars).not.toHaveProperty('INSTALL_SOURCE_COMMIT');
    expect(capture.events.some((entry) => entry.startsWith('upstream '))).toBe(false);
    expect(published()).toBe(true);
  });
});
describe('an installer is never moved in place', () => {
  it.each([
    ['a workers.dev installer to a domain', { existingOrigin: SELF_ORIGIN, domain: 'example.com' }],
    [
      'one domain to another',
      { existingOrigin: 'https://install.old.example', domain: 'example.com' },
    ],
  ] as const)('refuses to move %s, and changes nothing', async (_label, options) => {
    await expect(deploy({ ...selfHosted, existing: 'full', ...options })).rejects.toThrow(
      `This installer is already deployed at ${options.existingOrigin}. To serve it at https://install.example.com, remove it first`
    );
    expect(published()).toBe(false);
    expect(capture.writes).toHaveLength(0);
    expect(capture.calls.some((call) => call.method !== 'GET')).toBe(false);
    expect(capture.calls.some((call) => call.path.includes('/oauth_clients'))).toBe(false);
  });
  it('control: the same address deploys and keeps the client and its secrets', async () => {
    await deploy({ ...selfHosted, existing: 'full', existingOrigin: SELF_ORIGIN });
    expect(published()).toBe(true);
    expect(config().vars.APP_ORIGIN).toBe(SELF_ORIGIN);
    expect(capture.calls.some((call) => call.path.includes('/oauth_clients'))).toBe(false);
    expect(capture.calls.some((call) => call.method !== 'GET')).toBe(false);
  });
  it('control: naming the installer’s current domain again is not a move', async () => {
    await deploy({
      ...selfHosted,
      existing: 'full',
      existingOrigin: 'https://install.example.com',
      domain: 'example.com',
    });
    expect(published()).toBe(true);
    expect(config().vars.APP_ORIGIN).toBe('https://install.example.com');
  });
  it('stops when the deployed address is not one this command can serve', async () => {
    await expect(
      deploy({ ...selfHosted, existing: 'full', existingOrigin: 'https://app.example.com' })
    ).rejects.toThrow('not supported');
    expect(published()).toBe(false);
  });
});
describe('OAuth client problems are reported before anything is written', () => {
  it('an existing client whose secret is not on the Worker', async () => {
    await expect(deploy({ existing: 'bootstrap', ready: false, mode: 'full' })).rejects.toThrow(
      'OAuth secret missing'
    );
    expect(capture.calls.some((call) => call.method === 'PUT')).toBe(false);
    expect(published()).toBe(false);
  });
  it('an explicit client id without its secret', async () => {
    await expect(
      deploy({ existing: 'bootstrap', mode: 'full', orphanClient: true, clientIdOnly: true })
    ).rejects.toThrow('requires its private secret');
    expect(capture.calls.some((call) => call.method === 'PUT')).toBe(false);
  });
  it('an explicit client that belongs to another address', async () => {
    await expect(
      deploy({ mode: 'full', orphanClient: true, existingOrigin: 'https://install.other.example' })
    ).rejects.toThrow('does not belong');
    expect(published()).toBe(false);
    expect(capture.calls.some((call) => call.method !== 'GET')).toBe(false);
  });
});
describe('input validation', () => {
  it.each([
    ['a domain with a path', { domain: 'example.com/x' }, 'not a valid domain'],
    ['an unknown mode', { mode: 'sideways' }, 'Invalid installer mode'],
    [
      'an environment with unsafe characters',
      { environment: 'a/../b' },
      'Invalid installer environment',
    ],
    [
      'a non-numeric timeout',
      { env: { INSTALLER_LIVE_TIMEOUT_MS: 'soon' } },
      'INSTALLER_LIVE_TIMEOUT_MS must be',
    ],
    [
      'a zero poll interval',
      { env: { OAUTH_SECRETS_POLL_MS: '0' } },
      'OAUTH_SECRETS_POLL_MS must be',
    ],
    [
      'a negative retry interval',
      { env: { OAUTH_CLIENT_CREATE_RETRY_MS: '-5' } },
      'OAUTH_CLIENT_CREATE_RETRY_MS must be',
    ],
    [
      'a fractional create timeout',
      { env: { OAUTH_CLIENT_CREATE_TIMEOUT_MS: '1.5' } },
      'OAUTH_CLIENT_CREATE_TIMEOUT_MS must be',
    ],
    [
      'a non-numeric API timeout',
      { env: { INSTALLER_API_TIMEOUT_MS: 'slow' } },
      'INSTALLER_API_TIMEOUT_MS must be',
    ],
    [
      'a zero probe timeout',
      { env: { INSTALLER_PROBE_TIMEOUT_MS: '0' } },
      'INSTALLER_PROBE_TIMEOUT_MS must be',
    ],
    [
      'an interval longer than a timer can wait',
      { env: { INSTALLER_LIVE_POLL_MS: '2147483648' } },
      'INSTALLER_LIVE_POLL_MS must be',
    ],
  ] as const)('rejects %s before changing anything', async (_label, options, message) => {
    await expect(deploy({ ...selfHosted, ...options })).rejects.toThrow(message);
    expect(published()).toBe(false);
    expect(capture.writes).toHaveLength(0);
    expect(capture.calls.some((call) => call.method !== 'GET')).toBe(false);
  });
  it('control: the largest interval a timer can wait is accepted', async () => {
    await deploy({ ...selfHosted, env: { INSTALLER_LIVE_POLL_MS: '2147483647' } });
    expect(published()).toBe(true);
  });
  it('rejects a malformed account id before any request', async () => {
    vi.spyOn(process, 'chdir').mockImplementation(() => {});
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'DEPLOY_TOKEN');
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'not-an-account');
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    await expect(import('../scripts/deploy.mjs')).rejects.toThrow('CLOUDFLARE_ACCOUNT_ID');
    expect(fetched).not.toHaveBeenCalled();
  });
});
describe('request timeouts are settings', () => {
  it('gives up on a Cloudflare API call after INSTALLER_API_TIMEOUT_MS', async () => {
    await expect(
      deploy({ ...selfHosted, hangingApi: true, env: { INSTALLER_API_TIMEOUT_MS: '20' } })
    ).rejects.toThrow('Cloudflare request could not complete');
    expect(published()).toBe(false);
  });
  it('gives up on the upstream check after INSTALLER_PROBE_TIMEOUT_MS', async () => {
    await expect(
      deploy({ ...selfHosted, upstream: 'hang', env: { INSTALLER_PROBE_TIMEOUT_MS: '20' } })
    ).rejects.toThrow('Could not check commit');
    expect(published()).toBe(false);
  });
});
describe('waiting for a freshly published installer', () => {
  it('proceeds once INSTALLER_LIVE_TIMEOUT_MS has passed, and still finishes', async () => {
    await deploy({ ...selfHosted, unservedHealthChecks: 1e6, liveTimeoutMs: '20' });
    expect(logged()).toContain(`Installer ready: ${SELF_ORIGIN}`);
  });
  it('a poll interval longer than the timeout cannot outlast it', async () => {
    await deploy({
      ...selfHosted,
      unservedHealthChecks: 1e6,
      liveTimeoutMs: '30',
      env: { INSTALLER_LIVE_POLL_MS: '2147483647' },
    });
    expect(logged()).toContain(`Installer ready: ${SELF_ORIGIN}`);
  });
  it('the secrets check gives up at its timeout whatever the poll interval', async () => {
    await expect(
      deploy({
        existing: 'bootstrap',
        mode: 'full',
        secretsNeverVisible: true,
        env: { OAUTH_SECRETS_VISIBLE_TIMEOUT_MS: '30', OAUTH_SECRETS_POLL_MS: '2147483647' },
      })
    ).rejects.toThrow('readiness was not established');
    expect(published()).toBe(true);
  });
  it('does not wait when the client was settled before publishing', async () => {
    await deploy({ existing: 'bootstrap', mode: 'full' });
    expect(capture.events.some((entry) => entry.startsWith('served '))).toBe(false);
    expect(published()).toBe(true);
  });
});
