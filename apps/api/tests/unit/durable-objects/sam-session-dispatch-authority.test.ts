import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { dispatchTask } from '../../../src/durable-objects/sam-session/tools/dispatch-task';
import { retrySubtask } from '../../../src/durable-objects/sam-session/tools/retry-subtask';
import type { ToolContext } from '../../../src/durable-objects/sam-session/types';
import type { Env } from '../../../src/env';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../../src/services/default-capacity-pools';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';
import {
  seedCloudCredential,
  seedProjectWithMember,
  seedUser,
} from '../routes/capacity-pool-test-seeds';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  persistMessage: vi.fn(),
  requireRepositoryOwnerAccess: vi.fn(),
  startTaskRunnerDO: vi.fn(),
  generateTaskTitle: vi.fn(),
  projectDataFetch: vi.fn(),
}));

vi.mock('../../../src/services/project-data', () => ({
  createSession: mocks.createSession,
  persistMessage: mocks.persistMessage,
}));

vi.mock('../../../src/routes/projects/_helpers', () => ({
  requireRepositoryOwnerAccess: mocks.requireRepositoryOwnerAccess,
}));

vi.mock('../../../src/services/task-runner-do', () => ({
  startTaskRunnerDO: mocks.startTaskRunnerDO,
}));

vi.mock('../../../src/services/task-title', () => ({
  generateTaskTitle: mocks.generateTaskTitle,
  getTaskTitleConfig: vi.fn(() => ({})),
}));

function createEnv(sqlite: Database.Database): Env {
  return {
    DATABASE: createSqliteD1WithBindLimit(sqlite, 100),
    BASE_DOMAIN: 'sammy.party',
    BRANCH_NAME_PREFIX: 'sam/',
    BRANCH_NAME_MAX_LENGTH: '60',
    COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'false',
    PROJECT_DATA: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => ({
        fetch: mocks.projectDataFetch,
      })),
    },
  } as unknown as Env;
}

function makeContext(env: Env, userId: string): ToolContext {
  return {
    env: env as unknown as Record<string, unknown>,
    userId,
  };
}

describe('SAM session dispatch_task current project authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSession.mockResolvedValue('session-1');
    mocks.persistMessage.mockResolvedValue(undefined);
    mocks.requireRepositoryOwnerAccess.mockResolvedValue(undefined);
    mocks.startTaskRunnerDO.mockResolvedValue(undefined);
    mocks.generateTaskTitle.mockResolvedValue('Session dispatched task');
    mocks.projectDataFetch.mockResolvedValue(new Response('{}'));
  });

  async function seedRunnableProject(sqlite: Database.Database, userId = 'owner-1'): Promise<Env> {
    createAllSchemaTables(sqlite, schema);
    seedUser(sqlite, userId);
    seedProjectWithMember(sqlite, { projectId: 'project-1', userId, role: 'owner' });
    seedCloudCredential(sqlite, {
      id: 'project-cloud-1',
      userId,
      projectId: 'project-1',
    });
    const env = createEnv(sqlite);
    await ensureDefaultCapacityPoolsForExistingCredentials(drizzle(env.DATABASE, { schema }), {
      userId,
      projectId: 'project-1',
      includeInstallation: false,
    });
    return env;
  }

  it.each([
    ['completed', 'completed'],
    ['cancelled', 'cancelled'],
    ['in_progress', 'failed'],
  ] as const)(
    'dispatch_task session failure preserves/fails %s as %s through the real entry point',
    async (winningStatus, expectedStatus) => {
      const sqlite = new Database(':memory:');
      try {
        const env = await seedRunnableProject(sqlite);
        mocks.createSession.mockImplementationOnce(async () => {
          sqlite.prepare('UPDATE tasks SET status = ?').run(winningStatus);
          throw new Error('session unavailable');
        });

        await dispatchTask(
          { projectId: 'project-1', description: 'Dispatch failure guard' },
          makeContext(env, 'owner-1')
        );

        expect(sqlite.prepare('SELECT status FROM tasks').get()).toEqual({
          status: expectedStatus,
        });
      } finally {
        sqlite.close();
      }
    }
  );

  it.each([
    ['completed', 'completed'],
    ['cancelled', 'cancelled'],
    ['in_progress', 'failed'],
  ] as const)(
    'dispatch_task runner failure preserves/fails %s as %s through the real entry point',
    async (winningStatus, expectedStatus) => {
      const sqlite = new Database(':memory:');
      try {
        const env = await seedRunnableProject(sqlite);
        mocks.startTaskRunnerDO.mockImplementationOnce(async () => {
          sqlite.prepare('UPDATE tasks SET status = ?').run(winningStatus);
          throw new Error('runner unavailable');
        });

        await dispatchTask(
          { projectId: 'project-1', description: 'Runner failure guard' },
          makeContext(env, 'owner-1')
        );

        expect(sqlite.prepare('SELECT status FROM tasks').get()).toEqual({
          status: expectedStatus,
        });
      } finally {
        sqlite.close();
      }
    }
  );

  it.each([
    ['completed', 'completed'],
    ['cancelled', 'cancelled'],
    ['in_progress', 'failed'],
  ] as const)(
    'retry_subtask session failure preserves/fails %s as %s through the real entry point',
    async (winningStatus, expectedStatus) => {
      const sqlite = new Database(':memory:');
      try {
        const env = await seedRunnableProject(sqlite);
        sqlite
          .prepare(
            `INSERT INTO tasks
               (id, project_id, user_id, title, description, status, created_at, updated_at)
             VALUES ('original-task', 'project-1', 'owner-1', 'Original', 'Retry me', 'failed', ?, ?)`
          )
          .run(new Date().toISOString(), new Date().toISOString());
        mocks.createSession.mockImplementationOnce(async () => {
          sqlite
            .prepare("UPDATE tasks SET status = ? WHERE id != 'original-task'")
            .run(winningStatus);
          throw new Error('session unavailable');
        });

        await retrySubtask({ taskId: 'original-task' }, makeContext(env, 'owner-1'));

        expect(
          sqlite.prepare("SELECT status FROM tasks WHERE id != 'original-task'").get()
        ).toEqual({ status: expectedStatus });
      } finally {
        sqlite.close();
      }
    }
  );

  it.each([
    ['completed', 'completed'],
    ['cancelled', 'cancelled'],
    ['in_progress', 'failed'],
  ] as const)(
    'retry_subtask runner failure preserves/fails %s as %s through the real entry point',
    async (winningStatus, expectedStatus) => {
      const sqlite = new Database(':memory:');
      try {
        const env = await seedRunnableProject(sqlite);
        sqlite
          .prepare(
            `INSERT INTO tasks
               (id, project_id, user_id, title, description, status, created_at, updated_at)
             VALUES ('original-task', 'project-1', 'owner-1', 'Original', 'Retry me', 'failed', ?, ?)`
          )
          .run(new Date().toISOString(), new Date().toISOString());
        mocks.startTaskRunnerDO.mockImplementationOnce(async () => {
          sqlite
            .prepare("UPDATE tasks SET status = ? WHERE id != 'original-task'")
            .run(winningStatus);
          throw new Error('runner unavailable');
        });

        await retrySubtask({ taskId: 'original-task' }, makeContext(env, 'owner-1'));

        expect(
          sqlite.prepare("SELECT status FROM tasks WHERE id != 'original-task'").get()
        ).toEqual({ status: expectedStatus });
      } finally {
        sqlite.close();
      }
    }
  );

  it('retry_subtask keeps the original feature coordination channel on the replacement', async () => {
    const sqlite = new Database(':memory:');
    try {
      const env = await seedRunnableProject(sqlite);
      const insertOriginal = sqlite.prepare(
        `INSERT INTO tasks
           (id, project_id, user_id, title, description, status, coordination_channel,
            created_at, updated_at)
         VALUES (?, 'project-1', 'owner-1', 'Original', 'Retry me', 'failed', ?, ?, ?)`
      );
      const now = new Date().toISOString();
      insertOriginal.run('with-channel', 'feature.retry', now, now);
      insertOriginal.run('without-channel', null, now, now);

      await retrySubtask({ taskId: 'with-channel' }, makeContext(env, 'owner-1'));
      await retrySubtask({ taskId: 'without-channel' }, makeContext(env, 'owner-1'));

      expect(
        sqlite
          .prepare(
            `SELECT description, coordination_channel FROM tasks
             WHERE id NOT IN ('with-channel', 'without-channel')
             ORDER BY coordination_channel IS NULL, id`
          )
          .all()
      ).toEqual([
        { description: 'Retry me', coordination_channel: 'feature.retry' },
        { description: 'Retry me', coordination_channel: null },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('rejects removed project members before task/session/runner side effects', async () => {
    const sqlite = new Database(':memory:');
    try {
      createAllSchemaTables(sqlite, schema);
      seedUser(sqlite, 'owner-1');
      seedUser(sqlite, 'removed-1');
      seedProjectWithMember(sqlite, { projectId: 'project-1', userId: 'owner-1', role: 'owner' });
      sqlite
        .prepare(
          `INSERT INTO project_members (project_id, user_id, role, status)
           VALUES ('project-1', 'removed-1', 'maintainer', 'removed')`
        )
        .run();

      const env = createEnv(sqlite);
      const result = await dispatchTask(
        { projectId: 'project-1', description: 'Should not dispatch' },
        makeContext(env, 'removed-1')
      );

      expect(result).toMatchObject({ error: expect.stringContaining('Project') });
      expect(mocks.generateTaskTitle).not.toHaveBeenCalled();
      expect(mocks.createSession).not.toHaveBeenCalled();
      expect(mocks.persistMessage).not.toHaveBeenCalled();
      expect(mocks.requireRepositoryOwnerAccess).not.toHaveBeenCalled();
      expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  it('allows an active project member to dispatch with shared project credentials', async () => {
    const sqlite = new Database(':memory:');
    try {
      createAllSchemaTables(sqlite, schema);
      seedUser(sqlite, 'owner-1');
      seedUser(sqlite, 'member-1');
      seedProjectWithMember(sqlite, { projectId: 'project-1', userId: 'owner-1', role: 'owner' });
      sqlite
        .prepare(
          `INSERT INTO project_members (project_id, user_id, role, status)
           VALUES ('project-1', 'member-1', 'maintainer', 'active')`
        )
        .run();
      seedCloudCredential(sqlite, {
        id: 'project-cloud-1',
        userId: 'owner-1',
        projectId: 'project-1',
      });
      const env = createEnv(sqlite);
      await ensureDefaultCapacityPoolsForExistingCredentials(drizzle(env.DATABASE, { schema }), {
        userId: 'owner-1',
        projectId: 'project-1',
        includeInstallation: false,
      });

      const result = await dispatchTask(
        { projectId: 'project-1', description: 'Active member dispatch' },
        makeContext(env, 'member-1')
      );

      expect(result).toMatchObject({
        taskId: expect.any(String),
        status: 'queued',
      });
      const taskRow = sqlite
        .prepare(
          `SELECT user_id, credential_attribution_user_id, credential_attribution_project_id,
            credential_attribution_source, placement_credential_source
           FROM tasks`
        )
        .get() as Record<string, unknown>;
      expect(taskRow).toMatchObject({
        user_id: 'member-1',
        credential_attribution_user_id: 'member-1',
        credential_attribution_project_id: 'project-1',
        credential_attribution_source: 'project',
        placement_credential_source: 'project',
      });
      expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
        env,
        expect.objectContaining({
          userId: 'member-1',
          credentialAttributionUserId: 'member-1',
          credentialAttributionProjectId: 'project-1',
          credentialAttributionSource: 'project',
        })
      );
    } finally {
      sqlite.close();
    }
  });

  it('persists skill, profile, and project resource layers in session dispatch plans', async () => {
    const sqlite = new Database(':memory:');
    try {
      createAllSchemaTables(sqlite, schema);
      seedUser(sqlite, 'user-1');
      seedProjectWithMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
      seedCloudCredential(sqlite, {
        id: 'project-cloud-1',
        userId: 'user-1',
        projectId: 'project-1',
      });
      sqlite
        .prepare(`UPDATE projects SET resource_requirements_json = ? WHERE id = 'project-1'`)
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
      const env = createEnv(sqlite);
      await ensureDefaultCapacityPoolsForExistingCredentials(drizzle(env.DATABASE, { schema }), {
        userId: 'user-1',
        projectId: 'project-1',
        includeInstallation: false,
      });

      const result = await dispatchTask(
        {
          projectId: 'project-1',
          description: 'Session layered dispatch',
          agentProfileId: 'profile-1',
          skillId: 'skill-1',
        },
        makeContext(env, 'user-1')
      );

      expect(result).toMatchObject({
        taskId: expect.any(String),
        status: 'queued',
      });
      const taskRow = sqlite
        .prepare(
          `SELECT resource_requirements_json, resource_requirement_plan_json,
            resource_requirements_source, resolved_reservation_json
           FROM tasks`
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
        intent: Record<string, unknown>;
      };
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
      expect(reservation.fieldProvenance.minMemoryGb).toMatchObject({
        source: 'agent-profile',
        value: 12,
      });
    } finally {
      sqlite.close();
    }
  });
});
