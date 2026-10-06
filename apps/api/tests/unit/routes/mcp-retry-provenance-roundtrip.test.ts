/**
 * Finding 3, through the REAL retry_subtask handler.
 *
 * A retry re-reads the failed child's persisted plan and re-persists it on the
 * replacement task. The stored-reservation normalizer dropped `diagnostics` and
 * per-field `compatibility`, so a no-op retry silently erased the legacy vm-size
 * translation audit trail from the row and from the TaskRunner payload.
 */
import {
  type ResolvedResourceReservation,
  resolveResourceReservation,
} from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { McpTokenData } from '../../../src/routes/mcp/_helpers';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../../src/services/default-capacity-pools';
import { createPersistedTaskResourcePlanJson } from '../../../src/services/resource-requirements-input';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';
import { seedCloudCredential, seedProjectWithMember, seedUser } from './capacity-pool-test-seeds';

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

const TOKEN: McpTokenData = {
  taskId: 'parent-task-1',
  projectId: 'project-1',
  userId: 'user-1',
  workspaceId: 'workspace-1',
  createdAt: '2026-09-07T00:00:00.000Z',
};

function seedTask(
  sqlite: Database.Database,
  input: {
    id: string;
    parentTaskId: string | null;
    status: string;
    planJson?: string | null;
    reservationJson?: string | null;
  }
): void {
  sqlite
    .prepare(
      `INSERT INTO tasks (
         id, project_id, user_id, parent_task_id, title, description, status, priority,
         task_mode, dispatch_depth, triggered_by, created_by,
         resource_requirement_plan_json, resolved_reservation_json, created_at, updated_at
       )
       VALUES (?, 'project-1', 'user-1', ?, ?, ?, ?, 0, 'task', 1, 'mcp', 'user-1', ?, ?,
         '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z')`
    )
    .run(
      input.id,
      input.parentTaskId,
      `Task ${input.id}`,
      `Description ${input.id}`,
      input.status,
      input.planJson ?? null,
      input.reservationJson ?? null
    );
}

/** A reservation whose fields were translated by the legacy vm-size adapter. */
function legacyAdapterReservation(): ResolvedResourceReservation {
  const reservation = resolveResourceReservation(
    {},
    { taskId: 'child-1', projectId: 'project-1', userId: 'user-1' },
    { legacyVmSizes: { project: 'medium' } }
  );
  // Fixture guard — without these the roundtrip assertions prove nothing.
  expect(reservation.diagnostics?.length ?? 0).toBeGreaterThan(0);
  expect(reservation.fieldProvenance?.minVcpu?.compatibility).toBeDefined();
  return reservation;
}

describe('retry_subtask preserves full reservation provenance on the replacement task', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSession.mockResolvedValue('session-retry');
    mocks.persistMessage.mockResolvedValue(undefined);
    mocks.stopSession.mockResolvedValue(undefined);
    mocks.startTaskRunnerDO.mockResolvedValue(undefined);
    mocks.generateTaskTitle.mockResolvedValue('Retry task title');
  });

  it('carries diagnostics and per-field compatibility into the persisted replacement row', async () => {
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

      const reservation = legacyAdapterReservation();
      seedTask(sqlite, { id: 'parent-task-1', parentTaskId: null, status: 'in_progress' });
      seedTask(sqlite, {
        id: 'child-1',
        parentTaskId: 'parent-task-1',
        status: 'failed',
        planJson: createPersistedTaskResourcePlanJson({
          layers: {},
          resolvedReservation: reservation,
          requestedVmSize: 'medium',
          requestedVmSizeSource: 'project',
        }),
        reservationJson: JSON.stringify(reservation),
      });

      const response = await handleRetrySubtask(1, { taskId: 'child-1' }, TOKEN, env);
      expect(response.error).toBeUndefined();

      const replacement = sqlite
        .prepare(
          `SELECT resolved_reservation_json, resource_requirement_plan_json
             FROM tasks WHERE parent_task_id = 'parent-task-1' AND id != 'child-1'`
        )
        .get() as {
        resolved_reservation_json: string;
        resource_requirement_plan_json: string;
      };

      const persisted = JSON.parse(
        replacement.resolved_reservation_json
      ) as ResolvedResourceReservation;
      expect(persisted.diagnostics).toEqual(reservation.diagnostics);
      expect(persisted.fieldProvenance?.minVcpu?.compatibility).toEqual(
        reservation.fieldProvenance?.minVcpu?.compatibility
      );
      // A no-op retry is a fixed point on the whole reservation, not just the
      // numeric fields.
      expect(persisted).toEqual(reservation);

      const planReservation = (
        JSON.parse(replacement.resource_requirement_plan_json) as {
          resolvedReservation: ResolvedResourceReservation;
        }
      ).resolvedReservation;
      expect(planReservation).toEqual(reservation);

      // The runner receives the same complete reservation the row records.
      expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
        env,
        expect.objectContaining({ resolvedReservation: reservation })
      );
    } finally {
      sqlite.close();
    }
  });
});
