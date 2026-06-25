import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const mockVerifyCallbackToken = vi.fn();
const insertedEvents: Array<Record<string, unknown>> = [];
let selectLimitCount = 0;

vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: (...args: unknown[]) => mockVerifyCallbackToken(...args),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            selectLimitCount += 1;
            if (selectLimitCount === 1) {
              return Promise.resolve([{ projectId: 'proj-1', nodeId: 'node-1' }]);
            }
            if (selectLimitCount === 2) {
              return Promise.resolve([{ id: 'rel-7' }]);
            }
            return Promise.resolve([{ maxSeq: 0 }]);
          },
        }),
      }),
    }),
    insert: () => ({
      values: (value: Record<string, unknown>) => {
        insertedEvents.push(value);
        return Promise.resolve();
      },
    }),
  }),
}));

const { deploymentReleaseEventsCallbackRoute } = await import(
  '../../../src/routes/deployment-release-events-callback'
);

function createTestApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/nodes', deploymentReleaseEventsCallbackRoute);
  return app;
}

function requestEvent(headers: HeadersInit = { Authorization: 'Bearer node-token' }) {
  return createTestApp().request(
    '/api/nodes/node-1/deployment-release-events',
    {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        environmentId: 'env-1',
        releaseVersion: 7,
        eventType: 'deployment.apply.started',
        step: 'apply',
        message: 'deployment apply started',
      }),
    },
    { DATABASE: {} } as Env
  );
}

describe('deployment release events callback route', () => {
  beforeEach(() => {
    insertedEvents.length = 0;
    selectLimitCount = 0;
    mockVerifyCallbackToken.mockReset();
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'node-1',
      type: 'callback',
      scope: 'node',
    });
  });

  it('accepts node callback JWTs and persists release events', async () => {
    const response = await requestEvent();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mockVerifyCallbackToken).toHaveBeenCalledWith('node-token', expect.anything());
    expect(insertedEvents).toHaveLength(1);
    expect(insertedEvents[0]).toMatchObject({
      projectId: 'proj-1',
      environmentId: 'env-1',
      releaseId: 'rel-7',
      releaseVersion: 7,
      nodeId: 'node-1',
      seq: 1,
      eventType: 'deployment.apply.started',
      step: 'apply',
      message: 'deployment apply started',
    });
  });

  it('rejects missing and workspace-scoped callback tokens', async () => {
    const missing = await requestEvent({});
    expect(missing.status).toBe(401);

    mockVerifyCallbackToken.mockResolvedValueOnce({
      workspace: 'workspace-1',
      type: 'callback',
      scope: 'workspace',
    });
    const workspaceScoped = await requestEvent();
    expect(workspaceScoped.status).toBe(403);
    expect(insertedEvents).toHaveLength(0);
  });
});
