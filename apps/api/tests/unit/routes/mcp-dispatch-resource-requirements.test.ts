import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { McpTokenData } from '../../../src/routes/mcp/_helpers';
import { getRuntimeValidationError } from '../../../src/routes/mcp/dispatch-instant';
import { parseDispatchTaskParams } from '../../../src/routes/mcp/dispatch-tool-params';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../../src/services/default-capacity-pools';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';
import { seedCloudCredential, seedProjectWithMember, seedUser } from './capacity-pool-test-seeds';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  persistMessage: vi.fn(),
  getActivePolicies: vi.fn(),
  requireRepositoryOwnerAccess: vi.fn(),
  startTaskRunnerDO: vi.fn(),
  generateTaskTitle: vi.fn(),
}));

vi.mock('../../../src/services/project-data', () => ({
  createSession: mocks.createSession,
  persistMessage: mocks.persistMessage,
  getActivePolicies: mocks.getActivePolicies,
  stopSession: vi.fn(),
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

const { handleDispatchTask } = await import('../../../src/routes/mcp/dispatch-tool');

const limits = {
  dispatchDescriptionMaxLength: 1000,
  dispatchMaxPriority: 10,
  dispatchMaxReferences: 5,
  dispatchMaxReferenceLength: 200,
};

describe('MCP dispatch_task resource requirements input', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSession.mockResolvedValue('session-mcp-child');
    mocks.persistMessage.mockResolvedValue(undefined);
    mocks.getActivePolicies.mockResolvedValue([]);
    mocks.requireRepositoryOwnerAccess.mockResolvedValue(undefined);
    mocks.startTaskRunnerDO.mockResolvedValue(undefined);
    mocks.generateTaskTitle.mockResolvedValue('MCP child task');
  });

  it('preserves modern fields, explicit false, and legacy vmSize together', () => {
    const result = parseDispatchTaskParams(
      1,
      {
        description: 'Run explicit hardware',
        vmSize: 'small',
        resourceRequirements: { minVcpu: 4, minMemoryGb: 16, exclusiveNode: false },
      },
      limits
    );

    expect('parsed' in result).toBe(true);
    if (!('parsed' in result)) return;
    expect(result.parsed.vmSize).toBe('small');
    expect(result.parsed.resourceRequirements).toEqual({
      minVcpu: 4,
      minMemoryGb: 16,
      exclusiveNode: false,
    });
  });

  it('allows omitted resourceRequirements and rejects null task constraints', () => {
    const omitted = parseDispatchTaskParams(1, { description: 'Run default hardware' }, limits);
    expect('parsed' in omitted).toBe(true);
    if ('parsed' in omitted) expect(omitted.parsed.resourceRequirements).toBeUndefined();

    const nulled = parseDispatchTaskParams(
      1,
      { description: 'Run explicit hardware', resourceRequirements: null },
      limits
    );
    expect('error' in nulled).toBe(true);
    if ('error' in nulled) expect(nulled.error.error?.code).toBe(-32602);
  });

  it('rejects negative, non-finite, and malformed known fields', () => {
    for (const resourceRequirements of [
      { minVcpu: -1 },
      { minVcpu: 0 },
      { minMemoryGb: Number.NaN },
      { minDiskGb: Number.POSITIVE_INFINITY },
      { exclusiveNode: 'false' },
      { maxCoTenants: 0 },
      { maxCoTenants: 1.5 },
      [],
    ]) {
      const result = parseDispatchTaskParams(
        1,
        {
          description: 'Run explicit hardware',
          resourceRequirements,
        },
        limits
      );

      expect('error' in result).toBe(true);
      if ('error' in result) expect(result.error.error?.code).toBe(-32602);
    }
  });

  it('treats resourceRequirements as VM-only for container runtime validation', () => {
    expect(
      getRuntimeValidationError(
        { runtime: 'cf-container', resourceRequirements: { minVcpu: 2 } },
        'cf-container'
      )
    ).toContain('VM-only fields: resourceRequirements');
  });

  it('dispatches with task resource requirements above project defaults through real persistence', async () => {
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
        .prepare(
          `UPDATE projects
           SET resource_requirements_json = ?
           WHERE id = 'project-1'`
        )
        .run(JSON.stringify({ minVcpu: 2, exclusiveNode: false, minDiskGb: 0 }));
      sqlite
        .prepare(
          `INSERT INTO tasks (
             id, project_id, user_id, title, description, status, priority,
             task_mode, dispatch_depth, triggered_by, created_by,
             credential_attribution_user_id, credential_attribution_project_id,
             credential_attribution_source, created_at, updated_at
           )
           VALUES (
             'parent-task-1', 'project-1', 'user-1', 'Parent task',
             'Parent task', 'in_progress', 0, 'task', 0, 'user',
             'user-1', 'user-1', 'project-1', 'project',
             '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'
           )`
        )
        .run();

      const env = {
        DATABASE: createSqliteD1WithBindLimit(sqlite, 100),
        BASE_DOMAIN: 'sammy.party',
        BRANCH_NAME_PREFIX: 'sam/',
        BRANCH_NAME_MAX_LENGTH: '60',
        COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'false',
      } as Env;
      await ensureDefaultCapacityPoolsForExistingCredentials(drizzle(env.DATABASE, { schema }), {
        userId: 'user-1',
        projectId: 'project-1',
        includeInstallation: false,
      });
      const tokenData: McpTokenData = {
        taskId: 'parent-task-1',
        projectId: 'project-1',
        userId: 'user-1',
        workspaceId: 'workspace-1',
        createdAt: '2026-09-07T00:00:00.000Z',
      };

      const response = await handleDispatchTask(
        1,
        {
          description: 'Dispatch child task',
          resourceRequirements: { minMemoryGb: 4 },
        },
        tokenData,
        env
      );

      expect(response.error).toBeUndefined();
      const taskRow = sqlite
        .prepare(
          `SELECT resource_requirements_json, resource_requirements_source, resolved_reservation_json
           FROM tasks
           WHERE parent_task_id = 'parent-task-1'`
        )
        .get() as {
        resource_requirements_json: string | null;
        resource_requirements_source: string | null;
        resolved_reservation_json: string;
      };
      expect(JSON.parse(taskRow.resource_requirements_json ?? '{}')).toEqual({ minMemoryGb: 4 });
      expect(taskRow.resource_requirements_source).toBe('task');
      const reservation = JSON.parse(taskRow.resolved_reservation_json) as {
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
      expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
        env,
        expect.objectContaining({
          taskId: expect.any(String),
          projectId: 'project-1',
          userId: 'user-1',
          resourceRequirements: { minMemoryGb: 4 },
          resolvedReservation: expect.objectContaining({ source: 'task' }),
        })
      );
    } finally {
      sqlite.close();
    }
  });

  it('persists skill, profile, and project resource layers in HTTP MCP dispatch plans', async () => {
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
      sqlite
        .prepare(
          `INSERT INTO tasks (
             id, project_id, user_id, title, description, status, priority,
             task_mode, dispatch_depth, triggered_by, created_by,
             credential_attribution_user_id, credential_attribution_project_id,
             credential_attribution_source, created_at, updated_at
           )
           VALUES (
             'parent-task-1', 'project-1', 'user-1', 'Parent task',
             'Parent task', 'in_progress', 0, 'task', 0, 'user',
             'user-1', 'user-1', 'project-1', 'project',
             '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'
           )`
        )
        .run();

      const env = {
        DATABASE: createSqliteD1WithBindLimit(sqlite, 100),
        BASE_DOMAIN: 'sammy.party',
        BRANCH_NAME_PREFIX: 'sam/',
        BRANCH_NAME_MAX_LENGTH: '60',
        COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'false',
      } as Env;
      await ensureDefaultCapacityPoolsForExistingCredentials(drizzle(env.DATABASE, { schema }), {
        userId: 'user-1',
        projectId: 'project-1',
        includeInstallation: false,
      });
      const tokenData: McpTokenData = {
        taskId: 'parent-task-1',
        projectId: 'project-1',
        userId: 'user-1',
        workspaceId: 'workspace-1',
        createdAt: '2026-09-07T00:00:00.000Z',
      };

      const response = await handleDispatchTask(
        1,
        {
          description: 'Dispatch layered child task',
          agentProfileId: 'profile-1',
          skillId: 'skill-1',
        },
        tokenData,
        env
      );

      expect(response.error).toBeUndefined();
      const taskRow = sqlite
        .prepare(
          `SELECT resource_requirements_json, resource_requirement_plan_json,
            resource_requirements_source, resolved_reservation_json
           FROM tasks
           WHERE parent_task_id = 'parent-task-1'`
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

  it('rejects removed project members before HTTP MCP dispatch side effects', async () => {
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
      seedCloudCredential(sqlite, {
        id: 'project-cloud-1',
        userId: 'owner-1',
        projectId: 'project-1',
      });
      sqlite
        .prepare(
          `INSERT INTO tasks (
             id, project_id, user_id, title, description, status, priority,
             task_mode, dispatch_depth, triggered_by, created_by,
             created_at, updated_at
           )
           VALUES (
             'parent-task-1', 'project-1', 'removed-1', 'Parent task',
             'Parent task', 'in_progress', 0, 'task', 0, 'user',
             'removed-1', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'
           )`
        )
        .run();

      const env = {
        DATABASE: createSqliteD1WithBindLimit(sqlite, 100),
        BASE_DOMAIN: 'sammy.party',
        BRANCH_NAME_PREFIX: 'sam/',
        BRANCH_NAME_MAX_LENGTH: '60',
        COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'false',
      } as Env;
      const tokenData: McpTokenData = {
        taskId: 'parent-task-1',
        projectId: 'project-1',
        userId: 'removed-1',
        workspaceId: 'workspace-1',
        createdAt: '2026-09-07T00:00:00.000Z',
      };

      const response = await handleDispatchTask(
        1,
        { description: 'Should not dispatch' },
        tokenData,
        env
      );

      expect(response.error?.message).toContain('Project');
      expect(mocks.generateTaskTitle).not.toHaveBeenCalled();
      expect(mocks.createSession).not.toHaveBeenCalled();
      expect(mocks.persistMessage).not.toHaveBeenCalled();
      expect(mocks.requireRepositoryOwnerAccess).not.toHaveBeenCalled();
      expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
      expect(
        sqlite.prepare("SELECT COUNT(*) AS count FROM tasks WHERE parent_task_id = 'parent-task-1'").get()
      ).toEqual({ count: 0 });
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 });
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
      sqlite
        .prepare(
          `INSERT INTO tasks (
             id, project_id, user_id, title, description, status, priority,
             task_mode, dispatch_depth, triggered_by, created_by,
             created_at, updated_at
           )
           VALUES (
             'parent-task-1', 'project-1', 'member-1', 'Parent task',
             'Parent task', 'in_progress', 0, 'task', 0, 'user',
             'member-1', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'
           )`
        )
        .run();

      const env = {
        DATABASE: createSqliteD1WithBindLimit(sqlite, 100),
        BASE_DOMAIN: 'sammy.party',
        BRANCH_NAME_PREFIX: 'sam/',
        BRANCH_NAME_MAX_LENGTH: '60',
        COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'false',
      } as Env;
      await ensureDefaultCapacityPoolsForExistingCredentials(drizzle(env.DATABASE, { schema }), {
        userId: 'owner-1',
        projectId: 'project-1',
        includeInstallation: false,
      });
      const tokenData: McpTokenData = {
        taskId: 'parent-task-1',
        projectId: 'project-1',
        userId: 'member-1',
        workspaceId: 'workspace-1',
        createdAt: '2026-09-07T00:00:00.000Z',
      };

      const response = await handleDispatchTask(
        1,
        { description: 'Active member dispatch' },
        tokenData,
        env
      );

      expect(response.error).toBeUndefined();
      const taskRow = sqlite
        .prepare(
          `SELECT user_id, credential_attribution_user_id, credential_attribution_project_id,
            credential_attribution_source, placement_credential_source
           FROM tasks
           WHERE parent_task_id = 'parent-task-1'`
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
});
