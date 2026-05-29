import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { buildAuthTestApp, createMockAuth } from './auth-test-helpers';

const { mockGetSession, mockCreateSession, mockAuth } = createMockAuth();

vi.mock('../../../src/auth', () => ({ createAuth: vi.fn(() => mockAuth) }));
vi.mock('drizzle-orm/d1', () => ({ drizzle: vi.fn(() => currentMockDB) }));
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, eq: vi.fn((...args: unknown[]) => ({ type: 'eq', args })) };
});
vi.mock('../../../src/middleware/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/middleware/rate-limit')>();
  return {
    ...actual,
    checkRateLimit: vi.fn(() => Promise.resolve({ allowed: true, remaining: 10, resetAt: 9999999999 })),
  };
});

import { deviceFlowRoutes } from '../../../src/routes/device-flow';

let currentMockDB: ReturnType<typeof createMockDB>;

function createMockDB(user: unknown = { id: 'user-1', email: 'test@example.com', name: 'Test User', status: 'active', role: 'user' }) {
  return {
    select: vi.fn(() => {
      const chain = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        get: vi.fn(() => Promise.resolve(user)),
      };
      return chain;
    }),
  };
}

function createKV() {
  const data = new Map<string, string>();
  return {
    async get(key: string, type?: 'json') {
      const value = data.get(key) ?? null;
      if (value && type === 'json') return JSON.parse(value);
      return value;
    },
    async put(key: string, value: string) {
      data.set(key, value);
    },
    async delete(key: string) {
      data.delete(key);
    },
    data,
  };
}

function buildApp(kv = createKV(), envOverrides: Partial<Env> = {}) {
  return buildAuthTestApp(deviceFlowRoutes, '/api/auth', { KV: kv, ...envOverrides });
}

describe('device flow routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentMockDB = createMockDB();
    mockCreateSession.mockResolvedValue({ token: 'ba-session-token-device' });
  });

  it('creates a device code and stores pending KV state', async () => {
    const kv = createKV();
    const res = await buildApp(kv).request('/api/auth/device/code', { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deviceCode).toMatch(/^[a-f0-9]{64}$/);
    expect(body.userCode).toMatch(/^[A-Z]{4}-[0-9]{4}$/);
    expect(body.verificationUriComplete).toContain(`/device?code=${body.userCode}`);
    expect(await kv.get(`device:${body.deviceCode}`, 'json')).toMatchObject({
      userCode: body.userCode,
      status: 'pending',
    });
  });

  it('requires auth to approve a device code', async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await buildApp().request('/api/auth/device/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userCode: 'ABCD-1234' }),
    });

    expect(res.status).toBe(401);
  });

  it('approves a pending code and token exchange returns a session cookie once', async () => {
    const kv = createKV();
    const app = buildApp(kv);
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });

    const codeRes = await app.request('/api/auth/device/code', { method: 'POST' });
    const code = await codeRes.json();

    const approveRes = await app.request('/api/auth/device/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userCode: code.userCode }),
    });
    expect(approveRes.status).toBe(200);

    const tokenRes = await app.request('/api/auth/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: code.deviceCode }),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = await tokenRes.json();
    expect(tokenBody.sessionCookie).toMatch(/better-auth\.session_token=/);
    expect(tokenRes.headers.get('Set-Cookie')).toContain(tokenBody.sessionCookie);

    const consumedRes = await app.request('/api/auth/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: code.deviceCode }),
    });
    expect(consumedRes.status).toBe(410);
  });

  it('returns authorization_pending while the code is pending', async () => {
    const app = buildApp();
    const codeRes = await app.request('/api/auth/device/code', { method: 'POST' });
    const code = await codeRes.json();

    const res = await app.request('/api/auth/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: code.deviceCode }),
    });

    expect(res.status).toBe(428);
    expect(await res.json()).toMatchObject({ error: 'authorization_pending' });
  });
});
