import type { SignupApprovalConfig } from '@simple-agent-manager/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const mocks = vi.hoisted(() => ({
  getSignupApprovalConfig: vi.fn(),
  setSignupApprovalConfig: vi.fn(),
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: any, next: any) => next(),
  requireApproved: () => async (_c: any, next: any) => next(),
  requireSuperadmin: () => async (c: any, next: any) => {
    if (c.req.header('X-Test-Role') !== 'superadmin') {
      return c.json({ error: 'FORBIDDEN', message: 'Superadmin required' }, 403);
    }
    await next();
  },
  getUserId: () => 'superadmin-1',
}));

vi.mock('../../../src/middleware/rate-limit', () => ({
  rateLimit: () => async (_c: any, next: any) => next(),
}));

vi.mock('../../../src/services/limits', () => ({
  getRuntimeLimits: () => ({ maxNodesPerUser: 5, maxProjectsPerUser: 10 }),
}));

vi.mock('../../../src/services/observability', () => ({
  queryErrors: vi.fn(),
  getHealthSummary: vi.fn(),
  getErrorTrends: vi.fn(),
  queryCloudflareLogs: vi.fn(),
  getLogQueryRateLimit: () => 30,
  CfApiError: class extends Error {
    constructor(message: string) {
      super(message);
    }
  },
}));

vi.mock('../../../src/services/signup-approval', () => ({
  getSignupApprovalConfig: mocks.getSignupApprovalConfig,
  setSignupApprovalConfig: mocks.setSignupApprovalConfig,
}));

const { adminRoutes } = await import('../../../src/routes/admin');

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/admin', adminRoutes);
  return app;
}

function config(requireApproval: boolean): SignupApprovalConfig {
  return {
    requireApproval,
    source: 'runtime',
    updatedAt: '2026-07-06T12:00:00.000Z',
    updatedBy: 'superadmin-1',
  };
}

describe('admin signup approval routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the current signup approval config for superadmins', async () => {
    mocks.getSignupApprovalConfig.mockResolvedValue(config(false));

    const res = await createApp().request(
      '/api/admin/signup-approval',
      { headers: { 'X-Test-Role': 'superadmin' } },
      {} as Env,
    );

    await expect(res.json()).resolves.toEqual({ config: config(false) });
    expect(res.status).toBe(200);
    expect(mocks.getSignupApprovalConfig).toHaveBeenCalledOnce();
  });

  it('updates the config and records the superadmin user id', async () => {
    mocks.setSignupApprovalConfig.mockResolvedValue(config(true));

    const res = await createApp().request(
      '/api/admin/signup-approval',
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Test-Role': 'superadmin',
        },
        body: JSON.stringify({ requireApproval: true }),
      },
      {} as Env,
    );

    await expect(res.json()).resolves.toEqual({ config: config(true) });
    expect(res.status).toBe(200);
    expect(mocks.setSignupApprovalConfig).toHaveBeenCalledWith(
      expect.anything(),
      { requireApproval: true, updatedBy: 'superadmin-1' },
    );
  });

  it('keeps the endpoint behind the superadmin guard', async () => {
    const res = await createApp().request(
      '/api/admin/signup-approval',
      { headers: { 'X-Test-Role': 'admin' } },
      {} as Env,
    );

    await expect(res.json()).resolves.toEqual({
      error: 'FORBIDDEN',
      message: 'Superadmin required',
    });
    expect(res.status).toBe(403);
    expect(mocks.getSignupApprovalConfig).not.toHaveBeenCalled();
  });
});
