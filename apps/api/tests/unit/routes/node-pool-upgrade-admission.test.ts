import { describe, expect, it } from 'vitest';

import { ensureSessionRecovery } from '../../../src/services/session-recovery';
import { seedCloudCredential } from './capacity-pool-test-seeds';
import {
  assertReserved,
  fixture,
  reserve,
  type Scope,
  seedHost,
  select,
} from './node-pool-upgrade-test-helpers';

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
    const original = await f.run({
      resourceRequirements: { minVcpu: 1, minMemoryGb: 1, minDiskGb: 2 },
    });
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
        JSON.stringify({ minVcpu: 64, minMemoryGb: 128, minDiskGb: 1000 }),
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
