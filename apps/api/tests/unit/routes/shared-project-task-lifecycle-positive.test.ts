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
  createSession: vi.fn(),
  stopSession: vi.fn(),
  failSession: vi.fn(),
}));

import { setTaskStatus } from '../../../src/routes/tasks/_helpers';
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

  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'sammy.party' } as unknown as Env;
});

afterEach(() => sqlite.close());

describe('shared-project task lifecycle — positive paths for a non-creator member', () => {
  it('POST /:taskId/status: a member can cancel another member task and the row is persisted', async () => {
    await seedTask({ status: 'in_progress' });

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
      new Request(`https://api.test/api/projects/${PROJECT}/tasks/task-1/close`, { method: 'POST' }),
      env,
      mockCtx
    );

    expect(response.status).toBe(200);
    expect((await readTask())?.status).toBe('completed');
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
