/**
 * Vertical-slice authorization regressions for caller-controlled chat workspace links.
 *
 * The real Hono routes, Drizzle queries, task/session repair, terminal cleanup, and
 * task-runner cleanup execute against real SQLite predicates. Only the actual system
 * boundaries are faked: browser authentication, ProjectData RPC, and node teardown.
 * Every rejection has a valid control proving that chat creation/cleanup still works.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const CALLER = 'user-caller';
const OTHER_USER = 'user-other';
const PROJECT = 'project-shared';
const OTHER_PROJECT = 'project-other';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  linkSessionToTask: vi.fn(),
  stopSession: vi.fn(),
  failSession: vi.fn(),
  stopWorkspaceOnNode: vi.fn(),
  stopAgentSessionOnNode: vi.fn(),
  stopNodeResources: vi.fn(),
  markIdle: vi.fn(),
  scheduleWorkspaceDeletion: vi.fn(),
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => CALLER,
  getAuth: () => ({
    user: { id: CALLER, role: 'user' },
    session: { id: 'browser-session' },
  }),
}));

vi.mock('../../../src/services/project-data', () => ({
  createSession: (...args: unknown[]) => mocks.createSession(...args),
  getSession: (...args: unknown[]) => mocks.getSession(...args),
  linkSessionToTask: (...args: unknown[]) => mocks.linkSessionToTask(...args),
  stopSession: (...args: unknown[]) => mocks.stopSession(...args),
  failSession: (...args: unknown[]) => mocks.failSession(...args),
}));

vi.mock('../../../src/services/node-agent', () => ({
  stopWorkspaceOnNode: (...args: unknown[]) => mocks.stopWorkspaceOnNode(...args),
  stopAgentSessionOnNode: (...args: unknown[]) => mocks.stopAgentSessionOnNode(...args),
  cancelAgentPromptOnNode: vi.fn(),
}));

vi.mock('../../../src/services/nodes', () => ({
  stopNodeResources: (...args: unknown[]) => mocks.stopNodeResources(...args),
}));

vi.mock('../../../src/services/node-lifecycle', () => ({
  markIdle: (...args: unknown[]) => mocks.markIdle(...args),
}));

import { stopSubtask } from '../../../src/durable-objects/sam-session/tools/stop-subtask';
import { chatRoutes } from '../../../src/routes/chat';
import { cleanupTaskRun } from '../../../src/services/task-runner';
import { cleanupTerminalTaskResources } from '../../../src/services/task-terminal-cleanup';

type StoredSession = {
  id: string;
  projectId: string;
  taskId: string | null;
  workspaceId: string | null;
  createdByUserId: string;
  status: string;
  topic?: string | null;
};

let sqlite: Database.Database;
let env: Env;
let sessionSequence: number;
let sessions: Map<string, StoredSession>;

function db() {
  return drizzle(env.DATABASE, { schema });
}

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json(error.toJSON(), error.statusCode as never)
      : c.json({ error: 'INTERNAL_ERROR', message: error.message }, 500)
  );
  app.route('/api/projects/:projectId/sessions', chatRoutes);
  return app;
}

async function seedProject(projectId: string, ownerId: string, callerRole?: string): Promise<void> {
  await db()
    .insert(schema.projects)
    .values({
      id: projectId,
      userId: ownerId,
      name: projectId,
      repository: `org/${projectId}`,
      createdBy: ownerId,
    } as typeof schema.projects.$inferInsert);
  if (callerRole) {
    await db()
      .insert(schema.projectMembers)
      .values({
        projectId,
        userId: CALLER,
        role: callerRole,
        status: 'active',
        invitedBy: ownerId,
      } as typeof schema.projectMembers.$inferInsert);
  }
}

async function seedNode(nodeId: string, userId: string, runtime = 'cf-container'): Promise<void> {
  await db()
    .insert(schema.nodes)
    .values({
      id: nodeId,
      userId,
      name: nodeId,
      status: 'running',
      runtime,
    } as typeof schema.nodes.$inferInsert);
}

async function seedWorkspace(input: {
  id: string;
  projectId: string | null;
  userId: string;
  nodeId?: string;
  chatSessionId?: string | null;
  status?: string;
  taskMode?: string;
}): Promise<void> {
  await db()
    .insert(schema.workspaces)
    .values({
      id: input.id,
      projectId: input.projectId,
      userId: input.userId,
      nodeId: input.nodeId ?? null,
      name: input.id,
      repository: 'org/repo',
      vmSize: 'small',
      vmLocation: 'nbg1',
      status: input.status ?? 'running',
      chatSessionId: input.chatSessionId ?? null,
    } as typeof schema.workspaces.$inferInsert);
}

async function seedTask(input: {
  id: string;
  projectId: string;
  userId: string;
  sessionId: string | null;
  workspaceId: string | null;
  status?: string;
  taskMode?: string;
}): Promise<void> {
  await db()
    .insert(schema.tasks)
    .values({
      id: input.id,
      projectId: input.projectId,
      userId: input.userId,
      chatSessionId: input.sessionId,
      workspaceId: input.workspaceId,
      title: input.id,
      status: input.status ?? 'in_progress',
      taskMode: input.taskMode ?? 'conversation',
      createdBy: input.userId,
    } as typeof schema.tasks.$inferInsert);
}

function storeSession(input: Omit<StoredSession, 'status'> & { status?: string }): void {
  sessions.set(input.id, { ...input, status: input.status ?? 'active' });
}

async function postSession(projectId: string, body: Record<string, unknown>) {
  return createApp().fetch(
    new Request(`https://api.test/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env
  );
}

async function stopSession(projectId: string, sessionId: string) {
  return createApp().fetch(
    new Request(`https://api.test/api/projects/${projectId}/sessions/${sessionId}/stop`, {
      method: 'POST',
    }),
    env
  );
}

async function taskRows() {
  return db().select().from(schema.tasks);
}

function expectNoDestructiveBoundaryCalls(): void {
  expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
  expect(mocks.stopNodeResources).not.toHaveBeenCalled();
  expect(mocks.markIdle).not.toHaveBeenCalled();
  expect(mocks.scheduleWorkspaceDeletion).not.toHaveBeenCalled();
  expect(mocks.stopSession).not.toHaveBeenCalled();
  expect(mocks.failSession).not.toHaveBeenCalled();
}

beforeEach(async () => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.users,
    schema.projects,
    schema.projectMembers,
    schema.nodes,
    schema.workspaces,
    schema.tasks,
    schema.taskStatusEvents,
    schema.agentSessions,
    schema.computeUsage,
  ]);
  env = {
    DATABASE: createSqliteD1(sqlite),
    TASK_RUN_CLEANUP_DELAY_MS: '0',
    NODE_LIFECYCLE: {
      idFromName: (id: string) => id,
      get: () => ({ scheduleWorkspaceDeletion: mocks.scheduleWorkspaceDeletion }),
    },
  } as unknown as Env;
  sessions = new Map();
  sessionSequence = 0;

  mocks.createSession.mockImplementation(
    async (
      _env: Env,
      projectId: string,
      workspaceId: string | null,
      topic: string | null,
      taskId: string,
      createdByUserId: string
    ) => {
      const id = `created-session-${++sessionSequence}`;
      storeSession({ id, projectId, workspaceId, topic, taskId, createdByUserId });
      return id;
    }
  );
  mocks.getSession.mockImplementation(async (_env: Env, projectId: string, sessionId: string) => {
    const session = sessions.get(sessionId);
    return session?.projectId === projectId ? session : null;
  });
  mocks.linkSessionToTask.mockImplementation(
    async (_env: Env, projectId: string, sessionId: string, taskId: string) => {
      const session = sessions.get(sessionId);
      if (session?.projectId === projectId) session.taskId = taskId;
    }
  );
  mocks.stopSession.mockImplementation(async (_env: Env, projectId: string, sessionId: string) => {
    const session = sessions.get(sessionId);
    if (session?.projectId === projectId) session.status = 'stopped';
  });
  mocks.failSession.mockResolvedValue(undefined);
  mocks.stopWorkspaceOnNode.mockResolvedValue(undefined);
  mocks.stopAgentSessionOnNode.mockResolvedValue(undefined);
  mocks.stopNodeResources.mockResolvedValue(undefined);
  mocks.markIdle.mockResolvedValue(undefined);
  mocks.scheduleWorkspaceDeletion.mockResolvedValue(undefined);

  await db()
    .insert(schema.users)
    .values([
      { id: CALLER, email: 'caller@test.invalid', status: 'active' },
      { id: OTHER_USER, email: 'other@test.invalid', status: 'active' },
    ] as Array<typeof schema.users.$inferInsert>);
  await seedProject(PROJECT, OTHER_USER, 'maintainer');
  await seedProject(OTHER_PROJECT, OTHER_USER);
});

afterEach(() => sqlite.close());

describe('POST /sessions — workspace attachment authorization', () => {
  it('ATTACK: rejects another user workspace in the same shared project before any write', async () => {
    await seedWorkspace({ id: 'ws-other-user', projectId: PROJECT, userId: OTHER_USER });

    const response = await postSession(PROJECT, { workspaceId: 'ws-other-user', topic: 'attack' });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'NOT_FOUND' });
    expect(await taskRows()).toHaveLength(0);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('ATTACK: rejects the caller workspace when it belongs to another project', async () => {
    await seedWorkspace({ id: 'ws-other-project', projectId: OTHER_PROJECT, userId: CALLER });

    const response = await postSession(PROJECT, { workspaceId: 'ws-other-project' });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'NOT_FOUND' });
    expect(await taskRows()).toHaveLength(0);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('ATTACK: rejects a missing or stale workspace id without disclosing which scope failed', async () => {
    const response = await postSession(PROJECT, { workspaceId: 'ws-does-not-exist' });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'NOT_FOUND' });
    expect(await taskRows()).toHaveLength(0);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('CONTROL: preserves unbound session creation and its response contract', async () => {
    const response = await postSession(PROJECT, { topic: 'Unbound conversation' });

    expect(response.status).toBe(201);
    const body = await response.json<{ id: string; sessionId: string; taskId: string }>();
    expect(body).toEqual({
      id: body.sessionId,
      sessionId: body.sessionId,
      taskId: expect.any(String),
    });
    expect(mocks.createSession).toHaveBeenCalledWith(
      env,
      PROJECT,
      null,
      'Unbound conversation',
      body.taskId,
      CALLER
    );
    expect((await taskRows())[0]).toMatchObject({
      id: body.taskId,
      projectId: PROJECT,
      userId: CALLER,
      workspaceId: null,
      chatSessionId: body.sessionId,
    });
  });

  it('ATTACK: rejects attachment after cleanup has claimed the workspace', async () => {
    await seedWorkspace({
      id: 'ws-stopping',
      projectId: PROJECT,
      userId: CALLER,
      status: 'stopping',
    });

    const response = await postSession(PROJECT, { workspaceId: 'ws-stopping' });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'NOT_FOUND' });
    expect(await taskRows()).toHaveLength(0);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('CONTROL: a project member can attach their own pending same-project workspace', async () => {
    await seedWorkspace({
      id: 'ws-caller',
      projectId: PROJECT,
      userId: CALLER,
      status: 'pending',
    });

    const response = await postSession(PROJECT, { workspaceId: '  ws-caller  ' });

    expect(response.status).toBe(201);
    const body = await response.json<{ sessionId: string; taskId: string }>();
    expect((await taskRows())[0]).toMatchObject({
      id: body.taskId,
      projectId: PROJECT,
      userId: CALLER,
      workspaceId: 'ws-caller',
      chatSessionId: body.sessionId,
    });
    expect(mocks.createSession).toHaveBeenCalledWith(
      env,
      PROJECT,
      'ws-caller',
      null,
      body.taskId,
      CALLER
    );
  });

  it('ATTACK: post-validation cleanup claim prevents ProjectData session attachment', async () => {
    await seedWorkspace({
      id: 'ws-claim-after-validation',
      projectId: PROJECT,
      userId: CALLER,
      status: 'running',
    });
    mocks.createSession.mockImplementationOnce(
      async (
        _env: Env,
        projectId: string,
        workspaceId: string | null,
        topic: string | null,
        taskId: string,
        createdByUserId: string
      ) => {
        const id = 'session-raced-claim';
        storeSession({ id, projectId, workspaceId, topic, taskId, createdByUserId });
        sqlite
          .prepare(`UPDATE workspaces SET status = 'stopping' WHERE id = ?`)
          .run('ws-claim-after-validation');
        return id;
      }
    );

    const response = await postSession(PROJECT, { workspaceId: 'ws-claim-after-validation' });

    expect(response.status).toBe(404);
    expect(mocks.stopSession).toHaveBeenCalledWith(env, PROJECT, 'session-raced-claim');
    const workspace = sqlite
      .prepare(`SELECT chat_session_id FROM workspaces WHERE id = ?`)
      .get('ws-claim-after-validation') as { chat_session_id: string | null };
    expect(workspace.chat_session_id).toBeNull();
    const [task] = await taskRows();
    expect(task).toMatchObject({
      status: 'cancelled',
      workspaceId: null,
      chatSessionId: null,
      errorMessage: 'Workspace attachment failed',
    });
  });
});

describe('POST /sessions/:sessionId/stop — destructive-use revalidation', () => {
  it('ATTACK: a stale foreign-user workspace link returns 404 and reaches no destructive boundary', async () => {
    await seedNode('node-victim', OTHER_USER);
    await seedWorkspace({
      id: 'ws-victim',
      projectId: PROJECT,
      userId: OTHER_USER,
      nodeId: 'node-victim',
      chatSessionId: 'victim-session',
    });
    await seedTask({
      id: 'task-attacker',
      projectId: PROJECT,
      userId: CALLER,
      sessionId: 'attacker-session',
      workspaceId: 'ws-victim',
    });
    storeSession({
      id: 'attacker-session',
      projectId: PROJECT,
      taskId: 'task-attacker',
      workspaceId: 'ws-victim',
      createdByUserId: CALLER,
    });

    const response = await stopSession(PROJECT, 'attacker-session');

    expect(response.status).toBe(404);
    expectNoDestructiveBoundaryCalls();
    const [task] = await taskRows();
    expect(task.status).toBe('in_progress');
  });

  it('ATTACK: a stale cross-project workspace link returns 404 and tears down nothing', async () => {
    await seedNode('node-other-project', CALLER);
    await seedWorkspace({
      id: 'ws-other-project',
      projectId: OTHER_PROJECT,
      userId: CALLER,
      nodeId: 'node-other-project',
      chatSessionId: 'other-project-session',
    });
    await seedTask({
      id: 'task-cross-project-link',
      projectId: PROJECT,
      userId: CALLER,
      sessionId: 'session-cross-project-link',
      workspaceId: 'ws-other-project',
    });
    storeSession({
      id: 'session-cross-project-link',
      projectId: PROJECT,
      taskId: 'task-cross-project-link',
      workspaceId: 'ws-other-project',
      createdByUserId: CALLER,
    });

    const response = await stopSession(PROJECT, 'session-cross-project-link');

    expect(response.status).toBe(404);
    expectNoDestructiveBoundaryCalls();
  });

  it('ATTACK: mismatched task/session workspace records return 404 before lifecycle mutation', async () => {
    await seedWorkspace({ id: 'ws-session', projectId: PROJECT, userId: CALLER });
    await seedWorkspace({ id: 'ws-task', projectId: PROJECT, userId: CALLER });
    await seedTask({
      id: 'task-mismatch',
      projectId: PROJECT,
      userId: CALLER,
      sessionId: 'session-mismatch',
      workspaceId: 'ws-task',
    });
    storeSession({
      id: 'session-mismatch',
      projectId: PROJECT,
      taskId: 'task-mismatch',
      workspaceId: 'ws-session',
      createdByUserId: CALLER,
    });

    const response = await stopSession(PROJECT, 'session-mismatch');

    expect(response.status).toBe(404);
    expectNoDestructiveBoundaryCalls();
    expect((await taskRows())[0].status).toBe('in_progress');
  });

  it('ATTACK: a stale workspace-to-session backlink returns 404 before lifecycle mutation', async () => {
    await seedWorkspace({
      id: 'ws-stale-backlink',
      projectId: PROJECT,
      userId: CALLER,
      chatSessionId: 'different-session',
    });
    await seedTask({
      id: 'task-stale-backlink',
      projectId: PROJECT,
      userId: CALLER,
      sessionId: 'session-stale-backlink',
      workspaceId: 'ws-stale-backlink',
    });
    storeSession({
      id: 'session-stale-backlink',
      projectId: PROJECT,
      taskId: 'task-stale-backlink',
      workspaceId: 'ws-stale-backlink',
      createdByUserId: CALLER,
    });

    const response = await stopSession(PROJECT, 'session-stale-backlink');

    expect(response.status).toBe(404);
    expectNoDestructiveBoundaryCalls();
    expect((await taskRows())[0].status).toBe('in_progress');
  });

  it('ATTACK: a globally colliding foreign-project task record cannot be repaired into this session', async () => {
    await seedTask({
      id: 'task-foreign-project',
      projectId: OTHER_PROJECT,
      userId: CALLER,
      sessionId: 'session-colliding-task',
      workspaceId: null,
    });
    storeSession({
      id: 'session-colliding-task',
      projectId: PROJECT,
      taskId: null,
      workspaceId: null,
      createdByUserId: CALLER,
    });

    const response = await stopSession(PROJECT, 'session-colliding-task');

    expect(response.status).toBe(404);
    expectNoDestructiveBoundaryCalls();
    expect(mocks.linkSessionToTask).not.toHaveBeenCalled();
    expect(await taskRows()).toHaveLength(1);
    expect((await taskRows())[0].status).toBe('in_progress');
  });

  it('ATTACK: taskless repair rejects a stale foreign-user workspace before any cross-store write', async () => {
    await seedWorkspace({ id: 'ws-foreign-repair', projectId: PROJECT, userId: OTHER_USER });
    storeSession({
      id: 'session-foreign-repair',
      projectId: PROJECT,
      taskId: null,
      workspaceId: 'ws-foreign-repair',
      createdByUserId: CALLER,
    });

    const response = await stopSession(PROJECT, 'session-foreign-repair');

    expect(response.status).toBe(404);
    expectNoDestructiveBoundaryCalls();
    expect(mocks.linkSessionToTask).not.toHaveBeenCalled();
    expect(await taskRows()).toHaveLength(0);
  });

  it('CONTROL: same-project caller-owned cleanup preserves normal archive semantics', async () => {
    await seedNode('node-caller', CALLER);
    await seedWorkspace({
      id: 'ws-caller-active',
      projectId: PROJECT,
      userId: CALLER,
      nodeId: 'node-caller',
      chatSessionId: 'session-valid',
    });
    await seedTask({
      id: 'task-valid',
      projectId: PROJECT,
      userId: CALLER,
      sessionId: 'session-valid',
      workspaceId: 'ws-caller-active',
    });
    storeSession({
      id: 'session-valid',
      projectId: PROJECT,
      taskId: 'task-valid',
      workspaceId: 'ws-caller-active',
      createdByUserId: CALLER,
    });

    const response = await stopSession(PROJECT, 'session-valid');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'stopped', workspaceDeleted: true });
    expect(mocks.stopNodeResources).toHaveBeenCalledWith('node-caller', CALLER, env, {
      exclusiveWorkspaceId: 'ws-caller-active',
    });
    expect(mocks.stopSession).toHaveBeenCalledWith(env, PROJECT, 'session-valid');
    expect((await taskRows())[0].status).toBe('cancelled');
  });

  it('CONTROL: a session creator can archive their workspace for a shared task created by another member', async () => {
    await seedNode('node-shared-runner', CALLER);
    await seedWorkspace({
      id: 'ws-shared-runner',
      projectId: PROJECT,
      userId: CALLER,
      nodeId: 'node-shared-runner',
      chatSessionId: 'session-shared-runner',
    });
    await seedTask({
      id: 'task-created-by-member',
      projectId: PROJECT,
      userId: OTHER_USER,
      sessionId: 'session-shared-runner',
      workspaceId: 'ws-shared-runner',
      taskMode: 'task',
    });
    storeSession({
      id: 'session-shared-runner',
      projectId: PROJECT,
      taskId: 'task-created-by-member',
      workspaceId: 'ws-shared-runner',
      createdByUserId: CALLER,
    });

    const response = await stopSession(PROJECT, 'session-shared-runner');

    expect(response.status).toBe(200);
    expect(mocks.stopNodeResources).toHaveBeenCalledWith('node-shared-runner', CALLER, env, {
      exclusiveWorkspaceId: 'ws-shared-runner',
    });
  });

  it('CONTROL: an unbound session remains archivable', async () => {
    await seedTask({
      id: 'task-unbound',
      projectId: PROJECT,
      userId: CALLER,
      sessionId: 'session-unbound',
      workspaceId: null,
    });
    storeSession({
      id: 'session-unbound',
      projectId: PROJECT,
      taskId: 'task-unbound',
      workspaceId: null,
      createdByUserId: CALLER,
    });

    const response = await stopSession(PROJECT, 'session-unbound');

    expect(response.status).toBe(200);
    expect(mocks.stopSession).toHaveBeenCalledWith(env, PROJECT, 'session-unbound');
    expect(mocks.stopNodeResources).not.toHaveBeenCalled();
  });
});

describe('terminal cleanup service — internal defence in depth', () => {
  it('ATTACK: caller-scoped runtime cleanup cannot cross the authenticated project', async () => {
    await seedNode('node-project-scope', CALLER);
    await seedWorkspace({
      id: 'ws-project-scope',
      projectId: PROJECT,
      userId: CALLER,
      nodeId: 'node-project-scope',
    });
    await seedTask({
      id: 'task-project-scope',
      projectId: PROJECT,
      userId: CALLER,
      sessionId: 'session-project-scope',
      workspaceId: 'ws-project-scope',
    });

    await cleanupTaskRun('task-project-scope', env, undefined, CALLER, OTHER_PROJECT);

    expectNoDestructiveBoundaryCalls();
  });

  it('ATTACK: an internally completed task cannot follow a stale cross-project workspace link', async () => {
    await seedNode('node-stale-cross-project', CALLER);
    await seedWorkspace({
      id: 'ws-stale-cross-project',
      projectId: OTHER_PROJECT,
      userId: CALLER,
      nodeId: 'node-stale-cross-project',
      chatSessionId: 'session-stale-cross-project',
    });
    await seedTask({
      id: 'task-stale-cross-project',
      projectId: PROJECT,
      userId: CALLER,
      sessionId: 'session-task-project',
      workspaceId: 'ws-stale-cross-project',
    });

    await cleanupTerminalTaskResources(env, 'task-stale-cross-project', {
      status: 'completed',
    });

    expectNoDestructiveBoundaryCalls();
  });

  it('ATTACK: internal cleanup rejects a same-project workspace backlink to a different session', async () => {
    await seedNode('node-internal-backlink', CALLER);
    await seedWorkspace({
      id: 'ws-internal-backlink',
      projectId: PROJECT,
      userId: CALLER,
      nodeId: 'node-internal-backlink',
      chatSessionId: 'session-other-backlink',
    });
    await seedTask({
      id: 'task-internal-backlink',
      projectId: PROJECT,
      userId: CALLER,
      sessionId: 'session-task-backlink',
      workspaceId: 'ws-internal-backlink',
    });

    await cleanupTerminalTaskResources(env, 'task-internal-backlink', {
      status: 'completed',
    });

    expectNoDestructiveBoundaryCalls();
  });

  it('CONTROL: trusted internal completion still cleans a consistent same-project workspace', async () => {
    await seedNode('node-internal-valid', OTHER_USER);
    await seedWorkspace({
      id: 'ws-internal-valid',
      projectId: PROJECT,
      userId: OTHER_USER,
      nodeId: 'node-internal-valid',
      chatSessionId: 'session-internal-valid',
    });
    await seedTask({
      id: 'task-internal-valid',
      projectId: PROJECT,
      userId: CALLER,
      sessionId: 'session-internal-valid',
      workspaceId: 'ws-internal-valid',
      taskMode: 'task',
    });

    await cleanupTerminalTaskResources(env, 'task-internal-valid', {
      status: 'completed',
    });

    expect(mocks.stopSession).toHaveBeenCalledWith(env, PROJECT, 'session-internal-valid');
    expect(mocks.stopNodeResources).toHaveBeenCalledWith('node-internal-valid', OTHER_USER, env, {
      exclusiveWorkspaceId: 'ws-internal-valid',
    });
  });

  it('ATTACK: internal completion rejects a modern chat task when the workspace backlink is null', async () => {
    await seedNode('node-internal-null-backlink', CALLER);
    await seedWorkspace({
      id: 'ws-internal-null-backlink',
      projectId: PROJECT,
      userId: CALLER,
      nodeId: 'node-internal-null-backlink',
      chatSessionId: null,
    });
    await seedTask({
      id: 'task-internal-null-backlink',
      projectId: PROJECT,
      userId: CALLER,
      sessionId: 'session-internal-null-backlink',
      workspaceId: 'ws-internal-null-backlink',
    });

    await cleanupTerminalTaskResources(env, 'task-internal-null-backlink', {
      status: 'completed',
    });

    expectNoDestructiveBoundaryCalls();
  });

  it('CONTROL: a legacy task without a session backlink still cleans its authorized workspace compute', async () => {
    await seedNode('node-legacy-task-backlink', CALLER);
    await seedWorkspace({
      id: 'ws-legacy-task-backlink',
      projectId: PROJECT,
      userId: CALLER,
      nodeId: 'node-legacy-task-backlink',
      chatSessionId: 'workspace-session-not-owned-by-task',
    });
    await seedTask({
      id: 'task-legacy-task-backlink',
      projectId: PROJECT,
      userId: CALLER,
      sessionId: null,
      workspaceId: 'ws-legacy-task-backlink',
    });

    await cleanupTerminalTaskResources(env, 'task-legacy-task-backlink', {
      status: 'completed',
    });

    expect(mocks.stopSession).not.toHaveBeenCalled();
    expect(mocks.stopNodeResources).toHaveBeenCalledWith('node-legacy-task-backlink', CALLER, env, {
      exclusiveWorkspaceId: 'ws-legacy-task-backlink',
    });
  });

  it('ATTACK: active linked task blocks cleanup before any destructive boundary call', async () => {
    await seedNode('node-active-linked', CALLER);
    await seedWorkspace({
      id: 'ws-active-linked',
      projectId: PROJECT,
      userId: CALLER,
      nodeId: 'node-active-linked',
      chatSessionId: 'session-active-linked',
    });
    await seedTask({
      id: 'task-terminal-active-linked',
      projectId: PROJECT,
      userId: CALLER,
      sessionId: 'session-active-linked',
      workspaceId: 'ws-active-linked',
      status: 'completed',
    });
    await seedTask({
      id: 'task-active-linked',
      projectId: PROJECT,
      userId: CALLER,
      sessionId: 'session-active-linked',
      workspaceId: 'ws-active-linked',
      status: 'queued',
    });

    await cleanupTaskRun('task-terminal-active-linked', env);

    expectNoDestructiveBoundaryCalls();
    const workspace = sqlite
      .prepare(`SELECT status FROM workspaces WHERE id = ?`)
      .get('ws-active-linked') as { status: string };
    expect(workspace.status).toBe('running');
  });

  it('ATTACK: post-claim sibling insertion blocks whole cf-container deletion', async () => {
    await seedNode('node-sibling-race', CALLER);
    await seedWorkspace({
      id: 'ws-sibling-race',
      projectId: PROJECT,
      userId: CALLER,
      nodeId: 'node-sibling-race',
      chatSessionId: 'session-sibling-race',
    });
    await seedTask({
      id: 'task-sibling-race',
      projectId: PROJECT,
      userId: CALLER,
      sessionId: 'session-sibling-race',
      workspaceId: 'ws-sibling-race',
      status: 'completed',
    });
    sqlite.exec(`
      CREATE TRIGGER insert_sibling_after_cleanup_claim
      AFTER UPDATE OF status ON workspaces
      WHEN NEW.id = 'ws-sibling-race' AND NEW.status = 'stopping'
      BEGIN
        INSERT INTO workspaces (id, project_id, user_id, node_id, name, repository, vm_size, vm_location, status)
        VALUES ('ws-post-claim-sibling', '${PROJECT}', '${CALLER}', 'node-sibling-race', 'sibling', 'org/repo', 'small', 'nbg1', 'running');
      END;
    `);

    await cleanupTaskRun('task-sibling-race', env);

    expect(mocks.stopNodeResources).not.toHaveBeenCalled();
    const workspace = sqlite
      .prepare(`SELECT status FROM workspaces WHERE id = ?`)
      .get('ws-sibling-race') as { status: string };
    expect(workspace.status).toBe('running');
  });

  it('ATTACK: failed VM workspace stop restores the claimed workspace status', async () => {
    await seedNode('node-vm-failure', CALLER, 'vm');
    await seedWorkspace({
      id: 'ws-vm-failure',
      projectId: PROJECT,
      userId: CALLER,
      nodeId: 'node-vm-failure',
      chatSessionId: 'session-vm-failure',
    });
    await seedTask({
      id: 'task-vm-failure',
      projectId: PROJECT,
      userId: CALLER,
      sessionId: 'session-vm-failure',
      workspaceId: 'ws-vm-failure',
      status: 'completed',
    });
    mocks.stopWorkspaceOnNode.mockRejectedValueOnce(new Error('node unreachable'));

    await cleanupTaskRun('task-vm-failure', env);

    expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledWith(
      'node-vm-failure',
      'ws-vm-failure',
      env,
      CALLER
    );
    expect(mocks.markIdle).not.toHaveBeenCalled();
    const workspace = sqlite
      .prepare(`SELECT status, error_message FROM workspaces WHERE id = ?`)
      .get('ws-vm-failure') as { status: string; error_message: string | null };
    expect(workspace.status).toBe('running');
    expect(workspace.error_message).toBe('node unreachable');
  });
});

describe('SAM stop_subtask — workspace runtime boundary authorization', () => {
  async function seedStopSubtaskFixture(input: {
    suffix: string;
    workspaceUserId: string;
  }): Promise<{ projectId: string; taskId: string; workspaceId: string; nodeId: string }> {
    const projectId = `project-stop-tool-${input.suffix}`;
    const taskId = `task-stop-tool-${input.suffix}`;
    const workspaceId = `ws-stop-tool-${input.suffix}`;
    const nodeId = `node-stop-tool-${input.suffix}`;
    const sessionId = `session-stop-tool-${input.suffix}`;
    await seedProject(projectId, CALLER);
    await seedNode(nodeId, input.workspaceUserId);
    await seedWorkspace({
      id: workspaceId,
      projectId,
      userId: input.workspaceUserId,
      nodeId,
      chatSessionId: sessionId,
    });
    await seedTask({
      id: taskId,
      projectId,
      userId: CALLER,
      sessionId,
      workspaceId,
      status: 'running',
    });
    await db()
      .insert(schema.agentSessions)
      .values({
        id: `agent-stop-tool-${input.suffix}`,
        workspaceId,
        userId: input.workspaceUserId,
        status: 'running',
      } as typeof schema.agentSessions.$inferInsert);
    return { projectId, taskId, workspaceId, nodeId };
  }

  it('ATTACK: does not stop an agent session or runtime through another user workspace', async () => {
    const fixture = await seedStopSubtaskFixture({
      suffix: 'foreign-owner',
      workspaceUserId: OTHER_USER,
    });

    const result = await stopSubtask({ taskId: fixture.taskId }, { env, userId: CALLER } as never);

    expect(result).toMatchObject({ stopped: true, taskId: fixture.taskId });
    expect(mocks.stopAgentSessionOnNode).not.toHaveBeenCalled();
    expectNoDestructiveBoundaryCalls();
  });

  it('CONTROL: stops the caller-owned same-project agent session and runtime', async () => {
    const fixture = await seedStopSubtaskFixture({
      suffix: 'owner',
      workspaceUserId: CALLER,
    });

    const result = await stopSubtask({ taskId: fixture.taskId }, { env, userId: CALLER } as never);

    expect(result).toMatchObject({ stopped: true, taskId: fixture.taskId });
    expect(mocks.stopAgentSessionOnNode).toHaveBeenCalledWith(
      fixture.nodeId,
      fixture.workspaceId,
      'agent-stop-tool-owner',
      env,
      CALLER
    );
    expect(mocks.stopNodeResources).toHaveBeenCalledWith(fixture.nodeId, CALLER, env, {
      exclusiveWorkspaceId: fixture.workspaceId,
    });
  });
});
