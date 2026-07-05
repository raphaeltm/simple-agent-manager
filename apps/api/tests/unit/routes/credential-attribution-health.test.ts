import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { credentialHealthRoutes } from '../../../src/routes/projects/credential-health';
import { getProjectCredentialAttributionHealth } from '../../../src/services/credential-attribution-health';

const mocks = vi.hoisted(() => ({
  db: { id: 'mock-db' },
  requireProjectCapability: vi.fn(),
  getProjectCredentialAttributionHealth: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => mocks.db),
}));

vi.mock('../../../src/middleware/auth', () => ({
  getUserId: () => 'member-1',
}));

vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectCapability: mocks.requireProjectCapability,
}));

vi.mock('../../../src/services/credential-attribution-health', () => ({
  getProjectCredentialAttributionHealth: mocks.getProjectCredentialAttributionHealth,
}));

describe('credential attribution health route', () => {
  let app: Hono<{ Bindings: Env }>;
  const env = {
    DATABASE: {} as Env['DATABASE'],
    DEFAULT_TASK_AGENT_TYPE: 'codex',
  } as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route('/api/projects', credentialHealthRoutes);
  });

  it('uses project:read access and returns metadata-only health for members', async () => {
    const project = {
      id: 'proj-1',
      userId: 'owner-1',
      defaultAgentType: null,
      defaultProvider: null,
    };
    mocks.requireProjectCapability.mockResolvedValue(project);
    mocks.getProjectCredentialAttributionHealth.mockResolvedValue({
      projectId: 'proj-1',
      counts: {
        resources: 1,
        personalResources: 1,
        personalCredentials: 2,
        projectCoveredCredentials: 0,
        unknownCredentials: 0,
      },
      resources: [],
    });

    const res = await app.request(
      '/api/projects/proj-1/credential-attribution-health',
      { method: 'GET' },
      env
    );

    expect(res.status).toBe(200);
    expect(drizzle).toHaveBeenCalledWith(env.DATABASE, expect.any(Object));
    expect(mocks.requireProjectCapability).toHaveBeenCalledWith(
      mocks.db,
      'proj-1',
      'member-1',
      'project:read'
    );
    expect(getProjectCredentialAttributionHealth).toHaveBeenCalledWith({
      db: mocks.db,
      project,
      defaultAgentType: 'codex',
    });
    expect(await res.json()).toEqual({
      projectId: 'proj-1',
      counts: {
        resources: 1,
        personalResources: 1,
        personalCredentials: 2,
        projectCoveredCredentials: 0,
        unknownCredentials: 0,
      },
      resources: [],
    });
  });

  it('propagates access errors for users without project read capability', async () => {
    mocks.requireProjectCapability.mockRejectedValue(
      Object.assign(new Error('Project not found'), {
        statusCode: 404,
        error: 'NOT_FOUND',
      })
    );

    const res = await app.request(
      '/api/projects/proj-1/credential-attribution-health',
      { method: 'GET' },
      env
    );

    expect(res.status).toBe(404);
    expect(mocks.getProjectCredentialAttributionHealth).not.toHaveBeenCalled();
  });
});
