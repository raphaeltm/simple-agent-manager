/**
 * Miniflare integration tests for the NodeLifecycle Durable Object.
 *
 * Exercises the warm pool state machine (active → warm → destroying) with
 * real D1 transactions and DO storage. No vi.mock() — all bindings are
 * Miniflare-provided.
 *
 * NodeLifecycle DO: apps/api/src/durable-objects/node-lifecycle.ts
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  seedAgentSession,
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';
import {
  captureNodeLifecycleExpectedError,
  type NodeLifecycleTestDouble,
  type ProjectDataTestDouble,
} from './support/expected-error-doubles';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getStub(nodeId: string): DurableObjectStub<NodeLifecycleTestDouble> {
  const id = env.NODE_LIFECYCLE.idFromName(nodeId);
  return env.NODE_LIFECYCLE.get(id) as DurableObjectStub<NodeLifecycleTestDouble>;
}

function getProjectDataStub(projectId: string): DurableObjectStub<ProjectDataTestDouble> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  return env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectDataTestDouble>;
}

const TEST_USER_ID = 'user-nl-test-001';
const TEST_PROJECT_ID = 'project-nl-test-001';
const TEST_INSTALLATION_ID = 'installation-nl-test-001';

async function seedClaimTask(taskId: string): Promise<void> {
  await seedUser(TEST_USER_ID);
  await seedInstallation(TEST_INSTALLATION_ID, TEST_USER_ID);
  await seedProject(TEST_PROJECT_ID, TEST_USER_ID, TEST_INSTALLATION_ID);
  await seedTask(taskId, TEST_PROJECT_ID, TEST_USER_ID);
}

async function seedAuthorizedRecoveryClaim(input: {
  sourceTaskId: string;
  recoveryTaskId: string;
  workspaceId: string;
  chatSessionId: string;
}): Promise<void> {
  await seedUser(TEST_USER_ID);
  await seedInstallation(TEST_INSTALLATION_ID, TEST_USER_ID);
  await seedProject(TEST_PROJECT_ID, TEST_USER_ID, TEST_INSTALLATION_ID);
  await seedWorkspace(input.workspaceId, null, TEST_USER_ID, {
    projectId: TEST_PROJECT_ID,
    status: 'sleeping',
  });
  await seedTask(input.sourceTaskId, TEST_PROJECT_ID, TEST_USER_ID, {
    status: 'awaiting_followup',
    workspaceId: input.workspaceId,
    taskMode: 'conversation',
  });
  await seedTask(input.recoveryTaskId, TEST_PROJECT_ID, TEST_USER_ID, {
    status: 'queued',
    taskMode: 'conversation',
  });
  await env.DATABASE.prepare(
    `UPDATE tasks
        SET chat_session_id = ?, recovery_source_task_id = ?,
            triggered_by = 'session-recovery', updated_at = datetime('now')
      WHERE id = ?`
  )
    .bind(input.chatSessionId, input.sourceTaskId, input.recoveryTaskId)
    .run();
  await env.DATABASE.prepare(
    `INSERT INTO session_snapshots
       (id, project_id, workspace_id, user_id, chat_session_id, runtime, status,
        degradation, manifest_r2_key, expires_at, sleeping_at, recovery_status,
        recovery_task_id, recovery_attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'vm', 'available', 'none', ?, '2099-01-01T00:00:00.000Z',
             '2026-08-16T00:00:00.000Z', 'waking', ?, 1, datetime('now'), datetime('now'))`
  )
    .bind(
      `snapshot-${input.recoveryTaskId}`,
      TEST_PROJECT_ID,
      input.workspaceId,
      TEST_USER_ID,
      input.chatSessionId,
      `snapshots/${input.chatSessionId}/manifest.json`,
      input.recoveryTaskId
    )
    .run();
}

async function seedSleepingSnapshot(input: {
  nodeId: string;
  workspaceId: string;
  chatSessionId: string;
}): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT INTO session_snapshots
       (id, project_id, workspace_id, node_id, user_id, chat_session_id, runtime, status,
        degradation, manifest_r2_key, home_r2_key, expires_at, sleeping_at, sleep_status,
        recovery_attempts, sleep_attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'vm', 'available', 'none', ?, ?, '2099-01-01T00:00:00.000Z',
             '2026-08-26T20:56:54.000Z', 'sleeping', 0, 0, datetime('now'), datetime('now'))`
  )
    .bind(
      `snapshot-${input.workspaceId}`,
      TEST_PROJECT_ID,
      input.workspaceId,
      input.nodeId,
      TEST_USER_ID,
      input.chatSessionId,
      `snapshots/${input.chatSessionId}/manifest.json`,
      `snapshots/${input.chatSessionId}/home.tar.zst`
    )
    .run();
}

interface StoredNodeLifecycleState {
  nodeId: string;
  userId: string;
  status: 'active' | 'warm' | 'destroying';
  warmSince: number | null;
  claimedByTask: string | null;
  warmTimeoutOverrideMs?: number | null;
  destroyingSince?: number;
}

async function seedTestNode(nodeId: string, userId: string = TEST_USER_ID): Promise<void> {
  await seedUser(userId);
  await seedNode(nodeId, userId);
}

async function getNodeFromD1(
  nodeId: string
): Promise<{ status: string; warm_since: string | null } | null> {
  return await env.DATABASE.prepare(`SELECT status, warm_since FROM nodes WHERE id = ?`)
    .bind(nodeId)
    .first<{ status: string; warm_since: string | null }>();
}

async function getAgentSessionStatus(
  agentSessionId: string
): Promise<{ status: string; stopped_at: string | null } | null> {
  return await env.DATABASE.prepare(`SELECT status, stopped_at FROM agent_sessions WHERE id = ?`)
    .bind(agentSessionId)
    .first<{ status: string; stopped_at: string | null }>();
}

async function getStoredState(
  stub: DurableObjectStub<NodeLifecycleTestDouble>
): Promise<StoredNodeLifecycleState | null> {
  return await runInDurableObject(stub, async (instance) => {
    return (await instance.ctx.storage.get<StoredNodeLifecycleState>('state')) ?? null;
  });
}

async function getAlarm(stub: DurableObjectStub<NodeLifecycleTestDouble>): Promise<number | null> {
  return await runInDurableObject(stub, async (instance) => {
    return await instance.ctx.storage.getAlarm();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NodeLifecycle DO — warm pool state machine', () => {
  // Each test uses a unique nodeId to avoid cross-test DO state leakage

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('markIdle transitions to warm and updates D1 warm_since', async () => {
    const nodeId = 'nl-test-idle-001';
    await seedTestNode(nodeId);

    const stub = getStub(nodeId);
    const result = await stub.markIdle(nodeId, TEST_USER_ID);

    expect(result.status).toBe('warm');
    expect(result.warmSince).toBeTruthy();
    expect(result.nodeId).toBe(nodeId);

    // Verify D1 was updated
    const dbNode = await getNodeFromD1(nodeId);
    expect(dbNode).toBeTruthy();
    expect(dbNode!.warm_since).toBeTruthy();
  });

  it('markIdle keeps a user-owned (BYO) node ACTIVE — never warms it or arms a teardown alarm', async () => {
    // BYO machines must never enter the warm → destroying pipeline (architecture-critique #2).
    const nodeId = 'nl-test-byo-idle-001';
    await seedUser(TEST_USER_ID);
    await seedNode(nodeId, TEST_USER_ID, { nodeClass: 'user-owned' });

    const stub = getStub(nodeId);
    const result = await stub.markIdle(nodeId, TEST_USER_ID);

    // Kept active, not warmed.
    expect(result.status).toBe('active');
    expect(result.warmSince).toBeNull();

    // No warm alarm scheduled, and the stored DO state is active.
    expect(await getAlarm(stub)).toBeNull();
    expect((await getStoredState(stub))?.status).toBe('active');

    // D1 warm_since stays null → the node never becomes a warm-pool teardown candidate.
    const dbNode = await getNodeFromD1(nodeId);
    expect(dbNode!.warm_since).toBeNull();
  });

  it('markActive transitions to active and clears D1 warm_since', async () => {
    const nodeId = 'nl-test-active-001';
    await seedTestNode(nodeId);

    const stub = getStub(nodeId);

    // First make it warm
    await stub.markIdle(nodeId, TEST_USER_ID);
    const warmNode = await getNodeFromD1(nodeId);
    expect(warmNode!.warm_since).toBeTruthy();

    // Now mark active
    const result = await stub.markActive();
    expect(result.status).toBe('active');
    expect(result.warmSince).toBeNull();

    // Verify D1 warm_since is cleared
    const activeNode = await getNodeFromD1(nodeId);
    expect(activeNode!.warm_since).toBeNull();
  });

  it('tryClaim on warm node succeeds and transitions to active', async () => {
    const nodeId = 'nl-test-claim-warm-001';
    await seedTestNode(nodeId);

    const stub = getStub(nodeId);
    await seedClaimTask('task-001');
    await stub.markIdle(nodeId, TEST_USER_ID);

    const { claimed, state } = await stub.tryClaim('task-001');

    expect(claimed).toBe(true);
    expect(state.status).toBe('active');
    expect(state.claimedByTask).toBe('task-001');

    // D1 warm_since should be cleared
    const dbNode = await getNodeFromD1(nodeId);
    expect(dbNode!.warm_since).toBeNull();
  });

  it('rejects a guarded claim atomically when source authority is not live', async () => {
    const nodeId = 'nl-test-claim-revoked-001';
    const taskId = 'task-claim-revoked-001';
    await seedTestNode(nodeId);
    await seedClaimTask(taskId);

    const stub = getStub(nodeId);
    await stub.markIdle(nodeId, TEST_USER_ID);
    const alarmBefore = await getAlarm(stub);
    const result = await stub.tryClaim(taskId, {
      taskId: 'missing-source',
      projectId: TEST_PROJECT_ID,
      chatSessionId: 'missing-chat',
    });

    expect(result.claimed).toBe(false);
    expect(result.reason).toBe('source_task_revoked');
    expect(result.state.status).toBe('warm');
    expect(await getAlarm(stub)).toBe(alarmBefore);
    const task = await env.DATABASE.prepare(`SELECT claimed_warm_node_id FROM tasks WHERE id = ?`)
      .bind(taskId)
      .first<{ claimed_warm_node_id: string | null }>();
    expect(task?.claimed_warm_node_id).toBeNull();
  });

  it('accepts and persists a guarded claim when exact recovery authority is live', async () => {
    const nodeId = 'nl-test-claim-authorized-001';
    const sourceTaskId = 'task-claim-authorized-source-001';
    const recoveryTaskId = 'task-claim-authorized-recovery-001';
    const chatSessionId = 'chat-claim-authorized-001';
    await seedTestNode(nodeId);
    await seedAuthorizedRecoveryClaim({
      sourceTaskId,
      recoveryTaskId,
      workspaceId: 'workspace-claim-authorized-001',
      chatSessionId,
    });

    const stub = getStub(nodeId);
    await stub.markIdle(nodeId, TEST_USER_ID);
    const result = await stub.tryClaim(recoveryTaskId, {
      taskId: sourceTaskId,
      projectId: TEST_PROJECT_ID,
      chatSessionId,
    });

    expect(result.claimed).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.state).toMatchObject({
      status: 'active',
      claimedByTask: recoveryTaskId,
    });
    const task = await env.DATABASE.prepare(`SELECT claimed_warm_node_id FROM tasks WHERE id = ?`)
      .bind(recoveryTaskId)
      .first<{ claimed_warm_node_id: string | null }>();
    expect(task?.claimed_warm_node_id).toBe(nodeId);
  });

  it('persists and conditionally releases a claim after the caller-side crash window', async () => {
    const nodeId = 'nl-test-claim-release-001';
    const taskId = 'task-claim-release-001';
    await seedTestNode(nodeId);
    await seedClaimTask(taskId);

    const stub = getStub(nodeId);
    await stub.markIdle(nodeId, TEST_USER_ID);
    expect((await stub.tryClaim(taskId)).claimed).toBe(true);
    const claimedTask = await env.DATABASE.prepare(
      `SELECT claimed_warm_node_id FROM tasks WHERE id = ?`
    )
      .bind(taskId)
      .first<{ claimed_warm_node_id: string | null }>();
    expect(claimedTask?.claimed_warm_node_id).toBe(nodeId);

    expect((await stub.releaseClaim('another-task')).released).toBe(false);
    const released = await stub.releaseClaim(taskId);
    expect(released.released).toBe(true);
    expect(released.state.status).toBe('warm');
    expect(await getAlarm(stub)).toBeGreaterThan(Date.now());
    const releasedTask = await env.DATABASE.prepare(
      `SELECT claimed_warm_node_id FROM tasks WHERE id = ?`
    )
      .bind(taskId)
      .first<{ claimed_warm_node_id: string | null }>();
    expect(releasedTask?.claimed_warm_node_id).toBeNull();
  });

  it('keeps a D1-persisted claimant exclusive across a pre-storage crash window', async () => {
    const nodeId = 'nl-test-claim-exclusive-001';
    const firstTaskId = 'task-claim-exclusive-first-001';
    const secondTaskId = 'task-claim-exclusive-second-001';
    await seedTestNode(nodeId);
    await seedClaimTask(firstTaskId);
    await seedClaimTask(secondTaskId);

    const stub = getStub(nodeId);
    await stub.markIdle(nodeId, TEST_USER_ID);
    await env.DATABASE.prepare(`UPDATE tasks SET claimed_warm_node_id = ? WHERE id = ?`)
      .bind(nodeId, firstTaskId)
      .run();

    const conflicting = await stub.tryClaim(secondTaskId);
    expect(conflicting.claimed).toBe(false);
    expect(conflicting.reason).toBeUndefined();
    expect(conflicting.state.status).toBe('warm');

    const recovered = await stub.tryClaim(firstTaskId);
    expect(recovered.claimed).toBe(true);
    expect(recovered.state.claimedByTask).toBe(firstTaskId);
  });

  it('tryClaim on active node returns false', async () => {
    const nodeId = 'nl-test-claim-active-001';
    await seedTestNode(nodeId);

    const stub = getStub(nodeId);

    // Make warm then active
    await stub.markIdle(nodeId, TEST_USER_ID);
    await stub.markActive();

    const { claimed, state } = await stub.tryClaim('task-002');

    expect(claimed).toBe(false);
    expect(state.status).toBe('active');
  });

  it('markIdle on destroying node throws conflict error', async () => {
    const nodeId = 'nl-test-destroy-conflict-001';
    await seedTestNode(nodeId);

    const stub = getStub(nodeId);

    // Manually drive to destroying state using runInDurableObject
    await runInDurableObject(stub, async (instance) => {
      await instance.ctx.storage.put('state', {
        nodeId,
        userId: TEST_USER_ID,
        status: 'destroying',
        warmSince: Date.now() - 60_000,
        claimedByTask: null,
      });
    });

    const rejection = await captureNodeLifecycleExpectedError(stub, {
      operation: 'markIdle',
      args: [nodeId, TEST_USER_ID],
    });
    expect(rejection).toEqual({
      threw: true,
      name: 'Error',
      message: 'node_lifecycle_conflict: node is being destroyed',
    });

    expect((await stub.getStatus()).status).toBe('destroying');
  });

  it('getStatus returns current state', async () => {
    const nodeId = 'nl-test-status-001';
    await seedTestNode(nodeId);

    const stub = getStub(nodeId);

    // Before any state is set
    const initial = await stub.getStatus();
    expect(initial).toEqual({
      nodeId: '',
      status: 'active',
      warmSince: null,
      claimedByTask: null,
    }); // default when no stored state

    // After markIdle
    await stub.markIdle(nodeId, TEST_USER_ID);
    const warm = await stub.getStatus();
    expect(warm.status).toBe('warm');
    expect(warm.warmSince).toBeTruthy();
  });

  it('markIdle resets alarm when called twice (extending warm period)', async () => {
    const nodeId = 'nl-test-reset-alarm-001';
    await seedTestNode(nodeId);

    const stub = getStub(nodeId);

    const firstResult = await stub.markIdle(nodeId, TEST_USER_ID);
    expect(firstResult.status).toBe('warm');

    // Call again — should update warmSince (new timestamp)
    const secondResult = await stub.markIdle(nodeId, TEST_USER_ID);
    expect(secondResult.status).toBe('warm');
    expect(secondResult.warmSince).toBeTruthy();
  });

  it('alarm on warm state transitions to destroying and updates D1', async () => {
    const nodeId = 'nl-test-alarm-destroy-001';
    await seedTestNode(nodeId);

    const stub = getStub(nodeId);

    // Set warm state with warmSince far in the past so the timeout has expired
    await runInDurableObject(stub, async (instance) => {
      await instance.ctx.storage.put('state', {
        nodeId,
        userId: TEST_USER_ID,
        status: 'warm',
        warmSince: Date.now() - 600_000, // 10 minutes ago — well past any timeout
        claimedByTask: null,
      });
    });

    // Trigger alarm directly
    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    // Verify DO state transitioned to destroying
    const status = await stub.getStatus();
    expect(status.status).toBe('destroying');

    // Verify D1 node was updated to stopped
    const dbNode = await getNodeFromD1(nodeId);
    expect(dbNode!.status).toBe('stopped');
    expect(dbNode!.warm_since).toBeNull();
    expect(await getAlarm(stub)).not.toBeNull();
  });

  it('terminally cleans a destroying node and does not re-arm on a second alarm', async () => {
    const nodeId = 'nl-test-destroy-terminal-001';
    await seedTestNode(nodeId);
    await env.DATABASE.prepare(`UPDATE nodes SET status = 'stopped' WHERE id = ?`)
      .bind(nodeId)
      .run();

    const stub = getStub(nodeId);
    await runInDurableObject(stub, async (instance) => {
      await instance.ctx.storage.put('state', {
        nodeId,
        userId: TEST_USER_ID,
        status: 'destroying',
        warmSince: null,
        destroyingSince: Date.now(),
        claimedByTask: null,
      } satisfies StoredNodeLifecycleState);
      await instance.ctx.storage.setAlarm(Date.now() + 1_000);
      await instance.alarm();
    });

    expect(await getStoredState(stub)).toBeNull();
    expect(await getAlarm(stub)).toBeNull();

    await runInDurableObject(stub, async (instance) => instance.alarm());
    expect(await getStoredState(stub)).toBeNull();
    expect(await getAlarm(stub)).toBeNull();
  });

  it('terminally cleans a destroying state when its D1 node row is absent', async () => {
    const nodeId = 'nl-test-destroy-absent-001';
    await seedUser(TEST_USER_ID);
    const stub = getStub(nodeId);

    await runInDurableObject(stub, async (instance) => {
      await instance.ctx.storage.put('state', {
        nodeId,
        userId: TEST_USER_ID,
        status: 'destroying',
        warmSince: null,
        destroyingSince: Date.now(),
        claimedByTask: null,
      } satisfies StoredNodeLifecycleState);
      await instance.ctx.storage.setAlarm(Date.now() + 1_000);
      await instance.alarm();
    });

    expect(await getStoredState(stub)).toBeNull();
    expect(await getAlarm(stub)).toBeNull();
    expect(await getNodeFromD1(nodeId)).toBeNull();
  });

  it('finalizeDeletion routes an API-deleted node through destroying terminal cleanup', async () => {
    const nodeId = 'nl-test-api-delete-terminal-001';
    await seedTestNode(nodeId);
    const stub = getStub(nodeId);

    await stub.markIdle(nodeId, TEST_USER_ID);
    expect(await getStoredState(stub)).toMatchObject({ nodeId, status: 'warm' });
    expect(await getAlarm(stub)).not.toBeNull();

    await env.DATABASE.prepare('DELETE FROM nodes WHERE id = ?').bind(nodeId).run();
    await stub.finalizeDeletion(nodeId, TEST_USER_ID);

    expect(await getStoredState(stub)).toBeNull();
    expect(await getAlarm(stub)).toBeNull();
    expect(await getNodeFromD1(nodeId)).toBeNull();
  });

  it('retries a failed warm-to-destroying D1 handoff, then terminates next tick', async () => {
    const nodeId = 'nl-test-destroy-retry-001';
    await seedTestNode(nodeId);
    const stub = getStub(nodeId);

    await runInDurableObject(stub, async (instance) => {
      await instance.ctx.storage.put('state', {
        nodeId,
        userId: TEST_USER_ID,
        status: 'destroying',
        warmSince: null,
        destroyingSince: Date.now(),
        claimedByTask: null,
      } satisfies StoredNodeLifecycleState);
      await instance.alarm();
    });

    expect((await getNodeFromD1(nodeId))?.status).toBe('stopped');
    expect((await getStoredState(stub))?.status).toBe('destroying');
    expect(await getAlarm(stub)).not.toBeNull();

    await runInDurableObject(stub, async (instance) => instance.alarm());
    expect(await getStoredState(stub)).toBeNull();
    expect(await getAlarm(stub)).toBeNull();
  });

  it('self-cleans a destroying state after the maximum destroying age', async () => {
    const nodeId = 'nl-test-destroy-max-age-001';
    await seedTestNode(nodeId);
    const stub = getStub(nodeId);

    await runInDurableObject(stub, async (instance) => {
      await instance.ctx.storage.put('state', {
        nodeId,
        userId: TEST_USER_ID,
        status: 'destroying',
        warmSince: null,
        destroyingSince: Date.now() - 25 * 60 * 60 * 1_000,
        claimedByTask: null,
      } satisfies StoredNodeLifecycleState);
      await instance.alarm();
    });

    expect(await getStoredState(stub)).toBeNull();
    expect(await getAlarm(stub)).toBeNull();
    expect((await getNodeFromD1(nodeId))?.status).toBe('running');
  });

  it('tryClaim on node with no stored state returns false and the default active state', async () => {
    const nodeId = 'nl-test-claim-no-state-001';
    await seedTestNode(nodeId);

    const { claimed, state } = await getStub(nodeId).tryClaim('task-no-state');

    expect(claimed).toBe(false);
    expect(state).toEqual({
      nodeId: '',
      status: 'active',
      warmSince: null,
      claimedByTask: null,
    });
  });

  it('alarm on active state is a no-op (node was claimed between schedule and fire)', async () => {
    const nodeId = 'nl-test-alarm-active-noop-001';
    await seedTestNode(nodeId);

    const stub = getStub(nodeId);

    // Set active state (simulates: alarm was scheduled when warm, but node was claimed before it fired)
    await runInDurableObject(stub, async (instance) => {
      await instance.ctx.storage.put('state', {
        nodeId,
        userId: TEST_USER_ID,
        status: 'active',
        warmSince: null,
        claimedByTask: 'task-active',
      });
    });

    // Trigger alarm — should be a no-op
    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    // State should still be active
    const status = await stub.getStatus();
    expect(status.status).toBe('active');

    // D1 node should still be running (not stopped)
    const dbNode = await getNodeFromD1(nodeId);
    expect(dbNode!.status).toBe('running');
  });

  it('workspace deletion scheduling stores entry and can be cancelled', async () => {
    const nodeId = 'nl-test-ws-delete-001';
    const wsId = 'ws-pending-delete-001';
    await seedTestNode(nodeId);

    const stub = getStub(nodeId);
    await stub.markIdle(nodeId, TEST_USER_ID);

    // Schedule a workspace deletion
    await stub.scheduleWorkspaceDeletion(nodeId, wsId, TEST_USER_ID);

    // Cancel it
    await stub.cancelWorkspaceDeletion(wsId);

    // The DO should still be warm (deletion was cancelled, warm timeout still pending)
    const status = await stub.getStatus();
    expect(status.status).toBe('warm');
  });

  it('markActive preserves a pending workspace deletion alarm when clearing warm state', async () => {
    const nodeId = 'nl-test-active-preserves-ws-delete-001';
    const wsId = 'ws-delete-after-active-001';
    await seedTestNode(nodeId);

    const stub = getStub(nodeId);
    await stub.markIdle(nodeId, TEST_USER_ID);
    await stub.scheduleWorkspaceDeletion(nodeId, wsId, TEST_USER_ID);
    const deletionAlarm = await getAlarm(stub);
    expect(deletionAlarm).toBeGreaterThan(Date.now());

    await stub.markActive();

    const alarmAfterActivation = await getAlarm(stub);
    expect(alarmAfterActivation).toBe(deletionAlarm);
  });

  it('tryClaim preserves a pending workspace deletion alarm when clearing warm state', async () => {
    const nodeId = 'nl-test-claim-preserves-ws-delete-001';
    const wsId = 'ws-delete-after-claim-001';
    await seedTestNode(nodeId);

    const stub = getStub(nodeId);
    await seedClaimTask('task-preserve-delete-alarm');
    await stub.markIdle(nodeId, TEST_USER_ID);
    await stub.scheduleWorkspaceDeletion(nodeId, wsId, TEST_USER_ID);
    const deletionAlarm = await getAlarm(stub);
    expect(deletionAlarm).toBeGreaterThan(Date.now());

    const claim = await stub.tryClaim('task-preserve-delete-alarm');
    expect(claim.claimed).toBe(true);

    const alarmAfterClaim = await getAlarm(stub);
    expect(alarmAfterClaim).toBe(deletionAlarm);
  });

  it('alarm processes due workspace deletions while preserving active node state', async () => {
    const nodeId = 'nl-test-active-ws-delete-alarm-001';
    const wsId = 'ws-due-delete-active-001';
    const agentSessionId = 'agent-due-delete-active-001';
    await seedTestNode(nodeId);
    await seedWorkspace(wsId, nodeId, TEST_USER_ID, { status: 'stopped' });
    await seedAgentSession(agentSessionId, wsId, TEST_USER_ID, { status: 'running' });

    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const stub = getStub(nodeId);
    await runInDurableObject(stub, async (instance) => {
      await instance.ctx.storage.put('state', {
        nodeId,
        userId: TEST_USER_ID,
        status: 'active',
        warmSince: null,
        claimedByTask: null,
      } satisfies StoredNodeLifecycleState);
      await instance.ctx.storage.put(`ws-delete:${wsId}`, {
        nodeId,
        workspaceId: wsId,
        userId: TEST_USER_ID,
        deleteAt: Date.now() - 1_000,
      });
    });

    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    expect(await stub.getStatus()).toMatchObject({ status: 'active' });
    const workspace = await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
      .bind(wsId)
      .first<{ status: string }>();
    expect(workspace?.status).toBe('deleted');
    expect(await getAgentSessionStatus(agentSessionId)).toMatchObject({
      status: 'completed',
      stopped_at: expect.any(String),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await getAlarm(stub)).toBeNull();
  });

  it('alarm deletes a due sleeping workspace before warm-pool state exists', async () => {
    const nodeId = 'nl-test-uninitialized-ws-delete-001';
    const wsId = 'ws-due-delete-uninitialized-001';
    const agentSessionId = 'agent-due-delete-uninitialized-001';
    await seedTestNode(nodeId);
    await seedWorkspace(wsId, nodeId, TEST_USER_ID, { status: 'sleeping' });
    await seedAgentSession(agentSessionId, wsId, TEST_USER_ID, { status: 'running' });

    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const stub = getStub(nodeId);
    await stub.scheduleWorkspaceDeletion(nodeId, wsId, TEST_USER_ID);
    await runInDurableObject(stub, async (instance) => {
      expect(await instance.ctx.storage.get('state')).toBeUndefined();
      const deletion = await instance.ctx.storage.get<{
        nodeId: string;
        workspaceId: string;
        userId: string;
        deleteAt: number;
      }>(`ws-delete:${wsId}`);
      if (!deletion) throw new Error('expected scheduled workspace deletion');
      expect(deletion).toMatchObject({ nodeId, workspaceId: wsId, userId: TEST_USER_ID });
      await instance.ctx.storage.put(`ws-delete:${wsId}`, {
        ...deletion,
        deleteAt: Date.now() - 1_000,
      });
    });

    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    const workspace = await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
      .bind(wsId)
      .first<{ status: string }>();
    expect(workspace?.status).toBe('deleted');
    expect(await getAgentSessionStatus(agentSessionId)).toMatchObject({
      status: 'completed',
      stopped_at: expect.any(String),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await getAlarm(stub)).toBeNull();
  });

  it('preserves a ProjectData sleeping session when staged deletion finds a restorable snapshot', async () => {
    const nodeId = 'nl-test-preserve-sleeping-session-001';
    const wsId = 'ws-preserve-sleeping-session-001';
    await seedUser(TEST_USER_ID);
    await seedInstallation(TEST_INSTALLATION_ID, TEST_USER_ID);
    await seedProject(TEST_PROJECT_ID, TEST_USER_ID, TEST_INSTALLATION_ID);
    await seedTestNode(nodeId);
    await seedWorkspace(wsId, nodeId, TEST_USER_ID, {
      projectId: TEST_PROJECT_ID,
      status: 'sleeping',
    });

    const projectData = getProjectDataStub(TEST_PROJECT_ID);
    await projectData.ensureProjectId(TEST_PROJECT_ID);
    const chatSessionId = await projectData.createSession(
      wsId,
      'Sleeping session',
      null,
      TEST_USER_ID
    );
    expect(await projectData.sleepSession(chatSessionId)).toBe(true);
    await env.DATABASE.prepare(
      `UPDATE workspaces SET chat_session_id = ?, updated_at = datetime('now') WHERE id = ?`
    )
      .bind(chatSessionId, wsId)
      .run();
    await seedSleepingSnapshot({ nodeId, workspaceId: wsId, chatSessionId });

    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const stub = getStub(nodeId);
    await stub.scheduleWorkspaceDeletion(nodeId, wsId, TEST_USER_ID);
    await runInDurableObject(stub, async (instance) => {
      const deletion = await instance.ctx.storage.get<{
        nodeId: string;
        workspaceId: string;
        userId: string;
        deleteAt: number;
      }>(`ws-delete:${wsId}`);
      if (!deletion) throw new Error('expected scheduled workspace deletion');
      await instance.ctx.storage.put(`ws-delete:${wsId}`, {
        ...deletion,
        deleteAt: Date.now() - 1_000,
      });
      await instance.alarm();
    });

    const workspace = await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
      .bind(wsId)
      .first<{ status: string }>();
    expect(workspace?.status).toBe('deleted');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await getAlarm(stub)).toBeNull();

    const session = await projectData.getSession(chatSessionId);
    expect(session).toMatchObject({ id: chatSessionId, status: 'sleeping' });
  });

  it('tryClaim on destroying node returns false', async () => {
    const nodeId = 'nl-test-claim-destroying-001';
    await seedTestNode(nodeId);

    const stub = getStub(nodeId);

    // Set destroying state
    await runInDurableObject(stub, async (instance) => {
      await instance.ctx.storage.put('state', {
        nodeId,
        userId: TEST_USER_ID,
        status: 'destroying',
        warmSince: null,
        claimedByTask: null,
      });
    });

    const { claimed } = await stub.tryClaim('task-003');
    expect(claimed).toBe(false);
  });

  it('markIdle with warmTimeoutOverrideMs uses the override', async () => {
    const nodeId = 'nl-test-override-001';
    await seedTestNode(nodeId);

    const stub = getStub(nodeId);
    const result = await stub.markIdle(nodeId, TEST_USER_ID, 60_000);

    expect(result.status).toBe('warm');
    expect(result.warmSince).toBeTruthy();

    const stored = await getStoredState(stub);
    expect(stored?.warmTimeoutOverrideMs).toBe(60_000);
  });

  it('warm timeout override controls the alarm transition to destroying', async () => {
    const nodeId = 'nl-test-override-transition-001';
    await seedTestNode(nodeId);

    const stub = getStub(nodeId);
    await stub.markIdle(nodeId, TEST_USER_ID, 1_000);

    await runInDurableObject(stub, async (instance) => {
      const state = await instance.ctx.storage.get<StoredNodeLifecycleState>('state');
      if (!state) throw new Error('expected stored NodeLifecycle state');

      await instance.ctx.storage.put('state', {
        ...state,
        warmSince: Date.now() - 1_500,
      });
    });

    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    expect((await stub.getStatus()).status).toBe('destroying');
  });
});
