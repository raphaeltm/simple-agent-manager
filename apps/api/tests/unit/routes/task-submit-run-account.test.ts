/**
 * Choosing an account for one run, through the real `POST /api/projects/:projectId/tasks/submit`
 * handler (rule 62). The account check runs against a real SQLite engine: another person's
 * account, a paused one and one for a different agent are refused with no task written, and
 * the caller's own account is stored on the task (owner control, rule 28).
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { ensurePoolsWithStarterMachines } from '../../helpers/capacity-pool-picks';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';
import { seedCloudCredential, seedProjectWithMember, seedUser } from './capacity-pool-test-seeds';

const authState = vi.hoisted(() => ({ userId: 'user-1' }));
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

vi.mock('@simple-agent-manager/operations/internal/link-core', () => ({
  recordLink: mocks.recordLink,
}));

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

async function createEnv() {
  const sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  seedUser(sqlite, 'user-1');
  seedProjectWithMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
  seedProjectWithMember(sqlite, { projectId: 'project-2', userId: 'user-1', role: 'owner' });
  seedCloudCredential(sqlite, { id: 'cloud-1', userId: 'user-1', projectId: 'project-1' });
  seedAccounts(sqlite);
  const fixture = {
    sqlite,
    env: {
      DATABASE: createSqliteD1WithBindLimit(sqlite, 100),
      BASE_DOMAIN: 'sammy.party',
      // A web submit asks for 'vm' unless the profile says otherwise, so enabling
      // containers here only affects the explicit cf-container profile case below.
      CF_CONTAINER_ENABLED: 'true',
    } as Env,
  };
  // The user picked machines in the project pool: nothing joins a pool on its own.
  await ensurePoolsWithStarterMachines(drizzle(fixture.env.DATABASE, { schema }) as never, {
    userId: 'user-1',
    projectId: 'project-1',
    env: fixture.env,
  });
  return fixture;
}

const NOW = '2026-11-13T00:00:00.000Z';

function seedAccounts(sqlite: Database.Database): void {
  seedUser(sqlite, 'user-2');
  const credential = sqlite.prepare(
    `INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 'api-key', 'cipher', 'iv', ?, ?, ?)`
  );
  const configuration = sqlite.prepare(
    `INSERT INTO cc_configurations (id, owner_id, name, consumer_kind, consumer_target, credential_id, settings_json, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 'agent', ?, ?, NULL, ?, ?, ?)`
  );
  const seed = (id: string, owner: string, agentType: string, active = 1, configActive = 1) => {
    credential.run(`cred-${id}`, owner, id, active, NOW, NOW);
    configuration.run(`cfg-${id}`, owner, id, agentType, `cred-${id}`, configActive, NOW, NOW);
  };
  seed('work-max', 'user-1', 'claude-code');
  seed('paused', 'user-1', 'claude-code', 0);
  seed('paused-config', 'user-1', 'claude-code', 1, 0);
  seed('codex', 'user-1', 'openai-codex');
  seed('theirs', 'user-2', 'claude-code');
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

function taskRows(sqlite: Database.Database) {
  return sqlite.prepare('SELECT agent_configuration_id AS account FROM tasks').all() as Array<{
    account: string | null;
  }>;
}

describe('POST /tasks/submit with agentConfigurationId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.userId = 'user-1';
    mocks.requireRepositoryUserAccess.mockResolvedValue(undefined);
    mocks.createSession.mockResolvedValue('session-1');
    mocks.persistMessage.mockResolvedValue(undefined);
    mocks.recordActivityEvent.mockResolvedValue(undefined);
    mocks.stopSession.mockResolvedValue(undefined);
    mocks.updateSessionTopic.mockResolvedValue(true);
    mocks.startTaskRunnerDO.mockResolvedValue(undefined);
    mocks.getTaskRunnerStatus.mockResolvedValue(null);
    mocks.getTaskTitleConfig.mockReturnValue({});
    mocks.truncateTitle.mockReturnValue('Run on Work Max');
    mocks.generateTaskTitle.mockResolvedValue('Run on Work Max');
    mocks.enrichMessageWithMentions.mockResolvedValue({ enrichedMessage: 'Do the work.' });
  });

  it('stores the caller’s own account on a VM task', async () => {
    const { sqlite, env } = await createEnv();
    try {
      const response = await submit(createApp(), env, {
        message: 'Do the work.',
        agentType: 'claude-code',
        taskMode: 'task',
        agentConfigurationId: 'cfg-work-max',
      });
      expect(response.status).toBe(202);
      expect(taskRows(sqlite)).toEqual([{ account: 'cfg-work-max' }]);
      expect(mocks.startTaskRunnerDO).toHaveBeenCalledTimes(1);
    } finally {
      sqlite.close();
    }
  });

  it('stores the caller’s own account on an Instant task', async () => {
    const { sqlite, env } = await createEnv();
    try {
      sqlite
        .prepare(
          `INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, runtime,
             task_mode, is_builtin, created_at, updated_at)
           VALUES ('profile-instant', 'project-1', 'user-1', 'Opus Chat', 'claude-code',
             'cf-container', 'conversation', 0, ?, ?)`
        )
        .run(NOW, NOW);
      mocks.acceptInstantSession.mockResolvedValue({
        taskId: 'task-instant',
        chatSessionId: 'session-instant',
      });
      mocks.continueInstantSessionLaunch.mockResolvedValue(undefined);

      const response = await submit(createApp(), env, {
        message: 'Talk it through.',
        agentProfileId: 'profile-instant',
        taskMode: 'conversation',
        agentConfigurationId: 'cfg-work-max',
      });
      expect(response.status).toBe(202);
      expect(mocks.acceptInstantSession).toHaveBeenCalledTimes(1);
      expect(taskRows(sqlite)).toEqual([{ account: 'cfg-work-max' }]);
    } finally {
      sqlite.close();
    }
  });

  it('control: no choice stores NULL and still starts', async () => {
    const { sqlite, env } = await createEnv();
    try {
      const response = await submit(createApp(), env, {
        message: 'Do the work.',
        agentType: 'claude-code',
        taskMode: 'task',
      });
      expect(response.status).toBe(202);
      expect(taskRows(sqlite)).toEqual([{ account: null }]);
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ['another person’s account', 'cfg-theirs', /not found/],
    ['a paused account', 'cfg-paused', /paused/],
    ['a paused configuration', 'cfg-paused-config', /paused/],
    ['an account for another agent', 'cfg-codex', /is for openai-codex/],
    ['an unknown id', 'cfg-nope', /not found/],
  ])('refuses %s before writing a task', async (_name, configurationId, message) => {
    const { sqlite, env } = await createEnv();
    try {
      const response = await submit(createApp(), env, {
        message: 'Do the work.',
        agentType: 'claude-code',
        taskMode: 'task',
        agentConfigurationId: configurationId,
      });
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).toMatch(message);
      expect(taskRows(sqlite)).toEqual([]);
      expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it('accepts a backfill-length account id (longer than the 128-char resource id cap)', async () => {
    const { sqlite, env } = await createEnv();
    try {
      const longId = `cfg-${'b'.repeat(219)}`;
      sqlite
        .prepare(
          `INSERT INTO cc_configurations (id, owner_id, name, consumer_kind, consumer_target, credential_id, settings_json, is_active, created_at, updated_at)
           VALUES (?, 'user-1', 'Long', 'agent', 'claude-code', 'cred-work-max', NULL, 1, ?, ?)`
        )
        .run(longId, NOW, NOW);
      const response = await submit(createApp(), env, {
        message: 'Do the work.',
        agentType: 'claude-code',
        taskMode: 'task',
        agentConfigurationId: longId,
      });
      expect(response.status).toBe(202);
      expect(taskRows(sqlite)).toEqual([{ account: longId }]);
    } finally {
      sqlite.close();
    }
  });
});
