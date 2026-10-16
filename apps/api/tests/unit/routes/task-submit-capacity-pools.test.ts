import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { serve } from '@hono/node-server';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { log } from '../../../src/lib/logger';
import { getTaskSubmitOperation } from '../../../src/lib/task-submit-diagnostics';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { AppError } from '../../../src/middleware/error';
import { agentProfileRoutes } from '../../../src/routes/agent-profiles';
import { cliProjectMetadataRoutes } from '../../../src/routes/cli-project-metadata';
import { skillRoutes } from '../../../src/routes/skills';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../../src/services/default-capacity-pools';
import { resolveSkillProfile } from '../../../src/services/skills';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';
import {
  seedCloudCredential,
  seedPlatformCloudCredential,
  seedProjectWithMember,
  seedUser,
} from './capacity-pool-test-seeds';

const authState = vi.hoisted(() => ({
  userId: 'user-1',
}));

const mocks = vi.hoisted(() => ({
  requireRepositoryUserAccess: vi.fn(),
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
  generateTaskTitle: vi.fn(),
  getTaskTitleConfig: vi.fn(),
  truncateTitle: vi.fn(),
  enrichMessageWithMentions: vi.fn(),
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

function createApp(diagnostics = false) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) =>
    diagnostics
      ? handleAppError(err, c)
      : err instanceof AppError
        ? c.json(err.toJSON(), err.statusCode as never)
        : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500)
  );
  app.route('/api/projects/:projectId/tasks', submitRoutes);
  app.route('/api/projects/:projectId/cli', cliProjectMetadataRoutes);
  app.route('/api/projects/:projectId/agent-profiles', agentProfileRoutes);
  app.route('/api/projects/:projectId/skills', skillRoutes);
  return app;
}

function createEnv() {
  const sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  return {
    sqlite,
    env: {
      DATABASE: createSqliteD1WithBindLimit(sqlite, 100),
      BASE_DOMAIN: 'sammy.party',
    } as Env,
  };
}

function seedTaskSubmitRows(sqlite: Database.Database): void {
  seedUser(sqlite, 'user-1');
  seedProjectWithMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
  seedCloudCredential(sqlite, {
    id: 'project-cloud-1',
    userId: 'user-1',
    projectId: 'project-1',
  });
}

function addProjectMember(
  sqlite: Database.Database,
  input: { projectId: string; userId: string; role?: string; status?: string }
): void {
  sqlite
    .prepare(
      `INSERT INTO project_members (project_id, user_id, role, status)
       VALUES (?, ?, ?, ?)`
    )
    .run(input.projectId, input.userId, input.role ?? 'maintainer', input.status ?? 'active');
}

function seedParentTask(
  sqlite: Database.Database,
  input: {
    taskId?: string;
    projectId?: string;
    userId: string;
    credentialAttributionUserId?: string | null;
    credentialAttributionProjectId?: string | null;
    credentialAttributionSource?: string | null;
  }
): void {
  sqlite
    .prepare(
      `INSERT INTO tasks (
         id, project_id, user_id, title, description, status, priority,
         task_mode, dispatch_depth, triggered_by, created_by,
         credential_attribution_user_id, credential_attribution_project_id,
         credential_attribution_source, created_at, updated_at
       )
       VALUES (
         ?, ?, ?, 'Parent task', 'Parent task', 'queued', 0,
         'task', 0, 'user', ?,
         ?, ?, ?, '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z'
       )`
    )
    .run(
      input.taskId ?? 'parent-task-1',
      input.projectId ?? 'project-1',
      input.userId,
      input.userId,
      input.credentialAttributionUserId ?? null,
      input.credentialAttributionProjectId ?? null,
      input.credentialAttributionSource ?? null
    );
}

function taskCount(sqlite: Database.Database): number {
  return (
    sqlite.prepare('SELECT COUNT(*) AS count FROM tasks').get() as {
      count: number;
    }
  ).count;
}

async function seedProjectDefaultPool(env: Env): Promise<void> {
  await ensureDefaultCapacityPoolsForExistingCredentials(drizzle(env.DATABASE, { schema }), {
    userId: 'user-1',
    projectId: 'project-1',
    includeInstallation: false,
  });
}

async function seedStaticDefaultPool(
  env: Env,
  input: { userId: string; projectId?: string | null }
): Promise<void> {
  await ensureDefaultCapacityPoolsForExistingCredentials(drizzle(env.DATABASE, { schema }), {
    userId: input.userId,
    projectId: input.projectId ?? null,
    includeInstallation: false,
  });
}

const executionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

describe('task submit capacity-pool placement', () => {
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
    mocks.getTaskTitleConfig.mockReturnValue({});
    mocks.truncateTitle.mockReturnValue('Run in project pool');
    mocks.generateTaskTitle.mockResolvedValue('Generated task title');
    mocks.enrichMessageWithMentions.mockResolvedValue({
      enrichedMessage: 'Run in project pool',
    });
  });

  async function forkFixture() {
    const fixture = createEnv();
    fixture.sqlite.exec(
      readFileSync(join(process.cwd(), 'src/db/migrations/0189_cli_operation_receipts.sql'), 'utf8')
    );
    seedTaskSubmitRows(fixture.sqlite);
    fixture.sqlite.exec(
      "INSERT INTO tasks (id, project_id, user_id, title, status, output_branch) VALUES ('source-task', 'project-1', 'user-1', 'Source', 'completed', 'sam/prior')"
    );
    mocks.getSession.mockResolvedValue({
      id: 'source-chat',
      createdByUserId: 'user-1',
      status: 'stopped',
      taskId: 'source-task',
      workspaceId: 'missing-workspace',
      topic: 'Archived source',
    });
    mocks.getMessages.mockResolvedValue({
      messages: [
        {
          role: 'assistant',
          content: 'Finished prior work; API_KEY="canary-secret-value" ghp_' + 'a'.repeat(36),
        },
        { role: 'user', content: 'Old request' },
        { role: 'tool', content: 'NEVER_REPLAY_TOOL' },
        { role: 'system', content: 'NEVER_REPLAY_APPROVAL' },
      ],
      hasMore: true,
    });
    mocks.enrichMessageWithMentions.mockImplementation(async (message) => ({
      enrichedMessage: message,
    }));
    return fixture;
  }

  function forkRequest(
    app: ReturnType<typeof createApp>,
    env: Env,
    key = 'fork-intent',
    message = 'New exact prompt'
  ) {
    return app.request(
      '/api/projects/project-1/tasks/submit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ message, sourceSessionId: 'source-chat', taskMode: 'conversation' }),
      },
      env,
      executionCtx
    );
  }

  it('forks to a fresh linked chat, injects bounded redacted history into the VM prompt once and never changes source', async () => {
    const { sqlite, env } = await forkFixture();
    try {
      const response = await forkRequest(createApp(), env);
      expect(response.status, await response.clone().text()).toBe(202);
      const result = await response.json<{ taskId: string; sessionId: string }>();
      const task = sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(result.taskId) as {
        parent_task_id: string;
        output_branch: string;
      };
      expect(task.parent_task_id).toBe('source-task');
      expect(task.output_branch).not.toBe('sam/prior');
      const runner = mocks.startTaskRunnerDO.mock.calls[0]![1];
      expect(runner.taskDescription).toBe('New exact prompt');
      expect(runner.historicalContext).not.toContain('New exact prompt');
      expect(runner.historicalContext).toContain('Old request');
      expect(runner.historicalContext).toContain('TRUNCATED');
      expect(runner.historicalContext).toContain('source-chat');
      expect(runner.historicalContext).toContain('unavailable');
      expect(runner.historicalContext).toContain('verify the current repository');
      for (const secret of [
        'canary-secret-value',
        'ghp_' + 'a'.repeat(36),
        'NEVER_REPLAY_TOOL',
        'NEVER_REPLAY_APPROVAL',
      ])
        expect(runner.historicalContext).not.toContain(secret);
      expect(mocks.persistMessage.mock.calls.filter((call) => call[3] === 'user')).toEqual([
        [env, 'project-1', 'session-1', 'user', 'New exact prompt', null],
      ]);
      expect(mocks.stopSession).not.toHaveBeenCalled();
      expect(
        sqlite.prepare("SELECT status, output_branch FROM tasks WHERE id = 'source-task'").get()
      ).toEqual({ status: 'completed', output_branch: 'sam/prior' });
      expect(mocks.getSession.mock.results).toHaveLength(2);
    } finally {
      sqlite.close();
    }
  });

  it('replays repeated and concurrent Fork submissions without a second runtime or user prompt', async () => {
    const { sqlite, env } = await forkFixture();
    try {
      const app = createApp();
      const responses = await Promise.all([forkRequest(app, env), forkRequest(app, env)]);
      expect(responses.map((r) => r.status).sort()).toEqual([202, 409]);
      const first = await responses.find((r) => r.status === 202)!.json();
      const replay = await forkRequest(app, env);
      expect(replay.status).toBe(202);
      expect(await replay.json()).toEqual(first);
      expect(mocks.startTaskRunnerDO).toHaveBeenCalledOnce();
      expect(mocks.persistMessage.mock.calls.filter((c) => c[3] === 'user')).toHaveLength(1);
      expect((await forkRequest(app, env, 'fork-intent', 'Changed intent')).status).toBe(409);
    } finally {
      sqlite.close();
    }
  });

  it('retains newest text in chronological order and redacts before the history bound', async () => {
    const { sqlite, env } = await forkFixture();
    try {
      env.ARCHIVED_FORK_HISTORY_MAX_CHARS = '40';
      mocks.getMessages.mockResolvedValue({
        messages: [
          { role: 'user', content: 'OLDEST_MUST_BE_DROPPED'.repeat(5) },
          { role: 'assistant', content: 'middle' },
          { role: 'user', content: 'latest ghp_' + 'a'.repeat(36) },
        ],
        hasMore: false,
      });
      expect((await forkRequest(createApp(), env)).status).toBe(202);
      const prompt = mocks.startTaskRunnerDO.mock.calls[0]![1].historicalContext as string;
      expect(prompt).not.toContain('OLDEST_MUST_BE_DROPPED');
      expect(prompt).toContain('latest [REDACTED]');
      expect(prompt.indexOf('middle')).toBeLessThan(prompt.indexOf('latest [REDACTED]'));
      expect(prompt).toContain('TRUNCATED');
      expect(prompt).not.toContain('ghp_');
    } finally {
      sqlite.close();
    }
  });

  it('also truncates the serialized UTF-8 context byte budget without dropping the new prompt', async () => {
    const { sqlite, env } = await forkFixture();
    try {
      mocks.getMessages.mockResolvedValue({
        messages: [{ role: 'user', content: '日本語'.repeat(8000) }],
        hasMore: false,
      });
      expect((await forkRequest(createApp(), env)).status).toBe(202);
      const context = mocks.persistMessage.mock.calls.find((c) => c[3] === 'system')![4] as string;
      expect(new TextEncoder().encode(context).length).toBeLessThanOrEqual(65536);
      expect(context).toContain('TRUNCATED');
      expect(
        mocks.startTaskRunnerDO.mock.calls[0]![1].historicalContext.split('New exact prompt')
      ).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it('redacts secrets split across streamed assistant tokens and omits an incomplete oldest group', async () => {
    const { sqlite, env } = await forkFixture();
    try {
      mocks.getMessages.mockResolvedValue({
        messages: [
          { role: 'assistant', content: 'UNCERTAIN_TOKEN_SUFFIX' },
          { role: 'user', content: 'Prior user request' },
          { role: 'assistant', content: 'Output ghp_' },
          {
            role: 'assistant',
            content: 'a'.repeat(36) + '\nCookie: session=small-secret; other=second-secret',
          },
        ],
        hasMore: true,
      });
      expect((await forkRequest(createApp(), env)).status).toBe(202);
      const prompt = mocks.startTaskRunnerDO.mock.calls[0]![1].historicalContext as string;
      for (const secret of [
        'UNCERTAIN_TOKEN_SUFFIX',
        'ghp_',
        'a'.repeat(36),
        'small-secret',
        'second-secret',
      ])
        expect(prompt).not.toContain(secret);
      expect(prompt).toContain('Output [REDACTED]');
      expect(prompt).toContain('Prior user request');
    } finally {
      sqlite.close();
    }
  });

  it('omits system-origin bootstrap copies when forking an archived fork', async () => {
    const { sqlite, env } = await forkFixture();
    try {
      mocks.getMessages.mockResolvedValue({
        messages: [
          { role: 'assistant', content: 'Prior result', createdAt: 3 },
          {
            role: 'user',
            origin: 'system',
            content: 'INJECTED_BOOTSTRAP_ENVELOPE Old visible prompt OLD_APPROVAL_REMINDER',
            createdAt: 2,
          },
          { role: 'user', origin: 'user', content: 'Old visible prompt', createdAt: 1 },
        ],
        hasMore: false,
      });
      expect((await forkRequest(createApp(), env)).status).toBe(202);
      const prompt = mocks.startTaskRunnerDO.mock.calls[0]![1].historicalContext;
      expect(prompt.split('Old visible prompt')).toHaveLength(2);
      expect(prompt).toContain('Prior result');
      expect(prompt).not.toContain('INJECTED_BOOTSTRAP_ENVELOPE');
      expect(prompt).not.toContain('OLD_APPROVAL_REMINDER');
    } finally {
      sqlite.close();
    }
  });

  it('supplies the same historical context and one new prompt to an Instant agent', async () => {
    const { sqlite, env } = await forkFixture();
    try {
      env.CF_CONTAINER_ENABLED = 'true';
      sqlite.exec(
        "INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, runtime) VALUES ('instant', 'project-1', 'user-1', 'Instant', 'openai-codex', 'cf-container')"
      );
      mocks.acceptInstantSession.mockResolvedValue({ chatSessionId: 'instant-chat' });
      mocks.continueInstantSessionLaunch.mockResolvedValue(undefined);
      const response = await createApp().request(
        '/api/projects/project-1/tasks/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'instant-fork' },
          body: JSON.stringify({
            message: '  Instant new prompt  ',
            sourceSessionId: 'source-chat',
            agentProfileId: 'instant',
            taskMode: 'conversation',
          }),
        },
        env,
        executionCtx
      );
      expect(response.status, await response.clone().text()).toBe(202);
      const launch = mocks.acceptInstantSession.mock.calls[0]![2];
      expect(launch.initialPrompt).not.toContain('Old request');
      expect(launch.historicalContext).toContain('Old request');
      expect(launch.historicalContext).not.toContain('  Instant new prompt  ');
      expect(launch.initialPrompt.split('  Instant new prompt  ')).toHaveLength(2);
      expect(launch.displayMessage).toBe('  Instant new prompt  ');
      expect(launch.contextSummary).toContain('source-chat');
      expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it('forks legacy source without a task and retains explicit source chat lineage', async () => {
    const { sqlite, env } = await forkFixture();
    try {
      mocks.getSession.mockResolvedValue({
        id: 'source-chat',
        createdByUserId: 'user-1',
        status: 'stopped',
        taskId: null,
      });
      expect((await forkRequest(createApp(), env)).status).toBe(202);
      expect(mocks.startTaskRunnerDO.mock.calls[0]![1].historicalContext).toContain(
        '"sourceSessionId":"source-chat"'
      );
    } finally {
      sqlite.close();
    }
  });

  it.each(['other-owner', 'active', 'foreign-task'])(
    'rejects %s before reading transcript or creating work',
    async (kind) => {
      const { sqlite, env } = await forkFixture();
      try {
        mocks.getSession.mockResolvedValue({
          createdByUserId: kind === 'other-owner' ? 'user-2' : 'user-1',
          status: kind === 'active' ? 'active' : 'stopped',
          taskId: kind === 'foreign-task' ? 'foreign-task' : 'source-task',
        });
        expect((await forkRequest(createApp(), env)).status).toBe(kind === 'active' ? 409 : 403);
        expect(mocks.getMessages).not.toHaveBeenCalled();
        expect(mocks.createSession).not.toHaveBeenCalled();
      } finally {
        sqlite.close();
      }
    }
  );

  it('releases only a proven pre-effects rejection, allowing corrected retry', async () => {
    const { sqlite, env } = await forkFixture();
    try {
      env.MAX_TASK_MESSAGE_LENGTH = '2';
      const app = createApp();
      const response = await forkRequest(app, env);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ rejectedBeforeEffects: true });
      expect(sqlite.prepare('SELECT count(*) AS n FROM cli_operation_receipts').get()).toEqual({
        n: 0,
      });
      env.MAX_TASK_MESSAGE_LENGTH = '100';
      expect((await forkRequest(app, env)).status).toBe(202);
    } finally {
      sqlite.close();
    }
  });

  it('retains an uncertain receipt and never starts a duplicate after runner failure', async () => {
    const { sqlite, env } = await forkFixture();
    try {
      mocks.startTaskRunnerDO.mockRejectedValueOnce(new Error('Transport lost'));
      const app = createApp();
      expect((await forkRequest(app, env)).status).toBe(500);
      expect((await forkRequest(app, env)).status).toBe(409);
      expect(mocks.startTaskRunnerDO).toHaveBeenCalledOnce();
    } finally {
      sqlite.close();
    }
  });

  it.each([
    {
      agentProfileId: 'automatic',
      taskMode: 'conversation',
      resourceRequirements: { minVcpu: 2, minMemoryGb: 3.5, exclusiveNode: true },
    },
    {},
    { agentProfileId: 'automatic' },
    { workspaceProfile: 'full' },
    { devcontainerConfigName: 'custom' },
    { resourceRequirements: { minMemoryGb: 2 } },
    { vmLocation: 'fsn1' },
  ])('REST preserves VM placement with platform credentials and %j', async (input) => {
    const { sqlite, env } = createEnv();
    try {
      seedUser(sqlite, 'user-1');
      seedProjectWithMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
      seedPlatformCloudCredential(sqlite);
      sqlite.exec(
        "INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, runtime) VALUES ('automatic', 'project-1', 'user-1', 'Automatic', 'openai-codex', NULL)"
      );
      if ('taskMode' in input) {
        sqlite.exec("UPDATE projects SET repo_provider = 'artifacts' WHERE id = 'project-1'");
        sqlite.exec(
          "UPDATE agent_profiles SET runtime = 'vm', model = 'gpt-6.1-sol', effort = 'low', task_mode = 'conversation' WHERE id = 'automatic'"
        );
      }
      env.CF_CONTAINER_ENABLED = 'true';
      await ensureDefaultCapacityPoolsForExistingCredentials(drizzle(env.DATABASE, { schema }), {
        userId: 'user-1',
        projectId: 'project-1',
        includeInstallation: true,
      });
      const response = await createApp().request(
        '/api/projects/project-1/tasks/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'Start on a VM', ...input }),
        },
        env,
        executionCtx
      );
      expect(response.status, await response.clone().text()).toBe(202);
      expect(mocks.acceptInstantSession).not.toHaveBeenCalled();
      expect(mocks.startTaskRunnerDO).toHaveBeenCalledOnce();
      await Promise.all(vi.mocked(executionCtx.waitUntil).mock.calls.map(([promise]) => promise));
    } finally {
      sqlite.close();
    }
  });

  it.each(['route_project_authorization', 'task_insert'] as const)(
    'correlates real D1 %s failure with its request ID without exposing SQL or values',
    async (operation) => {
      const { sqlite, env } = createEnv();
      const logged = vi.spyOn(log, 'error');
      let originalError: Error | undefined;
      try {
        seedTaskSubmitRows(sqlite);
        await seedProjectDefaultPool(env);
        const database = env.DATABASE;
        env.DATABASE = {
          ...database,
          prepare(query: string) {
            const matches =
              operation === 'task_insert'
                ? /^insert into "tasks"/i.test(query)
                : /from "projects"/i.test(query);
            if (!matches) return database.prepare(query);
            const failing = database.prepare('INSERT INTO t1_missing_submit_table DEFAULT VALUES');
            return { ...failing, bind: () => failing };
          },
        } as D1Database;
        const app = createApp(true);
        app.onError((error, c) => {
          originalError = error;
          return handleAppError(error, c);
        });
        const response = await app.request(
          '/api/projects/project-1/tasks/submit',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: 'private prompt sk-test-secret',
              taskMode: 'conversation',
            }),
          },
          env,
          executionCtx
        );
        expect(response.status).toBe(500);
        expect(taskCount(sqlite)).toBe(0);
        expect(mocks.createSession).not.toHaveBeenCalled();
        const body = await response.json<{ requestId: string }>();
        expect(body.requestId).toEqual(expect.any(String));
        expect(getTaskSubmitOperation(originalError)).toBe(operation);
        expect(logged).toHaveBeenCalledWith(
          'request_error',
          expect.objectContaining({
            requestId: body.requestId,
            failingOperation: operation,
            errorName: 'Error',
            error: '[REDACTED_ERROR_MESSAGE]',
          })
        );
        const details = JSON.stringify(logged.mock.calls);
        expect(details).not.toContain('t1_missing_submit_table');
        expect(details).not.toContain('private prompt');
        expect(details).not.toContain('sk-test-secret');
      } finally {
        logged.mockRestore();
        sqlite.close();
      }
    }
  );

  it.each([
    'session_create',
    'runner_start',
    'session_failure_task_update',
    'runner_failure_task_update',
  ] as const)(
    'preserves the original failure phase or identifies a new %s cleanup failure',
    async (operation) => {
      const { sqlite, env } = createEnv();
      const initialFailure = new Error('private startup failure');
      let receivedError: Error | undefined;
      try {
        seedTaskSubmitRows(sqlite);
        await seedProjectDefaultPool(env);
        const sessionFailure = operation.startsWith('session_');
        if (sessionFailure) mocks.createSession.mockRejectedValueOnce(initialFailure);
        else mocks.startTaskRunnerDO.mockRejectedValueOnce(initialFailure);
        if (operation.includes('failure_task_update')) {
          const database = env.DATABASE;
          env.DATABASE = {
            ...database,
            prepare(query: string) {
              if (!/UPDATE tasks SET status = 'failed'/i.test(query))
                return database.prepare(query);
              const failing = database.prepare('UPDATE t1_missing_cleanup_table SET status = 1');
              return { ...failing, bind: () => failing };
            },
          } as D1Database;
        }
        const app = createApp(true);
        app.onError((error, c) => {
          receivedError = error;
          return handleAppError(error, c);
        });
        const response = await app.request(
          '/api/projects/project-1/tasks/submit',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: 'Start normal conversation',
              taskMode: 'conversation',
            }),
          },
          env,
          executionCtx
        );
        expect(response.status).toBe(500);
        expect(getTaskSubmitOperation(receivedError)).toBe(operation);
        if (operation.includes('failure_task_update'))
          expect(receivedError).not.toBe(initialFailure);
        else expect(receivedError).toBe(initialFailure);
      } finally {
        sqlite.close();
      }
    }
  );

  it.each(['invalid', 'quota', 'vm-after-insert', 'instant-after-insert'] as const)(
    'Connector receipt tracks proven task-effect boundary: %s',
    async (failure) => {
      const { sqlite, env } = createEnv();
      try {
        seedUser(sqlite, 'user-1');
        seedProjectWithMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
        seedPlatformCloudCredential(sqlite);
        for (const migration of ['0191_connector_execution.sql', '0189_cli_operation_receipts.sql'])
          sqlite.exec(readFileSync(join(process.cwd(), 'src/db/migrations', migration), 'utf8'));
        await ensureDefaultCapacityPoolsForExistingCredentials(drizzle(env.DATABASE, { schema }), {
          userId: 'user-1',
          projectId: 'project-1',
          includeInstallation: true,
        });
        env.CF_CONTAINER_ENABLED = 'true';
        sqlite
          .prepare(
            "INSERT INTO agent_profiles (id,project_id,user_id,name,agent_type,runtime) VALUES ('profile','project-1','user-1','Agent','openai-codex',?)"
          )
          .run(failure === 'instant-after-insert' ? 'cf-container' : 'vm');
        if (failure === 'quota')
          sqlite.exec(
            "INSERT INTO default_quotas (id,monthly_vcpu_hours_limit,updated_by) VALUES ('default',0,'user-1')"
          );
        if (failure === 'vm-after-insert')
          mocks.createSession.mockRejectedValueOnce(
            new AppError(403, 'FORBIDDEN', 'Denied after task insert')
          );
        if (failure === 'instant-after-insert')
          mocks.acceptInstantSession.mockRejectedValueOnce(
            new AppError(403, 'FORBIDDEN', 'Denied after task insert')
          );
        const { samChatStart } = await import('../../../src/operations/connector-operations');
        const context = {
          env,
          actor: {
            userId: 'user-1',
            via: 'connector' as const,
            scopes: new Set<'sam.read' | 'sam.write'>(['sam.read', 'sam.write']),
          },
          requestId: 'boundary',
          idempotencyKey: 'retry-boundary',
          execCtx: executionCtx,
        };
        const input = {
          projectId: 'project-1',
          message: failure === 'invalid' ? '   ' : 'Start work',
          agentProfileId: 'profile',
        };
        await expect(samChatStart.run(context, input)).rejects.toBeDefined();
        const receipts = sqlite.prepare('SELECT state FROM cli_operation_receipts').all();
        if (failure === 'invalid' || failure === 'quota') {
          expect(receipts).toEqual([]);
          expect(taskCount(sqlite)).toBe(0);
          sqlite.exec('DELETE FROM default_quotas');
          const result = await samChatStart.run(context, { ...input, message: 'Start work' });
          expect(result.taskId).toBeTruthy();
          expect(taskCount(sqlite)).toBe(1);
          expect(sqlite.prepare('SELECT state FROM cli_operation_receipts').all()).toEqual([
            { state: 'completed' },
          ]);
        } else {
          expect(receipts).toEqual([{ state: 'pending' }]);
          expect(taskCount(sqlite)).toBe(1);
          await expect(samChatStart.run(context, input)).rejects.toMatchObject({
            code: 'conflict',
          });
          expect(taskCount(sqlite)).toBe(1);
        }
        await Promise.all(vi.mocked(executionCtx.waitUntil).mock.calls.map(([promise]) => promise));
      } finally {
        sqlite.close();
      }
    }
  );

  it.each(['vm', 'cf-container'] as const)(
    'connector starts %s work through real placement/persistence with replay and provenance',
    async (runtime) => {
      const { sqlite, env } = createEnv();
      try {
        seedTaskSubmitRows(sqlite);
        await seedProjectDefaultPool(env);
        sqlite.exec(
          readFileSync(
            join(process.cwd(), 'src/db/migrations/0191_connector_execution.sql'),
            'utf8'
          )
        );
        sqlite.exec(
          readFileSync(
            join(process.cwd(), 'src/db/migrations/0189_cli_operation_receipts.sql'),
            'utf8'
          )
        );
        env.CF_CONTAINER_ENABLED = 'true';
        sqlite
          .prepare(
            "INSERT INTO agent_profiles (id,project_id,user_id,name,agent_type,model,runtime) VALUES ('connector-profile','project-1','user-1','Connector agent','openai-codex','gpt-6.1-sol',?)"
          )
          .run(runtime);
        mocks.acceptInstantSession.mockResolvedValue({ chatSessionId: 'instant-chat' });
        mocks.continueInstantSessionLaunch.mockResolvedValue({});
        const { samChatStart } = await import('../../../src/operations/connector-operations');
        const { samTaskGet } = await import('../../../src/operations/platform-operations');
        const context = {
          env,
          actor: {
            userId: 'user-1',
            via: 'connector' as const,
            clientName: 'Claude',
            scopes: new Set<'sam.read' | 'sam.write'>(['sam.read', 'sam.write']),
          },
          requestId: 'capability',
          idempotencyKey: 'connector-capability',
          execCtx: executionCtx,
        };
        const input = {
          projectId: 'project-1',
          message: 'Inspect project code; do not merge',
          agentProfileId: 'connector-profile',
        };
        const result = await samChatStart.run(context, input);
        expect(await samChatStart.run(context, input)).toEqual(result);
        expect(
          sqlite
            .prepare(
              'SELECT triggered_by,connector_client_name,agent_profile_hint FROM tasks WHERE id=?'
            )
            .get(result.taskId)
        ).toEqual({
          triggered_by: 'connector',
          connector_client_name: 'Claude',
          agent_profile_hint: 'connector-profile',
        });
        expect(
          await samTaskGet.run(context, { projectId: 'project-1', taskId: result.taskId })
        ).toMatchObject({
          id: result.taskId,
          triggeredBy: 'connector',
          connectorClientName: 'Claude',
        });
        expect(
          runtime === 'vm' ? mocks.startTaskRunnerDO : mocks.acceptInstantSession
        ).toHaveBeenCalledTimes(1);
        expect(mocks.recordActivityEvent).toHaveBeenCalledWith(
          env,
          'project-1',
          'task.submitted',
          'user',
          'user-1',
          null,
          result.sessionId,
          result.taskId,
          expect.objectContaining({ via: 'connector', clientName: 'Claude' })
        );
        await Promise.all(vi.mocked(executionCtx.waitUntil).mock.calls.map(([promise]) => promise));
      } finally {
        sqlite.close();
      }
    }
  );

  it.skipIf(!process.env.SAM_CLI_CONTRACT_BINARY)(
    'compiled CLI performs metadata lifecycle and submits through real Worker orchestration',
    async () => {
      const { sqlite, env } = createEnv();
      sqlite.exec(
        readFileSync(
          join(process.cwd(), 'src', 'db', 'migrations', '0189_cli_operation_receipts.sql'),
          'utf8'
        )
      );
      const projectId = '01K00000000000000000000000';
      const folder = await mkdtemp(join(tmpdir(), 'sam-cli-real-submit-'));
      seedUser(sqlite, 'user-1');
      seedProjectWithMember(sqlite, { projectId, userId: 'user-1', role: 'owner' });
      seedCloudCredential(sqlite, { id: 'fixture-cloud', userId: 'user-1', projectId });
      await seedStaticDefaultPool(env, { userId: 'user-1', projectId });
      env.DEFAULT_TASK_AGENT_TYPE = 'openai-codex';
      const app = createApp();
      // Only project display is a fixture endpoint; all workflow routes/services below are real.
      app.get('/api/projects/:projectId', (c) =>
        c.json({ id: projectId, name: 'Disposable fixture' })
      );
      const server = serve({ fetch: (req) => app.fetch(req, env, executionCtx), port: 0 });
      try {
        await new Promise<void>((resolve) => server.on('listening', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing fixture address');
        const cli = async (args: string[]) => {
          const { stdout, stderr } = await promisify(execFile)(
            process.env.SAM_CLI_CONTRACT_BINARY!,
            [...args, '--project', projectId, '--json'],
            {
              env: {
                ...process.env,
                SAM_API_URL: `http://127.0.0.1:${address.port}`,
                SAM_SESSION_COOKIE: 'fixture=synthetic',
                SAM_CONFIG_DIR: folder,
              },
            }
          );
          expect(stderr).toBe('');
          return JSON.parse(stdout) as Record<string, unknown>;
        };
        const profile = await cli(['profiles', 'create', '--name', 'Sol']);
        const skill = await cli(['skills', 'create', '--name', 'Review']);
        expect(
          await cli(['profiles', 'update', 'Sol', '--description', 'Synthetic metadata'])
        ).toMatchObject({ id: profile.id, description: 'Synthetic metadata' });
        expect(
          await cli(['skills', 'update', 'Review', '--description', 'Synthetic skill'])
        ).toMatchObject({ id: skill.id, description: 'Synthetic skill' });
        expect(
          await cli(['skills', 'resolve', 'Review', '--profileId', String(profile.id)])
        ).toMatchObject({ profileId: profile.id, skillId: skill.id, agentType: 'openai-codex' });
        const args = [
          'tasks',
          'submit',
          'Synthetic only; draft PR; do not merge',
          '--agent-profile',
          'Sol',
          '--skill',
          'Review',
          '--idempotency-key',
          'real-worker-fixture',
        ];
        const first = await cli(args);
        expect(await cli(args)).toEqual(first);
        expect(mocks.startTaskRunnerDO).toHaveBeenCalledTimes(1);
        expect(
          sqlite
            .prepare('SELECT agent_profile_hint, skill_id FROM tasks WHERE id = ?')
            .get(first.taskId)
        ).toEqual({ agent_profile_hint: profile.id, skill_id: skill.id });
        await Promise.all(vi.mocked(executionCtx.waitUntil).mock.calls.map(([promise]) => promise));
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
        sqlite.close();
        await rm(folder, { recursive: true, force: true });
      }
    }
  );

  it.each([
    ['vm', 'task'],
    ['vm', 'conversation'],
    ['cf-container', 'task'],
    ['cf-container', 'conversation'],
  ] as const)(
    'persists Sol and skill selection through real submit orchestration (%s / %s)',
    async (runtime, taskMode) => {
      const { sqlite, env } = createEnv();
      try {
        seedTaskSubmitRows(sqlite);
        await seedProjectDefaultPool(env);
        env.CF_CONTAINER_ENABLED = 'true';
        mocks.enrichMessageWithMentions.mockImplementation(async (content: string) => ({
          enrichedMessage: content,
        }));
        sqlite
          .prepare(
            `INSERT INTO agent_profiles
        (id, project_id, user_id, name, agent_type, model, effort, runtime, task_mode)
        VALUES ('sol', 'project-1', 'user-1', 'Sol', 'openai-codex', 'gpt-6.1-sol', 'high', ?, ?)`
          )
          .run(runtime, taskMode);
        sqlite.exec(`INSERT INTO skills
        (id, project_id, user_id, name, agent_type, default_profile_id, task_mode, system_prompt_append)
        VALUES ('review', 'project-1', 'user-1', 'Review', 'openai-codex', 'sol', 'task', 'Synthetic review guidance')`);
        mocks.acceptInstantSession.mockResolvedValue({ chatSessionId: 'instant-chat' });
        mocks.continueInstantSessionLaunch.mockResolvedValue({});
        const res = await createApp().request(
          '/api/projects/project-1/tasks/submit',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: 'Synthetic review; draft PR; do not merge',
              agentProfileId: 'sol',
              skillId: 'review',
              taskMode,
            }),
          },
          env,
          executionCtx
        );
        expect(res.status).toBe(202);
        const result = (await res.json()) as { taskId: string; sessionId: string };
        expect(
          sqlite
            .prepare(
              `SELECT agent_profile_hint, skill_id, skill_hint, task_mode, description
        FROM tasks WHERE id = ?`
            )
            .get(result.taskId)
        ).toMatchObject({
          agent_profile_hint: 'sol',
          skill_id: 'review',
          skill_hint: 'review',
          task_mode: taskMode,
          description: 'Synthetic review; draft PR; do not merge',
        });
        if (runtime === 'cf-container') {
          expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
          expect(mocks.acceptInstantSession).toHaveBeenCalledWith(
            expect.anything(),
            env,
            expect.objectContaining({
              agentProfileId: 'sol',
              skillId: 'review',
              taskMode,
              overrides: expect.objectContaining({ model: 'gpt-6.1-sol', effort: 'high' }),
              initialPrompt: expect.stringContaining('Synthetic review guidance'),
            })
          );
        } else {
          expect(mocks.acceptInstantSession).not.toHaveBeenCalled();
          expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
            env,
            expect.objectContaining({
              taskId: result.taskId,
              taskMode,
              agentProfileHint: 'sol',
              model: 'gpt-6.1-sol',
              effort: 'high',
              systemPromptAppend: 'Synthetic review guidance',
            })
          );
          expect(mocks.persistMessage).toHaveBeenCalledWith(
            env,
            'project-1',
            result.sessionId,
            'user',
            'Synthetic review; draft PR; do not merge',
            null
          );
        }
        await Promise.all(vi.mocked(executionCtx.waitUntil).mock.calls.map(([promise]) => promise));
      } finally {
        sqlite.close();
      }
    }
  );

  it('creates and updates metadata through real services, resolves it, and submits persisted identities', async () => {
    const { sqlite, env } = createEnv();
    try {
      seedTaskSubmitRows(sqlite);
      await seedProjectDefaultPool(env);
      env.DEFAULT_TASK_AGENT_TYPE = 'openai-codex';
      const app = createApp();
      const request = (path: string, method: string, body: unknown) =>
        app.request(
          `/api/projects/project-1/cli/${path}`,
          { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
          env,
          executionCtx
        );
      const profileResponse = await request('profiles', 'POST', { name: 'Sol fixture' });
      expect(profileResponse.status).toBe(201);
      const profile = (await profileResponse.json()) as { id: string; updatedAt: string };
      const skillResponse = await request('skills', 'POST', { name: 'Review fixture' });
      expect(skillResponse.status).toBe(201);
      const skill = (await skillResponse.json()) as { id: string; updatedAt: string };
      for (const [family, resource] of [
        ['profiles', profile],
        ['skills', skill],
      ] as const) {
        const updated = await request(`${family}/${resource.id}`, 'PATCH', {
          description: 'Updated synthetic metadata',
          expectedUpdatedAt: resource.updatedAt,
        });
        expect(updated.status).toBe(200);
        expect(await updated.json()).toMatchObject({
          id: resource.id,
          description: 'Updated synthetic metadata',
        });
        expect(
          (
            await request(`${family}/${resource.id}`, 'PATCH', {
              name: 'Stale overwrite',
              expectedUpdatedAt: resource.updatedAt,
            })
          ).status
        ).toBe(409);
      }
      const resolved = await resolveSkillProfile(
        drizzle(env.DATABASE, { schema }),
        'project-1',
        profile.id,
        skill.id,
        'user-1',
        env
      );
      expect(resolved).toMatchObject({
        profileId: profile.id,
        skillId: skill.id,
        agentType: 'openai-codex',
      });
      const res = await app.request(
        '/api/projects/project-1/tasks/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: 'Use persisted fixture',
            agentProfileId: profile.id,
            skillId: skill.id,
          }),
        },
        env,
        executionCtx
      );
      expect(res.status).toBe(202);
      const result = (await res.json()) as { taskId: string };
      expect(
        sqlite
          .prepare('SELECT agent_profile_hint, skill_id FROM tasks WHERE id = ?')
          .get(result.taskId)
      ).toEqual({ agent_profile_hint: profile.id, skill_id: skill.id });
      await Promise.all(vi.mocked(executionCtx.waitUntil).mock.calls.map(([promise]) => promise));
    } finally {
      sqlite.close();
    }
  });

  it.each([false, true])(
    'honors an Instant profile through task-submit without cloud credentials or a VM pool (attachment=%s)',
    async (withAttachment) => {
      const { sqlite, env } = createEnv();
      seedUser(sqlite, 'user-1');
      seedProjectWithMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
      sqlite.exec(`INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, runtime)
      VALUES ('instant', 'project-1', 'user-1', 'Instant', 'openai-codex', 'cf-container')`);
      env.CF_CONTAINER_ENABLED = 'true';
      const attachment = {
        uploadId: 'upload-1',
        filename: 'debug.txt',
        size: 4,
        contentType: 'text/plain',
      };
      env.R2 = { head: vi.fn().mockResolvedValue({ size: 4 }) } as unknown as R2Bucket;
      seedParentTask(sqlite, { taskId: 'parent-instant', userId: 'user-1' });
      mocks.acceptInstantSession.mockResolvedValue({ chatSessionId: 'instant-chat' });
      mocks.continueInstantSessionLaunch.mockResolvedValue({});
      const res = await createApp().request(
        '/api/projects/project-1/tasks/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: 'Use Instant',
            agentProfileId: 'instant',
            parentTaskId: 'parent-instant',
            contextSummary: 'Fork context',
            ...(withAttachment ? { attachments: [attachment] } : {}),
          }),
        },
        env,
        executionCtx
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ sessionId: 'instant-chat' });
      expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
      expect(
        sqlite
          .prepare("SELECT capacity_pool_id FROM tasks WHERE parent_task_id = 'parent-instant'")
          .get()
      ).toEqual({ capacity_pool_id: null });
      expect(mocks.acceptInstantSession).toHaveBeenCalledWith(
        expect.anything(),
        env,
        expect.objectContaining({
          contextSummary: 'Fork context',
          attachments: withAttachment ? [attachment] : [],
        })
      );
      expect(mocks.continueInstantSessionLaunch).toHaveBeenCalled();
      await Promise.all(vi.mocked(executionCtx.waitUntil).mock.calls.map(([promise]) => promise));
      expect(mocks.updateSessionTopic).toHaveBeenCalledWith(
        env,
        'project-1',
        'instant-chat',
        'Generated task title'
      );
      expect(
        sqlite.prepare("SELECT title FROM tasks WHERE parent_task_id = 'parent-instant'").get()
      ).toEqual({ title: 'Generated task title' });
      expect(mocks.recordActivityEvent).toHaveBeenCalledWith(
        env,
        'project-1',
        'task.submitted',
        'user',
        'user-1',
        null,
        'instant-chat',
        expect.any(String),
        expect.objectContaining({ branchName: expect.any(String) })
      );
    }
  );

  it('records acceptance failure in both task state and lifecycle history', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-1');
    seedProjectWithMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
    sqlite.exec(`INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, runtime)
      VALUES ('instant', 'project-1', 'user-1', 'Instant', 'openai-codex', 'cf-container')`);
    env.CF_CONTAINER_ENABLED = 'true';
    mocks.acceptInstantSession.mockRejectedValueOnce(new Error('Instant acceptance rejected'));
    const res = await createApp().request(
      '/api/projects/project-1/tasks/submit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Use Instant', agentProfileId: 'instant' }),
      },
      env,
      executionCtx
    );
    expect(res.status).toBe(500);
    expect(sqlite.prepare('SELECT status, execution_step, error_message FROM tasks').get()).toEqual(
      {
        status: 'failed',
        execution_step: 'launch_failed',
        error_message: 'Instant acceptance rejected',
      }
    );
    expect(
      sqlite
        .prepare('SELECT from_status, to_status FROM task_status_events ORDER BY created_at, rowid')
        .all()
    ).toEqual([
      { from_status: null, to_status: 'queued' },
      { from_status: 'queued', to_status: 'failed' },
    ]);
    expect(mocks.recordActivityEvent).not.toHaveBeenCalled();
  });

  it.each([{ resourceRequirements: { minMemoryGb: 4 } }, { vmSize: 'medium' }])(
    'rejects VM overrides on an Instant profile instead of changing runtime: %j',
    async (overrides) => {
      const { sqlite, env } = createEnv();
      seedTaskSubmitRows(sqlite);
      sqlite.exec(`INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, runtime)
      VALUES ('instant', 'project-1', 'user-1', 'Instant', 'openai-codex', 'cf-container')`);
      env.CF_CONTAINER_ENABLED = 'true';
      const res = await createApp().request(
        '/api/projects/project-1/tasks/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'Instant', agentProfileId: 'instant', ...overrides }),
        },
        env,
        executionCtx
      );
      expect(res.status).toBe(400);
      expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
      expect(mocks.acceptInstantSession).not.toHaveBeenCalled();
      expect(sqlite.prepare('SELECT count(*) AS count FROM tasks').get()).toEqual({ count: 0 });
    }
  );

  it('preserves the explicit agent, project defaults, and enriched prompt for Instant', async () => {
    const { sqlite, env } = createEnv();
    seedTaskSubmitRows(sqlite);
    sqlite.exec(`INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, runtime)
      VALUES ('instant', 'project-1', 'user-1', 'Instant', 'openai-codex', 'cf-container')`);
    sqlite.prepare('UPDATE projects SET agent_defaults = ? WHERE id = ?').run(
      JSON.stringify({
        'claude-code': { model: 'project-claude-model', permissionMode: 'acceptEdits' },
        'openai-codex': { model: 'different-agent-model', permissionMode: 'plan' },
      }),
      'project-1'
    );
    env.CF_CONTAINER_ENABLED = 'true';
    mocks.enrichMessageWithMentions.mockResolvedValue({
      enrichedMessage: 'Use @reviewer\nReviewer context',
    });
    mocks.acceptInstantSession.mockResolvedValue({ chatSessionId: 'instant-chat' });
    mocks.continueInstantSessionLaunch.mockResolvedValue(undefined);
    const res = await createApp().request(
      '/api/projects/project-1/tasks/submit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Use @reviewer',
          agentProfileId: 'instant',
          agentType: 'claude-code',
        }),
      },
      env,
      executionCtx
    );
    expect(res.status).toBe(202);
    expect(mocks.acceptInstantSession).toHaveBeenCalledWith(
      expect.anything(),
      env,
      expect.objectContaining({
        agentType: 'claude-code',
        displayMessage: 'Use @reviewer',
        initialPrompt: 'Use @reviewer\nReviewer context',
        overrides: expect.objectContaining({
          model: 'project-claude-model',
          permissionMode: 'acceptEdits',
        }),
      })
    );
    expect(sqlite.prepare('SELECT description FROM tasks').get()).toEqual({
      description: 'Use @reviewer\nReviewer context',
    });
    expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
  });

  it('rejects a disabled Instant runtime before creating a task or allocating VM capacity', async () => {
    const { sqlite, env } = createEnv();
    seedTaskSubmitRows(sqlite);
    sqlite.exec(`INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, runtime)
      VALUES ('instant', 'project-1', 'user-1', 'Instant', 'openai-codex', 'cf-container')`);
    env.CF_CONTAINER_ENABLED = 'false';
    const res = await createApp().request(
      '/api/projects/project-1/tasks/submit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Use Instant', agentProfileId: 'instant' }),
      },
      env,
      executionCtx
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      message: expect.stringContaining('Instant containers are disabled'),
    });
    expect(sqlite.prepare('SELECT count(*) AS count FROM tasks').get()).toEqual({ count: 0 });
    expect(mocks.acceptInstantSession).not.toHaveBeenCalled();
    expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
  });

  it('uses the effective default pool and persists task placement snapshots before TaskRunner start', async () => {
    const { sqlite, env } = createEnv();
    seedTaskSubmitRows(sqlite);
    await seedProjectDefaultPool(env);

    const res = await createApp().request(
      '/api/projects/project-1/tasks/submit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Run in project pool' }),
      },
      env,
      executionCtx
    );

    expect(res.status).toBe(202);
    const taskRow = sqlite
      .prepare(
        `SELECT
           capacity_pool_id,
           capacity_pool_scope,
           capacity_pool_revision,
           capacity_source_id,
           capacity_pool_candidate_id,
           placement_credential_source,
           placement_credential_reference,
           placement_credential_version,
           capacity_pool_project_id,
           workload_role,
           provider_instance_type,
           provider_instance_vcpu_count,
           provider_instance_memory_mb,
           provider_instance_disk_gb,
           provider_instance_price_display,
           provider_instance_price_currency,
           provider_instance_price_monthly_cents,
           provider_instance_price_hourly_micros,
           placement_explanation_json
         FROM tasks
         WHERE project_id = 'project-1'`
      )
      .get() as {
      capacity_pool_id: string | null;
      capacity_pool_scope: string | null;
      capacity_pool_revision: number | null;
      capacity_source_id: string | null;
      capacity_pool_candidate_id: string | null;
      placement_credential_source: string | null;
      placement_credential_reference: string | null;
      placement_credential_version: number | null;
      capacity_pool_project_id: string | null;
      workload_role: string | null;
      provider_instance_type: string | null;
      provider_instance_vcpu_count: number | null;
      provider_instance_memory_mb: number | null;
      provider_instance_disk_gb: number | null;
      provider_instance_price_display: string | null;
      provider_instance_price_currency: string | null;
      provider_instance_price_monthly_cents: number | null;
      provider_instance_price_hourly_micros: number | null;
      placement_explanation_json: string | null;
    };

    expect(taskRow).toMatchObject({
      capacity_pool_id: 'cap-pool-default:project:project-1',
      capacity_pool_scope: 'project',
      capacity_pool_revision: 1,
      capacity_source_id: 'cap-source-default:project:project-cloud-1',
      capacity_pool_candidate_id:
        'cap-candidate-default:cap-pool-default:project:project-1:cap-source-default:project:project-cloud-1:hetzner:nbg1:cx23',
      placement_credential_source: 'project',
      placement_credential_reference: 'credentials:project-cloud-1',
      placement_credential_version: Date.parse('2026-08-28T00:00:00.000Z'),
      capacity_pool_project_id: 'project-1',
      workload_role: 'workspace',
      provider_instance_type: 'cx23',
      provider_instance_vcpu_count: 2,
      provider_instance_memory_mb: 4096,
      provider_instance_disk_gb: 40,
      provider_instance_price_display: '€3.99/mo',
      provider_instance_price_currency: 'EUR',
      provider_instance_price_monthly_cents: 399,
      provider_instance_price_hourly_micros: 5466,
    });
    expect(taskRow.placement_explanation_json).toContain('capacity_pool_default');

    expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        taskId: expect.any(String),
        projectId: 'project-1',
        userId: 'user-1',
        cloudProvider: 'hetzner',
        credentialAttributionProjectId: 'project-1',
        credentialAttributionSource: 'project',
        capacityPoolSelection: expect.objectContaining({
          poolId: 'cap-pool-default:project:project-1',
          scope: 'project',
          candidates: expect.arrayContaining([
            expect.objectContaining({
              id: taskRow.capacity_pool_candidate_id,
              capacitySourceId: taskRow.capacity_source_id,
              provider: 'hetzner',
              location: 'nbg1',
              machineSize: 'small',
              providerInstanceType: 'cx23',
              providerInstanceVcpuCount: 2,
              providerInstanceMemoryMb: 4096,
              snapshot: expect.objectContaining({
                capacityPoolId: taskRow.capacity_pool_id,
                capacitySourceId: taskRow.capacity_source_id,
                capacityPoolCandidateId: taskRow.capacity_pool_candidate_id,
                providerInstanceType: 'cx23',
                providerInstanceVcpuCount: 2,
                providerInstanceMemoryMb: 4096,
              }),
            }),
          ]),
        }),
      })
    );
  });

  it('fails closed when the effective default pool has no eligible offering for the task', async () => {
    const { sqlite, env } = createEnv();
    seedTaskSubmitRows(sqlite);
    await seedProjectDefaultPool(env);

    const res = await createApp().request(
      '/api/projects/project-1/tasks/submit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Run a task that exceeds the default pool',
          resourceRequirements: { minVcpu: 999 },
        }),
      },
      env,
      executionCtx
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('No eligible compute-pool offering is available');
    expect(body.message).toContain('999 vCPU');
    expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_id = 'project-1'").get()
    ).toEqual({ count: 0 });
  });

  it('inherits project resource requirements into submitted task persistence and reservation', async () => {
    const { sqlite, env } = createEnv();
    seedTaskSubmitRows(sqlite);
    sqlite
      .prepare(
        `UPDATE projects
         SET resource_requirements_json = ?
         WHERE id = 'project-1'`
      )
      .run(JSON.stringify({ minVcpu: 2, exclusiveNode: false, minDiskGb: 0 }));
    await seedProjectDefaultPool(env);

    const res = await createApp().request(
      '/api/projects/project-1/tasks/submit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Run with project resources' }),
      },
      env,
      executionCtx
    );

    expect(res.status).toBe(202);
    const taskRow = sqlite
      .prepare(
        `SELECT resource_requirements_json, resource_requirements_source, resolved_reservation_json
         FROM tasks
         WHERE project_id = 'project-1'`
      )
      .get() as {
      resource_requirements_json: string | null;
      resource_requirements_source: string | null;
      resolved_reservation_json: string;
    };
    expect(JSON.parse(taskRow.resource_requirements_json ?? '{}')).toEqual({
      minVcpu: 2,
      exclusiveNode: false,
      minDiskGb: 0,
    });
    expect(taskRow.resource_requirements_source).toBe('project');
    const reservation = JSON.parse(taskRow.resolved_reservation_json) as {
      source: string;
      sourceId: string;
      cpuMillis: number;
      diskMb: number;
      exclusiveNode: boolean;
      fieldProvenance: Record<string, { source: string; value: unknown }>;
    };
    expect(reservation).toMatchObject({
      source: 'project',
      sourceId: 'project-1',
      cpuMillis: 2000,
      diskMb: 0,
      exclusiveNode: false,
    });
    expect(reservation.fieldProvenance.minVcpu).toMatchObject({
      source: 'project',
      value: 2,
    });
    expect(reservation.fieldProvenance.minDiskGb).toMatchObject({
      source: 'project',
      value: 0,
    });
    expect(reservation.fieldProvenance.exclusiveNode).toMatchObject({
      source: 'project',
      value: false,
    });
    expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        resourceRequirements: {
          minVcpu: 2,
          exclusiveNode: false,
          minDiskGb: 0,
        },
        resolvedReservation: expect.objectContaining({
          source: 'project',
          sourceId: 'project-1',
        }),
      })
    );
  });

  it('persists skill, profile, and project resource layers in the versioned plan', async () => {
    const { sqlite, env } = createEnv();
    seedTaskSubmitRows(sqlite);
    sqlite
      .prepare(
        `UPDATE projects
         SET resource_requirements_json = ?
         WHERE id = 'project-1'`
      )
      .run(JSON.stringify({ minDiskGb: 0, exclusiveNode: false }));
    sqlite
      .prepare(
        `INSERT INTO agent_profiles (
           id, project_id, user_id, name, agent_type, effort, resource_requirements_json
         )
         VALUES ('profile-1', 'project-1', 'user-1', 'Profile One', 'claude-code', 'auto', ?)`
      )
      .run(JSON.stringify({ minMemoryGb: 12 }));
    sqlite
      .prepare(
        `INSERT INTO skills (
           id, project_id, user_id, name, agent_type, resource_requirements_json
         )
         VALUES ('skill-1', 'project-1', 'user-1', 'Skill One', 'claude-code', ?)`
      )
      .run(JSON.stringify({ minVcpu: 4 }));
    await seedProjectDefaultPool(env);

    const res = await createApp().request(
      '/api/projects/project-1/tasks/submit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Run layered resource plan',
          agentProfileId: 'profile-1',
          skillId: 'skill-1',
        }),
      },
      env,
      executionCtx
    );

    expect(res.status).toBe(202);
    const taskRow = sqlite
      .prepare(
        `SELECT resource_requirements_json, resource_requirement_plan_json,
          resource_requirements_source, resolved_reservation_json
         FROM tasks
         WHERE project_id = 'project-1'`
      )
      .get() as {
      resource_requirements_json: string | null;
      resource_requirement_plan_json: string;
      resource_requirements_source: string | null;
      resolved_reservation_json: string;
    };

    expect(JSON.parse(taskRow.resource_requirements_json ?? '{}')).toEqual({ minVcpu: 4 });
    expect(taskRow.resource_requirements_source).toBe('skill');
    const plan = JSON.parse(taskRow.resource_requirement_plan_json) as {
      version: number;
      intent: Record<string, unknown>;
    };
    expect(plan.version).toBe(1);
    expect(plan.intent).toMatchObject({
      skill: { minVcpu: 4 },
      agentProfile: { minMemoryGb: 12 },
      project: { minDiskGb: 0, exclusiveNode: false },
    });
    const reservation = JSON.parse(taskRow.resolved_reservation_json) as {
      cpuMillis: number;
      memoryMb: number;
      diskMb: number;
      exclusiveNode: boolean;
      fieldProvenance: Record<string, { source: string; value: unknown }>;
    };
    expect(reservation).toMatchObject({
      cpuMillis: 4000,
      memoryMb: 12 * 1024,
      diskMb: 0,
      exclusiveNode: false,
    });
    expect(reservation.fieldProvenance.minVcpu).toMatchObject({
      source: 'skill',
      value: 4,
    });
    expect(reservation.fieldProvenance.minMemoryGb).toMatchObject({
      source: 'agent-profile',
      value: 12,
    });
    expect(reservation.fieldProvenance.minDiskGb).toMatchObject({
      source: 'project',
      value: 0,
    });
  });

  it('does not inherit another project member personal credential attribution from a parent task', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-a');
    seedUser(sqlite, 'user-b');
    seedProjectWithMember(sqlite, { projectId: 'project-1', userId: 'user-a', role: 'owner' });
    addProjectMember(sqlite, { projectId: 'project-1', userId: 'user-b' });
    seedCloudCredential(sqlite, {
      id: 'personal-canary-user-a',
      userId: 'user-a',
      projectId: null,
    });
    seedParentTask(sqlite, {
      userId: 'user-a',
      credentialAttributionUserId: 'user-a',
      credentialAttributionSource: 'user',
    });
    await seedStaticDefaultPool(env, { userId: 'user-b', projectId: 'project-1' });
    authState.userId = 'user-b';

    const res = await createApp().request(
      '/api/projects/project-1/tasks/submit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Child must not use user-a personal',
          parentTaskId: 'parent-task-1',
        }),
      },
      env,
      executionCtx
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.message).toContain('Cloud provider credentials required');
    expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
    expect(taskCount(sqlite)).toBe(1);
  });

  it('uses the current member personal credential when parent personal attribution is not theirs', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-a');
    seedUser(sqlite, 'user-b');
    seedProjectWithMember(sqlite, { projectId: 'project-1', userId: 'user-a', role: 'owner' });
    addProjectMember(sqlite, { projectId: 'project-1', userId: 'user-b' });
    seedCloudCredential(sqlite, {
      id: 'personal-canary-user-a',
      userId: 'user-a',
      projectId: null,
    });
    seedCloudCredential(sqlite, {
      id: 'personal-canary-user-b',
      userId: 'user-b',
      projectId: null,
    });
    seedParentTask(sqlite, {
      userId: 'user-a',
      credentialAttributionUserId: 'user-a',
      credentialAttributionSource: 'user',
    });
    await seedStaticDefaultPool(env, { userId: 'user-b', projectId: 'project-1' });
    authState.userId = 'user-b';

    const res = await createApp().request(
      '/api/projects/project-1/tasks/submit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Child uses user-b personal',
          parentTaskId: 'parent-task-1',
        }),
      },
      env,
      executionCtx
    );

    expect(res.status).toBe(202);
    expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        credentialAttributionUserId: 'user-b',
        credentialAttributionProjectId: null,
        credentialAttributionSource: 'user',
      })
    );
  });

  it('keeps project credential inheritance shared while attributing the current member', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-a');
    seedUser(sqlite, 'user-b');
    seedProjectWithMember(sqlite, { projectId: 'project-1', userId: 'user-a', role: 'owner' });
    addProjectMember(sqlite, { projectId: 'project-1', userId: 'user-b' });
    seedCloudCredential(sqlite, {
      id: 'project-canary',
      userId: 'user-a',
      projectId: 'project-1',
    });
    seedParentTask(sqlite, {
      userId: 'user-a',
      credentialAttributionUserId: 'user-a',
      credentialAttributionProjectId: 'project-1',
      credentialAttributionSource: 'project',
    });
    await seedStaticDefaultPool(env, { userId: 'user-b', projectId: 'project-1' });
    authState.userId = 'user-b';

    const res = await createApp().request(
      '/api/projects/project-1/tasks/submit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Child may use project credential',
          parentTaskId: 'parent-task-1',
        }),
      },
      env,
      executionCtx
    );

    expect(res.status).toBe(202);
    expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        credentialAttributionUserId: 'user-b',
        credentialAttributionProjectId: 'project-1',
        credentialAttributionSource: 'project',
      })
    );
  });

  it('preserves same-user personal credential continuation', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-a');
    seedProjectWithMember(sqlite, { projectId: 'project-1', userId: 'user-a', role: 'owner' });
    seedCloudCredential(sqlite, {
      id: 'personal-canary-user-a',
      userId: 'user-a',
      projectId: null,
    });
    seedParentTask(sqlite, {
      userId: 'user-a',
      credentialAttributionUserId: 'user-a',
      credentialAttributionSource: 'user',
    });
    await seedStaticDefaultPool(env, { userId: 'user-a', projectId: 'project-1' });
    authState.userId = 'user-a';

    const res = await createApp().request(
      '/api/projects/project-1/tasks/submit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Same user child', parentTaskId: 'parent-task-1' }),
      },
      env,
      executionCtx
    );

    expect(res.status).toBe(202);
    expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        credentialAttributionUserId: 'user-a',
        credentialAttributionProjectId: null,
        credentialAttributionSource: 'user',
      })
    );
  });

  it('rejects cross-project parent lineage before runner launch', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-1');
    seedProjectWithMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
    seedProjectWithMember(sqlite, { projectId: 'project-2', userId: 'user-1', role: 'owner' });
    seedCloudCredential(sqlite, {
      id: 'personal-canary-user-1',
      userId: 'user-1',
      projectId: null,
    });
    seedParentTask(sqlite, {
      taskId: 'other-project-parent',
      projectId: 'project-2',
      userId: 'user-1',
      credentialAttributionUserId: 'user-1',
      credentialAttributionSource: 'user',
    });

    const res = await createApp().request(
      '/api/projects/project-1/tasks/submit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Cross-project child',
          parentTaskId: 'other-project-parent',
        }),
      },
      env,
      executionCtx
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('Parent task belongs to a different project');
    expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
    expect(taskCount(sqlite)).toBe(1);
  });

  it('does not inherit a removed member personal credential attribution', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-a');
    seedUser(sqlite, 'user-b');
    seedProjectWithMember(sqlite, { projectId: 'project-1', userId: 'user-a', role: 'owner' });
    sqlite
      .prepare(
        `UPDATE project_members
         SET status = 'removed'
         WHERE project_id = 'project-1' AND user_id = 'user-a'`
      )
      .run();
    addProjectMember(sqlite, { projectId: 'project-1', userId: 'user-b' });
    seedCloudCredential(sqlite, {
      id: 'personal-canary-removed-user-a',
      userId: 'user-a',
      projectId: null,
    });
    seedParentTask(sqlite, {
      userId: 'user-a',
      credentialAttributionUserId: 'user-a',
      credentialAttributionSource: 'user',
    });
    authState.userId = 'user-b';

    const res = await createApp().request(
      '/api/projects/project-1/tasks/submit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Removed member credential must not apply',
          parentTaskId: 'parent-task-1',
        }),
      },
      env,
      executionCtx
    );

    expect(res.status).toBe(403);
    expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
    expect(taskCount(sqlite)).toBe(1);
  });
});
