/**
 * SSRF through the AI proxy passthrough (self-host T5).
 *
 * Any approved user can save an `openai-compatible` credential whose `baseUrl` is a server they
 * control. That server answers 302 to a loopback address; before the fix the Worker followed it
 * and relayed the internal response. This drives the real route with real HTTP servers and the
 * real `fetch` (undici follows redirects by default, like workerd and celld), so it fails on the
 * pre-fix code and passes only when the passthrough refuses the hop.
 *
 * Only DNS is simulated: `*.test.example` names are routed to local servers by a thin wrapper
 * around the real fetch that rewrites the authority and passes `init` (including `redirect`)
 * through unchanged.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/provider-limit-credential-pin', () => ({
  assertProviderLimitCredentialPin: vi.fn(async () => {}),
}));

const mockResolveForConsumer = vi.fn();
const auth = vi.hoisted(() => ({ agentType: 'opencode' }));

vi.mock('drizzle-orm/d1', () => ({ drizzle: () => ({}) }));
vi.mock('../../../src/services/ai-proxy-shared', () => ({
  verifyAIProxyAuth: vi.fn(async () => ({
    userId: 'attacker-user',
    workspaceId: 'ws-attacker',
    projectId: 'proj-attacker',
    agentType: auth.agentType,
  })),
  updateAIProxyAgentCredentialAttribution: vi.fn(),
  AIProxyAuthError: class extends Error {
    statusCode = 401;
  },
}));
// A self-hosted box (no AI Gateway) where an admin turned on `aiProxy.directUpstreamEnabled`:
// the configuration in which this passthrough is reachable on a box (ai-proxy-availability.ts).
vi.mock('../../../src/services/admin-settings-resolution', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/admin-settings-resolution')>();
  return {
    ...actual,
    resolveAdminSetting: async (env: never, name: string) =>
      name === 'aiProxy.directUpstreamEnabled'
        ? true
        : actual.resolveAdminSetting(env, name as never),
  };
});
vi.mock('../../../src/middleware/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 10, resetAt: 9999 })),
  createRateLimitKey: () => 'k',
  getCurrentWindowStart: () => 1000,
}));
vi.mock('../../../src/services/ai-token-budget', () => ({
  checkAiUsageGate: vi.fn(async () => ({ allowed: true })),
  incrementTokenUsage: vi.fn(async () => {}),
  incrementProviderUsage: vi.fn(async () => {}),
}));
vi.mock('../../../src/services/credential-limit-events', () => ({
  copyCredentialLimitHeaders: () => {},
  recordProxyCredentialLimitObservationsFromHeaders: vi.fn(),
}));
const mockLogWarn = vi.fn();
vi.mock('../../../src/lib/logger', () => {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: (...args: unknown[]) => mockLogWarn(...args),
  };
  // admin-settings (the hop-limit setting test) creates module loggers at import.
  return { log, createModuleLogger: () => log, serializeError: (err: unknown) => ({ err }) };
});
vi.mock('../../../src/lib/secrets', () => ({ getCredentialEncryptionKey: () => 'k' }));
vi.mock('../../../src/services/composable-credentials/resolve', () => ({
  resolveForConsumer: (...args: unknown[]) => mockResolveForConsumer(...args),
  explainForConsumer: async (...args: unknown[]) => ({
    resolved: await mockResolveForConsumer(...args),
    halted: false,
    steps: [],
  }),
}));
vi.mock('../../../src/services/composable-credentials/profile-context', () => ({
  resolveProfileCredentialContext: vi.fn(async () => null),
  resolveSessionProfileCredentialContext: vi.fn(async () => null),
}));

import { aiProxyPassthroughRoutes } from '../../../src/routes/ai-proxy-passthrough';
import {
  __resetAdminSettingsCacheForTest,
  updateAdminSettings,
} from '../../../src/services/admin-settings';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

const INTERNAL_SECRET = 'INTERNAL-ONLY-RESPONSE-7f3c';
const CHAT_PATH = '/ai/proxy/ws-token/openai/v1/chat/completions';

interface Recorded {
  method: string;
  url: string;
  body: string;
  headers: IncomingMessage['headers'];
}

function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const hits: Recorded[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      hits.push({ method: req.method ?? '', url: req.url ?? '', body, headers: req.headers });
      handler(req, res, body);
    });
  });
  return { server, hits };
}

function portOf(server: Server): number {
  return (server.address() as AddressInfo).port;
}

const internal = listen((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ secret: INTERNAL_SECRET }));
});

/** The attacker's "LLM endpoint": every path answers with the redirect under test. */
let attackerRedirect: { status: number; location: () => string } = {
  status: 302,
  location: () => `http://127.0.0.1:${portOf(internal.server)}/admin/state`,
};
const attacker = listen((_req, res) => {
  res.writeHead(attackerRedirect.status, { Location: attackerRedirect.location() });
  res.end('moved');
});

const legitimate = listen((_req, res, body) => {
  if ((JSON.parse(body || '{}') as { stream?: boolean }).stream) {
    // Server-sent events in two writes, so the relay must stream rather than buffer one chunk.
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n');
    setTimeout(
      () => res.end('data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n'),
      50
    );
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }));
});

/** Real fetch; only `<name>.test.example` is "resolved" to a local server. */
const realFetch = globalThis.fetch;
const routedFetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const servers: Record<string, Server> = {
    'attacker.test.example': attacker.server,
    'llm.test.example': legitimate.server,
  };
  const server = servers[url.hostname];
  if (server) {
    url.protocol = 'http:';
    url.hostname = '127.0.0.1';
    url.port = String(portOf(server));
  }
  return realFetch(url, init);
});

const app = new Hono();
app.route('/ai/proxy', aiProxyPassthroughRoutes);

function credentialWithBaseUrl(baseUrl: string) {
  mockResolveForConsumer.mockImplementation((_db, _userId, _key, consumer) =>
    Promise.resolve({
      consumer,
      configuration: { settings: {} },
      credential: {
        id: 'cred-attacker',
        secret: { kind: 'openai-compatible', apiKey: 'sk-attacker-own-key', baseUrl },
      },
      source: 'user-attachment',
    })
  );
}

/** The DATABASE binding the routes see; a real settings database in the hop-limit setting test. */
let database: unknown = {};

function postChat(extra: Record<string, unknown> = {}) {
  return app.request(
    CHAT_PATH,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'any-model',
        messages: [{ role: 'user', content: 'hi' }],
        ...extra,
      }),
    },
    { DATABASE: database, KV: {}, AI_PROXY_ENABLED: 'true' }
  );
}

beforeAll(async () => {
  for (const { server } of [internal, attacker, legitimate]) {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  }
  vi.stubGlobal('fetch', routedFetch);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const { server } of [internal, attacker, legitimate]) {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

beforeEach(() => {
  auth.agentType = 'opencode';
  internal.hits.length = 0;
  attacker.hits.length = 0;
  legitimate.hits.length = 0;
  routedFetch.mockClear();
});

describe('AI proxy passthrough: redirect to an internal address', () => {
  it.each([
    [302, 'http://127.0.0.1:{internal}/admin/state'],
    [307, 'http://127.0.0.1:{internal}/admin/state'],
    [308, 'http://[::ffff:127.0.0.1]:{internal}/admin/state'],
    [301, 'http://2130706433:{internal}/admin/state'],
    [303, 'http://localhost:{internal}/admin/state'],
  ])('refuses a %i to %s and never contacts the internal server', async (status, location) => {
    attackerRedirect = {
      status,
      location: () => location.replace('{internal}', String(portOf(internal.server))),
    };
    credentialWithBaseUrl('https://attacker.test.example/v1');

    const res = await postChat();
    const text = await res.text();

    // Liveness: the attacker's server really was called, so the refusal is the guard's doing.
    expect(attacker.hits).toHaveLength(1);
    expect(attacker.hits[0]?.url).toBe('/v1/chat/completions');
    expect(text).not.toContain(INTERNAL_SECRET);
    expect(internal.hits).toHaveLength(0);
    expect(res.status).toBe(502);
    // The runtime never followed a redirect on its own.
    for (const [, init] of routedFetch.mock.calls) expect(init?.redirect).toBe('manual');
  });

  it('control: a legitimate public endpoint is still proxied', async () => {
    credentialWithBaseUrl('https://llm.test.example/v1');

    const res = await postChat();

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('hello');
    expect(legitimate.hits).toHaveLength(1);
    expect(legitimate.hits[0]?.method).toBe('POST');
  });

  it('a 307 from one public host to another is refused: the prompt never reaches the second host', async () => {
    // A 307 keeps the body; following it would hand the request (prompts, tool results) to a
    // host the credential never named. guardedFetch refuses it (redirect_cross_origin_body).
    attackerRedirect = {
      status: 307,
      location: () => 'https://llm.test.example/v1/chat/completions',
    };
    credentialWithBaseUrl('https://attacker.test.example/v1');

    const res = await postChat();

    expect(res.status).toBe(502);
    expect(legitimate.hits).toHaveLength(0);
    // Liveness: the configured host was called once, with its own key.
    expect(attacker.hits).toHaveLength(1);
    expect(attacker.hits[0]?.headers.authorization).toBe('Bearer sk-attacker-own-key');
  });

  it('control: a streamed (SSE) response from a public endpoint is still relayed as a stream', async () => {
    credentialWithBaseUrl('https://llm.test.example/v1');

    const res = await postChat({ stream: true });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"hel"');
    let rest = '';
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      rest += new TextDecoder().decode(chunk.value);
    }
    expect(`${first}${rest}`).toContain('[DONE]');
  });

  it('never calls a stored credential whose base URL is itself a private address', async () => {
    credentialWithBaseUrl(`https://127.0.0.1:${portOf(internal.server)}/v1`);

    const res = await postChat();

    expect(res.status).toBe(401);
    expect(routedFetch).not.toHaveBeenCalled();
    expect(internal.hits).toHaveLength(0);
    // The refusal is diagnosable, not a silent "no credential".
    expect(mockLogWarn).toHaveBeenCalledWith('ai_proxy_passthrough.upstream_refused', {
      credentialId: 'cred-attacker',
      reason: 'host',
    });
  });
});

/** Anthropic dialect: an api-key credential with the base URL on the configuration. */
function anthropicConfigurationWithBaseUrl(baseUrl: string) {
  mockResolveForConsumer.mockImplementation((_db, _userId, _key, consumer) =>
    Promise.resolve({
      consumer,
      configuration: { settings: { baseUrl, dialect: 'anthropic' } },
      credential: { id: 'cred-anthropic', secret: { kind: 'api-key', apiKey: 'sk-ant-own' } },
      source: 'user-attachment',
    })
  );
}

function postTo(path: string) {
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] }),
    },
    { DATABASE: database, KV: {}, AI_PROXY_ENABLED: 'true' }
  );
}

describe('every passthrough route goes through the guarded fetch', () => {
  const ROUTES: Array<[string, string, string]> = [
    ['Anthropic messages', '/ai/proxy/ws-token/anthropic/v1/messages', '/anthropic/v1/messages'],
    [
      'Anthropic count_tokens',
      '/ai/proxy/ws-token/anthropic/v1/messages/count_tokens',
      '/anthropic/v1/messages/count_tokens',
    ],
  ];

  it.each(ROUTES)('%s refuses a redirect to an internal address', async (_name, path, upstream) => {
    auth.agentType = 'claude-code';
    attackerRedirect = {
      status: 307,
      location: () => `http://127.0.0.1:${portOf(internal.server)}/admin/state`,
    };
    anthropicConfigurationWithBaseUrl('https://attacker.test.example/anthropic');

    const res = await postTo(path);

    expect(attacker.hits.map((hit) => hit.url)).toEqual([upstream]);
    expect(await res.text()).not.toContain(INTERNAL_SECRET);
    expect(internal.hits).toHaveLength(0);
    expect(res.status).toBe(502);
  });

  it.each(ROUTES)('control: %s reaches a public endpoint', async (_name, path) => {
    auth.agentType = 'claude-code';
    anthropicConfigurationWithBaseUrl('https://llm.test.example/anthropic');

    const res = await postTo(path);

    expect(res.status).toBe(200);
    expect(legitimate.hits).toHaveLength(1);
  });

  it.each([
    'https://127.0.0.1/anthropic',
    'https://169.254.169.254/anthropic',
    'https://localhost/anthropic',
    'https://minio/anthropic',
    'https://[::1]/anthropic',
  ])('never calls a configuration base URL override on %s', async (baseUrl) => {
    auth.agentType = 'claude-code';
    anthropicConfigurationWithBaseUrl(baseUrl);

    const res = await postTo('/ai/proxy/ws-token/anthropic/v1/messages');

    expect(res.status).toBe(401);
    expect(routedFetch).not.toHaveBeenCalled();
  });
});

describe('a redirect chain longer than the hop limit (outbound.maxRedirects, default 3)', () => {
  it.each([
    ['OpenAI chat', CHAT_PATH, 'openai'],
    ['Anthropic messages', '/ai/proxy/ws-token/anthropic/v1/messages', 'anthropic'],
    [
      'Anthropic count_tokens',
      '/ai/proxy/ws-token/anthropic/v1/messages/count_tokens',
      'anthropic',
    ],
  ])('%s stops after the limit and answers 502', async (_name, path, dialect) => {
    let hop = 0;
    attackerRedirect = {
      status: 307,
      location: () => `https://attacker.test.example/loop/${(hop += 1)}`,
    };
    if (dialect === 'openai') {
      credentialWithBaseUrl('https://attacker.test.example/v1');
    } else {
      auth.agentType = 'claude-code';
      anthropicConfigurationWithBaseUrl('https://attacker.test.example/anthropic');
    }

    const res = await (dialect === 'openai' ? postChat() : postTo(path));

    // The first request plus three validated hops; the fourth Location is never requested.
    expect(attacker.hits.map((hit) => hit.url).slice(1)).toEqual(['/loop/1', '/loop/2', '/loop/3']);
    expect(res.status).toBe(502);
  });
});

describe('the passthrough reads outbound.maxRedirects as the admin set it', () => {
  let sqlite: { close: () => void } | undefined;
  afterEach(() => {
    sqlite?.close();
    sqlite = undefined;
    database = {};
    __resetAdminSettingsCacheForTest();
  });

  it('cuts the chain after one hop when the setting is 1, not the default 3', async () => {
    __resetAdminSettingsCacheForTest();
    const settings = createAdminSettingsEnv();
    sqlite = settings.sqlite;
    await updateAdminSettings(settings.env, {
      changes: [{ name: 'outbound.maxRedirects', value: 1 }],
      actorUserId: 'admin',
    });
    database = settings.env.DATABASE;
    let hop = 0;
    attackerRedirect = {
      status: 307,
      location: () => `https://attacker.test.example/loop/${(hop += 1)}`,
    };
    credentialWithBaseUrl('https://attacker.test.example/v1');

    const res = await postChat();

    expect(attacker.hits.map((hit) => hit.url).slice(1)).toEqual(['/loop/1']);
    expect(res.status).toBe(502);
  });
});
