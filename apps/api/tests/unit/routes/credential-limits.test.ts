import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { credentialLimitsRoute } from '../../../src/routes/credential-limits';
import { credentialLimitRoutes } from '../../../src/routes/projects/credential-limits';

const mocks = vi.hoisted(() => ({
  requireProjectCapability: vi.fn(),
  listProjectCredentialLimits: vi.fn(),
  listUserCredentialLimits: vi.fn(),
  resolveAgentSessionCredentialReference: vi.fn(),
  requireAuthCalls: 0,
}));

vi.mock('drizzle-orm/d1', () => ({ drizzle: vi.fn(() => ({ id: 'mock-db' })) }));

vi.mock('../../../src/middleware/auth', () => ({
  getUserId: () => 'member-1',
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => {
    mocks.requireAuthCalls += 1;
    await next();
  },
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectCapability: mocks.requireProjectCapability,
}));

vi.mock('../../../src/services/credential-limit-events/read', () => ({
  listProjectCredentialLimits: mocks.listProjectCredentialLimits,
  listUserCredentialLimits: mocks.listUserCredentialLimits,
  resolveAgentSessionCredentialReference: mocks.resolveAgentSessionCredentialReference,
}));

const SAMPLE = {
  credentials: [
    {
      credentialReference: 'cc_credentials:cred-1',
      credentialId: 'cred-1',
      credentialSource: 'user',
      provider: 'anthropic',
      providerMode: 'direct',
      agentType: 'claude-code',
      level: 'warning',
      observedAt: 1_700_000_000_000,
      windows: [],
    },
  ],
  generatedAt: 1_700_000_000_500,
};

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/projects', credentialLimitRoutes);
  app.route('/api/credentials', credentialLimitsRoute);
  return app;
}

describe('credential limit read routes', () => {
  let app: Hono<{ Bindings: Env }>;
  const env = { DATABASE: {} as Env['DATABASE'] } as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthCalls = 0;
    app = buildApp();
    mocks.requireProjectCapability.mockResolvedValue({ id: 'proj-1' });
    mocks.listProjectCredentialLimits.mockResolvedValue(SAMPLE);
    mocks.listUserCredentialLimits.mockResolvedValue(SAMPLE);
  });

  it('requires project:read and returns the project view', async () => {
    const response = await app.request('/api/projects/proj-1/credential-limits', {}, env);
    expect(response.status).toBe(200);
    expect(mocks.requireProjectCapability).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      'member-1',
      'project:read'
    );
    expect(mocks.listProjectCredentialLimits).toHaveBeenCalledWith(env, {
      projectId: 'proj-1',
      userId: 'member-1',
      credentialReference: undefined,
    });
    expect(mocks.resolveAgentSessionCredentialReference).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual(SAMPLE);
  });

  it("narrows to the agent session's server-attributed credential", async () => {
    mocks.resolveAgentSessionCredentialReference.mockResolvedValue('cc_credentials:cred-1');
    const response = await app.request(
      '/api/projects/proj-1/credential-limits?agentSessionId=01SESSION',
      {},
      env
    );
    expect(response.status).toBe(200);
    expect(mocks.resolveAgentSessionCredentialReference).toHaveBeenCalledWith(env, {
      projectId: 'proj-1',
      agentSessionId: '01SESSION',
    });
    expect(mocks.listProjectCredentialLimits).toHaveBeenCalledWith(env, {
      projectId: 'proj-1',
      userId: 'member-1',
      credentialReference: 'cc_credentials:cred-1',
    });
  });

  it('returns an empty list when the agent session has no attribution', async () => {
    mocks.resolveAgentSessionCredentialReference.mockResolvedValue(null);
    const response = await app.request(
      '/api/projects/proj-1/credential-limits?agentSessionId=01SESSION',
      {},
      env
    );
    expect(response.status).toBe(200);
    expect(mocks.listProjectCredentialLimits).not.toHaveBeenCalled();
    const body = (await response.json()) as { credentials: unknown[]; generatedAt: number };
    expect(body.credentials).toEqual([]);
    expect(typeof body.generatedAt).toBe('number');
  });

  it('rejects a malformed agentSessionId before touching the database', async () => {
    const response = await app.request(
      `/api/projects/proj-1/credential-limits?agentSessionId=${encodeURIComponent("x' OR 1=1")}`,
      {},
      env
    );
    expect(response.status).toBe(400);
    expect(mocks.resolveAgentSessionCredentialReference).not.toHaveBeenCalled();
    expect(mocks.listProjectCredentialLimits).not.toHaveBeenCalled();
  });

  it('propagates a membership rejection without reading windows', async () => {
    mocks.requireProjectCapability.mockRejectedValue(
      Object.assign(new Error('Project capability is required'), {
        statusCode: 403,
        error: 'FORBIDDEN',
      })
    );
    const response = await app.request('/api/projects/proj-1/credential-limits', {}, env);
    expect(response.status).toBe(403);
    expect(mocks.listProjectCredentialLimits).not.toHaveBeenCalled();
  });

  it("serves the signed-in user's personal credentials at /api/credentials/limits", async () => {
    const response = await app.request('/api/credentials/limits', {}, env);
    expect(response.status).toBe(200);
    expect(mocks.requireAuthCalls).toBe(1);
    expect(mocks.listUserCredentialLimits).toHaveBeenCalledWith(env, { userId: 'member-1' });
    await expect(response.json()).resolves.toEqual(SAMPLE);
  });
});
