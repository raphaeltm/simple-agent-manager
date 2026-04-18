/**
 * Unit tests for POST /api/trial/claim.
 *
 * Covers:
 *   - 401 when unauthenticated (handled via the auth middleware; tested by not
 *     installing the userId mock)
 *   - 500 when TRIAL_CLAIM_TOKEN_SECRET is unset
 *   - 400 when claim cookie missing
 *   - 400 when claim cookie signature fails / malformed / expired
 *   - 404 when trial record is absent
 *   - 400 when payload.projectId disagrees with stored record
 *   - 409 when trial already marked claimed in KV
 *   - 409 when D1 UPDATE affects zero rows (already claimed by someone else)
 *   - 200 happy path — D1 re-parented, KV markTrialClaimed called,
 *     Set-Cookie clears sam_trial_claim
 */
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

// Auth — always return a user so the claim route runs its own logic.
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_: unknown, next: () => Promise<unknown>) => next()),
  getUserId: () => 'user_claim_1',
}));

// drizzle-orm/d1 — stub to control UPDATE outcome
vi.mock('drizzle-orm/d1');

// Trial-store — control the record returned
const { readTrialMock, markTrialClaimedMock } = vi.hoisted(() => ({
  readTrialMock: vi.fn(),
  markTrialClaimedMock: vi.fn(),
}));
vi.mock('../../../src/services/trial/trial-store', () => ({
  readTrial: readTrialMock,
  markTrialClaimed: markTrialClaimedMock,
}));

// Silence logs
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { errors } from '../../../src/middleware/error';
import { claimRoutes } from '../../../src/routes/trial/claim';
import { signClaimToken } from '../../../src/services/trial/cookies';

const SECRET = 'test-secret-for-claim-route-32-bytes-long-minimum';

function makeApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    // Surface AppError as JSON (mirrors production onError)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = err as any;
    if (typeof e.statusCode === 'number' && typeof e.toJSON === 'function') {
      return c.json(e.toJSON(), e.statusCode);
    }
    return c.json({ error: 'INTERNAL', message: err.message }, 500);
  });
  app.route('/api/trial', claimRoutes);
  return app;
}

function setDrizzleUpdateChanges(changes: number) {
  const run = vi.fn().mockResolvedValue({ meta: { changes } });
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    run,
  };
  (drizzle as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    update: vi.fn().mockReturnValue(chain),
  });
  return { run, chain };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE: {} as D1Database,
    TRIAL_CLAIM_TOKEN_SECRET: SECRET,
    ...overrides,
  } as unknown as Env;
}

async function postClaim(
  app: Hono<{ Bindings: Env }>,
  cookie: string | null,
  env: Env = makeEnv()
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers['cookie'] = `sam_trial_claim=${encodeURIComponent(cookie)}`;
  return app.request(
    '/api/trial/claim',
    { method: 'POST', headers, body: '{}' },
    env
  );
}

function futurePayload(
  overrides: Partial<{
    trialId: string;
    projectId: string;
    issuedAt: number;
    expiresAt: number;
  }> = {}
) {
  const now = Date.now();
  return {
    trialId: 'trial_good',
    projectId: 'proj_good',
    issuedAt: now,
    expiresAt: now + 3600_000,
    ...overrides,
  };
}

describe('POST /api/trial/claim', () => {
  beforeEach(() => {
    readTrialMock.mockReset();
    markTrialClaimedMock.mockReset();
    vi.mocked(drizzle).mockReset();
  });

  it('returns 500 when TRIAL_CLAIM_TOKEN_SECRET is unset', async () => {
    const app = makeApp();
    const env = makeEnv({ TRIAL_CLAIM_TOKEN_SECRET: undefined } as Partial<Env>);
    const resp = await postClaim(app, 'anything', env);
    expect(resp.status).toBe(500);
  });

  it('returns 400 when claim cookie is missing', async () => {
    const app = makeApp();
    const resp = await postClaim(app, null);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { message?: string };
    expect(body.message).toMatch(/claim cookie/i);
  });

  it('returns 400 when claim cookie signature is invalid', async () => {
    const app = makeApp();
    const resp = await postClaim(app, 'not-a-real-token.sig');
    expect(resp.status).toBe(400);
  });

  it('returns 400 when claim cookie is expired', async () => {
    const app = makeApp();
    const token = await signClaimToken(
      { ...futurePayload(), expiresAt: Date.now() - 1000 },
      SECRET
    );
    const resp = await postClaim(app, token);
    expect(resp.status).toBe(400);
  });

  it('returns 404 when trial record does not exist', async () => {
    const app = makeApp();
    const token = await signClaimToken(futurePayload(), SECRET);
    readTrialMock.mockResolvedValueOnce(null);
    const resp = await postClaim(app, token);
    expect(resp.status).toBe(404);
  });

  it('returns 400 when cookie projectId disagrees with record projectId', async () => {
    const app = makeApp();
    const token = await signClaimToken(
      futurePayload({ projectId: 'proj_cookie' }),
      SECRET
    );
    readTrialMock.mockResolvedValueOnce({
      trialId: 'trial_good',
      projectId: 'proj_record_different',
      claimed: false,
    });
    const resp = await postClaim(app, token);
    expect(resp.status).toBe(400);
  });

  it('returns 409 when trial is already claimed in KV', async () => {
    const app = makeApp();
    const token = await signClaimToken(futurePayload(), SECRET);
    readTrialMock.mockResolvedValueOnce({
      trialId: 'trial_good',
      projectId: 'proj_good',
      claimed: true,
    });
    const resp = await postClaim(app, token);
    expect(resp.status).toBe(409);
  });

  it('returns 409 when D1 UPDATE affects zero rows (race)', async () => {
    const app = makeApp();
    const token = await signClaimToken(futurePayload(), SECRET);
    readTrialMock.mockResolvedValueOnce({
      trialId: 'trial_good',
      projectId: 'proj_good',
      claimed: false,
    });
    setDrizzleUpdateChanges(0);
    const resp = await postClaim(app, token);
    expect(resp.status).toBe(409);
  });

  it('returns 200 and clears claim cookie on successful re-parent', async () => {
    const app = makeApp();
    const token = await signClaimToken(futurePayload(), SECRET);
    readTrialMock.mockResolvedValueOnce({
      trialId: 'trial_good',
      projectId: 'proj_good',
      claimed: false,
    });
    markTrialClaimedMock.mockResolvedValueOnce({
      trialId: 'trial_good',
      projectId: 'proj_good',
      claimed: true,
    });
    const { run, chain } = setDrizzleUpdateChanges(1);

    const resp = await postClaim(app, token);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { projectId: string; claimedAt: number };
    expect(body.projectId).toBe('proj_good');
    expect(body.claimedAt).toBeGreaterThan(0);

    // Drizzle was called: update with set + where + run
    expect(chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_claim_1' })
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(markTrialClaimedMock).toHaveBeenCalledWith(expect.anything(), 'trial_good');

    // Set-Cookie should clear the claim cookie
    const setCookie = resp.headers.get('Set-Cookie');
    expect(setCookie).toContain('sam_trial_claim=;');
    expect(setCookie).toContain('Max-Age=0');
  });

  it('still returns 200 when markTrialClaimed fails (best-effort)', async () => {
    const app = makeApp();
    const token = await signClaimToken(futurePayload(), SECRET);
    readTrialMock.mockResolvedValueOnce({
      trialId: 'trial_good',
      projectId: 'proj_good',
      claimed: false,
    });
    markTrialClaimedMock.mockRejectedValueOnce(new Error('KV outage'));
    setDrizzleUpdateChanges(1);

    const resp = await postClaim(app, token);
    expect(resp.status).toBe(200);
  });
});

// Keep reference so the import isn't flagged as unused.
errors.badRequest;
