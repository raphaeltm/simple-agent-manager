/**
 * Start work through the real `POST /api/projects/:projectId/tasks/submit` handler.
 *
 * Everything is driven through the route, not through `submitTaskImplementation`
 * directly, so the schema, the auth middleware and the submit flow all participate
 * (rule 62). The idea gate runs against a real SQLite engine with a foreign-project
 * attack case and a same-project owner control (rules 11, 28).
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';
import { seedCloudCredential, seedProjectWithMember, seedUser } from './capacity-pool-test-seeds';

const authState = vi.hoisted(() => ({ userId: 'user-1' }));
const calls = vi.hoisted(() => [] as string[]);
const mocks = vi.hoisted(() => ({
  requireRepositoryUserAccess: vi.fn(),
  recordLink: vi.fn(),
  acceptInstantSession: vi.fn(),
  continueInstantSessionLaunch: vi.fn(),
  getSession: vi.fn(),
  getMessages: vi.fn(),
  createSession: vi.fn(),
  persistMessage: vi.fn(),
  recordActivityEvent: vi.fn(),
  stopSession: vi.fn(),
  updateSessionTopic: vi.fn(),
  startTaskRunnerDO: vi.fn(),
  getTaskRunnerStatus: vi.fn(),
  generateTaskTitle: vi.fn(),
  getTaskTitleConfig: vi.fn(),
  truncateTitle: vi.fn(),
  enrichMessageWithMentions: vi.fn(),
}));

vi.mock('../../../src/operations/link-core', () => ({ recordLink: mocks.recordLink }));

vi.mock('../../../src/services/instant-session', () => ({
  acceptInstantSession: mocks.acceptInstantSession,
  continueInstantSessionLaunch: mocks.continueInstantSessionLaunch,
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getUserId: () => authState.userId,
  getAuth: () => ({
    user: {
      id: authState.userId,
      name: 'User One',
      email: 'user-1@example.com',
      role: 'user',
      status: 'active',
    },
    session: { id: 'session-1', token: null, expiresAt: new Date() },
  }),
}));

vi.mock('../../../src/routes/projects/_helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/routes/projects/_helpers')>()),
  requireRepositoryUserAccess: mocks.requireRepositoryUserAccess,
  requireRepositoryAccess: mocks.requireRepositoryUserAccess,
}));

vi.mock('../../../src/services/project-data', () => ({
  getSession: mocks.getSession,
  getMessages: mocks.getMessages,
  createSession: mocks.createSession,
  persistMessage: mocks.persistMessage,
  recordActivityEvent: mocks.recordActivityEvent,
  stopSession: mocks.stopSession,
  updateSessionTopic: mocks.updateSessionTopic,
}));

vi.mock('../../../src/services/task-runner-do', () => ({
  startTaskRunnerDO: mocks.startTaskRunnerDO,
  getTaskRunnerStatus: mocks.getTaskRunnerStatus,
}));

vi.mock('../../../src/services/task-title', () => ({
  generateTaskTitle: mocks.generateTaskTitle,
  getTaskTitleConfig: mocks.getTaskTitleConfig,
  truncateTitle: mocks.truncateTitle,
}));

vi.mock('../../../src/services/mention-enrichment', () => ({
  enrichMessageWithMentions: mocks.enrichMessageWithMentions,
}));

const { submitRoutes } = await import('../../../src/routes/tasks/submit');

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) =>
    err instanceof AppError
      ? c.json(err.toJSON(), err.statusCode as never)
      : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500)
  );
  app.route('/api/projects/:projectId/tasks', submitRoutes);
  return app;
}

function createEnv() {
  const sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  seedUser(sqlite, 'user-1');
  seedProjectWithMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
  seedProjectWithMember(sqlite, { projectId: 'project-2', userId: 'user-1', role: 'owner' });
  seedCloudCredential(sqlite, { id: 'cloud-1', userId: 'user-1', projectId: 'project-1' });
  seedIdeas(sqlite);
  return {
    sqlite,
    env: {
      DATABASE: createSqliteD1WithBindLimit(sqlite, 100),
      BASE_DOMAIN: 'sammy.party',
      // A web submit asks for 'vm' unless the profile says otherwise, so enabling
      // containers here only affects the explicit cf-container profile case below.
      CF_CONTAINER_ENABLED: 'true',
    } as Env,
  };
}

function seedIdeas(sqlite: Database.Database): void {
  const insert = sqlite.prepare(
    `INSERT INTO tasks (id, project_id, user_id, title, description, status, priority,
       task_mode, dispatch_depth, triggered_by, created_by, created_at, updated_at)
     VALUES (?, ?, 'user-1', ?, ?, ?, 0, 'task', 0, 'user', 'user-1',
       '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z')`
  );
  insert.run(
    'idea-open',
    'project-1',
    'Retry failed webhook deliveries',
    'Use the 3-day window.',
    'draft'
  );
  insert.run('idea-done', 'project-1', 'Already shipped', null, 'completed');
  insert.run('idea-parked', 'project-1', 'Parked for now', null, 'cancelled');
  insert.run('task-ordinary', 'project-1', 'An ordinary task', null, 'queued');
  insert.run('idea-foreign', 'project-2', 'Another project idea', null, 'draft');
}

const executionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

function submit(app: Hono<{ Bindings: Env }>, env: Env, body: Record<string, unknown>) {
  return app.request(
    '/api/projects/project-1/tasks/submit',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env,
    executionCtx
  );
}

function linkRows(sqlite: Database.Database): number {
  return (sqlite.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count;
}

describe('POST /tasks/submit with sourceIdeaId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    authState.userId = 'user-1';
    mocks.requireRepositoryUserAccess.mockResolvedValue(undefined);
    mocks.recordLink.mockImplementation(() => {
      calls.push('recordLink');
      return Promise.resolve();
    });
    mocks.createSession.mockResolvedValue('session-1');
    mocks.persistMessage.mockResolvedValue(undefined);
    mocks.recordActivityEvent.mockResolvedValue(undefined);
    mocks.stopSession.mockImplementation(() => {
      calls.push('stopSession');
      return Promise.resolve();
    });
    mocks.updateSessionTopic.mockResolvedValue(true);
    mocks.startTaskRunnerDO.mockImplementation(() => {
      calls.push('startTaskRunnerDO');
      return Promise.resolve();
    });
    mocks.getTaskRunnerStatus.mockResolvedValue(null);
    mocks.getTaskTitleConfig.mockReturnValue({});
    mocks.truncateTitle.mockReturnValue('Work on the idea');
    mocks.generateTaskTitle.mockResolvedValue('Work on the idea');
    mocks.enrichMessageWithMentions.mockResolvedValue({ enrichedMessage: 'Match the window.' });
  });

  it('records works_on before the task runner starts (VM path)', async () => {
    const { sqlite, env } = createEnv();
    try {
      const response = await submit(createApp(), env, {
        message: 'Match the window.',
        taskMode: 'task',
        sourceIdeaId: 'idea-open',
      });
      expect(response.status).toBe(202);
      expect(mocks.recordLink).toHaveBeenCalledWith(env, 'project-1', {
        sourceKind: 'session',
        sourceId: 'session-1',
        targetKind: 'idea',
        targetId: 'idea-open',
        relation: 'works_on',
        origin: 'explicit',
        context: null,
      });
      // Liveness beside the ordering claim: both ran, and the link ran first.
      expect(calls).toEqual(['recordLink', 'startTaskRunnerDO']);
    } finally {
      sqlite.close();
    }
  });

  it('records discusses when the start is a conversation', async () => {
    const { sqlite, env } = createEnv();
    try {
      await submit(createApp(), env, {
        message: 'Talk it through.',
        taskMode: 'conversation',
        sourceIdeaId: 'idea-open',
      });
      expect(mocks.recordLink.mock.calls[0]?.[2]).toMatchObject({ relation: 'discusses' });
    } finally {
      sqlite.close();
    }
  });

  // Control: the suite must not pass with the link write deleted outright.
  it('records nothing and still starts when no idea is supplied', async () => {
    const { sqlite, env } = createEnv();
    try {
      const response = await submit(createApp(), env, { message: 'Plain task.', taskMode: 'task' });
      expect(response.status).toBe(202);
      expect(mocks.recordLink).not.toHaveBeenCalled();
      expect(calls).toEqual(['startTaskRunnerDO']);
    } finally {
      sqlite.close();
    }
  });

  it('aborts the start when the link cannot be written, leaving no queued task', async () => {
    const { sqlite, env } = createEnv();
    try {
      mocks.recordLink.mockImplementation(() => Promise.reject(new Error('DO unavailable')));
      const before = linkRows(sqlite);
      const response = await submit(createApp(), env, {
        message: 'Match the window.',
        taskMode: 'task',
        sourceIdeaId: 'idea-open',
      });
      expect(response.status).toBe(500);
      expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
      expect(calls).toContain('stopSession');
      const queued = sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM tasks WHERE status = 'queued' AND id != 'task-ordinary'"
        )
        .get() as { count: number };
      expect(queued.count).toBe(0);
      // The submitted task row exists but is terminal, not left queued for the runner.
      expect(linkRows(sqlite)).toBe(before + 1);
    } finally {
      sqlite.close();
    }
  });

  // What this proves and what it does not: the route always asks for the SAME
  // (source, target, relation) triple for a given chat and idea, which is the shape
  // T1's store upserts rather than duplicating (its own DO tests cover that). It does
  // not drive a real retry — a second `POST /tasks/submit` mints a new task and a new
  // session, so the only production path that re-links one session is a replayed SAM
  // dispatch reservation, which this route cannot reach.
  it('always asks for the same link triple for a given chat and idea', async () => {
    const { sqlite, env } = createEnv();
    try {
      const app = createApp();
      const body = { message: 'Match the window.', taskMode: 'task', sourceIdeaId: 'idea-open' };
      await submit(app, env, body);
      await submit(app, env, body);
      expect(mocks.recordLink).toHaveBeenCalledTimes(2);
      expect(mocks.recordLink.mock.calls[0]?.[2]).toEqual(mocks.recordLink.mock.calls[1]?.[2]);
    } finally {
      sqlite.close();
    }
  });

  it('404s an idea belonging to another project, before any task is created', async () => {
    const { sqlite, env } = createEnv();
    try {
      const before = linkRows(sqlite);
      const response = await submit(createApp(), env, {
        message: 'Match the window.',
        taskMode: 'task',
        sourceIdeaId: 'idea-foreign',
      });
      expect(response.status).toBe(404);
      expect(linkRows(sqlite)).toBe(before);
      expect(mocks.createSession).not.toHaveBeenCalled();
      expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it('404s an ordinary task used as an idea', async () => {
    const { sqlite, env } = createEnv();
    try {
      const response = await submit(createApp(), env, {
        message: 'Match the window.',
        taskMode: 'task',
        sourceIdeaId: 'task-ordinary',
      });
      expect(response.status).toBe(404);
      expect(mocks.createSession).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ['idea-done', /idea is done/i],
    ['idea-parked', /idea is parked/i],
  ])('409s %s with a message that says what to do', async (ideaId, pattern) => {
    const { sqlite, env } = createEnv();
    try {
      const before = linkRows(sqlite);
      const response = await submit(createApp(), env, {
        message: 'Match the window.',
        taskMode: 'task',
        sourceIdeaId: ideaId,
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { message: string }).message).toMatch(pattern);
      expect(linkRows(sqlite)).toBe(before);
      expect(mocks.createSession).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  // The Instant branch records the link inside `acceptInstantSession`, which is covered
  // by instant-session-idea-link.test.ts. What the route owes it is the validated id.
  it('passes the validated idea to the Instant branch', async () => {
    const { sqlite, env } = createEnv();
    try {
      sqlite
        .prepare(
          `INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, runtime,
             task_mode, is_builtin, created_at, updated_at)
           VALUES ('profile-instant', 'project-1', 'user-1', 'Brainstormer', 'claude-code',
             'cf-container', 'conversation', 0, '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z')`
        )
        .run();
      mocks.acceptInstantSession.mockResolvedValue({
        taskId: 'task-instant',
        chatSessionId: 'session-instant',
      });
      mocks.continueInstantSessionLaunch.mockResolvedValue(undefined);

      const response = await submit(createApp(), env, {
        message: 'Talk it through.',
        agentProfileId: 'profile-instant',
        taskMode: 'conversation',
        sourceIdeaId: 'idea-open',
      });

      expect(response.status).toBe(202);
      expect(mocks.acceptInstantSession).toHaveBeenCalledTimes(1);
      expect(mocks.acceptInstantSession.mock.calls[0]?.[2]).toMatchObject({
        sourceIdeaId: 'idea-open',
        taskMode: 'conversation',
      });
      // The route must not also write the link itself — that would double-write.
      expect(mocks.recordLink).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });
});
