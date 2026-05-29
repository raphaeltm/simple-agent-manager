import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { buildAuthTestApp, createMockAuth } from './auth-test-helpers';

const { mockGetSession, mockCreateSession, mockAuth } = createMockAuth();

vi.mock('drizzle-orm/d1', () => ({ drizzle: vi.fn(() => currentMockDB) }));
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn((...args: unknown[]) => ({ type: 'eq', args })),
    and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
    isNull: vi.fn((...args: unknown[]) => ({ type: 'isNull', args })),
  };
});
vi.mock('../../../src/auth', () => ({ createAuth: vi.fn(() => mockAuth) }));
vi.mock('../../../src/lib/ulid', () => ({ ulid: vi.fn(() => 'test-ulid-123') }));
vi.mock('../../../src/middleware/rate-limit', () => ({
  rateLimit: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
}));

import { apiTokenRoutes } from '../../../src/routes/api-tokens';

let currentMockDB: ReturnType<typeof createMockDB>;

function createMockDB(options: {
  selectGetResults?: unknown[];
  selectAllResults?: unknown[][];
  updateChanges?: number;
}) {
  const getQueue = [...(options.selectGetResults || [])];
  const allQueue = [...(options.selectAllResults || [])];
  const changes = options.updateChanges ?? 1;

  return {
    select: vi.fn(() => {
      const chain = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        all: vi.fn(() => Promise.resolve(allQueue.shift() || [])),
        get: vi.fn(() => Promise.resolve(getQueue.shift() ?? null)),
      };
      return chain;
    }),
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
    update: vi.fn(() => {
      const chain = {
        set: vi.fn(() => chain),
        where: vi.fn(() => Promise.resolve({ meta: { changes } })),
      };
      return chain;
    }),
  };
}

function buildApp(envOverrides: Partial<Env> = {}) {
  return buildAuthTestApp(apiTokenRoutes, '/api/auth', envOverrides);
}

describe('API token routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSession.mockResolvedValue({ token: 'ba-session-token-abc' });
  });

  it('lists API tokens for the authenticated user without a feature gate', async () => {
    currentMockDB = createMockDB({ selectAllResults: [[{ id: 'token-1', name: 'CLI' }]] });
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });

    const res = await buildApp().request('/api/auth/api-tokens');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 'token-1', name: 'CLI' }]);
  });

  it('creates a token with sam_pat_ prefix', async () => {
    currentMockDB = createMockDB({ selectAllResults: [[]] });
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });

    const res = await buildApp().request('/api/auth/api-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Work laptop' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toMatch(/^sam_pat_/);
    expect(body.name).toBe('Work laptop');
  });

  it('revokes a token owned by the authenticated user', async () => {
    currentMockDB = createMockDB({ updateChanges: 1 });
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });

    const res = await buildApp().request('/api/auth/api-tokens/token-1', { method: 'DELETE' });

    expect(res.status).toBe(200);
  });

  it('token-login accepts new sam_pat_ tokens and returns sessionCookie in JSON', async () => {
    currentMockDB = createMockDB({
      selectGetResults: [
        { id: 'token-1', userId: 'user-1', revokedAt: null },
        { id: 'user-1', email: 'test@example.com', name: 'Test User', status: 'active', role: 'user' },
      ],
    });

    const res = await buildApp().request('/api/auth/token-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'sam_pat_validtoken123' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionCookie).toMatch(/better-auth\.session_token=/);
    expect(body.user.email).toBe('test@example.com');
    expect(res.headers.get('Set-Cookie')).toContain(body.sessionCookie);
  });

  it('token-login preserves backward compatibility for sam_test_ tokens', async () => {
    currentMockDB = createMockDB({
      selectGetResults: [
        { id: 'token-1', userId: 'user-1', revokedAt: null },
        { id: 'user-1', email: 'legacy@example.com', name: 'Legacy', status: 'active', role: 'user' },
      ],
    });

    const res = await buildApp().request('/api/auth/token-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'sam_test_legacytoken123' }),
    });

    expect(res.status).toBe(200);
  });
});
