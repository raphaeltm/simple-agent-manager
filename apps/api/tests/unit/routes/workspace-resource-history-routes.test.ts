import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { projectResourceHistoryRoutes } from '../../../src/routes/projects/workspace-resource-history';
import { getWorkspaceResourceHistory } from '../../../src/services/workspace-resource-history';

const mocks = vi.hoisted(() => ({
  db: { id: 'mock-db' },
  requireProjectAccess: vi.fn(),
  getWorkspaceResourceHistory: vi.fn(),
  getSessionResourceTimeline: vi.fn(),
  getSessionResourceTimelineChunk: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => mocks.db),
}));

vi.mock('../../../src/middleware/auth', () => ({
  getUserId: () => 'member-1',
}));

vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectAccess: mocks.requireProjectAccess,
}));

vi.mock('../../../src/services/workspace-resource-history', () => ({
  getWorkspaceResourceHistory: mocks.getWorkspaceResourceHistory,
}));

vi.mock('../../../src/services/workspace-resource-timeline', () => ({
  getSessionResourceTimeline: mocks.getSessionResourceTimeline,
  getSessionResourceTimelineChunk: mocks.getSessionResourceTimelineChunk,
}));

describe('workspace resource history project routes', () => {
  let app: Hono<{ Bindings: Env }>;
  const env = { DATABASE: {} as Env['DATABASE'] } as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireProjectAccess.mockResolvedValue(undefined);
    mocks.getWorkspaceResourceHistory.mockResolvedValue({
      summary: {
        id: 'summary-1',
        agentProfileId: 'profile-1',
        skillId: 'skill-1',
        agentType: 'openai-codex',
      },
      chunks: [{ id: 'wrchunk:1' }],
    });
    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route('/api/projects', projectResourceHistoryRoutes);
  });

  it('returns session-scoped history after project membership authorization', async () => {
    const res = await app.request(
      '/api/projects/proj-1/sessions/sess-1/resource-history?chunkId=wrchunk%3A1',
      { method: 'GET' },
      env
    );

    expect(res.status).toBe(200);
    expect(drizzle).toHaveBeenCalledWith(env.DATABASE, expect.any(Object));
    expect(mocks.requireProjectAccess).toHaveBeenCalledWith(mocks.db, 'proj-1', 'member-1');
    expect(getWorkspaceResourceHistory).toHaveBeenCalledWith(env, {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      detailChunkId: 'wrchunk:1',
    });
    expect(await res.json()).toEqual({
      summary: {
        id: 'summary-1',
        agentProfileId: 'profile-1',
        skillId: 'skill-1',
        agentType: 'openai-codex',
      },
      chunks: [{ id: 'wrchunk:1' }],
    });
  });

  it('rejects overly long detail chunk IDs before reading R2 detail', async () => {
    const longChunkId = 'x'.repeat(257);
    const res = await app.request(
      `/api/projects/proj-1/tasks/task-1/resource-history?chunkId=${longChunkId}`,
      { method: 'GET' },
      env
    );

    expect(res.status).toBe(400);
    expect(mocks.requireProjectAccess).toHaveBeenCalledWith(mocks.db, 'proj-1', 'member-1');
    expect(mocks.getWorkspaceResourceHistory).not.toHaveBeenCalled();
  });

  it('propagates project access errors without reading resource history', async () => {
    mocks.requireProjectAccess.mockRejectedValueOnce(
      Object.assign(new Error('Project not found'), { statusCode: 404, error: 'NOT_FOUND' })
    );

    const res = await app.request(
      '/api/projects/proj-1/workspaces/ws-1/resource-history',
      { method: 'GET' },
      env
    );

    expect(res.status).toBe(404);
    expect(mocks.getWorkspaceResourceHistory).not.toHaveBeenCalled();
  });

  it('serves the whole-session timeline index after project authorization', async () => {
    mocks.getSessionResourceTimeline.mockResolvedValueOnce({ sessionId: 'sess-1', chunks: [] });

    const res = await app.request(
      '/api/projects/proj-1/sessions/sess-1/resource-timeline',
      {},
      env
    );

    expect(res.status).toBe(200);
    expect(mocks.requireProjectAccess).toHaveBeenCalledWith(mocks.db, 'proj-1', 'member-1');
    expect(mocks.getSessionResourceTimeline).toHaveBeenCalledWith(env, {
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });
    expect(await res.json()).toEqual({ sessionId: 'sess-1', chunks: [] });
  });

  it('serves one timeline chunk scoped to the project and session in the path', async () => {
    mocks.getSessionResourceTimelineChunk.mockResolvedValueOnce({
      chunkId: 'wrchunk:1',
      samples: [],
    });

    const res = await app.request(
      '/api/projects/proj-1/sessions/sess-1/resource-timeline/chunks/wrchunk%3A1',
      {},
      env
    );

    expect(res.status).toBe(200);
    expect(mocks.getSessionResourceTimelineChunk).toHaveBeenCalledWith(env, {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      chunkId: 'wrchunk:1',
    });
  });

  it('reads no timeline data when project access is denied', async () => {
    mocks.requireProjectAccess.mockRejectedValue(
      Object.assign(new Error('Project not found'), { statusCode: 404, error: 'NOT_FOUND' })
    );

    const index = await app.request(
      '/api/projects/proj-1/sessions/sess-1/resource-timeline',
      {},
      env
    );
    const chunk = await app.request(
      '/api/projects/proj-1/sessions/sess-1/resource-timeline/chunks/wrchunk%3A1',
      {},
      env
    );

    expect(index.status).toBe(404);
    expect(chunk.status).toBe(404);
    expect(mocks.getSessionResourceTimeline).not.toHaveBeenCalled();
    expect(mocks.getSessionResourceTimelineChunk).not.toHaveBeenCalled();
  });
});
