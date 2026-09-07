import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { findNodeWithCapacity } from '../../src/durable-objects/task-runner/node-selection';
import { reserveWorkspacePlacement } from '../../src/services/workspace-placement';
import { aggregateWorkspaceReservationRows } from '../../src/services/workspace-resource-capacity';
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

function interceptDatabase(
  statements: string[],
  options: {
    transformSql?: (sql: string) => string;
    transformBinds?: (values: unknown[]) => unknown[];
  } = {}
): D1Database {
  return {
    prepare(sql: string) {
      statements.push(sql);
      const statement = env.DATABASE.prepare(options.transformSql?.(sql) ?? sql);
      return {
        bind(...values: unknown[]) {
          return statement.bind(...(options.transformBinds?.(values) ?? values));
        },
      } as D1PreparedStatement;
    },
  } as D1Database;
}

function removeAggregateResourcePredicates(sql: string): string {
  const patterns = [
    /active\.cpu_millis\s*\+\s*requested\.cpu_millis\s*<=\s*n\.provider_instance_vcpu_count\s*\*\s*1000/,
    /active\.memory_mb\s*\+\s*requested\.memory_mb\s*<=\s*n\.provider_instance_memory_mb/,
    /active\.disk_mb\s*\+\s*requested\.disk_mb\s*<=\s*n\.provider_instance_disk_gb\s*\*\s*1024/,
  ];
  let mutated = sql;
  for (const pattern of patterns) {
    if (!pattern.test(mutated)) throw new Error(`mutation target not found: ${pattern.source}`);
    mutated = mutated.replace(pattern, '1 = 1');
  }
  return mutated;
}

function assertExactReservationSnapshot(
  actual: string | null | undefined,
  expected: ReturnType<typeof reservation>
): void {
  if (actual !== JSON.stringify(expected)) {
    throw new Error('persisted reservation changed after placement resolution');
  }
}

function assertUsageWithinSmallNode(rows: Array<{ resolvedReservationJson: string | null }>): void {
  const usage = aggregateWorkspaceReservationRows(rows);
  if (usage.cpuMillis > 2_000) throw new Error('CPU overcommit detected');
  if (usage.memoryMb > 4_096) throw new Error('memory overcommit detected');
  if (usage.diskMb > 40_960) throw new Error('disk overcommit detected');
}

describe('workspace resource-capacity D1 races', () => {
  it('uses one final D1 statement and persists exact placement snapshots', async () => {
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

    const statements: string[] = [];
    await expect(
      reserveWorkspacePlacement(
        interceptDatabase(statements),
        placement(workspaceId, nodeId, {
          vmSize: 'large',
          resolvedReservation,
          capacityPlacementSnapshot: snapshot,
        }),
        2
      )
    ).resolves.toBe(true);

    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^WITH requested_reservation AS/);
    expect(statements[0]).toContain('INSERT INTO workspaces');
    expect(statements[0]).toContain('FROM nodes n, requested_reservation requested');

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
    });
    assertExactReservationSnapshot(row?.resolved_reservation_json, resolvedReservation);
  });

  it('calibrates the exact-snapshot assertion against a bind mutation', async () => {
    const nodeId = 'node-vm-reservation-mutated-snapshot';
    const workspaceId = 'workspace-vm-reservation-mutated-snapshot';
    const exact = reservation({ source: 'task', sourceId: 'task-exact-before-async-work' });
    const expectedJson = JSON.stringify(exact);
    const mutatedJson = JSON.stringify({ ...exact, sourceId: 're-resolved-too-late' });
    await makeReadyNode(nodeId, VM_ADMISSION_USER_ID, 'large');

    await expect(
      reserveWorkspacePlacement(
        interceptDatabase([], {
          transformBinds: (values) =>
            values.map((value) => (value === expectedJson ? mutatedJson : value)),
        }),
        placement(workspaceId, nodeId, {
          vmSize: 'large',
          resolvedReservation: exact,
        }),
        2
      )
    ).resolves.toBe(true);

    const row = await env.DATABASE.prepare(
      `SELECT resolved_reservation_json AS resolvedReservationJson FROM workspaces WHERE id = ?`
    )
      .bind(workspaceId)
      .first<{ resolvedReservationJson: string | null }>();
    expect(() => assertExactReservationSnapshot(row?.resolvedReservationJson, exact)).toThrow(
      /changed after placement resolution/
    );
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

  it('calibrates the aggregate invariant against removal of all resource CAS predicates', async () => {
    const nodeId = 'node-vm-reservation-mutated-cas';
    await makeReadyNode(nodeId, VM_ADMISSION_USER_ID, 'small');
    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-reservation-mutated-cas-existing', nodeId, {
          vmSize: 'small',
        }),
        3
      )
    ).resolves.toBe(true);

    const statements: string[] = [];
    await expect(
      reserveWorkspacePlacement(
        interceptDatabase(statements, { transformSql: removeAggregateResourcePredicates }),
        placement('workspace-vm-reservation-mutated-cas-overflow', nodeId, {
          vmSize: 'small',
        }),
        3
      )
    ).resolves.toBe(true);
    expect(statements).toHaveLength(1);

    const rows = await env.DATABASE.prepare(
      `SELECT resolved_reservation_json AS resolvedReservationJson
       FROM workspaces
       WHERE node_id = ? AND status IN ('running', 'creating', 'recovery')`
    )
      .bind(nodeId)
      .all<{ resolvedReservationJson: string | null }>();
    expect(() => assertUsageWithinSmallNode(rows.results)).toThrow(/overcommit detected/);
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
