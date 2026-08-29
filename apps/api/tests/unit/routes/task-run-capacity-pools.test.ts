import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../../src/services/default-capacity-pools';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';
import {
  seedCloudCredential,
  seedProjectWithMember,
  seedUser,
} from './capacity-pool-test-seeds';

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

function createEnv() {
  const sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  return {
    sqlite,
    env: {
      DATABASE: createSqliteD1WithBindLimit(sqlite, 100),
      BASE_DOMAIN: 'sammy.party',
      COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'false',
    } as Env,
  };
}

function seedRunRows(sqlite: Database.Database): void {
  seedUser(sqlite, 'user-1');
  sqlite.prepare(`UPDATE users SET github_id = '123' WHERE id = 'user-1'`).run();
  seedProjectWithMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
  seedCloudCredential(sqlite, {
    id: 'project-cloud-1',
    userId: 'user-1',
    projectId: 'project-1',
  });
  sqlite
    .prepare(
      `INSERT INTO tasks (
         id, project_id, user_id, title, description, status, priority,
         task_mode, dispatch_depth, triggered_by, created_by, created_at, updated_at
       )
       VALUES (
         'task-1', 'project-1', 'user-1', 'Run existing task',
         'Existing ready task', 'ready', 0, 'task', 0, 'user',
         'user-1', '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z'
       )`
    )
    .run();
}

async function seedProjectDefaultPool(env: Env): Promise<void> {
  await ensureDefaultCapacityPoolsForExistingCredentials(drizzle(env.DATABASE, { schema }), {
    userId: 'user-1',
    projectId: 'project-1',
    includeInstallation: false,
  });
}

const executionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

describe('task run capacity-pool placement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRepositoryUserAccess.mockResolvedValue(undefined);
    mocks.createSession.mockResolvedValue('session-1');
    mocks.stopSession.mockResolvedValue(undefined);
    mocks.startTaskRunnerDO.mockResolvedValue(undefined);
  });

  it('persists concrete pool candidate metadata and passes it to TaskRunner start', async () => {
    const { sqlite, env } = createEnv();
    seedRunRows(sqlite);
    await seedProjectDefaultPool(env);

    const res = await createApp().request(
      '/api/projects/project-1/tasks/task-1/run',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      env,
      executionCtx
    );

    expect(res.status).toBe(202);
    const taskRow = sqlite
      .prepare(
        `SELECT
           status,
           capacity_pool_id,
           capacity_pool_scope,
           capacity_source_id,
           capacity_pool_candidate_id,
           placement_credential_source,
           placement_credential_reference,
           capacity_pool_project_id,
           provider_instance_type,
           provider_instance_vcpu_count,
           provider_instance_memory_mb
         FROM tasks
         WHERE id = 'task-1'`
      )
      .get() as {
      status: string;
      capacity_pool_id: string | null;
      capacity_pool_scope: string | null;
      capacity_source_id: string | null;
      capacity_pool_candidate_id: string | null;
      placement_credential_source: string | null;
      placement_credential_reference: string | null;
      capacity_pool_project_id: string | null;
      provider_instance_type: string | null;
      provider_instance_vcpu_count: number | null;
      provider_instance_memory_mb: number | null;
    };

    expect(taskRow).toMatchObject({
      status: 'queued',
      capacity_pool_id: 'cap-pool-default:project:project-1',
      capacity_pool_scope: 'project',
      capacity_source_id: 'cap-source-default:project:project-cloud-1',
      capacity_pool_candidate_id:
        'cap-candidate-default:cap-pool-default:project:project-1:cap-source-default:project:project-cloud-1:hetzner:nbg1:cx23',
      placement_credential_source: 'project',
      placement_credential_reference: 'credentials:project-cloud-1',
      capacity_pool_project_id: 'project-1',
      provider_instance_type: 'cx23',
      provider_instance_vcpu_count: 2,
      provider_instance_memory_mb: 4096,
    });

    expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        taskId: 'task-1',
        projectId: 'project-1',
        userId: 'user-1',
        cloudProvider: 'hetzner',
        credentialAttributionSource: 'project',
        credentialAttributionProjectId: 'project-1',
        capacityPoolSelection: expect.objectContaining({
          poolId: 'cap-pool-default:project:project-1',
          scope: 'project',
          candidates: expect.arrayContaining([
            expect.objectContaining({
              id: taskRow.capacity_pool_candidate_id,
              capacitySourceId: taskRow.capacity_source_id,
              providerInstanceType: 'cx23',
              providerInstanceVcpuCount: 2,
              providerInstanceMemoryMb: 4096,
              snapshot: expect.objectContaining({
                capacityPoolCandidateId: taskRow.capacity_pool_candidate_id,
                providerInstanceType: 'cx23',
              }),
            }),
          ]),
        }),
      })
    );
  });
});
