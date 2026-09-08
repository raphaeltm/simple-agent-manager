import { describe, expect, it } from 'vitest';

import { applyCapacityCandidateProvisioningTarget } from '../../../src/durable-objects/task-runner/node-provisioning-target';
import type { TaskRunnerState } from '../../../src/durable-objects/task-runner/types';
import { assertNodeAllocationPlanCurrent, createNodeRecord } from '../../../src/services/nodes';
import { ensureSessionRecovery } from '../../../src/services/session-recovery';
import { seedCloudCredential } from './capacity-pool-test-seeds';
import {
  assertReserved,
  type Fixture,
  fixture,
  reserve,
  type Scope,
  seedHost,
  select,
  snapshotFor,
} from './node-pool-upgrade-test-helpers';

async function createSelectedNode(f: Fixture, state: TaskRunnerState) {
  const candidate = state.config.capacityPoolSelection!.candidates[0]!;
  applyCapacityCandidateProvisioningTarget(state, candidate);
  const node = await createNodeRecord(f.env, {
    userId: state.userId,
    name: 'Fresh recovery node',
    vmSize: state.config.vmSize,
    vmLocation: state.config.vmLocation,
    cloudProvider: state.config.cloudProvider ?? undefined,
    heartbeatStaleAfterSeconds: 300,
    providerInstanceType: state.config.providerInstanceType,
    providerInstanceBootDiskSizeGb: state.config.providerInstanceBootDiskSizeGb,
    providerInstanceImage: state.config.providerInstanceImage,
    providerInstanceArchitecture: state.config.providerInstanceArchitecture,
    capacityPlacementSnapshot: state.stepResults.capacityPlacementSnapshot,
  });
  return node;
}

describe('old node-pool requests through TaskRunner admission', () => {
  it.each<Scope>(['installation', 'user', 'project'])(
    'admits a legacy saved task using only its %s credential with exact attribution',
    async (scope) => {
      const f = fixture(scope);
      const start = await f.run();
      const snapshot = await seedHost(f, start);
      expect(snapshot.capacityPoolScope).toBe(scope);
      expect(snapshot.placementCredentialSource).toBe(
        scope === 'installation' ? 'platform' : scope
      );
      expect(
        start.config.resolvedReservation?.fieldProvenance?.minVcpu?.compatibility?.legacyVmSize
      ).toBe('small');
      expect(await select(f, start)).toMatchObject({ nodeId: 'host' });
      expect(await reserve(f, start, snapshot)).toBe(true);
      assertReserved(f, start, snapshot);
      if (scope === 'installation')
        expect(f.sqlite.prepare('SELECT count(*) count FROM credentials').get()).toEqual({
          count: 0,
        });
      expect(
        f.sqlite.prepare('SELECT count(*) count FROM tasks WHERE id = ?').get('task-1')
      ).toEqual({ count: 1 });
    }
  );

  it('keeps explicit modern fields above a contradictory old size through final reservation', async () => {
    const f = fixture();
    const start = await f.run({
      resourceRequirements: { minVcpu: 1, minMemoryGb: 1, minDiskGb: 2 },
    });
    const snapshot = await seedHost(f, start);
    expect(start.config.resolvedReservation).toMatchObject({
      cpuMillis: 1000,
      memoryMb: 1024,
      diskMb: 2048,
    });
    expect(await reserve(f, start, snapshot)).toBe(true);
    assertReserved(f, start, snapshot);
  });

  it('shares project credential access while rejecting another member’s node at selection and final admission', async () => {
    const f = fixture('project');
    const start = await f.run();
    const snapshot = await seedHost(f, start, 'other-member-host', 'owner');
    expect(snapshot.placementCredentialReference).toBe('credentials:cloud');
    expect(await select(f, start)).toBeNull();
    expect(await reserve(f, start, snapshot, 'other-member-host')).toBe(false);
    await seedHost(f, start);
    expect(await select(f, start)).toMatchObject({ nodeId: 'host' });
    expect(await reserve(f, start, snapshot)).toBe(true);
  });

  it('wakes an old sleeping session with its persisted reservation after project defaults change, then admits it on the same source', async () => {
    const f = fixture();
    f.sqlite.prepare('UPDATE projects SET resource_requirements_json = ? WHERE id = ?')
      .run(JSON.stringify({ minMemoryGb: 1 }), 'project-1');
    f.sqlite.exec('UPDATE tasks SET requested_vm_size = NULL, requested_vm_size_source = NULL');
    const original = await f.run({
      resourceRequirements: { minVcpu: 1, minDiskGb: 2 },
    });
    expect(original.config.resolvedReservation).toMatchObject({ memoryMb: 1024 });
    const originalSnapshot = await seedHost(f, original, 'sleeping-host');
    expect(
      await reserve(f, original, originalSnapshot, 'sleeping-host', 'sleeping-workspace')
    ).toBe(true);
    f.sqlite.exec(`UPDATE workspaces SET status = 'sleeping', chat_session_id = 'chat-1',
      runtime_deletion_confirmed_at = '2026-09-07T00:00:00Z' WHERE id = 'sleeping-workspace';
      UPDATE nodes SET status = 'stopped', runtime_termination_confirmed_at = '2026-09-07T00:00:00Z' WHERE id = 'sleeping-host';
      UPDATE tasks SET status = 'awaiting_followup', workspace_id = 'sleeping-workspace', chat_session_id = 'chat-1' WHERE id = 'task-1';
      INSERT INTO session_snapshots (id, workspace_id, node_id, project_id, user_id, chat_session_id,
        agent_session_id, runtime, status, degradation, manifest_r2_key, manifest_json,
        snapshot_generation, expires_at, sleep_status, sleeping_at, recovery_attempts, updated_at)
      VALUES ('snapshot-1', 'sleeping-workspace', 'sleeping-host', 'project-1', 'user-1', 'chat-1',
        'old-agent-session', 'vm', 'available', 'none', 'snapshots/chat-1/final/manifest.json',
        '{"status":"available","agentType":"claude-code"}', 'final', '2099-09-07T00:00:00Z',
        'sleeping', '2026-09-07T00:00:00Z', 0, '2026-09-07T00:00:00Z')`);
    f.sqlite
      .prepare(
        'UPDATE projects SET default_vm_size = ?, resource_requirements_json = ? WHERE id = ?'
      )
      .run(
        'large',
        JSON.stringify({ minMemoryGb: 2 }),
        'project-1'
      );
    const historicalNode = f.sqlite
      .prepare('SELECT * FROM nodes WHERE id = ?')
      .get('sleeping-host');
    const historicalWorkspace = f.sqlite
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get('sleeping-workspace');
    const result = await ensureSessionRecovery(f.env, 'project-1', 'chat-1');
    expect(result).toMatchObject({ status: 'waking' });
    expect(f.starts).toHaveLength(2);
    const wake = f.starts[1]!;
    expect(wake.config.resumeSnapshotChatSessionId).toBe('chat-1');
    expect(wake.config.resolvedReservation).toEqual(original.config.resolvedReservation);
    expect(wake.config.resolvedReservation).toMatchObject({ memoryMb: 1024 });
    const state = { ...wake, stepResults: {} } as TaskRunnerState;
    const freshNode = await createSelectedNode(f, state);
    // Recovery's fresh allocation must preserve the canonical candidate's boot
    // options. Native local disk capacity is not a requested boot-disk override.
    await expect(assertNodeAllocationPlanCurrent(f.env, freshNode.id, 'user-1', 'project-1'))
      .resolves.toBeUndefined();
    expect(state.config.resolvedReservation).toEqual(original.config.resolvedReservation);
    const snapshot = await seedHost(f, wake);
    expect(snapshot.capacityPoolId).toBe(originalSnapshot.capacityPoolId);
    expect(snapshot.capacitySourceId).toBe(originalSnapshot.capacitySourceId);
    expect(snapshot.placementCredentialReference).toBe(
      originalSnapshot.placementCredentialReference
    );
    expect(await select(f, wake)).toMatchObject({ nodeId: 'host' });
    expect(await reserve(f, wake, snapshot)).toBe(true);
    assertReserved(f, wake, snapshot);
    expect(f.sqlite.prepare('SELECT * FROM nodes WHERE id = ?').get('sleeping-host')).toEqual(
      historicalNode
    );
    expect(
      f.sqlite.prepare('SELECT * FROM workspaces WHERE id = ?').get('sleeping-workspace')
    ).toEqual({
      ...(historicalWorkspace as Record<string, unknown>),
      chat_session_id: null,
      updated_at: expect.any(String),
    });
  });

  it.each(['compact', 'snapshot'] as const)('preserves explicit native boot options from a %s candidate through provider allocation authority', async (representation) => {
    const f = fixture();
    const start = await f.run();
    const candidate = start.config.capacityPoolSelection!.candidates[0]!;
    const nativeOptions = {
      providerInstanceBootDiskSizeGb: 30,
      providerInstanceImage: 'ubuntu-24.04',
      providerInstanceArchitecture: 'x86_64',
    };
    f.sqlite.prepare(`UPDATE capacity_pool_candidates SET provider_instance_boot_disk_size_gb = ?,
      provider_instance_image = ?, provider_instance_architecture = ? WHERE id = ?`)
      .run(30, 'ubuntu-24.04', 'x86_64', candidate.id);
    const snapshot = { ...snapshotFor(start), ...nativeOptions };
    if (representation === 'snapshot') {
      candidate.snapshot = snapshot;
      delete candidate.providerInstanceBootDiskSizeGb;
      delete candidate.providerInstanceImage;
      delete candidate.providerInstanceArchitecture;
    } else {
      delete candidate.snapshot;
      Object.assign(candidate, nativeOptions);
    }
    const state = { ...start, stepResults: {} } as TaskRunnerState;
    const node = await createSelectedNode(f, state);
    await expect(assertNodeAllocationPlanCurrent(f.env, node.id, 'user-1', 'project-1'))
      .resolves.toBeUndefined();
    expect(state.config).toMatchObject(nativeOptions);
    expect(state.stepResults.capacityPlacementSnapshot).toMatchObject(nativeOptions);
    f.sqlite.prepare('UPDATE capacity_pools SET revision = revision + 1 WHERE id = ?').run(candidate.poolId);
    await expect(assertNodeAllocationPlanCurrent(f.env, node.id, 'user-1', 'project-1'))
      .rejects.toThrow('Node allocation plan is no longer current');
  });

  it('rejects a queued snapshot after owner removal without rewriting historical hardware or falling through to another credential', async () => {
    const f = fixture('project');
    // A lower-priority personal credential must never turn removal into fallback.
    seedCloudCredential(f.sqlite, { id: 'personal-fallback', userId: 'user-1' });
    const start = await f.run();
    const snapshot = await seedHost(f, start);
    const before = f.sqlite.prepare('SELECT * FROM nodes WHERE id = ?').get('host');
    f.sqlite
      .prepare("UPDATE capacity_pool_candidates SET status = 'deleted' WHERE pool_id = ?")
      .run(snapshot.capacityPoolId);
    f.sqlite
      .prepare('UPDATE capacity_pools SET revision = revision + 1 WHERE id = ?')
      .run(snapshot.capacityPoolId);
    expect(await reserve(f, start, snapshot)).toBe(false);
    expect(f.sqlite.prepare('SELECT * FROM nodes WHERE id = ?').get('host')).toEqual(before);
    expect(f.sqlite.prepare('SELECT count(*) count FROM workspaces').get()).toEqual({ count: 0 });
  });
});
