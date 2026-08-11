/**
 * Tests for orchestrator override REST route (apps/api/src/routes/orchestrator.ts
 * POST /tasks/:taskId/override).
 *
 * Covers the jsonValidator migration: valid bodies reach the service layer,
 * malformed bodies are rejected with the standard 400 shape before the
 * service is called, and the pre-existing handler-level checks (missing
 * fields, invalid state) keep their exact messages.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const mocks = vi.hoisted(() => ({
  requireProjectCapability: vi.fn(),
  overrideTaskState: vi.fn(),
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  getAuth: () => ({
    user: { id: 'user-1', email: 'u@test.dev', name: 'U', role: 'user', status: 'active' },
  }),
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectCapability: mocks.requireProjectCapability,
}));
vi.mock('../../../src/services/project-orchestrator', () => ({
  overrideTaskState: mocks.overrideTaskState,
}));

import { drizzle } from 'drizzle-orm/d1';

vi.mock('drizzle-orm/d1', () => ({ drizzle: vi.fn() }));

import { orchestratorRoutes } from '../../../src/routes/orchestrator';

const ROUTE_PATH = '/api/projects/:projectId/orchestrator';
const BASE = 'https://api.test.example.com/api/projects/project-1/orchestrator';

function makeEnv(): Env {
  return { DATABASE: {} as unknown } as Env;
}

/** Chainable drizzle mock — mirrors the pattern used in dashboard.test.ts. */
function mockMissionQuery(rows: Array<{ id: string }>) {
  const mockDb = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  (drizzle as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockDb);
  return mockDb;
}

function makeApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json(
        { error: appError.error, message: appError.message },
        appError.statusCode as 400
      );
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route(ROUTE_PATH, orchestratorRoutes);
  return app;
}

describe('orchestrator override route', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireProjectCapability.mockResolvedValue({ id: 'project-1', userId: 'owner-1' });
    app = makeApp();
  });

  it('overrides task state from a valid body', async () => {
    mockMissionQuery([{ id: 'mission-1' }]);
    mocks.overrideTaskState.mockResolvedValueOnce(true);

    const res = await app.request(
      `${BASE}/tasks/task-1/override`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          missionId: 'mission-1',
          newState: 'schedulable',
          reason: 'manual retry',
        }),
      },
      makeEnv()
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });
    expect(mocks.overrideTaskState).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      'mission-1',
      'task-1',
      'schedulable',
      'manual retry'
    );
  });

  it('rejects a malformed body (wrong-type missionId) with the standard 400 shape before calling the service', async () => {
    const res = await app.request(
      `${BASE}/tasks/task-1/override`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ missionId: 42, newState: 'schedulable', reason: 'x' }),
      },
      makeEnv()
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('BAD_REQUEST');
    expect(mocks.overrideTaskState).not.toHaveBeenCalled();
  });

  it('preserves the "Missing missionId, newState, or reason" message when a field is missing', async () => {
    const res = await app.request(
      `${BASE}/tasks/task-1/override`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ missionId: 'mission-1', newState: 'schedulable' }),
      },
      makeEnv()
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('Missing missionId, newState, or reason');
    expect(mocks.overrideTaskState).not.toHaveBeenCalled();
  });

  it('preserves the "Invalid state" message for a newState outside the overridable allowlist', async () => {
    const res = await app.request(
      `${BASE}/tasks/task-1/override`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ missionId: 'mission-1', newState: 'not-a-real-state', reason: 'x' }),
      },
      makeEnv()
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain('Invalid state: not-a-real-state');
    expect(mocks.overrideTaskState).not.toHaveBeenCalled();
  });
});
