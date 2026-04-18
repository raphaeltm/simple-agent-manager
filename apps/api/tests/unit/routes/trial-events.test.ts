/**
 * Unit tests for GET /api/trial/:trialId/events (SSE).
 *
 * Covers:
 *   - 404 when no trial record exists
 *   - 500 when TRIAL_CLAIM_TOKEN_SECRET is unset
 *   - 401 when fingerprint cookie is missing
 *   - 401 when fingerprint signature fails
 *   - 401 when fingerprint UUID doesn't match record.fingerprint
 *   - 200 + text/event-stream headers on happy path with poll returning
 *     a terminal event (trial.ready) that closes the stream
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

// Trial-store mock
const { readTrialMock } = vi.hoisted(() => ({
  readTrialMock: vi.fn(),
}));
vi.mock('../../../src/services/trial/trial-store', () => ({
  readTrial: readTrialMock,
}));

// Silence logs
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { eventsRoutes } from '../../../src/routes/trial/events';
import { signFingerprint } from '../../../src/services/trial/cookies';

const SECRET = 'test-secret-for-sse-route-32-bytes-long-minimum';

function makeApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = err as any;
    if (typeof e.statusCode === 'number' && typeof e.toJSON === 'function') {
      return c.json(e.toJSON(), e.statusCode);
    }
    return c.json({ error: 'INTERNAL', message: err.message }, 500);
  });
  app.route('/api/trial', eventsRoutes);
  return app;
}

/** Build an env with a TRIAL_EVENT_BUS DO stub whose `poll` returns the given events */
function makeEnvWithDO(
  pollResponse: { events: { cursor: number; event: unknown }[]; cursor: number; closed: boolean },
  overrides: Partial<Env> = {}
): Env {
  const stub = {
    fetch: vi.fn(async (url: string | URL) => {
      if (String(url).includes('/poll')) {
        return new Response(JSON.stringify(pollResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }),
  };
  return {
    TRIAL_CLAIM_TOKEN_SECRET: SECRET,
    TRIAL_SSE_HEARTBEAT_MS: '60000',
    TRIAL_SSE_POLL_TIMEOUT_MS: '100',
    TRIAL_SSE_MAX_DURATION_MS: '5000',
    TRIAL_EVENT_BUS: {
      idFromName: vi.fn(() => 'do-id'),
      get: vi.fn(() => stub),
    },
    ...overrides,
  } as unknown as Env;
}

async function getEvents(
  app: Hono<{ Bindings: Env }>,
  trialId: string,
  cookie: string | null,
  env: Env
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers['cookie'] = `sam_trial_fingerprint=${encodeURIComponent(cookie)}`;
  return app.request(
    `/api/trial/${trialId}/events`,
    { method: 'GET', headers },
    env
  );
}

describe('GET /api/trial/:trialId/events — auth + bail-out', () => {
  beforeEach(() => {
    readTrialMock.mockReset();
  });

  it('returns 404 when no trial record exists', async () => {
    const app = makeApp();
    const env = makeEnvWithDO({ events: [], cursor: 0, closed: false });
    readTrialMock.mockResolvedValueOnce(null);

    const resp = await getEvents(app, 'trial_missing', 'whatever', env);
    expect(resp.status).toBe(404);
  });

  it('returns 500 when TRIAL_CLAIM_TOKEN_SECRET is unset', async () => {
    const app = makeApp();
    readTrialMock.mockResolvedValueOnce({
      trialId: 't',
      fingerprint: 'fp',
      claimed: false,
      expiresAt: Date.now() + 60_000,
    });
    const env = makeEnvWithDO(
      { events: [], cursor: 0, closed: false },
      { TRIAL_CLAIM_TOKEN_SECRET: undefined } as Partial<Env>
    );
    const resp = await getEvents(app, 't', 'anything', env);
    expect(resp.status).toBe(500);
  });

  it('returns 401 when fingerprint cookie is missing', async () => {
    const app = makeApp();
    readTrialMock.mockResolvedValueOnce({
      trialId: 't',
      fingerprint: 'fp',
      claimed: false,
      expiresAt: Date.now() + 60_000,
    });
    const env = makeEnvWithDO({ events: [], cursor: 0, closed: false });
    const resp = await getEvents(app, 't', null, env);
    expect(resp.status).toBe(401);
  });

  it('returns 401 when fingerprint signature is invalid', async () => {
    const app = makeApp();
    readTrialMock.mockResolvedValueOnce({
      trialId: 't',
      fingerprint: 'fp',
      claimed: false,
      expiresAt: Date.now() + 60_000,
    });
    const env = makeEnvWithDO({ events: [], cursor: 0, closed: false });
    const resp = await getEvents(app, 't', 'bad.sig', env);
    expect(resp.status).toBe(401);
  });

  it("returns 401 when fingerprint UUID doesn't match record.fingerprint", async () => {
    const app = makeApp();
    readTrialMock.mockResolvedValueOnce({
      trialId: 't',
      fingerprint: 'fp-expected',
      claimed: false,
      expiresAt: Date.now() + 60_000,
    });
    const signed = await signFingerprint('fp-attacker', SECRET);
    const env = makeEnvWithDO({ events: [], cursor: 0, closed: false });
    const resp = await getEvents(app, 't', signed, env);
    expect(resp.status).toBe(401);
  });
});

describe('GET /api/trial/:trialId/events — happy path', () => {
  beforeEach(() => {
    readTrialMock.mockReset();
  });

  it('returns 200 + text/event-stream + streams events then closes on terminal', async () => {
    const app = makeApp();
    readTrialMock.mockResolvedValueOnce({
      trialId: 'trial_good',
      fingerprint: 'fp-good',
      claimed: false,
      expiresAt: Date.now() + 60_000,
    });

    const terminalEvent = { type: 'trial.ready', projectId: 'proj', at: Date.now() };
    const env = makeEnvWithDO({
      events: [{ cursor: 1, event: terminalEvent }],
      cursor: 1,
      closed: true,
    });

    const signed = await signFingerprint('fp-good', SECRET);
    const resp = await getEvents(app, 'trial_good', signed, env);

    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/event-stream');
    expect(resp.headers.get('cache-control')).toContain('no-cache');
    expect(resp.headers.get('x-accel-buffering')).toBe('no');

    // Drain the stream and assert the SSE frame shape.
    const body = await resp.text();
    expect(body).toContain(': connected');
    expect(body).toContain('event: trial.ready');
    expect(body).toContain('"type":"trial.ready"');
  });
});
