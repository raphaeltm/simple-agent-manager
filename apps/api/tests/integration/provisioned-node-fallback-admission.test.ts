import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildAdmissionIdentity } from '../../src/durable-objects/task-runner/node-provisioning-admission';
import { handleNodeProvisioning } from '../../src/durable-objects/task-runner/node-steps';
import type { TaskRunnerState } from '../../src/durable-objects/task-runner/types';
import { resumeWorkspacePlacementFallback } from '../../src/durable-objects/task-runner/workspace-placement-fallback';
import * as nodesService from '../../src/services/nodes';
import { tryAcquireVmProvisioningLease } from '../../src/services/vm-admission-control';
import { createIncompatibleCapacityFixture } from '../helpers/incompatible-agent-capacity-fixture';

// Real fallback, provisioning handlers, credential resolution, lease SQL and pool trigger.
// SQLite replaces D1; storage/alarm scheduling and provider HTTP are the boundaries simulated.
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

async function fallback(state = fixture.state, nodeId = 'existing-node') {
  fixture.sqlite
    .prepare('UPDATE tasks SET auto_provisioned_node_id = ? WHERE id = ?')
    .run(nodeId, state.taskId);
  state.stepResults.nodeId = nodeId;
  state.stepResults.autoProvisioned = true;
  state.rejectedAutoProvisionedNodeId = nodeId;
  expect(await resumeWorkspacePlacementFallback(state, fixture.rc)).toBe(true);
  expect(state.stepResults.nodeId).toBeNull();
  expect(state.admissionScopeKey).toBeNull();
  expect(state.admissionLeaseToken).toBeNull();
  expect(
    fixture.sqlite
      .prepare('SELECT auto_provisioned_node_id FROM tasks WHERE id = ?')
      .get(state.taskId)
  ).toEqual({ auto_provisioned_node_id: null });
}

function admission(taskId = fixture.state.taskId) {
  return fixture.sqlite
    .prepare(
      'SELECT state, reason, wait_deadline_at, next_retry_at FROM vm_task_admissions WHERE task_id = ?'
    )
    .get(taskId) as {
    state: string;
    reason: string;
    wait_deadline_at: string;
    next_retry_at: string | null;
  };
}

describe('normal admission after provisioned-node fallback', () => {
  it.each(['capacity_pool_node_limit', 'user_node_limit'] as const)(
    'keeps the original %s queue deadline through retries, then expires without allocation',
    async (reason) => {
      const { sqlite, state, rc } = fixture;
      const provision = vi.spyOn(nodesService, 'provisionNode');
      rc.env.VM_ADMISSION_WAIT_TIMEOUT_MS = '5000';
      if (reason === 'user_node_limit') {
        state.config.capacityPoolSelection!.maxNodes = 2;
        sqlite.exec('UPDATE capacity_pools SET max_nodes = 2');
        rc.env.MAX_NODES_PER_USER = '1';
      }
      // Start with the owner's real fenced lease; fallback must relinquish it before queueing.
      const identity = await buildAdmissionIdentity(state, rc);
      expect(identity).not.toBeNull();
      if (!identity) throw new Error('Missing fixture admission identity');
      const grant = await tryAcquireVmProvisioningLease(rc.env, identity);
      expect(grant.kind).toBe('granted');
      if (grant.kind !== 'granted') throw new Error('Expected initial lease');
      state.admissionScopeKey = grant.scopeKey;
      state.admissionLeaseToken = grant.fencingToken;
      await fallback();
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM vm_provisioning_leases').get()).toEqual({
        count: 0,
      });

      await handleNodeProvisioning(state, rc);
      const first = admission();
      expect(first).toMatchObject({ state: 'waiting', reason });
      expect(first.wait_deadline_at).toBe(new Date(Date.now() + 5000).toISOString());
      expect(rc.ctx.storage.setAlarm).toHaveBeenLastCalledWith(Date.now() + 1000);
      for (let retry = 0; retry < 4; retry++) {
        vi.advanceTimersByTime(1000);
        await handleNodeProvisioning(state, rc);
        expect(admission()).toMatchObject({
          state: 'waiting',
          reason,
          wait_deadline_at: first.wait_deadline_at,
        });
      }
      vi.advanceTimersByTime(1000);
      await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({ permanent: true });
      expect(admission()).toMatchObject({
        state: 'expired',
        reason: 'wait_deadline_expired',
        next_retry_at: null,
      });
      expect(
        sqlite
          .prepare('SELECT admission_state, admission_reason FROM tasks WHERE id = ?')
          .get(state.taskId)
      ).toEqual({ admission_state: 'expired', admission_reason: 'wait_deadline_expired' });
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM nodes').get()).toEqual({ count: 1 });
      expect(sqlite.prepare('SELECT status FROM nodes WHERE id = ?').get('existing-node')).toEqual({
        status: 'running',
      });
      expect(
        sqlite.prepare('SELECT status FROM workspaces WHERE id = ?').get('old-workspace')
      ).toEqual({ status: 'running' });
      expect(provision).not.toHaveBeenCalled();
    }
  );

  it('serializes two fallback owners through one real provisioning lease before provider allocation', async () => {
    const { sqlite, state, rc } = fixture;
    sqlite.exec(`
      UPDATE capacity_pools SET max_nodes = 4;
      INSERT INTO nodes (id, user_id, name, status, capacity_pool_id, runtime, node_role, node_class)
        VALUES ('second-rejected-node', 'user-1', 'Second occupied host', 'running', 'pool-1', 'vm', 'workspace', 'managed');
      INSERT INTO tasks (id, project_id, user_id, status)
        VALUES ('task-2', 'project-1', 'user-1', 'queued');
      INSERT INTO workspaces (id, user_id, node_id, project_id, status, resolved_reservation_json)
        SELECT 'second-occupied-workspace', user_id, 'second-rejected-node', project_id, status, resolved_reservation_json
        FROM workspaces WHERE id = 'old-workspace';
    `);
    // Leave room for both requests: the lease, rather than the pool trigger, must serialize
    // provider allocation. The separate limit tests exercise a pool with no free slot.
    state.config.capacityPoolSelection!.maxNodes = 4;
    const second = structuredClone(state);
    second.taskId = 'task-2';
    await fallback(state);
    await fallback(second, 'second-rejected-node');

    let announceProvider!: () => void;
    let announceDuplicate!: () => void;
    let finishProvider!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      announceProvider = resolve;
    });
    const duplicateProviderStarted = new Promise<void>((resolve) => {
      announceDuplicate = resolve;
    });
    const providerReleased = new Promise<void>((resolve) => {
      finishProvider = resolve;
    });
    let providerCalls = 0;
    const provision = vi.spyOn(nodesService, 'provisionNode').mockImplementation(async (nodeId) => {
      if (++providerCalls > 1) announceDuplicate();
      announceProvider();
      await providerReleased;
      sqlite
        .prepare(
          "UPDATE nodes SET status = 'running', agent_version = 'current-agent' WHERE id = ?"
        )
        .run(nodeId);
    });
    const runs = [handleNodeProvisioning(state, rc), handleNodeProvisioning(second, rc)];
    // Stop exactly at provider HTTP: the winner has recorded its inflight node, while the
    // loser must finish by entering the shared queue rather than issuing another request.
    try {
      await providerStarted;
      const loser = await Promise.race([
        ...runs.map((run, index) => run.then(() => index)),
        duplicateProviderStarted.then(() => -1),
      ]);
      // A removed lease fence reports the extra provider call directly, without waiting for
      // a timeout on two provider requests that are both deliberately paused.
      expect(provision).toHaveBeenCalledTimes(1);
      const losingState: TaskRunnerState = loser === 0 ? state : second;
      expect(admission(losingState.taskId)).toMatchObject({
        state: 'waiting',
        reason: 'compatible_node_provisioning',
      });
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM vm_provisioning_leases').get()).toEqual({
        count: 1,
      });
      expect(
        sqlite.prepare("SELECT COUNT(*) AS count FROM nodes WHERE status = 'creating'").get()
      ).toEqual({ count: 1 });
    } finally {
      finishProvider();
      await Promise.allSettled(runs);
    }
    await Promise.all(runs);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM nodes').get()).toEqual({ count: 3 });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE status = 'running'").get()
    ).toEqual({ count: 2 });
  });
});

// Security review (2026-11-19): the fallback stamps node-local provenance and releases the task
// pointer. Each attack below must stamp nothing, release nothing and refuse the handoff, while the
// owner path above (`fallback()`) proves the same fixture does stamp and release.
describe('provisioned-node fallback ownership scoping', () => {
  function stamped(nodeId = 'existing-node') {
    const row = fixture.sqlite
      .prepare('SELECT task_provisioned FROM nodes WHERE id = ?')
      .get(nodeId) as { task_provisioned: number | null };
    return row.task_provisioned === 1;
  }
  function pointer() {
    return fixture.sqlite
      .prepare('SELECT auto_provisioned_node_id FROM tasks WHERE id = ?')
      .get(fixture.state.taskId);
  }
  function arm(state: TaskRunnerState, nodeId = 'existing-node') {
    fixture.sqlite
      .prepare('UPDATE tasks SET auto_provisioned_node_id = ? WHERE id = ?')
      .run(nodeId, fixture.state.taskId);
    state.stepResults.nodeId = nodeId;
    state.stepResults.autoProvisioned = true;
    state.rejectedAutoProvisionedNodeId = nodeId;
  }

  it('owner control: stamps the owned node and releases the pointer', async () => {
    await fallback();
    expect(stamped()).toBe(true);
  });

  it("refuses a pointer to another user's node", async () => {
    fixture.sqlite.exec(`
      INSERT INTO nodes (id, user_id, name, status, capacity_pool_id, runtime, node_role, node_class)
        VALUES ('foreign-node', 'user-2', 'Foreign host', 'running', 'pool-1', 'vm', 'workspace', 'managed');
    `);
    arm(fixture.state, 'foreign-node');
    await expect(resumeWorkspacePlacementFallback(fixture.state, fixture.rc)).rejects.toThrow();
    expect(stamped('foreign-node')).toBe(false);
    expect(pointer()).toEqual({ auto_provisioned_node_id: 'foreign-node' });
  });

  it('refuses a task row owned by another user', async () => {
    arm(fixture.state);
    fixture.sqlite
      .prepare("UPDATE tasks SET user_id = 'user-2' WHERE id = ?")
      .run(fixture.state.taskId);
    await expect(resumeWorkspacePlacementFallback(fixture.state, fixture.rc)).rejects.toThrow();
    expect(stamped()).toBe(false);
    expect(pointer()).toEqual({ auto_provisioned_node_id: 'existing-node' });
  });

  it('refuses when both the task and the node belong to another user than the runner', async () => {
    arm(fixture.state);
    fixture.sqlite.exec("UPDATE nodes SET user_id = 'user-2' WHERE id = 'existing-node'");
    fixture.sqlite
      .prepare("UPDATE tasks SET user_id = 'user-2' WHERE id = ?")
      .run(fixture.state.taskId);
    await expect(resumeWorkspacePlacementFallback(fixture.state, fixture.rc)).rejects.toThrow();
    expect(stamped()).toBe(false);
    expect(pointer()).toEqual({ auto_provisioned_node_id: 'existing-node' });
  });

  it("refuses when the runner's project does not own the task", async () => {
    const foreignProject = structuredClone(fixture.state);
    foreignProject.projectId = 'project-2';
    arm(foreignProject);
    await expect(resumeWorkspacePlacementFallback(foreignProject, fixture.rc)).rejects.toThrow();
    expect(stamped()).toBe(false);
    expect(pointer()).toEqual({ auto_provisioned_node_id: 'existing-node' });
  });
});
