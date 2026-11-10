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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/provider-limit-credential-pin', () => ({
  assertProviderLimitCredentialPin: vi.fn(async () => {}),
}));

const mockResolveForConsumer = vi.fn();

vi.mock('drizzle-orm/d1', () => ({ drizzle: () => ({}) }));
vi.mock('../../../src/db/schema', () => ({}));
vi.mock('../../../src/services/ai-proxy-shared', () => ({
  verifyAIProxyAuth: vi.fn(async () => ({
    userId: 'attacker-user',
    workspaceId: 'ws-attacker',
    projectId: 'proj-attacker',
    agentType: 'opencode',
  })),
  updateAIProxyAgentCredentialAttribution: vi.fn(),
  AIProxyAuthError: class extends Error {
    statusCode = 401;
  },
}));
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
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
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

const INTERNAL_SECRET = 'INTERNAL-ONLY-RESPONSE-7f3c';
const CHAT_PATH = '/ai/proxy/ws-token/openai/v1/chat/completions';

interface Recorded {
  method: string;
  url: string;
  body: string;
}

function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const hits: Recorded[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      hits.push({ method: req.method ?? '', url: req.url ?? '', body });
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

const legitimate = listen((_req, res) => {
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

function postChat() {
  return app.request(
    CHAT_PATH,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'any-model', messages: [{ role: 'user', content: 'hi' }] }),
    },
    { DATABASE: {}, KV: {}, AI_PROXY_ENABLED: 'true' }
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

  it('control: a 307 from one public host to another is followed with the body replayed', async () => {
    attackerRedirect = {
      status: 307,
      location: () => 'https://llm.test.example/v1/chat/completions',
    };
    credentialWithBaseUrl('https://attacker.test.example/v1');

    const res = await postChat();

    expect(res.status).toBe(200);
    expect(legitimate.hits).toHaveLength(1);
    expect(legitimate.hits[0]?.method).toBe('POST');
    expect(JSON.parse(legitimate.hits[0]?.body ?? '{}')).toMatchObject({ model: 'any-model' });
  });

  it('never calls a stored credential whose base URL is itself a private address', async () => {
    credentialWithBaseUrl(`https://127.0.0.1:${portOf(internal.server)}/v1`);

    const res = await postChat();

    expect(res.status).toBe(401);
    expect(routedFetch).not.toHaveBeenCalled();
    expect(internal.hits).toHaveLength(0);
  });
});
