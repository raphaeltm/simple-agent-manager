import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { requestIncompatiblePoolNodeDrain } from '../../src/durable-objects/task-runner/incompatible-node-drain';
import { findNodeWithCapacity } from '../../src/durable-objects/task-runner/node-selection';
import { handleNodeProvisioning } from '../../src/durable-objects/task-runner/node-steps';
import { claimNodeForCleanup } from '../../src/scheduled/node-cleanup/shared';
import * as nodesService from '../../src/services/nodes';
import { filterReusableNodesByCurrentAuthority } from '../../src/services/reusable-node-authority';
import { markSessionSnapshotSleeping } from '../../src/services/session-snapshots';
import { createIncompatibleCapacityFixture } from '../helpers/incompatible-agent-capacity-fixture';

let fixture: ReturnType<typeof createIncompatibleCapacityFixture>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-05T12:00:00.000Z'));
  fixture = createIncompatibleCapacityFixture();
});
afterEach(() => {
  fixture?.sqlite.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const snapshot = () =>
  fixture.sqlite
    .prepare('SELECT * FROM session_snapshots WHERE chat_session_id = ?')
    .get('old-chat') as Record<string, unknown> | undefined;

describe('incompatible occupied host capacity admission', () => {
  it('queues safe sleep and real admission wait without creating a node beyond the pool limit', async () => {
    const provision = vi.spyOn(nodesService, 'provisionNode');
    await handleNodeProvisioning(fixture.state, fixture.rc);
    expect(JSON.stringify(fixture.state.stepResults.placementDiagnostics)).toContain(
      'Host agent version is incompatible'
    );
    expect(snapshot()).toMatchObject({
      workspace_id: 'old-workspace',
      node_id: 'existing-node',
      sleep_status: 'scheduled',
      sleep_after: new Date().toISOString(),
    });
    expect(
      fixture.sqlite
        .prepare('SELECT state, reason FROM vm_task_admissions WHERE task_id = ?')
        .get('task-1')
    ).toEqual({ state: 'waiting', reason: 'capacity_pool_node_limit' });
    expect(fixture.sqlite.prepare('SELECT status FROM workspaces').get()).toEqual({
      status: 'running',
    });
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM nodes').get()).toEqual({
      count: 1,
    });
    expect(provision).not.toHaveBeenCalled();
    expect(fixture.rc.ctx.storage.setAlarm).toHaveBeenCalledWith(Date.now() + 1000);
  });

  it('admits a replacement only after sleep and guarded cleanup release the occupied slot', async () => {
    const { sqlite, state, rc } = fixture;
    const provision = vi.spyOn(nodesService, 'provisionNode').mockImplementation(async (id) => {
      sqlite
        .prepare("UPDATE nodes SET status='running',agent_version='current-agent' WHERE id=?")
        .run(id);
    });
    await handleNodeProvisioning(state, rc);
    const node = { id: 'existing-node', user_id: 'user-1', status: 'running' };
    expect(await claimNodeForCleanup(rc.env, node, new Date().toISOString())).toBe(false);
    // Model the snapshot/runtime stop boundary's receipt; use the existing sleep
    // lifecycle writer and cleanup ownership CAS, never the drain to release work.
    sqlite.exec(
      "UPDATE session_snapshots SET status='available',degradation='none',snapshot_generation='generation-1'"
    );
    expect(
      await markSessionSnapshotSleeping(drizzle(fixture.database, { schema }), rc.env, 'old-chat')
    ).toBe(true);
    sqlite.exec(
      "UPDATE workspaces SET status='sleeping',runtime_deletion_confirmed_at='2026-10-05T12:00:00.000Z'"
    );
    sqlite.prepare('UPDATE workspaces SET updated_at=?').run(new Date().toISOString());
    expect(await claimNodeForCleanup(rc.env, node, new Date().toISOString())).toBe(false);
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    expect(await claimNodeForCleanup(rc.env, node, new Date().toISOString())).toBe(true);
    // The provider deletion receipt is the external boundary; its confirmed
    // terminal state is what makes the production DB cap permit a replacement.
    sqlite.exec(
      "UPDATE nodes SET status='deleted',runtime_termination_confirmed_at='2026-10-05T12:00:00.000Z' WHERE id='existing-node'"
    );
    vi.advanceTimersByTime(1001);
    await handleNodeProvisioning(state, rc);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(state.stepResults.nodeId).toBeTruthy();
    expect(state.stepResults.nodeId).not.toBe('existing-node');
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM nodes WHERE status IN ('running','creating','destroying') AND capacity_pool_id='pool-1'"
        )
        .get()
    ).toEqual({ count: 1 });
    expect(snapshot()).toMatchObject({
      sleep_status: 'sleeping',
      snapshot_generation: 'generation-1',
    });
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
  });

  it('eligible full host waits to its configured deadline without requesting drain', async () => {
    fixture.rc.env.VM_ADMISSION_WAIT_TIMEOUT_MS = '60000';
    fixture.sqlite.prepare("UPDATE nodes SET agent_version='current-agent'").run();
    fixture.sqlite.prepare('UPDATE workspaces SET resolved_reservation_json=?').run(
      JSON.stringify({
        version: 3,
        cpuMillis: 1000,
        memoryMb: 15872,
        diskMb: 2048,
        exclusiveNode: false,
        source: 'task',
        sourceId: 'old-task',
      })
    );
    expect(
      await filterReusableNodesByCurrentAuthority(fixture.database, {
        userId: 'user-1',
        projectId: 'project-1',
        selections: [
          {
            nodeId: 'existing-node',
            capacityPlacementSnapshot: fixture.state.stepResults.capacityPlacementSnapshot!,
          },
        ],
      })
    ).toEqual(new Set(['existing-node']));
    await handleNodeProvisioning(fixture.state, fixture.rc);
    expect(JSON.stringify(fixture.state.stepResults.placementDiagnostics)).toContain(
      'memory budget would be exceeded after host reserve'
    );
    expect(snapshot()).toBeUndefined();
    vi.advanceTimersByTime(60001);
    await expect(handleNodeProvisioning(fixture.state, fixture.rc)).rejects.toMatchObject({
      permanent: true,
    });
    expect(
      fixture.sqlite.prepare('SELECT state FROM vm_task_admissions WHERE task_id = ?').get('task-1')
    ).toEqual({ state: 'expired' });
    expect(snapshot()).toBeUndefined();
  });

  it.each([
    ["UPDATE nodes SET user_id='another-user'"],
    ["UPDATE nodes SET capacity_pool_id='another-pool'"],
    ["UPDATE nodes SET node_class='user-owned'"],
    ["UPDATE nodes SET node_role='deployment'"],
    ["UPDATE nodes SET runtime='cf-container'"],
    ["DELETE FROM tasks WHERE id='old-task'"],
    ["UPDATE workspaces SET status='creating'"],
  ])('does not drain a host outside managed same-owner pool provenance: %s', async (sql) => {
    fixture.sqlite.exec(sql);
    await requestIncompatiblePoolNodeDrain(fixture.state, fixture.rc);
    expect(snapshot()).toBeUndefined();
  });

  it.each(['failed', 'terminal_failed', 'preparing', 'capturing', 'stopping', 'scheduled'])(
    'preserves existing %s sleep episode and its budgets',
    async (status) => {
      await requestIncompatiblePoolNodeDrain(fixture.state, fixture.rc);
      fixture.sqlite
        .prepare(
          "UPDATE session_snapshots SET sleep_status=?, sleep_after='2026-10-06T00:00:00.000Z',sleep_claim_id='claim',sleep_attempts=3,sleep_episode_failures=2"
        )
        .run(status);
      const before = snapshot();
      await requestIncompatiblePoolNodeDrain(fixture.state, fixture.rc);
      expect(snapshot()).toEqual(before);
    }
  );

  it('preserves a claim won after candidate selection before the final scheduling CAS', async () => {
    await requestIncompatiblePoolNodeDrain(fixture.state, fixture.rc);
    fixture.sqlite.exec('UPDATE session_snapshots SET sleep_status=NULL');
    const prepare = fixture.database.prepare.bind(fixture.database);
    vi.spyOn(fixture.database, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes("UPDATE session_snapshots SET sleep_status = 'scheduled'"))
        fixture.sqlite.exec(
          "UPDATE session_snapshots SET sleep_status='capturing',sleep_claim_id='winning-claim',sleep_episode_failures=2"
        );
      return prepare(sql);
    });
    await requestIncompatiblePoolNodeDrain(fixture.state, fixture.rc);
    expect(snapshot()).toMatchObject({
      sleep_status: 'capturing',
      sleep_claim_id: 'winning-claim',
      sleep_episode_failures: 2,
    });
  });

  it('reports usable memory through real node selection even when resolver removed the offering', async () => {
    fixture.sqlite.exec(
      "UPDATE nodes SET agent_version='current-agent',provider_instance_memory_mb=4096,observed_provider_instance_memory_mb=4096"
    );
    fixture.state.config.resolvedReservation!.memoryMb = 3712;
    fixture.state.config.capacityPoolSelection!.candidates = [];
    expect(await findNodeWithCapacity(fixture.state, fixture.rc)).toBeNull();
    expect(JSON.stringify(fixture.state.stepResults.placementDiagnostics)).toContain(
      'Host memory cannot satisfy the requested resources after host reserve'
    );
    expect(JSON.stringify(fixture.state.stepResults.placementDiagnostics)).not.toContain(
      'Host is outside the current pool allocation authority'
    );
  });

  it.each(['expired', 'deleted'])(
    'does not let an unqueueable %s snapshot consume the bounded drain candidate limit',
    async (status) => {
      await requestIncompatiblePoolNodeDrain(fixture.state, fixture.rc);
      fixture.sqlite.prepare('UPDATE session_snapshots SET sleep_status=NULL,status=?').run(status);
      fixture.sqlite.exec(`
      INSERT INTO workspaces (id,user_id,node_id,project_id,chat_session_id,status) VALUES ('z-valid-workspace','user-1','existing-node','project-1','z-valid-chat','running');
      INSERT INTO agent_sessions (id,workspace_id,status,created_at) VALUES ('z-valid-agent','z-valid-workspace','running','2026-10-01T00:00:00.000Z');
    `);
      fixture.rc.env.WORKSPACE_CLEANUP_SWEEP_LIMIT = '1';
      await requestIncompatiblePoolNodeDrain(fixture.state, fixture.rc);
      expect(snapshot()).toMatchObject({ status, sleep_status: null });
      expect(
        fixture.sqlite
          .prepare(
            "SELECT sleep_status FROM session_snapshots WHERE chat_session_id='z-valid-chat'"
          )
          .get()
      ).toEqual({ sleep_status: 'scheduled' });
    }
  );

  it('rejects a relocation racing between selection and placeholder insertion', async () => {
    const prepare = fixture.database.prepare.bind(fixture.database);
    vi.spyOn(fixture.database, 'prepare').mockImplementation((sql: string) => {
      if (sql.startsWith('INSERT INTO session_snapshots'))
        fixture.sqlite.exec("UPDATE workspaces SET node_id='replacement-node'");
      return prepare(sql);
    });
    await requestIncompatiblePoolNodeDrain(fixture.state, fixture.rc);
    expect(snapshot()).toBeUndefined();
  });
});
