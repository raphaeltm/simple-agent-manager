/**
 * auth middleware — behavioral tests for `resolveSessionStatus`.
 *
 * `resolveSessionStatus` is module-private (not exported), so it is exercised
 * through the public `requireAuth` / `optionalAuth` middleware that call it when
 * projecting a BetterAuth session onto the request `auth` context.
 *
 * The function exists because `'system'` is the status of internal sentinel rows
 * (e.g. system_anonymous_trials, seeded by migration 0043). `status` is an
 * input:false additionalField — only migrations write 'system' — so a real,
 * OAuth-authenticated request must never carry it. If a live session does, that is
 * an anomaly: the middleware logs `auth.system_status_anomaly` and falls back to the
 * least-privileged status ('pending') rather than coercing it to 'active' and
 * granting access. These tests assert each branch:
 *   1. 'system' -> 'pending' + a logged anomaly
 *   2. non-string -> 'active' (the safe default for absent/legacy status fields)
 *   3. any other string -> passed through verbatim
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../../src/auth', () => ({
  createAuth: vi.fn(() => ({
    api: { getSession: mocks.getSession },
  })),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mocks.warn,
    error: vi.fn(),
  },
}));

import { optionalAuth, requireAuth } from '../../../src/middleware/auth';

interface SessionUser {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  role?: unknown;
  status?: unknown;
}

function makeSession(user: SessionUser) {
  return {
    user,
    session: {
      id: 'sess-1',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    },
  };
}

interface CapturedAuth {
  user: { id: string; role: string; status: string };
  session: { id: string };
}

function makeContext() {
  const store: Record<string, unknown> = {};
  const c = {
    env: { GITHUB_CLIENT_ID: 'x' } as Record<string, unknown>,
    req: { raw: { headers: new Headers() } },
    set: (key: string, value: unknown) => {
      store[key] = value;
    },
    get: (key: string) => store[key],
  };
  return { c, store };
}

describe('resolveSessionStatus via requireAuth', () => {
  beforeEach(() => {
    mocks.getSession.mockReset();
    mocks.warn.mockReset();
  });

  it("downgrades a 'system' session status to 'pending' and logs an anomaly", async () => {
    mocks.getSession.mockResolvedValue(
      makeSession({ id: 'sentinel-1', email: 's@x.internal', role: 'user', status: 'system' }),
    );
    const { c, store } = makeContext();
    const next = vi.fn(async () => {});

    await requireAuth()(c as never, next as never);

    expect((store.auth as CapturedAuth).user.status).toBe('pending');
    expect(mocks.warn).toHaveBeenCalledWith('auth.system_status_anomaly', { userId: 'sentinel-1' });
    expect(next).toHaveBeenCalledOnce();
  });

  it("defaults a non-string status to 'active' without logging an anomaly", async () => {
    mocks.getSession.mockResolvedValue(
      makeSession({ id: 'user-1', email: 'u@x.com', role: 'user', status: undefined }),
    );
    const { c, store } = makeContext();

    await requireAuth()(c as never, vi.fn(async () => {}) as never);

    expect((store.auth as CapturedAuth).user.status).toBe('active');
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it.each([
    { id: 'user-2', email: 'a@x.com', status: 'active' },
    { id: 'user-3', email: 'b@x.com', status: 'suspended' },
  ])('passes through a $status status verbatim', async ({ id, email, status }) => {
    mocks.getSession.mockResolvedValue(makeSession({ id, email, role: 'user', status }));
    const { c, store } = makeContext();

    await requireAuth()(c as never, vi.fn(async () => {}) as never);

    expect((store.auth as CapturedAuth).user.status).toBe(status);
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});

describe('resolveSessionStatus via optionalAuth', () => {
  beforeEach(() => {
    mocks.getSession.mockReset();
    mocks.warn.mockReset();
  });

  it("downgrades a 'system' status to 'pending' and logs an anomaly", async () => {
    mocks.getSession.mockResolvedValue(
      makeSession({ id: 'sentinel-2', email: 's2@x.internal', role: 'user', status: 'system' }),
    );
    const { c, store } = makeContext();
    const next = vi.fn(async () => {});

    await optionalAuth()(c as never, next as never);

    expect((store.auth as CapturedAuth).user.status).toBe('pending');
    expect(mocks.warn).toHaveBeenCalledWith('auth.system_status_anomaly', { userId: 'sentinel-2' });
    expect(next).toHaveBeenCalledOnce();
  });
});
