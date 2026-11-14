/**
 * Start work through the real `POST /api/projects/:projectId/tasks/submit` handler.
 *
 * Everything is driven through the route, not through `submitTaskImplementation`
 * directly, so the schema, the auth middleware and the submit flow all participate
 * (rule 62). The idea gate and the per-run account check run against a real SQLite
 * engine with foreign-owner attack cases and owner controls (rules 11, 28).
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

// The agent-key callback authenticates the VM agent; the slice test below calls it as w-slice.
vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn(async () => ({ workspace: 'w-slice', scope: 'workspace' })),
  signCallbackToken: vi.fn(),
  signCurrentWorkspaceCallbackToken: vi.fn(),
}));

const { submitRoutes } = await import('../../../src/routes/tasks/submit');
const { runtimeRoutes } = await import('../../../src/routes/workspaces/runtime');
const { encrypt } = await import('../../../src/services/encryption');
const ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

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
  seedIdeas(sqlite);
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

function seedIdeas(sqlite: Database.Database): void {
  const insert = sqlite.prepare(
    `INSERT INTO tasks (id, project_id, user_id, title, description, status, is_idea, priority,
       task_mode, dispatch_depth, triggered_by, created_by, created_at, updated_at)
     VALUES (?, ?, 'user-1', ?, ?, ?, ?, 0, 'task', 0, 'user', 'user-1',
       '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z')`
  );
  insert.run(
    'idea-open',
    'project-1',
    'Retry failed webhook deliveries',
    'Use the 3-day window.',
    'draft',
    1
  );
  insert.run('idea-done', 'project-1', 'Already shipped', null, 'completed', 1);
  insert.run('idea-parked', 'project-1', 'Parked for now', null, 'cancelled', 1);
  insert.run('task-ordinary', 'project-1', 'An ordinary task', null, 'queued', 0);
  // Draft, same project, not an idea — only `is_idea` separates it from `idea-open`, so the
  // refusal below cannot pass merely because the status differs (program decision 16).
  insert.run('task-ordinary-draft', 'project-1', 'An ordinary draft task', null, 'draft', 0);
  insert.run('idea-foreign', 'project-2', 'Another project idea', null, 'draft', 1);
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
    const { sqlite, env } = await createEnv();
    try {
      const response = await submit(createApp(), env, {
        message: 'Match the window.',
        taskMode: 'task',
        sourceIdeaId: 'idea-open',
      });
      expect(response.status).toBe(202);
      expect(mocks.recordLink).toHaveBeenCalledWith(expect.objectContaining({ env }), 'project-1', {
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
    const { sqlite, env } = await createEnv();
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
    const { sqlite, env } = await createEnv();
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
    const { sqlite, env } = await createEnv();
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
    const { sqlite, env } = await createEnv();
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
    const { sqlite, env } = await createEnv();
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
    const { sqlite, env } = await createEnv();
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

  /*
   * The discriminating version of the test above. `task-ordinary` is `queued`, which the OLD
   * `status = 'draft'` rule excluded too — so that test passes under either definition and
   * cannot tell them apart. This row is `draft` in the same project, differing only in
   * `is_idea = 0`: exactly what the old rule would have accepted as an idea.
   */
  it('404s an ordinary DRAFT task, which the old status rule would have accepted', async () => {
    const { sqlite, env } = await createEnv();
    try {
      const refused = await submit(createApp(), env, {
        message: 'Match the window.',
        taskMode: 'task',
        sourceIdeaId: 'task-ordinary-draft',
      });
      expect(refused.status).toBe(404);
      expect(mocks.createSession).not.toHaveBeenCalled();

      // Owner control: a real idea on the same path still starts, so the refusal above is the
      // flag and not the route being broken for everything.
      const accepted = await submit(createApp(), env, {
        message: 'Match the window.',
        taskMode: 'task',
        sourceIdeaId: 'idea-open',
      });
      expect(accepted.status).toBe(202);
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ['idea-done', /idea is done/i],
    ['idea-parked', /idea is parked/i],
  ])('409s %s with a message that says what to do', async (ideaId, pattern) => {
    const { sqlite, env } = await createEnv();
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
    const { sqlite, env } = await createEnv();
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

/** Tasks the submit created: everything except the ideas and tasks `seedIdeas` wrote. */
const SUBMITTED = `SELECT id, agent_configuration_id AS account FROM tasks
  WHERE id NOT IN ('idea-open', 'idea-done', 'idea-parked', 'task-ordinary',
                   'task-ordinary-draft', 'idea-foreign')`;

function taskRows(sqlite: Database.Database) {
  return (sqlite.prepare(SUBMITTED).all() as Array<{ account: string | null }>).map(
    ({ account }) => ({ account })
  );
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

  it('vertical slice: the account chosen at submit is the one agent-key hands the run', async () => {
    const { sqlite, env } = await createEnv();
    try {
      (env as { ENCRYPTION_KEY?: string }).ENCRYPTION_KEY = ENCRYPTION_KEY;
      for (const id of ['work-max', 'personal']) {
        const { ciphertext, iv } = await encrypt(`sk-${id}`, ENCRYPTION_KEY);
        if (id === 'personal') {
          sqlite
            .prepare(
              `INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at)
               VALUES ('cred-personal', 'user-1', 'personal', 'api-key', ?, ?, 1, ?, ?)`
            )
            .run(ciphertext, iv, NOW, NOW);
          sqlite
            .prepare(
              `INSERT INTO cc_configurations (id, owner_id, name, consumer_kind, consumer_target, credential_id, settings_json, is_active, created_at, updated_at)
               VALUES ('cfg-personal', 'user-1', 'personal', 'agent', 'claude-code', 'cred-personal', NULL, 1, ?, ?)`
            )
            .run(NOW, NOW);
        } else {
          sqlite
            .prepare(
              `UPDATE cc_credentials SET encrypted_token = ?, iv = ? WHERE id = 'cred-work-max'`
            )
            .run(ciphertext, iv);
        }
      }
      // Personal is the default; the chat chooses Work Max.
      sqlite.exec(`
        INSERT INTO cc_attachments (id, configuration_id, consumer_kind, consumer_target, user_id, project_id, is_active)
          VALUES ('att-default', 'cfg-personal', 'agent', 'claude-code', 'user-1', NULL, 1);
      `);

      const response = await submit(createApp(), env, {
        message: 'Do the work.',
        agentType: 'claude-code',
        taskMode: 'task',
        agentConfigurationId: 'cfg-work-max',
      });
      expect(response.status).toBe(202);
      const task = sqlite.prepare(SUBMITTED).get() as { id: string };

      // The TaskRunner provisions the run's workspace and binds it (mocked out above).
      sqlite.exec(`
        INSERT INTO nodes (id, user_id, status) VALUES ('n-slice', 'user-1', 'running');
        INSERT INTO workspaces (id, user_id, node_id, project_id, status)
          VALUES ('w-slice', 'user-1', 'n-slice', 'project-1', 'running');
      `);
      sqlite.prepare(`UPDATE tasks SET workspace_id = 'w-slice' WHERE id = ?`).run(task.id);

      const app = new Hono<{ Bindings: Env }>();
      app.onError((err, c) =>
        err instanceof AppError
          ? c.json(err.toJSON(), err.statusCode as never)
          : c.json({ error: String(err) }, 500)
      );
      app.route('/api/workspaces', runtimeRoutes);
      const keyResponse = await app.request(
        '/api/workspaces/w-slice/agent-key',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer cb', 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentType: 'claude-code' }),
        },
        env
      );
      expect(keyResponse.status).toBe(200);
      const body = (await keyResponse.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ credentialReference: 'cc_credentials:cred-work-max' });
      expect(JSON.stringify(body)).not.toContain('sk-personal');
    } finally {
      sqlite.close();
    }
  });
});
