import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const mocks = vi.hoisted(() => ({
  drizzle: vi.fn(),
  getUserId: vi.fn(),
  requireProjectCapability: vi.fn(),
  getSession: vi.fn(),
  getMessages: vi.fn(),
  ensureSessionTaskBacked: vi.fn(),
  summarizeSession: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => ({ drizzle: mocks.drizzle }));
vi.mock('../../../src/middleware/auth', () => ({ getUserId: mocks.getUserId }));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectCapability: mocks.requireProjectCapability,
}));
vi.mock('../../../src/services/project-data', () => ({
  getSession: mocks.getSession,
  getMessages: mocks.getMessages,
}));
vi.mock('../../../src/services/session-task-repair', () => ({
  ensureSessionTaskBacked: mocks.ensureSessionTaskBacked,
}));
vi.mock('../../../src/services/session-summarize', () => ({
  getSummarizeConfig: vi.fn(() => ({})),
  summarizeSession: mocks.summarizeSession,
}));

import { chatForkRoutes } from '../../../src/routes/chat-fork';

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/projects/:projectId/sessions', chatForkRoutes);
  return app;
}

describe('chatForkRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.drizzle.mockReturnValue({});
    mocks.getUserId.mockReturnValue('forking-user');
    mocks.requireProjectCapability.mockResolvedValue({ id: 'project-1' });
    mocks.getSession.mockResolvedValue({
      id: 'session-1',
      topic: 'Source chat',
      taskId: null,
      createdByUserId: 'source-creator',
    });
    mocks.getMessages.mockResolvedValue({
      messages: [{ role: 'user', content: 'Original prompt', createdAt: 1 }],
    });
    mocks.ensureSessionTaskBacked.mockResolvedValue({
      id: 'parent-task',
      title: 'Source chat',
      description: 'Original prompt',
      outputBranch: 'sam/source',
      outputPrUrl: null,
      outputSummary: null,
    });
    mocks.summarizeSession.mockResolvedValue({ summary: 'Source summary', messageCount: 1 });
  });

  it('prepares a fork for an authorized teammate and preserves source creator attribution', async () => {
    const res = await makeApp().request(
      'https://api.test/api/projects/project-1/sessions/session-1/fork-prepare',
      { method: 'POST' },
      { DATABASE: {} } as Env
    );

    expect(res.status).toBe(200);
    expect(mocks.requireProjectCapability).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      'forking-user',
      'task:write'
    );
    expect(mocks.ensureSessionTaskBacked).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        projectId: 'project-1',
        sessionId: 'session-1',
        fallbackUserId: 'source-creator',
      }
    );
    await expect(res.json()).resolves.toMatchObject({
      parentTaskId: 'parent-task',
      parentSessionId: 'session-1',
      repaired: true,
    });
  });

  it('returns not found without attempting legacy repair for a missing session', async () => {
    mocks.getSession.mockResolvedValueOnce(null);

    const res = await makeApp().request(
      'https://api.test/api/projects/project-1/sessions/missing/fork-prepare',
      { method: 'POST' },
      { DATABASE: {} } as Env
    );

    expect(res.status).toBe(404);
    expect(mocks.ensureSessionTaskBacked).not.toHaveBeenCalled();
  });
});
