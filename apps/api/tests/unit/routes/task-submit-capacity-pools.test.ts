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

const authState = vi.hoisted(() => ({
  userId: 'user-1',
}));

const mocks = vi.hoisted(() => ({
  requireRepositoryUserAccess: vi.fn(),
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

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
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
}));

vi.mock('../../../src/services/project-data', () => ({
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
