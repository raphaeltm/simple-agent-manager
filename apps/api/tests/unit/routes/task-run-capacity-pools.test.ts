import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveResourceReservation } from '@simple-agent-manager/shared';
import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../../src/services/default-capacity-pools';
import { createPersistedTaskResourcePlanJson } from '../../../src/services/resource-requirements-input';
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

function readRunTaskResourceRow(sqlite: Database.Database): {
  status: string;
  resource_requirements_json: string | null;
  resource_requirement_plan_json: string | null;
  resource_requirements_source: string | null;
  resolved_reservation_json: string | null;
  requested_vm_size: string | null;
  requested_vm_size_source: string | null;
} {
  return sqlite
    .prepare(
      `SELECT status, resource_requirements_json, resource_requirement_plan_json,
        resource_requirements_source, resolved_reservation_json,
        requested_vm_size, requested_vm_size_source
       FROM tasks
       WHERE id = 'task-1'`
    )
    .get() as {
    status: string;
    resource_requirements_json: string | null;
    resource_requirement_plan_json: string | null;
    resource_requirements_source: string | null;
    resolved_reservation_json: string | null;
    requested_vm_size: string | null;
    requested_vm_size_source: string | null;
  };
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

  it('preserves stored task resource requirements when the run request omits them', async () => {
    const { sqlite, env } = createEnv();
    seedRunRows(sqlite);
    await seedProjectDefaultPool(env);
    const storedRequirements = JSON.stringify({
      minVcpu: 2,
      exclusiveNode: false,
      minDiskGb: 0,
    });
    sqlite
      .prepare(
        `UPDATE tasks
         SET resource_requirements_json = ?,
             resource_requirements_source = 'task'
         WHERE id = 'task-1'`
      )
      .run(storedRequirements);

    const res = await createApp().request(
      '/api/projects/project-1/tasks/task-1/run',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      env,
      executionCtx
    );

    expect(res.status).toBe(202);
    const row = readRunTaskResourceRow(sqlite);
    expect(row.resource_requirements_json).toBe(storedRequirements);
    expect(row.resource_requirements_source).toBe('task');
    const reservation = JSON.parse(row.resolved_reservation_json ?? '{}') as {
      source: string;
      sourceId: string;
      diskMb: number;
      exclusiveNode: boolean;
      fieldProvenance: Record<string, { source: string; value: unknown }>;
    };
    expect(reservation.source).toBe('task');
    expect(reservation.sourceId).toBe('task-1');
    expect(reservation.diskMb).toBe(0);
    expect(reservation.exclusiveNode).toBe(false);
    expect(reservation.fieldProvenance.minDiskGb).toMatchObject({
      source: 'task',
      value: 0,
    });
    expect(reservation.fieldProvenance.exclusiveNode).toMatchObject({
      source: 'task',
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
      })
    );
  });

  it('preserves versioned plan layers when compatibility JSON only contains the highest layer', async () => {
    const { sqlite, env } = createEnv();
    seedRunRows(sqlite);
    const storedLayers = {
      skill: { minVcpu: 4 },
      agentProfile: { minMemoryGb: 12 },
      project: { minDiskGb: 0, exclusiveNode: false },
    };
    const storedReservation = resolveResourceReservation(storedLayers, {
      taskId: 'task-1',
      skillId: 'skill-1',
      agentProfileId: 'profile-1',
      projectId: 'project-1',
      userId: 'user-1',
    });
    const storedPlanJson = createPersistedTaskResourcePlanJson({
      layers: storedLayers,
      resolvedReservation: storedReservation,
      requestedVmSize: 'small',
      requestedVmSizeSource: 'project',
    });
    sqlite
      .prepare(
        `UPDATE projects
         SET resource_requirements_json = ?
         WHERE id = 'project-1'`
      )
      .run(JSON.stringify({ minMemoryGb: 2, minDiskGb: 80, exclusiveNode: true }));
    sqlite
      .prepare(
        `UPDATE tasks
         SET resource_requirement_plan_json = ?,
             resource_requirements_json = ?,
             resource_requirements_source = ?,
             resolved_reservation_json = ?,
             requested_vm_size = ?,
             requested_vm_size_source = ?
         WHERE id = 'task-1'`
      )
      .run(
        storedPlanJson,
        JSON.stringify({ minVcpu: 4 }),
        'skill',
        JSON.stringify(storedReservation),
        'small',
        'project'
      );
    await seedProjectDefaultPool(env);

    const res = await createApp().request(
      '/api/projects/project-1/tasks/task-1/run',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      env,
      executionCtx
    );

    expect(res.status).toBe(202);
    const row = readRunTaskResourceRow(sqlite);
    expect(row.resource_requirements_json).toBe(JSON.stringify({ minVcpu: 4 }));
    const rewrittenPlan = JSON.parse(row.resource_requirement_plan_json ?? '{}') as {
      intent: Record<string, unknown>;
    };
    expect(rewrittenPlan.intent).toMatchObject({
      skill: { minVcpu: 4 },
      agentProfile: { minMemoryGb: 12 },
      project: { minDiskGb: 0, exclusiveNode: false },
    });
    const reservation = JSON.parse(row.resolved_reservation_json ?? '{}') as {
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
    expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        resolvedReservation: expect.objectContaining({
          cpuMillis: 4000,
          memoryMb: 12 * 1024,
          diskMb: 0,
          exclusiveNode: false,
        }),
        resourceRequirements: { minVcpu: 4 },
      })
    );
  });

  it('preserves omitted legacy VM size and original source when project defaults changed', async () => {
    const { sqlite, env } = createEnv();
    seedRunRows(sqlite);
    sqlite.prepare(`UPDATE projects SET default_vm_size = 'small' WHERE id = 'project-1'`).run();
    sqlite
      .prepare(
        `UPDATE tasks
         SET requested_vm_size = 'large',
             requested_vm_size_source = 'project',
             resource_requirements_json = NULL,
             resource_requirement_plan_json = NULL,
             resolved_reservation_json = NULL
         WHERE id = 'task-1'`
      )
      .run();
    await seedProjectDefaultPool(env);

    const res = await createApp().request(
      '/api/projects/project-1/tasks/task-1/run',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      env,
      executionCtx
    );

    expect(res.status).toBe(202);
    const row = readRunTaskResourceRow(sqlite);
    expect(row.requested_vm_size).toBe('large');
    expect(row.requested_vm_size_source).toBe('project');
    const reservation = JSON.parse(row.resolved_reservation_json ?? '{}') as {
      source: string;
      cpuMillis: number;
      memoryMb: number;
      fieldProvenance: Record<string, { source: string; compatibility?: { legacyVmSize: string } }>;
    };
    expect(reservation.source).toBe('project');
    expect(reservation.cpuMillis).toBe(4000);
    expect(reservation.memoryMb).toBe(8192);
    expect(reservation.fieldProvenance.minVcpu).toMatchObject({
      source: 'project',
      compatibility: expect.objectContaining({ legacyVmSize: 'large' }),
    });
    expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        vmSize: 'large',
        vmSizeSource: 'project',
        resolvedReservation: expect.objectContaining({
          source: 'project',
          memoryMb: 8192,
        }),
      })
    );
  });

  it('uses explicit modern run requirements as the task layer and fills remaining fields from project layer', async () => {
    const { sqlite, env } = createEnv();
    seedRunRows(sqlite);
    sqlite
      .prepare(
        `UPDATE projects
         SET resource_requirements_json = ?
         WHERE id = 'project-1'`
      )
      .run(JSON.stringify({ minVcpu: 2, exclusiveNode: false, minDiskGb: 0 }));
    await seedProjectDefaultPool(env);

    const res = await createApp().request(
      '/api/projects/project-1/tasks/task-1/run',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceRequirements: { minMemoryGb: 4 } }),
      },
      env,
      executionCtx
    );

    expect(res.status).toBe(202);
    const row = readRunTaskResourceRow(sqlite);
    expect(JSON.parse(row.resource_requirements_json ?? '{}')).toEqual({ minMemoryGb: 4 });
    const reservation = JSON.parse(row.resolved_reservation_json ?? '{}') as {
      source: string;
      fieldProvenance: Record<string, { source: string; value: unknown }>;
    };
    expect(reservation.source).toBe('task');
    expect(reservation.fieldProvenance.minMemoryGb).toMatchObject({
      source: 'task',
      value: 4,
    });
    expect(reservation.fieldProvenance.minVcpu).toMatchObject({
      source: 'project',
      value: 2,
    });
    expect(reservation.fieldProvenance.minDiskGb).toMatchObject({
      source: 'project',
      value: 0,
    });
    expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        resourceRequirements: { minMemoryGb: 4 },
        resolvedReservation: expect.objectContaining({ source: 'task' }),
      })
    );
  });

  it('clears stored task requirements on explicit null and resolves lower project requirements', async () => {
    const { sqlite, env } = createEnv();
    seedRunRows(sqlite);
    sqlite
      .prepare(
        `UPDATE projects
         SET resource_requirements_json = ?
         WHERE id = 'project-1'`
      )
      .run(JSON.stringify({ minVcpu: 2, exclusiveNode: false, minDiskGb: 0 }));
    sqlite
      .prepare(`UPDATE tasks SET resource_requirements_json = ? WHERE id = 'task-1'`)
      .run(JSON.stringify({ minVcpu: 4 }));
    await seedProjectDefaultPool(env);

    const res = await createApp().request(
      '/api/projects/project-1/tasks/task-1/run',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceRequirements: null }),
      },
      env,
      executionCtx
    );

    expect(res.status).toBe(202);
    const row = readRunTaskResourceRow(sqlite);
    expect(row.resource_requirements_json).toBeNull();
    expect(row.resource_requirements_source).toBe('project');
    const reservation = JSON.parse(row.resolved_reservation_json ?? '{}') as {
      source: string;
      fieldProvenance: Record<string, { source: string; value: unknown }>;
    };
    expect(reservation.source).toBe('project');
    expect(reservation.fieldProvenance.minVcpu).toMatchObject({
      source: 'project',
      value: 2,
    });
    expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        resourceRequirements: {
          minVcpu: 2,
          exclusiveNode: false,
          minDiskGb: 0,
        },
      })
    );
  });

  it('repairs malformed stored task requirements with explicit null replacement', async () => {
    const { sqlite, env } = createEnv();
    seedRunRows(sqlite);
    sqlite
      .prepare(`UPDATE projects SET resource_requirements_json = ? WHERE id = 'project-1'`)
      .run(JSON.stringify({ minVcpu: 2, minDiskGb: 0, exclusiveNode: false }));
    sqlite
      .prepare(`UPDATE tasks SET resource_requirements_json = ? WHERE id = 'task-1'`)
      .run('{malformed');
    await seedProjectDefaultPool(env);

    const res = await createApp().request(
      '/api/projects/project-1/tasks/task-1/run',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceRequirements: null }),
      },
      env,
      executionCtx
    );

    expect(res.status).toBe(202);
    const row = readRunTaskResourceRow(sqlite);
    expect(row.resource_requirements_json).toBeNull();
    expect(row.resource_requirements_source).toBe('project');
  });

  it('repairs malformed stored task requirements with an explicit object replacement', async () => {
    const { sqlite, env } = createEnv();
    seedRunRows(sqlite);
    sqlite
      .prepare(`UPDATE tasks SET resource_requirements_json = ? WHERE id = 'task-1'`)
      .run('{malformed');
    await seedProjectDefaultPool(env);

    const res = await createApp().request(
      '/api/projects/project-1/tasks/task-1/run',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceRequirements: { minVcpu: 2 } }),
      },
      env,
      executionCtx
    );

    expect(res.status).toBe(202);
    const row = readRunTaskResourceRow(sqlite);
    expect(JSON.parse(row.resource_requirements_json ?? '{}')).toEqual({ minVcpu: 2 });
    expect(row.resource_requirements_source).toBe('task');
  });

  it('rejects malformed stored task requirements without wiping metadata or starting a runner', async () => {
    const { sqlite, env } = createEnv();
    seedRunRows(sqlite);
    sqlite
      .prepare(`UPDATE tasks SET resource_requirements_json = ? WHERE id = 'task-1'`)
      .run('{malformed');

    const res = await createApp().request(
      '/api/projects/project-1/tasks/task-1/run',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      env,
      executionCtx
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('resourceRequirementsJson is malformed');
    const row = readRunTaskResourceRow(sqlite);
    expect(row.status).toBe('ready');
    expect(row.resource_requirements_json).toBe('{malformed');
    expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
  });

  it('rejects invalid modern run requirements without updating the task', async () => {
    const { sqlite, env } = createEnv();
    seedRunRows(sqlite);
    sqlite
      .prepare(
        `UPDATE tasks
         SET resource_requirements_json = ?,
             resource_requirements_source = 'task'
         WHERE id = 'task-1'`
      )
      .run(JSON.stringify({ minVcpu: 2 }));

    const res = await createApp().request(
      '/api/projects/project-1/tasks/task-1/run',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceRequirements: { minVcpu: 0 } }),
      },
      env,
      executionCtx
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('minVcpu');
    const row = readRunTaskResourceRow(sqlite);
    expect(row.status).toBe('ready');
    expect(JSON.parse(row.resource_requirements_json ?? '{}')).toEqual({ minVcpu: 2 });
    expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
  });
});
