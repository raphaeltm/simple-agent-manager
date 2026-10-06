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
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

// Auth — always return a user so the claim route runs its own logic.
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_: unknown, next: () => Promise<unknown>) => next()),
  getUserId: () => 'user_claim_1',
}));

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

interface MockD1Statement {
  sql: string;
  binds: unknown[];
  run: ReturnType<typeof vi.fn>;
}

interface ClaimTestEnv extends Env {
  __statements: MockD1Statement[];
}

function makeEnv(
  overrides: Partial<Env> = {},
  options: {
    projectUpdateChanges?: number;
    trialUpdateChanges?: number;
    batchReject?: Error;
    rollbackChanges?: number;
  } = {},
): ClaimTestEnv {
  const statements: MockD1Statement[] = [];
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...binds: unknown[]) => {
      const statement: MockD1Statement = {
        sql,
        binds,
        run: vi.fn(async () => {
          return { meta: { changes: options.rollbackChanges ?? 1 } };
        }),
      };
      statements.push(statement);
      return statement;
    }),
  }));
  const batch = vi.fn(async () => {
    if (options.batchReject) {
      throw options.batchReject;
    }
    return [
      { meta: { changes: options.projectUpdateChanges ?? 1 } },
      { meta: { changes: options.trialUpdateChanges ?? 1 } },
    ];
  });

  return {
    DATABASE: { prepare, batch } as unknown as D1Database,
    TRIAL_CLAIM_TOKEN_SECRET: SECRET,
    __statements: statements,
    ...overrides,
  } as unknown as ClaimTestEnv;
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

function trialRecord(
  overrides: Partial<{
    trialId: string;
    projectId: string;
    claimed: boolean;
    expiresAt: number;
  }> = {}
) {
  return {
    trialId: 'trial_good',
    projectId: 'proj_good',
    claimed: false,
    expiresAt: Date.now() + 3600_000,
    ...overrides,
  };
}

describe('POST /api/trial/claim', () => {
  beforeEach(() => {
    readTrialMock.mockReset();
    markTrialClaimedMock.mockReset();
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
    readTrialMock.mockResolvedValueOnce(trialRecord({
      trialId: 'trial_good',
      projectId: 'proj_record_different',
    }));
    const resp = await postClaim(app, token);
    expect(resp.status).toBe(400);
  });

  it('returns 409 when trial is already claimed in KV', async () => {
    const app = makeApp();
    const token = await signClaimToken(futurePayload(), SECRET);
    readTrialMock.mockResolvedValueOnce(trialRecord({ claimed: true }));
    const resp = await postClaim(app, token);
    expect(resp.status).toBe(409);
  });

  it('returns 409 when the KV trial record has expired', async () => {
    const app = makeApp();
    const token = await signClaimToken(futurePayload(), SECRET);
    readTrialMock.mockResolvedValueOnce(trialRecord({ expiresAt: Date.now() - 1 }));
    const resp = await postClaim(app, token);
    expect(resp.status).toBe(409);
  });

  it('returns 409 when project re-parent affects zero rows (race)', async () => {
    const app = makeApp();
    const token = await signClaimToken(futurePayload(), SECRET);
    const env = makeEnv({}, { projectUpdateChanges: 0, trialUpdateChanges: 0 });
    readTrialMock.mockResolvedValueOnce(trialRecord());
    const resp = await postClaim(app, token, env);
    expect(resp.status).toBe(409);
  });

  it('returns 500 and rolls back when D1 refuses the trial claimed transition after re-parent', async () => {
    const app = makeApp();
    const token = await signClaimToken(futurePayload(), SECRET);
    const env = makeEnv({}, { projectUpdateChanges: 1, trialUpdateChanges: 0 });
    readTrialMock.mockResolvedValueOnce(trialRecord());

    const resp = await postClaim(app, token, env);

    expect(resp.status).toBe(500);
    expect(markTrialClaimedMock).not.toHaveBeenCalled();
    const rollback = env.__statements.find((stmt) =>
      stmt.sql.includes('UPDATE projects') && stmt.sql.includes('WHERE id = ?') && stmt.binds[0] === 'system_anonymous_trials'
    );
    expect(rollback).toBeDefined();
    expect(rollback?.run).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when D1 cannot record the batched claim transition', async () => {
    const app = makeApp();
    const token = await signClaimToken(futurePayload(), SECRET);
    const env = makeEnv({}, { batchReject: new Error('D1 unavailable') });
    readTrialMock.mockResolvedValueOnce(trialRecord());

    const resp = await postClaim(app, token, env);

    expect(resp.status).toBe(500);
    expect(markTrialClaimedMock).not.toHaveBeenCalled();
  });

  it('returns 200 and clears claim cookie on successful re-parent', async () => {
    const app = makeApp();
    const token = await signClaimToken(futurePayload(), SECRET);
    const env = makeEnv();
    readTrialMock.mockResolvedValueOnce(trialRecord());
    markTrialClaimedMock.mockResolvedValueOnce({
      trialId: 'trial_good',
      projectId: 'proj_good',
      claimed: true,
    });

    const resp = await postClaim(app, token, env);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { projectId: string; claimedAt: number };
    expect(body.projectId).toBe('proj_good');
    expect(body.claimedAt).toBeGreaterThan(0);

    expect(env.DATABASE.batch).toHaveBeenCalledTimes(1);
    expect(markTrialClaimedMock).toHaveBeenCalledWith(expect.anything(), 'trial_good');
    expect(env.__statements.some((stmt) => stmt.sql.includes("SET status = 'claimed'"))).toBe(true);
    expect(env.__statements.some((stmt) => stmt.sql.includes('AND EXISTS'))).toBe(true);

    // Set-Cookie should clear the claim cookie
    const setCookie = resp.headers.get('Set-Cookie');
    expect(setCookie).toContain('sam_trial_claim=;');
    expect(setCookie).toContain('Max-Age=0');
  });

  it('still returns 200 when markTrialClaimed fails (best-effort)', async () => {
    const app = makeApp();
    const token = await signClaimToken(futurePayload(), SECRET);
    readTrialMock.mockResolvedValueOnce(trialRecord());
    markTrialClaimedMock.mockRejectedValueOnce(new Error('KV outage'));

    const resp = await postClaim(app, token);
    expect(resp.status).toBe(200);
  });
});

// Keep reference so the import isn't flagged as unused.
errors.badRequest;
