/**
 * Behavioral tests for POST /api/trial/create.
 *
 * Verifies end-to-end integration across:
 *   - Valibot body validation (bad JSON → 400 invalid_url)
 *   - Kill-switch off → 503 trials_disabled
 *   - Missing TRIAL_CLAIM_TOKEN_SECRET → 503 trials_disabled
 *   - probeGithubRepo 404 → 404 repo_not_found
 *   - probeGithubRepo private → 403 repo_private
 *   - probeGithubRepo oversized → 413 repo_too_large
 *   - TrialCounter at cap → 429 cap_exceeded with waitlistResetsAt
 *   - TrialCounter RPC failure → 503 trials_disabled
 *   - Happy path → 201 with Set-Cookie headers and expected response shape
 *   - D1 insert failure → decrements counter slot (no burn)
 *   - Existing fingerprint cookie is reused for a second create
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { isTrialsEnabledMock } = vi.hoisted(() => ({
  isTrialsEnabledMock: vi.fn(),
}));
vi.mock('../../../src/services/trial/kill-switch', () => ({
  isTrialsEnabled: isTrialsEnabledMock,
}));

const { insertMock, valuesMock } = vi.hoisted(() => {
  const valuesMock = vi.fn().mockResolvedValue(undefined);
  const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
  return { insertMock, valuesMock };
});

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn().mockReturnValue({ insert: insertMock }),
}));

vi.mock('../../../src/db/schema', () => ({
  trials: {
    id: 'id',
    fingerprint: 'fingerprint',
    repoUrl: 'repo_url',
    monthKey: 'month_key',
    status: 'status',
  },
}));

const { createRoutes, probeGithubRepo } = await import(
  '../../../src/routes/trial/create'
);

const SECRET = 'test-secret-at-least-32-bytes-long-for-hmac-xx';

type Slot = { allowed: boolean; count: number };

function makeEnv(options: {
  tryIncrementFn?: (monthKey: string, cap: number) => Promise<Slot>;
  decrementFn?: (monthKey: string) => Promise<number>;
  secret?: string | undefined;
  cap?: string;
  orchestratorStart?: (input: unknown) => Promise<void>;
}): Env {
  const orchestratorStartFn =
    options.orchestratorStart ?? vi.fn(async () => {});
  const orchestratorStub = { start: orchestratorStartFn };
  return {
    TRIAL_CLAIM_TOKEN_SECRET: 'secret' in options ? options.secret : SECRET,
    TRIAL_MONTHLY_CAP: options.cap,
    BASE_DOMAIN: 'example.com',
    TRIAL_COUNTER: {
      idFromName: vi.fn(() => 'do-id'),
      get: vi.fn(() => ({
        tryIncrement:
          options.tryIncrementFn ??
          vi.fn(async () => ({ allowed: true, count: 1 })),
        decrement: options.decrementFn ?? vi.fn(async () => 0),
      })),
    },
    TRIAL_ORCHESTRATOR: {
      idFromName: vi.fn(() => 'orchestrator-do-id'),
      get: vi.fn(() => orchestratorStub),
    },
    TRIAL_EVENT_BUS: {
      idFromName: vi.fn(() => 'event-bus-do-id'),
      get: vi.fn(() => ({
        fetch: vi.fn(async () => new Response('ok')),
      })),
    },
    // Trial-store KV mirror — Track B readers (SSE events, claim) look trials
    // up by trialId in KV. Minimal stub that accepts puts and returns null on
    // reads, which is enough for the create-path tests.
    KV: {
      put: vi.fn(async () => undefined),
      get: vi.fn(async () => null),
      delete: vi.fn(async () => undefined),
    },
  } as unknown as Env;
}

function makeApp(env: Env, fetchFn?: typeof fetch) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/trial', createRoutes);
  // Inject a stub global.fetch used by probeGithubRepo inside the handler.
  // (The route calls probeGithubRepo() with the default fetch.)
  if (fetchFn) vi.stubGlobal('fetch', fetchFn);
  return { app, env };
}

async function callCreate(
  app: Hono<{ Bindings: Env }>,
  env: Env,
  body: unknown,
  cookie?: string,
  executionCtx?: ExecutionContext
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  return app.fetch(
    new Request('https://api.test/api/trial/create', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
    executionCtx
  );
}

/** Minimal ExecutionContext stub that synchronously awaits every waitUntil
 *  promise so assertions can observe side effects after `callCreate` resolves. */
function makeExecutionCtx(): ExecutionContext & { waitUntilPromises: Promise<unknown>[] } {
  const promises: Promise<unknown>[] = [];
  const ctx: ExecutionContext & { waitUntilPromises: Promise<unknown>[] } = {
    waitUntil: (p: Promise<unknown>) => {
      promises.push(p);
    },
    passThroughOnException: () => {},
    props: {},
    waitUntilPromises: promises,
  } as unknown as ExecutionContext & { waitUntilPromises: Promise<unknown>[] };
  return ctx;
}

function okGithubFetch(overrides: Partial<{ size: number; private: boolean }> = {}) {
  return vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ size: 50, private: false, ...overrides }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  );
}

describe('probeGithubRepo (unit)', () => {
  it('returns ok for a public, small repo', async () => {
    const fetchFn = okGithubFetch({ size: 100 });
    const res = await probeGithubRepo('a', 'b', {
      maxKb: 500,
      timeoutMs: 1000,
      fetchFn,
    });
    expect(res).toEqual({ ok: true, sizeKb: 100, private: false });
  });

  it('returns repo_not_found on 404', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 404 }));
    const res = await probeGithubRepo('a', 'b', {
      maxKb: 500,
      timeoutMs: 1000,
      fetchFn,
    });
    expect(res).toEqual({ ok: false, reason: 'repo_not_found' });
  });

  it('returns repo_private for private repos', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ private: true, size: 1 }), { status: 200 })
      );
    const res = await probeGithubRepo('a', 'b', {
      maxKb: 500,
      timeoutMs: 1000,
      fetchFn,
    });
    expect(res).toEqual({ ok: false, reason: 'repo_private' });
  });

  it('returns repo_too_large when size exceeds maxKb', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ private: false, size: 1000 }), {
          status: 200,
        })
      );
    const res = await probeGithubRepo('a', 'b', {
      maxKb: 500,
      timeoutMs: 1000,
      fetchFn,
    });
    expect(res).toEqual({ ok: false, reason: 'repo_too_large' });
  });

  it('returns repo_not_found on 5xx / network errors', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down'));
    const res = await probeGithubRepo('a', 'b', {
      maxKb: 500,
      timeoutMs: 1000,
      fetchFn,
    });
    expect(res).toEqual({ ok: false, reason: 'repo_not_found' });
  });
});

describe('POST /api/trial/create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    isTrialsEnabledMock.mockResolvedValue(true);
    valuesMock.mockResolvedValue(undefined);
  });

  it('rejects non-JSON body with 400 invalid_url', async () => {
    const { app, env } = makeApp(makeEnv({}));
    const res = await callCreate(app, env, 'not json');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_url');
  });

  it('rejects non-GitHub URLs with 400 invalid_url', async () => {
    const { app, env } = makeApp(makeEnv({}));
    const res = await callCreate(app, env, {
      repoUrl: 'https://gitlab.com/foo/bar',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_url');
  });

  it('returns 503 trials_disabled when kill-switch is off', async () => {
    isTrialsEnabledMock.mockResolvedValue(false);
    const { app, env } = makeApp(makeEnv({}));
    const res = await callCreate(app, env, {
      repoUrl: 'https://github.com/alice/repo',
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('trials_disabled');
  });

  it('returns 503 trials_disabled when TRIAL_CLAIM_TOKEN_SECRET is missing', async () => {
    const { app, env } = makeApp(makeEnv({ secret: undefined }));
    const res = await callCreate(app, env, {
      repoUrl: 'https://github.com/alice/repo',
    });
    expect(res.status).toBe(503);
  });

  it('returns 404 repo_not_found when GitHub 404s', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 404 }))
    );
    const { app, env } = makeApp(makeEnv({}));
    const res = await callCreate(app, env, {
      repoUrl: 'https://github.com/alice/missing',
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('repo_not_found');
  });

  it('returns 403 repo_private when probe reports private', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ private: true, size: 1 }), {
            status: 200,
          })
        )
    );
    const { app, env } = makeApp(makeEnv({}));
    const res = await callCreate(app, env, {
      repoUrl: 'https://github.com/alice/private',
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('repo_private');
  });

  it('returns 413 repo_too_large when probe reports oversized', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ private: false, size: 9_999_999 }), {
            status: 200,
          })
        )
    );
    const { app, env } = makeApp(makeEnv({}));
    const res = await callCreate(app, env, {
      repoUrl: 'https://github.com/alice/big',
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('repo_too_large');
  });

  it('returns 429 cap_exceeded with waitlistResetsAt when counter rejects', async () => {
    vi.stubGlobal('fetch', okGithubFetch());
    const tryIncrementFn = vi.fn(async () => ({ allowed: false, count: 1500 }));
    const { app, env } = makeApp(makeEnv({ tryIncrementFn }));
    const res = await callCreate(app, env, {
      repoUrl: 'https://github.com/alice/repo',
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      error: string;
      waitlistResetsAt?: string;
    };
    expect(body.error).toBe('cap_exceeded');
    expect(body.waitlistResetsAt).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it('returns 503 trials_disabled when counter DO throws', async () => {
    vi.stubGlobal('fetch', okGithubFetch());
    const tryIncrementFn = vi.fn().mockRejectedValue(new Error('DO down'));
    const { app, env } = makeApp(makeEnv({ tryIncrementFn }));
    const res = await callCreate(app, env, {
      repoUrl: 'https://github.com/alice/repo',
    });
    expect(res.status).toBe(503);
  });

  it('happy path: 201 with Set-Cookie headers and response body', async () => {
    vi.stubGlobal('fetch', okGithubFetch());
    const { app, env } = makeApp(makeEnv({}));
    const res = await callCreate(app, env, {
      repoUrl: 'https://github.com/alice/repo',
    });
    expect(res.status).toBe(201);

    // Validate response body shape
    const body = (await res.json()) as {
      trialId: string;
      projectId: string;
      eventsUrl: string;
      expiresAt: number;
    };
    expect(body.trialId).toMatch(/^trial_/);
    expect(body.projectId).toBe(''); // populated by Track B later
    expect(body.eventsUrl).toContain('/api/trial/events?trialId=');
    expect(body.expiresAt).toBeGreaterThan(Date.now());

    // Two Set-Cookie headers should be present (fingerprint + claim).
    // Hono/Workers uses Headers which exposes multiple Set-Cookie via getSetCookie().
    const setCookie = (res.headers as Headers & {
      getSetCookie?: () => string[];
    }).getSetCookie?.();
    expect(setCookie).toBeTruthy();
    expect(setCookie!.length).toBeGreaterThanOrEqual(2);

    // D1 insert should have been called exactly once with the expected shape.
    expect(insertMock).toHaveBeenCalledTimes(1);
    const inserted = valuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(inserted.status).toBe('pending');
    expect(inserted.repoUrl).toBe('https://github.com/alice/repo');
    expect(inserted.repoOwner).toBe('alice');
    expect(inserted.repoName).toBe('repo');

    // KV mirror: trial record MUST be written to KV so Track B readers
    // (SSE /events, /claim) can resolve it by trialId. Regression guard —
    // skipping this write caused every SSE connection to 404 (see commit
    // history).
    const kvPut = env.KV.put as unknown as ReturnType<typeof vi.fn>;
    const trialKeyPut = kvPut.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].startsWith('trial:')
    );
    expect(trialKeyPut).toBeTruthy();
    const stored = JSON.parse(trialKeyPut![1] as string) as {
      trialId: string;
      fingerprint: string;
      projectId: string;
    };
    expect(stored.trialId).toBe(body.trialId);
    expect(stored.projectId).toBe(''); // populated by Track B orchestrator later
    expect(stored.fingerprint).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('decrements counter slot when D1 insert fails (no burn)', async () => {
    vi.stubGlobal('fetch', okGithubFetch());
    valuesMock.mockRejectedValueOnce(new Error('UNIQUE constraint failed'));
    const decrementFn = vi.fn().mockResolvedValue(0);
    const { app, env } = makeApp(makeEnv({ decrementFn }));

    const res = await callCreate(app, env, {
      repoUrl: 'https://github.com/alice/repo',
    });
    expect(res.status).toBe(500);
    expect(decrementFn).toHaveBeenCalledTimes(1);
  });

  it('dispatches TrialOrchestrator.start() with repo owner/name/canonical URL via waitUntil', async () => {
    vi.stubGlobal('fetch', okGithubFetch());
    const startFn = vi.fn(async () => {});
    const env = makeEnv({ orchestratorStart: startFn });
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/trial', createRoutes);
    const ctx = makeExecutionCtx();

    const res = await callCreate(
      app,
      env,
      { repoUrl: 'https://github.com/alice/repo' },
      undefined,
      ctx
    );
    expect(res.status).toBe(201);

    // waitUntil should have been called at least twice (orchestrator + knowledge).
    expect(ctx.waitUntilPromises.length).toBeGreaterThanOrEqual(2);
    // Drain waitUntil promises so the orchestrator.start() call is observable.
    await Promise.all(ctx.waitUntilPromises.map((p) => p.catch(() => {})));

    expect(startFn).toHaveBeenCalledTimes(1);
    const arg = startFn.mock.calls[0]?.[0] as {
      trialId: string;
      repoUrl: string;
      repoOwner: string;
      repoName: string;
    };
    expect(arg.trialId).toMatch(/^trial_/);
    expect(arg.repoOwner).toBe('alice');
    expect(arg.repoName).toBe('repo');
    expect(arg.repoUrl).toBe('https://github.com/alice/repo');
  });

  it('still returns 201 when TrialOrchestrator.start() rejects (fire-and-forget)', async () => {
    vi.stubGlobal('fetch', okGithubFetch());
    const startFn = vi.fn().mockRejectedValue(new Error('DO unavailable'));
    const env = makeEnv({ orchestratorStart: startFn });
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/trial', createRoutes);
    const ctx = makeExecutionCtx();

    const res = await callCreate(
      app,
      env,
      { repoUrl: 'https://github.com/alice/repo' },
      undefined,
      ctx
    );
    // Response status must remain 201 — orchestrator failure is non-blocking.
    expect(res.status).toBe(201);
    // Drain waitUntil promises so the rejection is observable but swallowed.
    await Promise.all(ctx.waitUntilPromises.map((p) => p.catch(() => {})));
    expect(startFn).toHaveBeenCalledTimes(1);
  });

  it('rate-limits per IP when KV shows the window count is at the limit', async () => {
    // Regression guard for the HIGH security-auditor finding: `POST /create`
    // must enforce a per-IP rate limit before the kill-switch + DO dispatch.
    // We override KV.get so the middleware sees an already-exhausted bucket
    // and returns 429 without touching the orchestrator.
    vi.stubGlobal('fetch', okGithubFetch());
    const env = makeEnv({});
    const exhaustedWindow = {
      count: 999_999,
      windowStart: Math.floor(Date.now() / 1000 / 3600) * 3600,
    };
    (env.KV.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (key: string) =>
        key.startsWith('ratelimit:trial-create:') ? exhaustedWindow : null
    );
    const app = new Hono<{ Bindings: Env }>();
    // Mirror the global error handler from apps/api/src/index.ts so AppError
    // (thrown by the rate-limit middleware) serializes to its real statusCode.
    const { AppError } = await import('../../../src/middleware/error');
    type AppErrorJson = { error: string; message: string; details?: unknown };
    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON() as AppErrorJson, err.statusCode as 429);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: 'err' }, 500);
    });
    app.route('/api/trial', createRoutes);

    const res = await app.fetch(
      new Request('https://api.test/api/trial/create', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'CF-Connecting-IP': '203.0.113.7',
        },
        body: JSON.stringify({ repoUrl: 'https://github.com/alice/repo' }),
      }),
      env
    );
    expect(res.status).toBe(429);
    // DO must NOT have been called when rate limit blocks the request.
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('reuses existing fingerprint UUID from cookie', async () => {
    vi.stubGlobal('fetch', okGithubFetch());
    const { app, env } = makeApp(makeEnv({}));

    // Mint a cookie that contains a UUID prefix (signature verification is
    // NOT required for reuse — the route just extracts the prefix).
    const existingUuid = '11111111-2222-3333-4444-555555555555';
    const cookie = `sam_trial_fingerprint=${existingUuid}.someSignatureHere`;

    const res = await callCreate(
      app,
      env,
      { repoUrl: 'https://github.com/alice/repo' },
      cookie
    );
    expect(res.status).toBe(201);

    // The inserted row should carry the reused UUID.
    const inserted = valuesMock.mock.calls[0]?.[0] as { fingerprint: string };
    expect(inserted.fingerprint).toBe(existingUuid);
  });
});
