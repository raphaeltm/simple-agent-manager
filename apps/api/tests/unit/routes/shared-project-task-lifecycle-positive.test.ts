/**
 * Positive-path + write-predicate tests for shared-project task lifecycle authorization (PR #1740).
 *
 * The IDOR suite (`shared-project-task-authorization.test.ts`) proves the negative half: a caller
 * cannot reach across projects. This suite proves the half the PR actually exists to deliver — a
 * project member who did NOT create a task can still drive its lifecycle — and that the rule-11
 * `project_id` write predicates are real rather than decorative.
 *
 * These run against a REAL in-memory SQLite engine, so route UPDATE/SELECT predicates are executed
 * by a SQL engine and assertions read back actual persisted rows. The prior suite's `buildDb` mock
 * returns canned rows and ignores `.where()` arguments, which is why the security-auditor (HIGH-1)
 * and test-engineer (CRITICAL) reviews rated its write-scoping coverage non-discriminating.
 */
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const CREATOR = 'user-creator';
const MEMBER = 'user-member';
const PROJECT = 'project-shared';

const mocks = vi.hoisted(() => ({
  requireProjectCapability: vi.fn(),
  requireOwnedWorkspace: vi.fn(),
  cleanupTaskRun: vi.fn(),
  cleanupTerminalTaskResourcesOrThrow: vi.fn(),
  recordActivityEvent: vi.fn(),
  startTaskRunnerDO: vi.fn(),
  requireRepositoryUserAccess: vi.fn(),
  createSession: vi.fn(),
  cleanupWorkspaceForDeletion: vi.fn(),
  recordTaskLifecycleEventBestEffort: vi.fn(async () => undefined),
}));

// The caller is MEMBER: a project member with task:write who did NOT create the task.
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getAuth: () => ({ user: { id: MEMBER, name: 'Member', email: 'member@test.com' } }),
  getUserId: () => MEMBER,
}));
vi.mock('../../../src/middleware/project-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/middleware/project-auth')>()),
  requireProjectCapability: mocks.requireProjectCapability,
  requireOwnedWorkspace: mocks.requireOwnedWorkspace,
}));
vi.mock('../../../src/services/task-runner', () => ({ cleanupTaskRun: mocks.cleanupTaskRun }));
vi.mock('../../../src/services/task-terminal-cleanup', () => ({
  cleanupTerminalTaskResourcesOrThrow: mocks.cleanupTerminalTaskResourcesOrThrow,
}));
vi.mock('../../../src/services/project-data', () => ({
  recordActivityEvent: mocks.recordActivityEvent,
  createSession: mocks.createSession,
  stopSession: vi.fn(),
  failSession: vi.fn(),
}));
vi.mock('../../../src/services/project-lifecycle-events', () => ({
  isLifecycleTaskStatus: (status: string) =>
    ['in_progress', 'completed', 'failed', 'cancelled'].includes(status),
  recordTaskLifecycleEventBestEffort: mocks.recordTaskLifecycleEventBestEffort,
}));
vi.mock('../../../src/services/task-runner-do', () => ({
  startTaskRunnerDO: mocks.startTaskRunnerDO,
}));
vi.mock('../../../src/services/workspace-cleanup', () => ({
  cleanupWorkspaceForDeletion: (...args: unknown[]) => mocks.cleanupWorkspaceForDeletion(...args),
}));
vi.mock('../../../src/services/workspace-deletion-callback-signal', () => ({
  signalWorkspaceDeletionUnconfirmedCallback: vi.fn(async () => undefined),
}));
vi.mock('../../../src/routes/projects/_helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/routes/projects/_helpers')>()),
  requireRepositoryUserAccess: mocks.requireRepositoryUserAccess,
}));

import {
  setTaskStatus,
  updateTaskExecutionStepFromCallback,
} from '../../../src/routes/tasks/_helpers';
import { crudRoutes } from '../../../src/routes/tasks/crud';
import { runRoutes } from '../../../src/routes/tasks/run';

let sqlite: Database.Database;
let env: Env;

function db() {
  return drizzle(env.DATABASE, { schema });
}

function makeApp(routes: Hono<{ Bindings: Env }>) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) =>
    err instanceof AppError
      ? c.json(err.toJSON(), err.statusCode as never)
      : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500)
  );
  app.route('/api/projects/:projectId/tasks', routes);
  return app;
}

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

async function seedTask(overrides: Partial<typeof schema.tasks.$inferInsert> = {}) {
  await db()
    .insert(schema.tasks)
    .values({
      id: 'task-1',
      projectId: PROJECT,
      userId: CREATOR,
      title: 'Task created by another member',
      status: 'in_progress',
      taskMode: 'task',
      updatedAt: '2026-10-07T10:00:00.000Z',
      ...overrides,
    } as typeof schema.tasks.$inferInsert);
}

async function readTask(id = 'task-1') {
  const [row] = await db().select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireProjectCapability.mockResolvedValue({ id: PROJECT, userId: CREATOR });
  mocks.cleanupTaskRun.mockResolvedValue(undefined);
  mocks.cleanupTerminalTaskResourcesOrThrow.mockResolvedValue(undefined);
  mocks.recordActivityEvent.mockResolvedValue(undefined);
  mocks.startTaskRunnerDO.mockResolvedValue(undefined);
  mocks.requireRepositoryUserAccess.mockResolvedValue(undefined);
  mocks.createSession.mockResolvedValue('session-1');
  mocks.cleanupWorkspaceForDeletion.mockResolvedValue({ status: 'confirmed' });

  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'sammy.party' } as unknown as Env;
});

afterEach(() => sqlite.close());

describe('shared-project task lifecycle — positive paths for a non-creator member', () => {
  it('POST /:taskId/run: a member can run another member task, under their OWN identity', async () => {
    // This is the route the PR exists to widen, and the most consequential one — it provisions
    // real infrastructure. The compute must be attributed to the caller (MEMBER), never the task
    // creator, because everything downstream (credentials, repo access, node ownership, and the
    // cleanup identity in cleanupTaskRun) keys off whoever actually ran it.
    await db()
      .insert(schema.projects)
      .values({
        id: PROJECT,
        userId: CREATOR,
        name: 'Shared project',
        repository: 'org/repo',
        installationId: 'inst-1',
        defaultBranch: 'main',
      } as typeof schema.projects.$inferInsert);
    // The cloud-provider credential gate is caller-scoped (`credentials.userId = caller`), so the
    // MEMBER running the task must have their own — the task creator's would not do.
    await db()
      .insert(schema.credentials)
      .values({
        id: 'cred-member',
        userId: MEMBER,
        credentialType: 'cloud-provider',
        provider: 'hetzner',
        name: 'member hetzner',
      } as typeof schema.credentials.$inferInsert);
    await seedTask({ status: 'ready' });

    const response = await makeApp(runRoutes).fetch(
      new Request(`https://api.test/api/projects/${PROJECT}/tasks/task-1/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      env,
      mockCtx
    );

    expect(response.status).toBe(202);
    expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        taskId: 'task-1',
        projectId: PROJECT,
        userId: MEMBER,
        cloudProvider: 'hetzner',
        credentialAttributionUserId: MEMBER,
        credentialAttributionProjectId: null,
        credentialAttributionSource: 'user',
        vmSizeSource: 'platform',
      })
    );
    const updatedTask = await readTask();
    expect(updatedTask?.credentialAttributionUserId).toBe(MEMBER);
    expect(updatedTask?.credentialAttributionProjectId).toBeNull();
    expect(updatedTask?.credentialAttributionSource).toBe('user');
    expect(updatedTask?.requestedVmSizeSource).toBe('platform');
    expect(updatedTask?.resourceRequirementsSource).toBe('platform');
    expect(updatedTask?.resolvedReservationJson).toContain('"source":"platform"');
    // Repo access is re-verified for the CALLER, not the task creator.
    expect(mocks.requireRepositoryUserAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      MEMBER
    );
    expect(mocks.startTaskRunnerDO).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: CREATOR })
    );
  });

  it.each(['in_progress', 'sleeping'])('POST /:taskId/status: a member can cancel another member %s task', async (status) => {
    await seedTask({ status });

    const response = await makeApp(crudRoutes).fetch(
      new Request(`https://api.test/api/projects/${PROJECT}/tasks/task-1/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toStatus: 'cancelled' }),
      }),
      env,
      mockCtx
    );

    expect(response.status).toBe(200);
    // The widening is the point of the PR: a non-creator member drives the lifecycle...
    expect((await readTask())?.status).toBe('cancelled');
    // ...but compute teardown stays scoped to the caller, never the task creator.
    expect(mocks.cleanupTerminalTaskResourcesOrThrow).toHaveBeenCalledWith(
      env,
      'task-1',
      expect.objectContaining({ status: 'cancelled', requiredUserId: MEMBER, projectId: PROJECT })
    );
  });

  it.each(['queued', 'sleeping'])('DELETE /:taskId: cleanup precedes deleting a %s task row', async (status) => {
    await seedTask({ status, errorMessage: 'waiting for capacity' });
    mocks.cleanupTerminalTaskResourcesOrThrow.mockImplementationOnce(async () => {
      expect((await readTask())?.id).toBe('task-1');
    });

    const response = await makeApp(crudRoutes).fetch(
      new Request(`https://api.test/api/projects/${PROJECT}/tasks/task-1`, {
        method: 'DELETE',
      }),
      env,
      mockCtx
    );

    expect(response.status).toBe(200);
    expect(await readTask()).toBeUndefined();
    expect(mocks.cleanupTerminalTaskResourcesOrThrow).toHaveBeenCalledWith(
      env,
      'task-1',
      expect.objectContaining({
        status: 'cancelled',
        errorMessage: 'waiting for capacity',
        requiredUserId: MEMBER,
        projectId: PROJECT,
        destructiveSessionEnd: true,
      })
    );
  });

  it('POST /:taskId/status: same-status in_progress replay does not emit lifecycle noise', async () => {
    await seedTask({ status: 'in_progress' });

    const response = await makeApp(crudRoutes).fetch(
      new Request(`https://api.test/api/projects/${PROJECT}/tasks/task-1/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toStatus: 'in_progress' }),
      }),
      env,
      mockCtx
    );

    expect(response.status).toBe(200);
    expect((await readTask())?.status).toBe('in_progress');
    expect(mocks.recordTaskLifecycleEventBestEffort).not.toHaveBeenCalled();
  });

  it('POST /:taskId/run/cleanup: a member can clean up another member terminal task', async () => {
    await seedTask({ status: 'completed', workspaceId: 'ws-creator' });

    const response = await makeApp(runRoutes).fetch(
      new Request(`https://api.test/api/projects/${PROJECT}/tasks/task-1/run/cleanup`, {
        method: 'POST',
      }),
      env,
      mockCtx
    );

    expect(response.status).toBe(200);
    expect(mocks.cleanupTaskRun).toHaveBeenCalledWith('task-1', env, undefined, MEMBER);
  });

  it('POST /:taskId/run/cleanup: a failed run goes through preservation-first cleanup', async () => {
    // Explicit cleanup of a failed run must not destroy work SAM would otherwise
    // snapshot: it takes the same terminal cleanup as the automatic failure paths,
    // which consults failed-task preservation. The completed-run case above is the
    // control that keeps the direct teardown.
    await seedTask({ status: 'failed', workspaceId: 'ws-creator', errorMessage: 'Prompt failed' });

    const response = await makeApp(runRoutes).fetch(
      new Request(`https://api.test/api/projects/${PROJECT}/tasks/task-1/run/cleanup`, {
        method: 'POST',
      }),
      env,
      mockCtx
    );

    expect(response.status).toBe(200);
    expect(mocks.cleanupTerminalTaskResourcesOrThrow).toHaveBeenCalledWith(env, 'task-1', {
      status: 'failed',
      requiredUserId: MEMBER,
      projectId: PROJECT,
      failureLogEvent: 'task.run_cleanup.failed',
      logContext: { projectId: PROJECT, source: 'tasks.run_cleanup' },
    });
    expect(mocks.cleanupTaskRun).not.toHaveBeenCalled();
  });

  it('POST /:taskId/status: failing a task hands it to non-destructive terminal cleanup', async () => {
    await seedTask({ status: 'in_progress' });

    const response = await makeApp(crudRoutes).fetch(
      new Request(`https://api.test/api/projects/${PROJECT}/tasks/task-1/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toStatus: 'failed', errorMessage: 'Abandoned by the user' }),
      }),
      env,
      mockCtx
    );

    expect(response.status).toBe(200);
    expect(await readTask()).toMatchObject({
      status: 'failed',
      errorMessage: 'Abandoned by the user',
    });
    const [, , options] = mocks.cleanupTerminalTaskResourcesOrThrow.mock.calls[0] ?? [];
    expect(options).toMatchObject({
      status: 'failed',
      errorMessage: 'Abandoned by the user',
      requiredUserId: MEMBER,
      projectId: PROJECT,
    });
    // No destructive intent: preservation decides whether the runtime is kept.
    expect(options).not.toHaveProperty('destructiveSessionEnd');
  });

  it('POST /:taskId/delegate: a member can delegate another member ready task to their own workspace', async () => {
    await seedTask({ status: 'ready' });
    mocks.requireOwnedWorkspace.mockResolvedValue({
      id: 'ws-member',
      userId: MEMBER,
      projectId: PROJECT,
      status: 'running',
    });

    const response = await makeApp(crudRoutes).fetch(
      new Request(`https://api.test/api/projects/${PROJECT}/tasks/task-1/delegate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws-member' }),
      }),
      env,
      mockCtx
    );

    expect(response.status).toBe(200);
    const task = await readTask();
    expect(task?.status).toBe('delegated');
    expect(task?.workspaceId).toBe('ws-member');
  });

  it('POST /:taskId/close: a member can close another member conversation task', async () => {
    await seedTask({ status: 'in_progress', taskMode: 'conversation' });

    const response = await makeApp(crudRoutes).fetch(
      new Request(`https://api.test/api/projects/${PROJECT}/tasks/task-1/close`, {
        method: 'POST',
      }),
      env,
      mockCtx
    );

    expect(response.status).toBe(200);
    expect((await readTask())?.status).toBe('completed');
  });
});

describe('POST /:taskId/close — workspace teardown stays caller-scoped (real SQLite)', () => {
  async function seedSleepingConversation(owner = MEMBER) {
    await seedConversationWithWorkspace(owner);
    await db().update(schema.tasks).set({ status: 'sleeping' }).where(eq(schema.tasks.id, 'task-1'));
    await db().update(schema.workspaces).set({ status: 'sleeping', chatSessionId: 'session-1' })
      .where(eq(schema.workspaces.id, 'ws-conv'));
  }

  it('archives a sleeping VM conversation and awaits its owned cleanup', async () => {
    await seedSleepingConversation();
    mocks.cleanupWorkspaceForDeletion.mockImplementationOnce(async () => {
      expect((await readTask())?.status).toBe('completed');
      await db().delete(schema.workspaces).where(eq(schema.workspaces.id, 'ws-conv'));
      return { status: 'confirmed' };
    });
    expect((await close()).status).toBe(200);
    expect((await readTask())?.completedAt).toBeTruthy();
    expect(sqlite.prepare('SELECT COUNT(*) FROM workspaces').pluck().get()).toBe(0);
    expect(sqlite.prepare('SELECT from_status, to_status FROM task_status_events').get())
      .toMatchObject({ from_status: 'sleeping', to_status: 'completed' });
    expect(mocks.cleanupWorkspaceForDeletion).toHaveBeenCalledWith(expect.objectContaining({
      userId: MEMBER, workspace: expect.objectContaining({ id: 'ws-conv', status: 'sleeping' }),
    }));
  });

  it('executes real owned snapshot/workspace cleanup after proven VM teardown', async () => {
    await seedSleepingConversation();
    await db().insert(schema.nodes).values({
      id: 'node-conv', userId: MEMBER, name: 'sleeping VM node', runtime: 'vm',
      runtimeTerminationConfirmedAt: '2026-10-07T10:00:00.000Z',
    } as typeof schema.nodes.$inferInsert);
    for (const [id, session, owner] of [['owned-snapshot', 'session-1', MEMBER], ['other-snapshot', 'session-other', MEMBER]]) {
      await db().insert(schema.sessionSnapshots).values({
        id, chatSessionId: session, userId: owner, projectId: PROJECT,
        workspaceId: 'ws-conv', runtime: 'vm',
        sleepingAt: '2026-10-07T10:00:00.000Z', recoveryAttemptId: `${id}-attempt`,
        status: 'available', homeR2Key: `${id}/home`, wipR2Key: `${id}/wip`,
        manifestR2Key: `${id}/manifest`, expiresAt: '2026-10-14T10:00:00.000Z',
      });
    }
    const deleteObjects = vi.fn(async () => undefined);
    env.R2 = { delete: deleteObjects, list: vi.fn(async () => ({ objects: [], truncated: false })) } as unknown as R2Bucket;
    env.NODE_LIFECYCLE = {
      idFromName: vi.fn((id: string) => id), get: vi.fn(() => ({
        claimWorkspaceDeletionAttempt: vi.fn(async () => 'claimed'),
        confirmWorkspaceDeletion: vi.fn(async () => undefined),
      })),
    } as unknown as Env['NODE_LIFECYCLE'];
    const actual = await vi.importActual<typeof import('../../../src/services/workspace-cleanup')>(
      '../../../src/services/workspace-cleanup'
    );
    mocks.cleanupWorkspaceForDeletion.mockImplementation(actual.cleanupWorkspaceForDeletion);
    expect((await close()).status).toBe(200);
    expect(sqlite.prepare("SELECT COUNT(*) FROM workspaces WHERE id = 'ws-conv'").pluck().get()).toBe(0);
    expect(sqlite.prepare('SELECT id, sleeping_at, recovery_attempt_id FROM session_snapshots').all())
      .toEqual([{ id: 'other-snapshot', sleeping_at: '2026-10-07T10:00:00.000Z', recovery_attempt_id: 'other-snapshot-attempt' }]);
    expect(deleteObjects).toHaveBeenCalledWith(['owned-snapshot/home', 'owned-snapshot/wip', 'owned-snapshot/manifest']);
    expect((await close()).status).toBe(200);
    expect(deleteObjects).toHaveBeenCalledTimes(1);
  });

  it.each(['retry', 'fenced', 'superseded'])('reports cleanup %s without repeating completion on retry', async (status) => {
    await seedSleepingConversation();
    mocks.cleanupWorkspaceForDeletion.mockResolvedValueOnce({ status, reason: 'workspace_assignment_changed' });
    expect((await close()).status).toBe(409);
    expect((await readTask())?.status).toBe('completed');
    expect(sqlite.prepare('SELECT COUNT(*) FROM workspaces').pluck().get()).toBe(1);
    expect((await close()).status).toBe(200);
    expect(sqlite.prepare('SELECT COUNT(*) FROM task_status_events').pluck().get()).toBe(1);
  });

  it('retries failed archive cleanup without duplicate status or activity events', async () => {
    await seedSleepingConversation();
    mocks.cleanupWorkspaceForDeletion.mockRejectedValueOnce(new Error('cleanup unavailable'));
    expect((await close()).status).toBe(500);
    const completedAt = (await readTask())?.completedAt;
    expect((await close()).status).toBe(200);
    expect((await readTask())?.completedAt).toBe(completedAt);
    expect(mocks.cleanupWorkspaceForDeletion).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare('SELECT COUNT(*) FROM task_status_events').pluck().get()).toBe(1);
    expect(mocks.recordActivityEvent).toHaveBeenCalledTimes(1);
  });

  it('repeated archive after workspace removal is idempotent', async () => {
    await seedSleepingConversation();
    expect((await close()).status).toBe(200);
    await db().delete(schema.workspaces).where(eq(schema.workspaces.id, 'ws-conv'));
    expect((await close()).status).toBe(200);
    expect(mocks.cleanupWorkspaceForDeletion).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare('SELECT COUNT(*) FROM task_status_events').pluck().get()).toBe(1);
  });

  it('does not destroy another member sleeping workspace', async () => {
    await seedSleepingConversation(CREATOR);
    expect((await close()).status).toBe(200);
    expect(mocks.cleanupWorkspaceForDeletion).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT status FROM workspaces').pluck().get()).toBe('sleeping');
  });

  it.each(['status', 'workspace', 'revision'])('fences a concurrent wake %s change before archive', async (change) => {
    await seedSleepingConversation();
    const prepare = env.DATABASE.prepare.bind(env.DATABASE);
    let raced = false;
    vi.spyOn(env.DATABASE, 'prepare').mockImplementation((query: string) => {
      if (!raced && query.startsWith('update "tasks"')) {
        raced = true;
        if (change === 'status') sqlite.prepare("UPDATE tasks SET status = 'queued'").run();
        if (change === 'workspace') sqlite.prepare("UPDATE tasks SET workspace_id = 'ws-new'").run();
        if (change === 'revision') sqlite.prepare("UPDATE tasks SET updated_at = '2026-10-07T10:01:00.000Z'").run();
      }
      return prepare(query);
    });
    expect((await close()).status).toBe(409);
    expect((await readTask())?.status).not.toBe('completed');
    expect(mocks.cleanupWorkspaceForDeletion).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) FROM task_status_events').pluck().get()).toBe(0);
  });

  it('rejects sleeping task-mode completion via the conversation endpoint', async () => {
    await seedTask({ status: 'sleeping', taskMode: 'task' });
    expect((await close()).status).toBe(400);
    expect((await readTask())?.status).toBe('sleeping');
  });

  /** Seed a conversation task whose workspace belongs to `owner`. */
  async function seedConversationWithWorkspace(owner: string) {
    await db()
      .insert(schema.workspaces)
      .values({
        id: 'ws-conv',
        projectId: PROJECT,
        userId: owner,
        nodeId: 'node-conv',
        name: 'conv-ws',
        repository: 'org/repo',
        vmSize: 'small',
        vmLocation: 'nbg1',
        status: 'running',
      } as typeof schema.workspaces.$inferInsert);
    await seedTask({ status: 'in_progress', taskMode: 'conversation', workspaceId: 'ws-conv' });
  }

  async function close() {
    return makeApp(crudRoutes).fetch(
      new Request(`https://api.test/api/projects/${PROJECT}/tasks/task-1/close`, {
        method: 'POST',
      }),
      env,
      mockCtx
    );
  }

  it('ATTACK: closing a task whose workspace belongs to another member tears down nothing', async () => {
    await seedConversationWithWorkspace(CREATOR); // caller is MEMBER

    const response = await close();

    // The lifecycle transition is project-authorized and still succeeds...
    expect(response.status).toBe(200);
    expect((await readTask())?.status).toBe('completed');
    // ...but the other member's compute must not be touched.
    expect(mocks.cleanupWorkspaceForDeletion).not.toHaveBeenCalled();
  });

  it('CONTROL: closing a task whose workspace the caller owns DOES tear it down', async () => {
    await seedConversationWithWorkspace(MEMBER);

    const response = await close();

    expect(response.status).toBe(200);
    expect(mocks.cleanupWorkspaceForDeletion).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: expect.objectContaining({ id: 'ws-conv' }),
        userId: MEMBER,
      })
    );
  });
});

describe('task write predicates are project-scoped (rule 11 defence in depth)', () => {
  it('setTaskStatus does not mutate a row when the caller resolved the wrong project', async () => {
    // Simulates the failure rule 11 guards against: an ORM bug, refactor typo, or stubbed lookup
    // hands the writer a task object carrying the WRONG projectId. The row must survive untouched
    // because project_id is in the UPDATE predicate — not merely because the lookup was correct.
    await seedTask({ status: 'in_progress' });
    const victim = await readTask();
    expect(victim).toBeDefined();

    await setTaskStatus(
      db(),
      { ...(victim as schema.Task), projectId: 'project-ATTACKER' },
      'cancelled',
      'user',
      MEMBER
    );

    expect((await readTask())?.status).toBe('in_progress');
  });

  it('setTaskStatus does mutate the row when the project matches (discriminating control)', async () => {
    await seedTask({ status: 'in_progress' });
    const task = await readTask();

    await setTaskStatus(db(), task as schema.Task, 'cancelled', 'user', MEMBER);

    expect((await readTask())?.status).toBe('cancelled');
  });
});

describe('task callback writes are fenced by the active workspace incarnation', () => {
  const callbackSnapshot = {
    workspaceId: 'ws-callback',
    userId: CREATOR,
    projectId: PROJECT,
    chatSessionId: 'chat-callback',
    status: 'running',
    nodeId: 'node-callback',
    nodeStatus: 'running',
  } as const;

  async function seedCallbackTask(): Promise<schema.Task> {
    await db()
      .insert(schema.nodes)
      .values({
        id: callbackSnapshot.nodeId,
        userId: CREATOR,
        name: 'callback node',
        status: callbackSnapshot.nodeStatus,
        healthStatus: 'healthy',
        vmSize: 'small',
        vmLocation: 'nbg1',
      } as typeof schema.nodes.$inferInsert);
    await db()
      .insert(schema.workspaces)
      .values({
        id: callbackSnapshot.workspaceId,
        nodeId: callbackSnapshot.nodeId,
        userId: callbackSnapshot.userId,
        projectId: callbackSnapshot.projectId,
        chatSessionId: callbackSnapshot.chatSessionId,
        name: 'callback workspace',
        repository: 'org/repo',
        status: callbackSnapshot.status,
        vmSize: 'small',
        vmLocation: 'nbg1',
      } as typeof schema.workspaces.$inferInsert);
    await seedTask({ workspaceId: callbackSnapshot.workspaceId });
    return (await readTask()) as schema.Task;
  }

  async function beginWorkspaceDeletion(): Promise<void> {
    await db()
      .update(schema.workspaces)
      .set({ status: 'stopping' })
      .where(eq(schema.workspaces.id, callbackSnapshot.workspaceId));
  }

  it('rejects a status transition after deletion wins the CAS race', async () => {
    const task = await seedCallbackTask();
    await beginWorkspaceDeletion();

    await expect(
      setTaskStatus(db(), task, 'failed', 'workspace_callback', callbackSnapshot.workspaceId, {
        callbackFence: { env, expected: callbackSnapshot },
      })
    ).rejects.toMatchObject({ statusCode: 410 });

    expect((await readTask())?.status).toBe('in_progress');
    expect(sqlite.prepare('SELECT COUNT(*) FROM task_status_events').pluck().get()).toBe(0);
  });

  it('rejects an execution-step update after deletion wins the CAS race', async () => {
    const task = await seedCallbackTask();
    await beginWorkspaceDeletion();

    await expect(
      updateTaskExecutionStepFromCallback(
        db(),
        task,
        { executionStep: 'awaiting_followup' },
        { env, expected: callbackSnapshot }
      )
    ).rejects.toMatchObject({ statusCode: 410 });

    expect((await readTask())?.executionStep).toBeNull();
  });

  it('updates task status when the exact workspace and node remain active', async () => {
    const task = await seedCallbackTask();

    await setTaskStatus(
      db(),
      task,
      'completed',
      'workspace_callback',
      callbackSnapshot.workspaceId,
      { callbackFence: { env, expected: callbackSnapshot } }
    );

    expect((await readTask())?.status).toBe('completed');
    expect(sqlite.prepare('SELECT COUNT(*) FROM task_status_events').pluck().get()).toBe(1);
  });
});
