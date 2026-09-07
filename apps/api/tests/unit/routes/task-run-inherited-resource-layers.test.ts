/**
 * Finding 2, through the REAL Run handler and a real SQL engine.
 *
 * Reproduces the production shape: an older task with no versioned plan and no
 * stored reservation, carrying only a legacy `resource_requirements_json` whose
 * source is `skill`. Running it with an explicit task-level override — object or
 * null — must not erase the inherited skill requirement.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../../src/services/default-capacity-pools';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';
import { seedCloudCredential, seedProjectWithMember, seedUser } from './capacity-pool-test-seeds';

const mocks = vi.hoisted(() => ({
  requireRepositoryUserAccess: vi.fn(),
  createSession: vi.fn(),
  stopSession: vi.fn(),
  startTaskRunnerDO: vi.fn(),
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getAuth: () => ({
    user: {
      id: 'user-1',
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
}));

vi.mock('../../../src/services/project-data', () => ({
  createSession: mocks.createSession,
  stopSession: mocks.stopSession,
}));

vi.mock('../../../src/services/task-runner-do', () => ({
  startTaskRunnerDO: mocks.startTaskRunnerDO,
}));

const { runRoutes } = await import('../../../src/routes/tasks/run');

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) =>
    err instanceof AppError
      ? c.json(err.toJSON(), err.statusCode as never)
      : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500)
  );
  app.route('/api/projects/:projectId/tasks', runRoutes);
  return app;
}

const executionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

async function seedLegacyTask(input: {
  resourceRequirementsJson: string | null;
  resourceRequirementsSource: string | null;
}): Promise<{ sqlite: Database.Database; env: Env }> {
  const sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  seedUser(sqlite, 'user-1');
  sqlite.prepare(`UPDATE users SET github_id = '123' WHERE id = 'user-1'`).run();
  seedProjectWithMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
  seedCloudCredential(sqlite, { id: 'project-cloud-1', userId: 'user-1', projectId: 'project-1' });
  // Deliberately no plan JSON and no reservation JSON — the pre-plan row shape.
  sqlite
    .prepare(
      `INSERT INTO tasks (
         id, project_id, user_id, title, description, status, priority,
         task_mode, dispatch_depth, triggered_by, created_by,
         resource_requirements_json, resource_requirements_source,
         created_at, updated_at
       )
       VALUES (
         'task-1', 'project-1', 'user-1', 'Legacy inherited task',
         'Inherited from a skill', 'ready', 0, 'task', 0, 'user', 'user-1',
         ?, ?, '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z'
       )`
    )
    .run(input.resourceRequirementsJson, input.resourceRequirementsSource);

  const env = {
    DATABASE: createSqliteD1WithBindLimit(sqlite, 100),
    BASE_DOMAIN: 'sammy.party',
    COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'false',
  } as Env;
  await ensureDefaultCapacityPoolsForExistingCredentials(drizzle(env.DATABASE, { schema }), {
    userId: 'user-1',
    projectId: 'project-1',
    includeInstallation: false,
  });
  return { sqlite, env };
}

function readPlan(sqlite: Database.Database): {
  intent: Record<string, unknown>;
  reservation: { cpuMillis: number; memoryMb: number; source: string };
} {
  const row = sqlite
    .prepare(
      `SELECT resource_requirement_plan_json, resolved_reservation_json FROM tasks WHERE id = 'task-1'`
    )
    .get() as { resource_requirement_plan_json: string; resolved_reservation_json: string };
  return {
    intent: (JSON.parse(row.resource_requirement_plan_json) as { intent: Record<string, unknown> })
      .intent,
    reservation: JSON.parse(row.resolved_reservation_json) as {
      cpuMillis: number;
      memoryMb: number;
      source: string;
    },
  };
}

async function run(env: Env, body: string) {
  return createApp().request(
    '/api/projects/project-1/tasks/task-1/run',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
    env,
    executionCtx
  );
}

describe('task run preserves inherited resource layers across an explicit task override', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRepositoryUserAccess.mockResolvedValue(undefined);
    mocks.createSession.mockResolvedValue('session-1');
    mocks.stopSession.mockResolvedValue(undefined);
    mocks.startTaskRunnerDO.mockResolvedValue(undefined);
  });

  it('keeps the inherited skill layer when the task override is explicit null', async () => {
    const { sqlite, env } = await seedLegacyTask({
      resourceRequirementsJson: JSON.stringify({ minVcpu: 4, minMemoryGb: 12 }),
      resourceRequirementsSource: 'skill',
    });
    try {
      const res = await run(env, JSON.stringify({ resourceRequirements: null }));
      expect(res.status).toBe(202);

      const { intent, reservation } = readPlan(sqlite);
      expect(intent.skill).toEqual({ minVcpu: 4, minMemoryGb: 12 });
      expect(intent.task).toBeNull();
      // The inherited requirement still drives the actual reservation.
      expect(reservation).toMatchObject({ cpuMillis: 4000, memoryMb: 12 * 1024, source: 'skill' });
      expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
        env,
        expect.objectContaining({
          resolvedReservation: expect.objectContaining({ cpuMillis: 4000, memoryMb: 12 * 1024 }),
        })
      );
    } finally {
      sqlite.close();
    }
  });

  it('keeps the inherited skill layer when the task override is an explicit object', async () => {
    const { sqlite, env } = await seedLegacyTask({
      resourceRequirementsJson: JSON.stringify({ minVcpu: 4, minMemoryGb: 12 }),
      resourceRequirementsSource: 'skill',
    });
    try {
      const res = await run(env, JSON.stringify({ resourceRequirements: { minVcpu: 8 } }));
      expect(res.status).toBe(202);

      const { intent, reservation } = readPlan(sqlite);
      // Task wins on the field it names; the inherited memory requirement survives.
      expect(intent.task).toEqual({ minVcpu: 8 });
      expect(intent.skill).toEqual({ minVcpu: 4, minMemoryGb: 12 });
      expect(reservation).toMatchObject({ cpuMillis: 8000, memoryMb: 12 * 1024, source: 'task' });
    } finally {
      sqlite.close();
    }
  });

  it('still replaces a task-sourced stored layer rather than merging with it', async () => {
    const { sqlite, env } = await seedLegacyTask({
      resourceRequirementsJson: JSON.stringify({ minVcpu: 4, minMemoryGb: 12 }),
      resourceRequirementsSource: 'task',
    });
    try {
      const res = await run(env, JSON.stringify({ resourceRequirements: { minVcpu: 8 } }));
      expect(res.status).toBe(202);

      const { intent, reservation } = readPlan(sqlite);
      expect(intent.task).toEqual({ minVcpu: 8 });
      expect(intent.skill).toBeNull();
      // The replaced memory requirement is gone — the override is authoritative.
      expect(reservation.memoryMb).not.toBe(12 * 1024);
    } finally {
      sqlite.close();
    }
  });

  it('rejects the run when an unrelated inherited layer is malformed', async () => {
    const { sqlite, env } = await seedLegacyTask({
      resourceRequirementsJson: JSON.stringify({ minVcpu: 'banana' }),
      resourceRequirementsSource: 'skill',
    });
    try {
      const res = await run(env, JSON.stringify({ resourceRequirements: { minVcpu: 8 } }));
      expect(res.status).toBe(400);
      // Fails before any effect: the task is untouched and no runner started.
      const row = sqlite.prepare(`SELECT status FROM tasks WHERE id = 'task-1'`).get() as {
        status: string;
      };
      expect(row.status).toBe('ready');
      expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it('repairs a malformed task-sourced layer instead of blocking the run', async () => {
    const { sqlite, env } = await seedLegacyTask({
      resourceRequirementsJson: '{not json',
      resourceRequirementsSource: 'task',
    });
    try {
      const res = await run(env, JSON.stringify({ resourceRequirements: { minVcpu: 8 } }));
      expect(res.status).toBe(202);
      const { intent } = readPlan(sqlite);
      expect(intent.task).toEqual({ minVcpu: 8 });
    } finally {
      sqlite.close();
    }
  });
});
