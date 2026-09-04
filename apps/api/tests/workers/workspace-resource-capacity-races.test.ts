import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { findNodeWithCapacity } from '../../src/durable-objects/task-runner/node-selection';
import { reserveWorkspacePlacement } from '../../src/services/workspace-placement';
import { seedWorkspace } from './helpers/seed-d1';
import {
  assignNodeCapacity,
  capacitySnapshot,
  createIsolatedPlacementScope,
  makeReadyNode,
  placement,
  reservation,
  seedVmAdmissionPlacementScope,
  selectorContext,
  taskState,
  VM_ADMISSION_PROJECT_ID,
  VM_ADMISSION_USER_ID,
} from './helpers/vm-workspace-placement';

beforeAll(seedVmAdmissionPlacementScope);

describe('workspace resource-capacity D1 races', () => {
  it('persists capacity and resolved reservation snapshots during final reservation', async () => {
    const nodeId = 'node-vm-admission-capacity-snapshot';
    const workspaceId = 'workspace-vm-admission-capacity-snapshot';
    const snapshot = capacitySnapshot({
      poolId: 'pool-vm-admission-project',
      sourceId: 'source-vm-admission-project',
      candidateId: 'candidate-vm-admission-project',
      scope: 'project',
      projectId: VM_ADMISSION_PROJECT_ID,
    });
    await makeReadyNode(nodeId, VM_ADMISSION_USER_ID, 'large');
    await assignNodeCapacity(nodeId, snapshot);
    const resolvedReservation = reservation({
      cpuMillis: 3_000,
      memoryMb: 6_144,
      source: 'task',
      sourceId: 'task-capacity-snapshot',
    });

    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement(workspaceId, nodeId, {
          vmSize: 'large',
          resolvedReservation,
          capacityPlacementSnapshot: snapshot,
        }),
        2
      )
    ).resolves.toBe(true);

    const row = await env.DATABASE.prepare(
      `SELECT capacity_pool_id, capacity_pool_scope, capacity_source_id,
              capacity_pool_candidate_id, capacity_pool_project_id, workload_role,
              placement_explanation_json, resolved_reservation_json
       FROM workspaces
       WHERE id = ?`
    )
      .bind(workspaceId)
      .first<{
        capacity_pool_id: string | null;
        capacity_pool_scope: string | null;
        capacity_source_id: string | null;
        capacity_pool_candidate_id: string | null;
        capacity_pool_project_id: string | null;
        workload_role: string | null;
        placement_explanation_json: string | null;
        resolved_reservation_json: string | null;
      }>();

    expect(row).toMatchObject({
      capacity_pool_id: snapshot.capacityPoolId,
      capacity_pool_scope: 'project',
      capacity_source_id: snapshot.capacitySourceId,
      capacity_pool_candidate_id: snapshot.capacityPoolCandidateId,
      capacity_pool_project_id: VM_ADMISSION_PROJECT_ID,
      workload_role: 'workspace',
      placement_explanation_json: snapshot.placementExplanationJson,
      resolved_reservation_json: JSON.stringify(resolvedReservation),
    });
  });

  it('rejects cx23 overpacking in reusable selection and the final reservation CAS', async () => {
    const scope = await createIsolatedPlacementScope('cx23');
    const nodeId = 'node-vm-reservation-cx23';
    await makeReadyNode(nodeId, scope.userId, 'small');
    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-reservation-cx23-first', nodeId, {
          ...scope,
          resolvedReservation: reservation(),
          vmSize: 'small',
        }),
        3
      )
    ).resolves.toBe(true);

    await expect(
      findNodeWithCapacity(
        taskState(scope.userId, 'small', {
          ...scope,
          resolvedReservation: reservation(),
        }),
        selectorContext()
      )
    ).resolves.toBeNull();
    for (const suffix of ['second', 'third']) {
      await expect(
        reserveWorkspacePlacement(
          env.DATABASE,
          placement(`workspace-vm-reservation-cx23-${suffix}`, nodeId, {
            ...scope,
            resolvedReservation: reservation(),
            vmSize: 'small',
          }),
          3
        )
      ).resolves.toBe(false);
    }
  });

  it('admits only aggregate reservation combinations that fit a larger node', async () => {
    const nodeId = 'node-vm-reservation-large-aggregate';
    await makeReadyNode(nodeId, VM_ADMISSION_USER_ID, 'large');

    for (let index = 0; index < 4; index += 1) {
      await expect(
        reserveWorkspacePlacement(
          env.DATABASE,
          placement(`workspace-vm-reservation-large-${index}`, nodeId),
          10
        )
      ).resolves.toBe(true);
    }
    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-reservation-large-overflow', nodeId),
        10
      )
    ).resolves.toBe(false);
  });

  it('atomically grants exactly one contender the final declared resources', async () => {
    const nodeId = 'node-vm-reservation-last-capacity';
    await makeReadyNode(nodeId, VM_ADMISSION_USER_ID, 'medium');
    await seedWorkspace(
      'workspace-vm-reservation-last-capacity-existing',
      nodeId,
      VM_ADMISSION_USER_ID,
      {
        projectId: VM_ADMISSION_PROJECT_ID,
        status: 'running',
        resolvedReservationJson: JSON.stringify(reservation()),
      }
    );

    const outcomes = await Promise.all([
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-reservation-last-capacity-a', nodeId),
        3
      ),
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-reservation-last-capacity-b', nodeId),
        3
      ),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });

  it('enforces exclusive reservations in selection and final reservation', async () => {
    const occupiedScope = await createIsolatedPlacementScope('exclusive-occupied');
    const occupiedNode = 'node-vm-reservation-exclusive-occupied';
    await makeReadyNode(occupiedNode, occupiedScope.userId, 'large');
    await seedWorkspace(
      'workspace-vm-reservation-exclusive-occupant',
      occupiedNode,
      occupiedScope.userId,
      {
        projectId: occupiedScope.projectId,
        status: 'running',
        resolvedReservationJson: JSON.stringify(reservation()),
      }
    );
    const exclusive = reservation({ exclusiveNode: true, maxCoTenants: 1 });

    await expect(
      findNodeWithCapacity(
        taskState(occupiedScope.userId, 'small', {
          ...occupiedScope,
          resolvedReservation: exclusive,
        }),
        selectorContext()
      )
    ).resolves.toBeNull();
    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-reservation-exclusive-denied', occupiedNode, {
          ...occupiedScope,
          resolvedReservation: exclusive,
        }),
        10
      )
    ).resolves.toBe(false);

    await env.DATABASE.prepare(`UPDATE workspaces SET resolved_reservation_json = ? WHERE id = ?`)
      .bind(JSON.stringify(exclusive), 'workspace-vm-reservation-exclusive-occupant')
      .run();
    await expect(
      findNodeWithCapacity(
        taskState(occupiedScope.userId, 'small', {
          ...occupiedScope,
          resolvedReservation: reservation(),
        }),
        selectorContext()
      )
    ).resolves.toBeNull();

    const emptyNode = 'node-vm-reservation-exclusive-empty';
    await makeReadyNode(emptyNode, VM_ADMISSION_USER_ID, 'large');
    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-reservation-exclusive-first', emptyNode, {
          resolvedReservation: exclusive,
        }),
        10
      )
    ).resolves.toBe(true);
    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-reservation-after-exclusive', emptyNode),
        10
      )
    ).resolves.toBe(false);
  });

  it('fails closed on legacy reservations while preserving one empty-node placement', async () => {
    const scope = await createIsolatedPlacementScope('legacy-data');
    const nullNode = 'node-vm-reservation-null-legacy';
    const malformedNode = 'node-vm-reservation-malformed-legacy';
    const missingDiskNode = 'node-vm-reservation-missing-disk-legacy';
    await makeReadyNode(nullNode, scope.userId, 'large');
    await makeReadyNode(malformedNode, scope.userId, 'large');
    await makeReadyNode(missingDiskNode, scope.userId, 'large');
    await seedWorkspace('workspace-vm-reservation-null-legacy', nullNode, scope.userId, {
      projectId: scope.projectId,
      status: 'running',
      resolvedReservationJson: null,
    });
    await seedWorkspace('workspace-vm-reservation-malformed-legacy', malformedNode, scope.userId, {
      projectId: scope.projectId,
      status: 'running',
      resolvedReservationJson: '{broken',
    });
    await seedWorkspace(
      'workspace-vm-reservation-missing-disk-legacy',
      missingDiskNode,
      scope.userId,
      {
        projectId: scope.projectId,
        status: 'running',
        resolvedReservationJson: JSON.stringify(reservation()),
      }
    );
    await env.DATABASE.prepare(`UPDATE nodes SET provider_instance_disk_gb = NULL WHERE id = ?`)
      .bind(missingDiskNode)
      .run();

    await expect(
      findNodeWithCapacity(
        taskState(scope.userId, 'small', {
          ...scope,
          resolvedReservation: reservation(),
        }),
        selectorContext()
      )
    ).resolves.toBeNull();
    for (const [workspaceId, nodeId] of [
      ['workspace-vm-reservation-after-null', nullNode],
      ['workspace-vm-reservation-after-malformed', malformedNode],
      ['workspace-vm-reservation-after-missing-disk', missingDiskNode],
    ]) {
      await expect(
        reserveWorkspacePlacement(env.DATABASE, placement(workspaceId, nodeId, { ...scope }), 10)
      ).resolves.toBe(false);
    }

    const emptyLegacyNode = 'node-vm-reservation-empty-legacy';
    await makeReadyNode(emptyLegacyNode, scope.userId, 'large');
    await env.DATABASE.prepare(
      `UPDATE nodes
       SET provider_instance_type = NULL,
           provider_instance_vcpu_count = NULL,
           provider_instance_memory_mb = NULL,
           provider_instance_disk_gb = NULL
       WHERE id = ?`
    )
      .bind(emptyLegacyNode)
      .run();
    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-reservation-empty-legacy-first', emptyLegacyNode, { ...scope }),
        10
      )
    ).resolves.toBe(true);
    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-reservation-empty-legacy-second', emptyLegacyNode, { ...scope }),
        10
      )
    ).resolves.toBe(false);
  });
});
