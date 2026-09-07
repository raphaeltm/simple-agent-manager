import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveResourceReservation } from '@simple-agent-manager/shared';
import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { McpTokenData } from '../../../src/routes/mcp/_helpers';
import { createPersistedTaskResourcePlanJson } from '../../../src/services/resource-requirements-input';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../../src/services/default-capacity-pools';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';
import {
  seedCloudCredential,
  seedProjectWithMember,
  seedUser,
} from './capacity-pool-test-seeds';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  persistMessage: vi.fn(),
  stopSession: vi.fn(),
  startTaskRunnerDO: vi.fn(),
  generateTaskTitle: vi.fn(),
}));

vi.mock('../../../src/services/project-data', () => ({
  createSession: mocks.createSession,
  persistMessage: mocks.persistMessage,
  stopSession: mocks.stopSession,
}));

vi.mock('../../../src/services/task-runner-do', () => ({
  startTaskRunnerDO: mocks.startTaskRunnerDO,
}));

vi.mock('../../../src/services/task-title', () => ({
  generateTaskTitle: mocks.generateTaskTitle,
  getTaskTitleConfig: vi.fn(() => ({})),
}));

const { handleRetrySubtask } = await import('../../../src/routes/mcp/orchestration-tools');

function createEnv(sqlite: Database.Database): Env {
  return {
    DATABASE: createSqliteD1WithBindLimit(sqlite, 100),
    BASE_DOMAIN: 'sammy.party',
    BRANCH_NAME_PREFIX: 'sam/',
    BRANCH_NAME_MAX_LENGTH: '60',
    COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'false',
  } as Env;
}

function seedTask(
  sqlite: Database.Database,
  input: {
    id: string;
    parentTaskId?: string | null;
    status: string;
    resourceRequirementPlanJson?: string | null;
    resourceRequirementsJson?: string | null;
    resourceRequirementsSource?: string | null;
    resolvedReservationJson?: string | null;
    requestedVmSize?: string | null;
    requestedVmSizeSource?: string | null;
  }
): void {
  sqlite
    .prepare(
      `INSERT INTO tasks (
         id, project_id, user_id, parent_task_id, title, description, status, priority,
         task_mode, dispatch_depth, triggered_by, created_by, resource_requirement_plan_json,
         resource_requirements_json, resource_requirements_source, resolved_reservation_json,
         requested_vm_size, requested_vm_size_source, created_at, updated_at
       )
       VALUES (
         ?, 'project-1', 'user-1', ?, ?, ?, ?, 0, 'task', 1, 'mcp', 'user-1',
         ?, ?, ?, ?, ?, ?, '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'
       )`
    )
    .run(
      input.id,
      input.parentTaskId ?? null,
      `Task ${input.id}`,
      `Description ${input.id}`,
      input.status,
      input.resourceRequirementPlanJson ?? null,
      input.resourceRequirementsJson ?? null,
      input.resourceRequirementsSource ?? null,
      input.resolvedReservationJson ?? null,
      input.requestedVmSize ?? null,
      input.requestedVmSizeSource ?? null
    );
}

describe('MCP retry_subtask resource plan persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSession.mockResolvedValue('session-retry');
    mocks.persistMessage.mockResolvedValue(undefined);
    mocks.stopSession.mockResolvedValue(undefined);
    mocks.startTaskRunnerDO.mockResolvedValue(undefined);
    mocks.generateTaskTitle.mockResolvedValue('Retry task title');
  });

  it('preserves the failed child resource plan and provenance in the replacement task', async () => {
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
      const env = createEnv(sqlite);
      await ensureDefaultCapacityPoolsForExistingCredentials(drizzle(env.DATABASE, { schema }), {
        userId: 'user-1',
        projectId: 'project-1',
        includeInstallation: false,
      });

      seedTask(sqlite, { id: 'parent-task-1', parentTaskId: null, status: 'in_progress' });
      const storedLayers = {
        skill: { minVcpu: 4 },
        agentProfile: { minMemoryGb: 12 },
        project: { minDiskGb: 0, exclusiveNode: false },
      };
      const storedReservation = resolveResourceReservation(storedLayers, {
        taskId: 'child-1',
        skillId: 'skill-1',
        agentProfileId: 'profile-1',
        projectId: 'project-1',
        userId: 'user-1',
      });
      seedTask(sqlite, {
        id: 'child-1',
        parentTaskId: 'parent-task-1',
        status: 'failed',
        resourceRequirementPlanJson: createPersistedTaskResourcePlanJson({
          layers: storedLayers,
          resolvedReservation: storedReservation,
          requestedVmSize: 'small',
          requestedVmSizeSource: 'project',
        }),
        resourceRequirementsJson: JSON.stringify({ minVcpu: 4 }),
        resourceRequirementsSource: 'skill',
        resolvedReservationJson: JSON.stringify(storedReservation),
        requestedVmSize: 'small',
        requestedVmSizeSource: 'project',
      });

      const tokenData: McpTokenData = {
        taskId: 'parent-task-1',
        projectId: 'project-1',
        userId: 'user-1',
        workspaceId: 'workspace-1',
        createdAt: '2026-09-07T00:00:00.000Z',
      };

      const response = await handleRetrySubtask(
        1,
        { taskId: 'child-1', newDescription: 'Retry with same resources' },
        tokenData,
        env
      );

      expect(response.error).toBeUndefined();
      const replacement = sqlite
        .prepare(
          `SELECT resource_requirements_json, resource_requirement_plan_json,
            resource_requirements_source, resolved_reservation_json
           FROM tasks
           WHERE parent_task_id = 'parent-task-1' AND id != 'child-1'`
        )
        .get() as {
        resource_requirements_json: string | null;
        resource_requirement_plan_json: string;
        resource_requirements_source: string | null;
        resolved_reservation_json: string;
      };

      expect(JSON.parse(replacement.resource_requirements_json ?? '{}')).toEqual({ minVcpu: 4 });
      expect(replacement.resource_requirements_source).toBe('skill');
      const plan = JSON.parse(replacement.resource_requirement_plan_json) as {
        intent: Record<string, unknown>;
      };
      expect(plan.intent).toMatchObject({
        skill: { minVcpu: 4 },
        agentProfile: { minMemoryGb: 12 },
        project: { minDiskGb: 0, exclusiveNode: false },
      });
      const reservation = JSON.parse(replacement.resolved_reservation_json) as {
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
      expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
        env,
        expect.objectContaining({
          resourceRequirements: { minVcpu: 4 },
          resolvedReservation: expect.objectContaining({
            cpuMillis: 4000,
            memoryMb: 12 * 1024,
            diskMb: 0,
            exclusiveNode: false,
          }),
        })
      );
    } finally {
      sqlite.close();
    }
  });
});
