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

import type { Env } from '../../src/env';
import { ensureSessionRecovery } from '../../src/services/session-recovery';
import {
  attemptWorkspaceDeletion,
  loadWorkspaceDeletionIdentity,
} from '../../src/services/workspace-deletion';
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

async function getWorkspaceStatusFromD1(workspaceId: string): Promise<string | null> {
  const workspace = await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
    .bind(workspaceId)
    .first<{ status: string }>();
  return workspace?.status ?? null;
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

async function setNodeLifecycleDeletionEnv(
  stub: DurableObjectStub<NodeLifecycleTestDouble>,
  overrides: Record<string, string | undefined>
): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    const mutableEnv = instance.env as unknown as Record<string, string | undefined>;
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete mutableEnv[key];
      else mutableEnv[key] = value;
    }
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

  it('does not renew the bounded warm-claim timestamp on an idempotent retry', async () => {
    const nodeId = 'nl-test-claim-fixed-timestamp-001';
    const taskId = 'task-claim-fixed-timestamp-001';
    const originalClaimedAt = '2026-08-27T12:00:00.000Z';
    await seedTestNode(nodeId);
    await seedClaimTask(taskId);

    const stub = getStub(nodeId);
    await stub.markIdle(nodeId, TEST_USER_ID);
    expect((await stub.tryClaim(taskId)).claimed).toBe(true);
    await env.DATABASE.prepare(
      `UPDATE tasks SET claimed_warm_node_at = ? WHERE id = ? AND claimed_warm_node_id = ?`
    )
      .bind(originalClaimedAt, taskId, nodeId)
      .run();

    expect((await stub.tryClaim(taskId)).claimed).toBe(true);
    const retriedClaim = await env.DATABASE.prepare(
      `SELECT claimed_warm_node_id, claimed_warm_node_at FROM tasks WHERE id = ?`
    )
      .bind(taskId)
      .first<{ claimed_warm_node_id: string | null; claimed_warm_node_at: string | null }>();
    expect(retriedClaim).toEqual({
      claimed_warm_node_id: nodeId,
      claimed_warm_node_at: originalClaimedAt,
    });
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
    const task = await env.DATABASE.prepare(
      `SELECT claimed_warm_node_id, claimed_warm_node_at FROM tasks WHERE id = ?`
    )
      .bind(taskId)
      .first<{ claimed_warm_node_id: string | null; claimed_warm_node_at: string | null }>();
    expect(task?.claimed_warm_node_id).toBeNull();
    expect(task?.claimed_warm_node_at).toBeNull();
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
    const task = await env.DATABASE.prepare(
      `SELECT claimed_warm_node_id, claimed_warm_node_at FROM tasks WHERE id = ?`
    )
      .bind(recoveryTaskId)
      .first<{ claimed_warm_node_id: string | null; claimed_warm_node_at: string | null }>();
    expect(task?.claimed_warm_node_id).toBe(nodeId);
    expect(task?.claimed_warm_node_at).toEqual(expect.any(String));
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
      `SELECT claimed_warm_node_id, claimed_warm_node_at FROM tasks WHERE id = ?`
    )
      .bind(taskId)
      .first<{ claimed_warm_node_id: string | null; claimed_warm_node_at: string | null }>();
    expect(claimedTask?.claimed_warm_node_id).toBe(nodeId);
    expect(claimedTask?.claimed_warm_node_at).toEqual(expect.any(String));

    expect((await stub.releaseClaim('another-task')).released).toBe(false);
    const released = await stub.releaseClaim(taskId);
    expect(released.released).toBe(true);
    expect(released.state.status).toBe('warm');
    expect(await getAlarm(stub)).toBeGreaterThan(Date.now());
    const releasedTask = await env.DATABASE.prepare(
      `SELECT claimed_warm_node_id, claimed_warm_node_at FROM tasks WHERE id = ?`
    )
      .bind(taskId)
      .first<{ claimed_warm_node_id: string | null; claimed_warm_node_at: string | null }>();
    expect(releasedTask?.claimed_warm_node_id).toBeNull();
    expect(releasedTask?.claimed_warm_node_at).toBeNull();
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
    await env.DATABASE.prepare(
      `UPDATE tasks SET claimed_warm_node_id = ?, claimed_warm_node_at = ? WHERE id = ?`
    )
      .bind(nodeId, new Date().toISOString(), firstTaskId)
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

  it.each(['stopped', 'deleted'] as const)(
    'preserves an in-flight workspace deletion retry when destroying D1 state is %s',
    async (nodeStatus) => {
      const nodeId = `nl-test-destroy-preserves-${nodeStatus}-001`;
      const wsId = `ws-destroy-preserves-${nodeStatus}-001`;
      await seedTestNode(nodeId);
      await seedWorkspace(wsId, nodeId, TEST_USER_ID, { status: 'stopped' });

      const stub = getStub(nodeId);
      await stub.scheduleWorkspaceDeletion(nodeId, wsId, TEST_USER_ID);
      await env.DATABASE.prepare('UPDATE nodes SET status = ? WHERE id = ?')
        .bind(nodeStatus, nodeId)
        .run();
      await runInDurableObject(stub, async (instance) => {
        await instance.ctx.storage.put('state', {
          nodeId,
          userId: TEST_USER_ID,
          status: 'destroying',
          warmSince: null,
          destroyingSince: Date.now(),
          claimedByTask: null,
        } satisfies StoredNodeLifecycleState);
        const key = `ws-delete:${wsId}`;
        const pending = await instance.ctx.storage.get<Record<string, unknown>>(key);
        await instance.ctx.storage.put(key, { ...pending, deleteAt: Date.now() - 1 });
      });

      let fetchEntered = false;
      let releaseFetch = false;
      const fetchMock = vi.fn(async () => {
        fetchEntered = true;
        while (!releaseFetch) await new Promise((resolve) => setTimeout(resolve, 1));
        throw new Error('simulated timeout');
      });
      vi.stubGlobal('fetch', fetchMock);

      const alarmInvocation = runInDurableObject(stub, async (instance) => instance.alarm());
      try {
        await vi.waitFor(() => expect(fetchEntered).toBe(true));
        await alarmInvocation;

        expect(await getStoredState(stub)).toBeNull();
        expect(await getAlarm(stub)).not.toBeNull();
        expect(
          await runInDurableObject(stub, async (instance) =>
            instance.ctx.storage.get(`ws-delete:${wsId}`)
          )
        ).toMatchObject({ attemptCount: 1, deadLetteredAt: null });
      } finally {
        releaseFetch = true;
        await alarmInvocation;
      }

      await vi.waitFor(async () => {
        const pending = await runInDurableObject(stub, async (instance) =>
          instance.ctx.storage.get<{ lastError: string | null }>(`ws-delete:${wsId}`)
        );
        expect(pending?.lastError).toContain('VM attempt 1');
        expect(await getAlarm(stub)).not.toBeNull();
      });
      expect(
        await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
          .bind(wsId)
          .first<{ status: string }>()
      ).toEqual({ status: 'stopping' });
    }
  );

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

  it('fences a stale scheduled cleanup claim after restart wins', async () => {
    const nodeId = 'nl-test-restart-before-cleanup-claim-001';
    const wsId = 'ws-restart-before-cleanup-claim-001';
    await seedTestNode(nodeId);
    await seedWorkspace(wsId, nodeId, TEST_USER_ID, { status: 'stopped' });

    // This is the identity snapshot captured by the scheduled safety-net scan.
    const expected = {
      workspaceId: wsId,
      nodeId,
      nodeUserId: TEST_USER_ID,
      nodeRuntime: 'vm',
      nodeProviderInstanceId: null,
      nodeRuntimeIncarnationId: null,
      userId: TEST_USER_ID,
      projectId: null,
      chatSessionId: null,
    };

    // Restart completes before the scan reaches NodeLifecycle.claimAttempt().
    await env.DATABASE.prepare("UPDATE workspaces SET status = 'running' WHERE id = ?")
      .bind(wsId)
      .run();

    const stub = getStub(nodeId);
    await expect(
      stub.claimWorkspaceDeletionAttempt(nodeId, wsId, TEST_USER_ID, expected)
    ).resolves.toBe(false);

    const workspace = await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
      .bind(wsId)
      .first<{ status: string }>();
    expect(workspace?.status).toBe('running');
    expect(
      await runInDurableObject(stub, async (instance) =>
        instance.ctx.storage.get(`ws-delete:${wsId}`)
      )
    ).toBeUndefined();
  });

  it('persists a deletion claim before VM I/O and refuses restart cancellation while fetch is deferred', async () => {
    const nodeId = 'nl-test-durable-claim-before-fetch-001';
    const wsId = 'ws-durable-claim-before-fetch-001';
    await seedTestNode(nodeId);
    await seedWorkspace(wsId, nodeId, TEST_USER_ID, { status: 'stopped' });

    const stub = getStub(nodeId);
    await stub.scheduleWorkspaceDeletion(nodeId, wsId, TEST_USER_ID);
    await runInDurableObject(stub, async (instance) => {
      const key = `ws-delete:${wsId}`;
      const pending = await instance.ctx.storage.get<Record<string, unknown>>(key);
      await instance.ctx.storage.put(key, { ...pending, deleteAt: Date.now() - 1 });
    });

    let fetchEntered = false;
    let releaseFetch = false;
    let workspaceStatusAtFetch: string | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        workspaceStatusAtFetch =
          (
            await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
              .bind(wsId)
              .first<{ status: string }>()
          )?.status ?? null;
        fetchEntered = true;
        while (!releaseFetch) await new Promise((resolve) => setTimeout(resolve, 1));
        return new Response(null, { status: 204 });
      })
    );

    const alarmInvocation = runInDurableObject(stub, async (instance) => instance.alarm());
    let alarmRace: 'returned' | 'blocked' = 'blocked';
    try {
      await vi.waitFor(() => expect(fetchEntered).toBe(true));
      alarmRace = await Promise.race([
        alarmInvocation.then(() => 'returned' as const),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 1_000)),
      ]);
      expect(workspaceStatusAtFetch).toBe('stopping');

      const claimed = await runInDurableObject(stub, async (instance) =>
        instance.ctx.storage.get<{
          attemptCount: number;
          lastAttemptAt: number;
          claimId: string;
          deleteAt: number;
        }>(`ws-delete:${wsId}`)
      );
      expect(claimed).toMatchObject({
        attemptCount: 1,
        lastAttemptAt: expect.any(Number),
        claimId: expect.any(String),
        deleteAt: expect.any(Number),
      });
      expect(await getAlarm(stub)).toBeGreaterThan(Date.now());
      await expect(stub.cancelWorkspaceDeletion(wsId)).resolves.toBe(false);
    } finally {
      releaseFetch = true;
      await alarmInvocation;
    }
    expect(alarmRace).toBe('returned');
    await vi.waitFor(async () => {
      const workspace = await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
        .bind(wsId)
        .first<{ status: string }>();
      expect(workspace?.status).toBe('deleted');
      expect(
        await runInDurableObject(stub, async (instance) =>
          instance.ctx.storage.get(`ws-delete:${wsId}`)
        )
      ).toBeUndefined();
      expect(await getAlarm(stub)).toBeNull();
    });
  });

  it('serializes restart cancellation against the durable alarm claim', async () => {
    for (let iteration = 0; iteration < 8; iteration++) {
      const nodeId = `nl-test-cancel-claim-race-${iteration}`;
      const wsId = `ws-cancel-claim-race-${iteration}`;
      await seedTestNode(nodeId);
      await seedWorkspace(wsId, nodeId, TEST_USER_ID, { status: 'stopped' });

      const stub = getStub(nodeId);
      await stub.scheduleWorkspaceDeletion(nodeId, wsId, TEST_USER_ID);
      await runInDurableObject(stub, async (instance) => {
        const key = `ws-delete:${wsId}`;
        const pending = await instance.ctx.storage.get<Record<string, unknown>>(key);
        await instance.ctx.storage.put(key, { ...pending, deleteAt: Date.now() - 1 });
      });

      let requestedWorkspaceId: string | null = null;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          requestedWorkspaceId = url.includes(wsId) ? wsId : null;
          return new Response(null, { status: 204 });
        })
      );

      const [, cancelled] = await Promise.all([
        runInDurableObject(stub, async (instance) => instance.alarm()),
        stub.cancelWorkspaceDeletion(wsId),
      ]);
      if (cancelled) {
        const status = await getWorkspaceStatusFromD1(wsId);
        // Cancellation can linearize after a fully confirmed attempt has already
        // removed its durable entry. In that case the route's exact D1 CAS still
        // refuses the restart because the workspace is terminal.
        if (requestedWorkspaceId) expect(status).toBe('deleted');
        else expect(status).toBe('stopped');
      } else {
        await vi.waitFor(async () => expect(await getWorkspaceStatusFromD1(wsId)).toBe('deleted'));
        expect(requestedWorkspaceId).toBe(wsId);
      }
    }
  });

  it('retains the durable claim across a D1 claim fault and converges after D1 recovers', async () => {
    const nodeId = 'nl-test-d1-claim-fault-001';
    const wsId = 'ws-d1-claim-fault-001';
    await seedTestNode(nodeId);
    await seedWorkspace(wsId, nodeId, TEST_USER_ID, { status: 'stopped' });

    const stub = getStub(nodeId);
    await stub.scheduleWorkspaceDeletion(nodeId, wsId, TEST_USER_ID);
    await runInDurableObject(stub, async (instance) => {
      const key = `ws-delete:${wsId}`;
      const pending = await instance.ctx.storage.get<Record<string, unknown>>(key);
      await instance.ctx.storage.put(key, { ...pending, deleteAt: Date.now() - 1 });
    });

    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    let injectedClaimFailures = 0;

    await runInDurableObject(stub, async (instance) => {
      const mutableEnv = instance.env as unknown as { DATABASE: D1Database };
      const originalDatabase = mutableEnv.DATABASE;
      const faultingDatabase = new Proxy(originalDatabase, {
        get(target, property) {
          if (property === 'prepare') {
            return (query: string): D1PreparedStatement => {
              const isExactDeletionClaim =
                query.includes("SET status = 'stopping'") &&
                query.includes("status IN ('stopped', 'sleeping', 'stopping', 'deleted')");
              if (isExactDeletionClaim && injectedClaimFailures === 0) {
                return {
                  bind: () => ({
                    run: async () => {
                      injectedClaimFailures += 1;
                      throw new Error('simulated D1 claim outage');
                    },
                  }),
                } as unknown as D1PreparedStatement;
              }
              return target.prepare(query);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      mutableEnv.DATABASE = faultingDatabase;
      try {
        await instance.alarm();
      } finally {
        mutableEnv.DATABASE = originalDatabase;
      }
    });

    expect(injectedClaimFailures).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
        .bind(wsId)
        .first<{ status: string }>()
    ).toMatchObject({ status: 'stopped' });

    const retained = await runInDurableObject(stub, async (instance) =>
      instance.ctx.storage.get<{
        attemptCount: number;
        lastAttemptAt: number;
        lastError: string;
        claimId: string;
        deleteAt: number;
      }>(`ws-delete:${wsId}`)
    );
    expect(retained).toMatchObject({
      attemptCount: 1,
      lastAttemptAt: expect.any(Number),
      lastError: 'D1 deletion claim failed before VM request',
      claimId: expect.any(String),
      deleteAt: expect.any(Number),
    });
    expect(retained!.deleteAt).toBeGreaterThan(Date.now());
    expect(await getAlarm(stub)).toBeGreaterThan(Date.now());

    await runInDurableObject(stub, async (instance) => {
      const key = `ws-delete:${wsId}`;
      const pending = await instance.ctx.storage.get<Record<string, unknown>>(key);
      await instance.ctx.storage.put(key, { ...pending, deleteAt: Date.now() - 1 });
      await instance.alarm();
    });
    await vi.waitFor(async () => {
      const workspace = await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
        .bind(wsId)
        .first<{ status: string }>();
      expect(workspace?.status).toBe('deleted');
      expect(
        await runInDurableObject(stub, async (instance) =>
          instance.ctx.storage.get(`ws-delete:${wsId}`)
        )
      ).toBeUndefined();
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      await runInDurableObject(stub, async (instance) =>
        instance.ctx.storage.get(`ws-delete:${wsId}`)
      )
    ).toBeUndefined();
    await vi.waitFor(async () => expect(await getAlarm(stub)).toBeNull());
  });

  it('continues the warm lifecycle alarm while deferred VM deletion remains owned by waitUntil', async () => {
    const nodeId = 'nl-test-alarm-wait-until-001';
    const wsId = 'ws-alarm-wait-until-001';
    await seedTestNode(nodeId);
    await seedWorkspace(wsId, nodeId, TEST_USER_ID, { status: 'stopped' });

    const stub = getStub(nodeId);
    await runInDurableObject(stub, async (instance) => {
      await instance.ctx.storage.put('state', {
        nodeId,
        userId: TEST_USER_ID,
        status: 'warm',
        warmSince: Date.now() - 10_000,
        claimedByTask: null,
        warmTimeoutOverrideMs: 1,
      } satisfies StoredNodeLifecycleState);
      await instance.ctx.storage.put(`ws-delete:${wsId}`, {
        nodeId,
        workspaceId: wsId,
        userId: TEST_USER_ID,
        deleteAt: Date.now() - 1,
      });
    });

    let fetchEntered = false;
    let releaseFetch = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchEntered = true;
        while (!releaseFetch) await new Promise((resolve) => setTimeout(resolve, 1));
        return new Response(null, { status: 204 });
      })
    );

    const alarmInvocation = runInDurableObject(stub, async (instance) => instance.alarm());
    let alarmRace: 'returned' | 'blocked' = 'blocked';
    try {
      await vi.waitFor(() => expect(fetchEntered).toBe(true));
      alarmRace = await Promise.race([
        alarmInvocation.then(() => 'returned' as const),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 1_000)),
      ]);
      expect(await getStoredState(stub)).toMatchObject({ status: 'destroying' });
      expect(
        await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
          .bind(wsId)
          .first<{ status: string }>()
      ).toMatchObject({ status: 'stopping' });
    } finally {
      releaseFetch = true;
      await alarmInvocation;
    }
    expect(alarmRace).toBe('returned');
    await vi.waitFor(async () => {
      const workspace = await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
        .bind(wsId)
        .first<{ status: string }>();
      expect(workspace?.status).toBe('deleted');
      expect(
        await runInDurableObject(stub, async (instance) =>
          instance.ctx.storage.get(`ws-delete:${wsId}`)
        )
      ).toBeUndefined();
    });
  });

  it('bounds each alarm batch and applies exponential deletion retry delays', async () => {
    const nodeId = 'nl-test-delete-batch-backoff-001';
    const workspaceIds = [
      'ws-delete-batch-backoff-001',
      'ws-delete-batch-backoff-002',
      'ws-delete-batch-backoff-003',
    ];
    await seedTestNode(nodeId);
    for (const workspaceId of workspaceIds) {
      await seedWorkspace(workspaceId, nodeId, TEST_USER_ID, { status: 'stopped' });
    }

    const stub = getStub(nodeId);
    await setNodeLifecycleDeletionEnv(stub, {
      WORKSPACE_DELETION_ALARM_BATCH_SIZE: '2',
      WORKSPACE_DELETION_RETRY_BASE_MS: '60000',
      WORKSPACE_DELETION_RETRY_MAX_MS: '240000',
    });

    try {
      for (const workspaceId of workspaceIds) {
        await stub.scheduleWorkspaceDeletion(nodeId, workspaceId, TEST_USER_ID);
      }
      await runInDurableObject(stub, async (instance) => {
        for (const workspaceId of workspaceIds) {
          const key = `ws-delete:${workspaceId}`;
          const pending = await instance.ctx.storage.get<Record<string, unknown>>(key);
          await instance.ctx.storage.put(key, { ...pending, deleteAt: Date.now() - 1 });
        }
      });

      const fetchMock = vi.fn(async () => {
        throw new Error('simulated retryable deletion failure');
      });
      vi.stubGlobal('fetch', fetchMock);
      const afterFirstAlarm = await runInDurableObject(stub, async (instance) => {
        await instance.alarm();
        return await Promise.all(
          workspaceIds.map((workspaceId) =>
            instance.ctx.storage.get<{
              attemptCount?: number;
              lastAttemptAt?: number;
              lastError?: string | null;
              deleteAt: number;
            }>(`ws-delete:${workspaceId}`)
          )
        );
      });
      expect(afterFirstAlarm[0]).toMatchObject({ attemptCount: 1 });
      expect(afterFirstAlarm[1]).toMatchObject({ attemptCount: 1 });
      expect(afterFirstAlarm[2]).toMatchObject({ attemptCount: 0 });
      for (const [index, entry] of afterFirstAlarm.slice(0, 2).entries()) {
        expect(entry).toBeDefined();
        await vi.waitFor(async () => {
          const completed = await runInDurableObject(stub, async (instance) =>
            instance.ctx.storage.get<{ lastError?: string | null }>(
              `ws-delete:${workspaceIds[index]}`
            )
          );
          expect(completed?.lastError).toContain('VM attempt 1');
        });
        expect(entry!.deleteAt - entry!.lastAttemptAt!).toBeGreaterThanOrEqual(60_000);
        expect(entry!.deleteAt - entry!.lastAttemptAt!).toBeLessThan(61_000);
      }

      await runInDurableObject(stub, async (instance) => {
        const key = `ws-delete:${workspaceIds[0]}`;
        const pending = await instance.ctx.storage.get<Record<string, unknown>>(key);
        await instance.ctx.storage.put(key, { ...pending, deleteAt: Date.now() - 1 });
      });
      await runInDurableObject(stub, async (instance) => instance.alarm());
      let secondAttempt:
        | {
            attemptCount: number;
            lastAttemptAt: number;
            lastError: string | null;
            deleteAt: number;
          }
        | undefined;
      await vi.waitFor(async () => {
        secondAttempt = await runInDurableObject(stub, async (instance) =>
          instance.ctx.storage.get<{
            attemptCount: number;
            lastAttemptAt: number;
            lastError: string | null;
            deleteAt: number;
          }>(`ws-delete:${workspaceIds[0]}`)
        );
        expect(secondAttempt?.attemptCount).toBe(2);
        expect(secondAttempt?.lastError).toContain('VM attempt 2');
      });
      expect(secondAttempt).toMatchObject({ attemptCount: 2 });
      expect(secondAttempt!.deleteAt - secondAttempt!.lastAttemptAt).toBeGreaterThanOrEqual(
        120_000
      );
      expect(secondAttempt!.deleteAt - secondAttempt!.lastAttemptAt).toBeLessThan(121_000);
    } finally {
      await setNodeLifecycleDeletionEnv(stub, {
        WORKSPACE_DELETION_ALARM_BATCH_SIZE: undefined,
        WORKSPACE_DELETION_RETRY_BASE_MS: undefined,
        WORKSPACE_DELETION_RETRY_MAX_MS: undefined,
      });
    }
  });

  it('dead-letters an over-age deletion without terminalizing or rearming its alarm', async () => {
    const nodeId = 'nl-test-delete-dead-letter-001';
    const wsId = 'ws-delete-dead-letter-001';
    const payloadMarker = 'must-not-enter-operator-telemetry';
    await seedTestNode(nodeId);
    await seedWorkspace(wsId, nodeId, TEST_USER_ID, { status: 'stopping' });

    const stub = getStub(nodeId);
    await setNodeLifecycleDeletionEnv(stub, { WORKSPACE_DELETION_MAX_RESIDENCE_MS: '100' });
    try {
      await stub.scheduleWorkspaceDeletion(nodeId, wsId, TEST_USER_ID);
      await runInDurableObject(stub, async (instance) => {
        const key = `ws-delete:${wsId}`;
        const pending = await instance.ctx.storage.get<Record<string, unknown>>(key);
        if (!pending) throw new Error('expected scheduled workspace deletion');
        await instance.ctx.storage.put(key, {
          ...pending,
          deleteAt: Date.now() - 1,
          firstScheduledAt: Date.now() - 1_000,
          attemptCount: 3,
          lastAttemptAt: Date.now() - 500,
          lastError: payloadMarker,
          claimId: 'claim-before-dead-letter',
        });
        await instance.ctx.storage.setAlarm(Date.now() + 60_000);
      });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await runInDurableObject(stub, async (instance) => instance.alarm());
      await vi.waitFor(async () => {
        const retained = await runInDurableObject(stub, async (instance) =>
          instance.ctx.storage.get<{
            attemptCount: number;
            deadLetteredAt: number;
            deadLetterReason: string;
          }>(`ws-delete:${wsId}`)
        );
        expect(retained).toMatchObject({
          attemptCount: 3,
          deadLetteredAt: expect.any(Number),
          deadLetterReason: 'maximum retry residence exceeded',
        });
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(await getAlarm(stub)).toBeNull();
      expect(
        await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
          .bind(wsId)
          .first<{ status: string }>()
      ).toMatchObject({ status: 'stopping' });

      await vi.waitFor(async () => {
        const telemetry = await env.OBSERVABILITY_DATABASE.prepare(
          `SELECT message, stack, context, ip_address, user_agent, workspace_id, node_id
             FROM platform_errors
            WHERE workspace_id = ?
            ORDER BY timestamp DESC
            LIMIT 1`
        )
          .bind(wsId)
          .first<{
            message: string;
            stack: string | null;
            context: string | null;
            ip_address: string | null;
            user_agent: string | null;
            workspace_id: string | null;
            node_id: string | null;
          }>();
        expect(telemetry).toMatchObject({
          message: 'Workspace deletion entered durable operator quarantine',
          stack: null,
          context: null,
          ip_address: null,
          user_agent: null,
          workspace_id: wsId,
          node_id: nodeId,
        });
        expect(JSON.stringify(telemetry)).not.toContain(payloadMarker);
      });
    } finally {
      await setNodeLifecycleDeletionEnv(stub, {
        WORKSPACE_DELETION_MAX_RESIDENCE_MS: undefined,
      });
    }
  });

  it('claims and quarantines a timed-out deletion, refuses restart, then converges on retry', async () => {
    const nodeId = 'nl-test-delete-timeout-retry-001';
    const wsId = 'ws-delete-timeout-retry-001';
    const agentSessionId = 'agent-delete-timeout-retry-001';
    await seedTestNode(nodeId);
    await seedWorkspace(wsId, nodeId, TEST_USER_ID, { status: 'stopped' });
    await seedAgentSession(agentSessionId, wsId, TEST_USER_ID, { status: 'running' });

    const stub = getStub(nodeId);
    await stub.scheduleWorkspaceDeletion(nodeId, wsId, TEST_USER_ID);
    await runInDurableObject(stub, async (instance) => {
      const key = `ws-delete:${wsId}`;
      const pending = await instance.ctx.storage.get<Record<string, unknown>>(key);
      await instance.ctx.storage.put(key, { ...pending, deleteAt: Date.now() - 1 });
    });
    const timeoutFetch = vi.fn(async () => {
      throw new Error('simulated timeout');
    });
    vi.stubGlobal('fetch', timeoutFetch);

    await runInDurableObject(stub, async (instance) => instance.alarm());

    let quarantined: { status: string; error_message: string | null } | null = null;
    let pendingAfterTimeout:
      | {
          attemptCount: number;
          lastAttemptAt: number;
          lastError: string | null;
          deleteAt: number;
        }
      | undefined;
    await vi.waitFor(async () => {
      quarantined = await env.DATABASE.prepare(
        'SELECT status, error_message FROM workspaces WHERE id = ?'
      )
        .bind(wsId)
        .first<{ status: string; error_message: string | null }>();
      pendingAfterTimeout = await runInDurableObject(stub, async (instance) =>
        instance.ctx.storage.get<{
          attemptCount: number;
          lastAttemptAt: number;
          lastError: string | null;
          deleteAt: number;
        }>(`ws-delete:${wsId}`)
      );
      expect(timeoutFetch).toHaveBeenCalledOnce();
      expect(quarantined?.error_message).toContain('VM attempt 1');
      expect(pendingAfterTimeout?.lastError).toContain('VM attempt 1');
    });
    expect(quarantined).toMatchObject({
      status: 'stopping',
      error_message: expect.stringContaining('deletion unconfirmed'),
    });
    expect(await getAgentSessionStatus(agentSessionId)).toMatchObject({
      status: 'running',
      stopped_at: null,
    });
    expect(pendingAfterTimeout).toMatchObject({
      attemptCount: 1,
      lastAttemptAt: expect.any(Number),
      deleteAt: expect.any(Number),
    });
    expect(await stub.cancelWorkspaceDeletion(wsId)).toBe(false);

    const successFetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', successFetch);
    await runInDurableObject(stub, async (instance) => {
      const key = `ws-delete:${wsId}`;
      const pending = await instance.ctx.storage.get<Record<string, unknown>>(key);
      await instance.ctx.storage.put(key, { ...pending, deleteAt: Date.now() - 1 });
      await instance.alarm();
    });

    let finalized: { status: string } | null = null;
    await vi.waitFor(async () => {
      finalized = await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
        .bind(wsId)
        .first<{ status: string }>();
      expect(finalized?.status).toBe('deleted');
      expect(await getAgentSessionStatus(agentSessionId)).toMatchObject({
        status: 'completed',
        stopped_at: expect.any(String),
      });
      expect(
        await runInDurableObject(stub, async (instance) =>
          instance.ctx.storage.get(`ws-delete:${wsId}`)
        )
      ).toBeUndefined();
      expect(await getAlarm(stub)).toBeNull();
    });
    expect(finalized?.status).toBe('deleted');
    expect(successFetch).toHaveBeenCalledOnce();
  });

  it('treats a workspace-specific VM 404 as idempotent absence proof', async () => {
    const nodeId = 'nl-test-delete-404-proof-001';
    const wsId = 'ws-delete-404-proof-001';
    const agentSessionId = 'agent-delete-404-proof-001';
    await seedTestNode(nodeId);
    await seedWorkspace(wsId, nodeId, TEST_USER_ID, { status: 'stopped' });
    await seedAgentSession(agentSessionId, wsId, TEST_USER_ID, { status: 'running' });

    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const stub = getStub(nodeId);
    await stub.scheduleWorkspaceDeletion(nodeId, wsId, TEST_USER_ID);
    await runInDurableObject(stub, async (instance) => {
      const key = `ws-delete:${wsId}`;
      const pending = await instance.ctx.storage.get<Record<string, unknown>>(key);
      await instance.ctx.storage.put(key, { ...pending, deleteAt: Date.now() - 1 });
      await instance.alarm();
    });

    let workspace: { status: string } | null = null;
    await vi.waitFor(async () => {
      workspace = await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
        .bind(wsId)
        .first<{ status: string }>();
      expect(workspace?.status).toBe('deleted');
      expect(await getAgentSessionStatus(agentSessionId)).toMatchObject({
        status: 'completed',
        stopped_at: expect.any(String),
      });
      expect(
        await runInDurableObject(stub, async (instance) =>
          instance.ctx.storage.get(`ws-delete:${wsId}`)
        )
      ).toBeUndefined();
      expect(await getAlarm(stub)).toBeNull();
    });
    expect(workspace?.status).toBe('deleted');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not treat a deleted node status label as runtime termination proof', async () => {
    const nodeId = 'nl-test-node-label-not-proof-001';
    const wsId = 'ws-node-label-not-proof-001';
    await seedTestNode(nodeId);
    await seedWorkspace(wsId, nodeId, TEST_USER_ID, { status: 'stopped' });
    await env.DATABASE.prepare("UPDATE nodes SET status = 'deleted' WHERE id = ?")
      .bind(nodeId)
      .run();
    const fetchMock = vi.fn(async () => {
      throw new Error('node unreachable');
    });
    vi.stubGlobal('fetch', fetchMock);

    const stub = getStub(nodeId);
    await stub.scheduleWorkspaceDeletion(nodeId, wsId, TEST_USER_ID);
    await runInDurableObject(stub, async (instance) => {
      const key = `ws-delete:${wsId}`;
      const pending = await instance.ctx.storage.get<Record<string, unknown>>(key);
      await instance.ctx.storage.put(key, { ...pending, deleteAt: Date.now() - 1 });
      await instance.alarm();
    });

    let workspace: { status: string } | null = null;
    await vi.waitFor(async () => {
      workspace = await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
        .bind(wsId)
        .first<{ status: string }>();
      const pending = await runInDurableObject(stub, async (instance) =>
        instance.ctx.storage.get<{ lastError?: string | null; deleteAt: number }>(
          `ws-delete:${wsId}`
        )
      );
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(workspace?.status).toBe('stopping');
      expect(pending?.lastError).toContain('VM attempt 1');
      expect(pending?.deleteAt).toBeGreaterThan(Date.now());
    });
    expect(workspace?.status).toBe('stopping');
    expect(
      await runInDurableObject(stub, async (instance) =>
        instance.ctx.storage.get(`ws-delete:${wsId}`)
      )
    ).toBeDefined();
  });

  it('accepts the strict provider/container termination marker without contacting the VM', async () => {
    const nodeId = 'nl-test-strict-node-proof-001';
    const wsId = 'ws-strict-node-proof-001';
    await seedTestNode(nodeId);
    await seedWorkspace(wsId, nodeId, TEST_USER_ID, { status: 'stopped' });
    await env.DATABASE.prepare('UPDATE nodes SET runtime_termination_confirmed_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), nodeId)
      .run();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const stub = getStub(nodeId);
    await stub.scheduleWorkspaceDeletion(nodeId, wsId, TEST_USER_ID);
    await runInDurableObject(stub, async (instance) => {
      const key = `ws-delete:${wsId}`;
      const pending = await instance.ctx.storage.get<Record<string, unknown>>(key);
      await instance.ctx.storage.put(key, { ...pending, deleteAt: Date.now() - 1 });
      await instance.alarm();
    });

    let workspace: { status: string } | null = null;
    await vi.waitFor(async () => {
      workspace = await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
        .bind(wsId)
        .first<{ status: string }>();
      expect(workspace?.status).toBe('deleted');
      expect(
        await runInDurableObject(stub, async (instance) =>
          instance.ctx.storage.get(`ws-delete:${wsId}`)
        )
      ).toBeUndefined();
      expect(await getAlarm(stub)).toBeNull();
    });
    expect(workspace?.status).toBe('deleted');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fences a reassigned workspace incarnation and keeps the original deletion evidence', async () => {
    const oldNodeId = 'nl-test-reassigned-old-001';
    const newNodeId = 'nl-test-reassigned-new-001';
    const wsId = 'ws-reassigned-incarnation-001';
    await seedTestNode(oldNodeId);
    await seedTestNode(newNodeId);
    await seedWorkspace(wsId, oldNodeId, TEST_USER_ID, { status: 'stopped' });
    const stub = getStub(oldNodeId);
    await stub.scheduleWorkspaceDeletion(oldNodeId, wsId, TEST_USER_ID);
    await env.DATABASE.prepare("UPDATE workspaces SET node_id = ?, status = 'running' WHERE id = ?")
      .bind(newNodeId, wsId)
      .run();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await runInDurableObject(stub, async (instance) => {
      const key = `ws-delete:${wsId}`;
      const pending = await instance.ctx.storage.get<Record<string, unknown>>(key);
      await instance.ctx.storage.put(key, { ...pending, deleteAt: Date.now() - 1 });
      await instance.alarm();
    });

    let workspace: { status: string; node_id: string | null } | null = null;
    await vi.waitFor(async () => {
      workspace = await env.DATABASE.prepare('SELECT status, node_id FROM workspaces WHERE id = ?')
        .bind(wsId)
        .first<{ status: string; node_id: string | null }>();
      const retained = await runInDurableObject(stub, async (instance) =>
        instance.ctx.storage.get<{ deadLetteredAt?: number | null }>(`ws-delete:${wsId}`)
      );
      expect(workspace).toMatchObject({ status: 'running', node_id: newNodeId });
      expect(retained?.deadLetteredAt).toEqual(expect.any(Number));
      expect(await getAlarm(stub)).toBeNull();
    });
    expect(workspace).toMatchObject({ status: 'running', node_id: newNodeId });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      await runInDurableObject(stub, async (instance) =>
        instance.ctx.storage.get(`ws-delete:${wsId}`)
      )
    ).toBeDefined();
  });

  it.each(['node', 'user', 'project', 'chat-session'] as const)(
    'preserves a new %s incarnation that wins while VM deletion is in flight',
    async (dimension) => {
      const suffix = dimension.replace('-', '_');
      const oldNodeId = `nl-test-inflight-${suffix}-old-001`;
      const newNodeId = `nl-test-inflight-${suffix}-new-001`;
      const wsId = `ws-inflight-${suffix}-001`;
      const newUserId = `user-inflight-${suffix}-001`;
      const newProjectId = `project-inflight-${suffix}-001`;
      const newInstallationId = `installation-inflight-${suffix}-001`;
      const newChatSessionId = `chat-inflight-${suffix}-001`;
      await seedTestNode(oldNodeId);
      if (dimension === 'node') await seedTestNode(newNodeId);
      if (dimension === 'user') await seedUser(newUserId);
      if (dimension === 'project') {
        await seedInstallation(newInstallationId, TEST_USER_ID, {
          installationIdValue: `external-${newInstallationId}`,
          accountName: `account-${suffix}`,
        });
        await seedProject(newProjectId, TEST_USER_ID, newInstallationId);
      }
      await seedWorkspace(wsId, oldNodeId, TEST_USER_ID, { status: 'stopped' });

      const fetchMock = vi.fn(async () => {
        const mutation =
          dimension === 'node'
            ? ["UPDATE workspaces SET node_id = ?, status = 'running' WHERE id = ?", newNodeId]
            : dimension === 'user'
              ? ["UPDATE workspaces SET user_id = ?, status = 'running' WHERE id = ?", newUserId]
              : dimension === 'project'
                ? [
                    "UPDATE workspaces SET project_id = ?, status = 'running' WHERE id = ?",
                    newProjectId,
                  ]
                : [
                    "UPDATE workspaces SET chat_session_id = ?, status = 'running' WHERE id = ?",
                    newChatSessionId,
                  ];
        await env.DATABASE.prepare(mutation[0]).bind(mutation[1], wsId).run();
        return new Response(null, { status: 204 });
      });
      vi.stubGlobal('fetch', fetchMock);

      const stub = getStub(oldNodeId);
      await stub.scheduleWorkspaceDeletion(oldNodeId, wsId, TEST_USER_ID);
      await runInDurableObject(stub, async (instance) => {
        const key = `ws-delete:${wsId}`;
        const pending = await instance.ctx.storage.get<Record<string, unknown>>(key);
        await instance.ctx.storage.put(key, { ...pending, deleteAt: Date.now() - 1 });
        await instance.alarm();
      });

      let workspace: {
        status: string;
        node_id: string | null;
        user_id: string;
        project_id: string | null;
        chat_session_id: string | null;
      } | null = null;
      await vi.waitFor(async () => {
        workspace = await env.DATABASE.prepare(
          'SELECT status, node_id, user_id, project_id, chat_session_id FROM workspaces WHERE id = ?'
        )
          .bind(wsId)
          .first<{
            status: string;
            node_id: string | null;
            user_id: string;
            project_id: string | null;
            chat_session_id: string | null;
          }>();
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(
          await runInDurableObject(stub, async (instance) =>
            instance.ctx.storage.get(`ws-delete:${wsId}`)
          )
        ).toBeUndefined();
        expect(await getAlarm(stub)).toBeNull();
      });
      expect(workspace?.status).toBe('running');
      expect(workspace?.node_id).toBe(dimension === 'node' ? newNodeId : oldNodeId);
      expect(workspace?.user_id).toBe(dimension === 'user' ? newUserId : TEST_USER_ID);
      expect(workspace?.project_id).toBe(dimension === 'project' ? newProjectId : null);
      expect(workspace?.chat_session_id).toBe(
        dimension === 'chat-session' ? newChatSessionId : null
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  );

  it('preserves a status-only restart that wins while VM deletion is in flight', async () => {
    const nodeId = 'nl-test-inflight-status-only-001';
    const wsId = 'ws-inflight-status-only-001';
    const agentSessionId = 'agent-inflight-status-only-001';
    await seedTestNode(nodeId);
    await seedWorkspace(wsId, nodeId, TEST_USER_ID, { status: 'stopped' });
    await seedAgentSession(agentSessionId, wsId, TEST_USER_ID, { status: 'running' });

    const fetchMock = vi.fn(async () => {
      await env.DATABASE.prepare("UPDATE workspaces SET status = 'running' WHERE id = ?")
        .bind(wsId)
        .run();
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const stub = getStub(nodeId);
    await stub.scheduleWorkspaceDeletion(nodeId, wsId, TEST_USER_ID);
    await runInDurableObject(stub, async (instance) => {
      const key = `ws-delete:${wsId}`;
      const pending = await instance.ctx.storage.get<Record<string, unknown>>(key);
      await instance.ctx.storage.put(key, { ...pending, deleteAt: Date.now() - 1 });
      await instance.alarm();
    });

    await vi.waitFor(async () => {
      const workspace = await env.DATABASE.prepare(
        `SELECT status,
                runtime_deletion_confirmed_at AS confirmedAt,
                runtime_deletion_proof AS proof
           FROM workspaces WHERE id = ?`
      )
        .bind(wsId)
        .first<{ status: string; confirmedAt: string | null; proof: string | null }>();
      expect(workspace).toEqual({ status: 'running', confirmedAt: null, proof: null });
      expect(await getAgentSessionStatus(agentSessionId)).toMatchObject({
        status: 'running',
        stopped_at: null,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  it('fences a node reincarnation after durable claim at the physical fetch boundary', async () => {
    const nodeId = 'nl-test-runtime-boundary-incarnation-001';
    const wsId = 'ws-runtime-boundary-incarnation-001';
    await seedTestNode(nodeId);
    await env.DATABASE.prepare(
      `UPDATE nodes
          SET provider_instance_id = ?, runtime_incarnation_id = ?
        WHERE id = ?`
    )
      .bind('provider-old-001', 'runtime-old-001', nodeId)
      .run();
    await seedWorkspace(wsId, nodeId, TEST_USER_ID, { status: 'stopped' });

    const expected = await loadWorkspaceDeletionIdentity(env.DATABASE, wsId);
    expect(expected).not.toBeNull();
    const stub = getStub(nodeId);
    await stub.scheduleWorkspaceDeletion(nodeId, wsId, TEST_USER_ID, { expected: expected! });
    await expect(
      stub.claimWorkspaceDeletionAttempt(nodeId, wsId, TEST_USER_ID, expected!)
    ).resolves.toBe(true);

    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const outcome = await runInDurableObject(stub, async (instance) => {
      const mutableEnv = instance.env as unknown as { DATABASE: D1Database };
      const originalDatabase = mutableEnv.DATABASE;
      let runtimeLookupMutations = 0;
      const mutateAfterRuntimeLookup = async () => {
        if (runtimeLookupMutations > 0) return;
        runtimeLookupMutations += 1;
        await originalDatabase
          .prepare(
            `UPDATE nodes
                SET provider_instance_id = ?, runtime_incarnation_id = ?
              WHERE id = ?`
          )
          .bind('provider-new-001', 'runtime-new-001', nodeId)
          .run();
      };
      const wrapStatement = (
        statement: D1PreparedStatement,
        interceptResult: boolean
      ): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, property, receiver) {
            if (property === 'bind') {
              return (...values: unknown[]) =>
                wrapStatement(target.bind(...values), interceptResult);
            }
            if (
              interceptResult &&
              (property === 'first' || property === 'raw' || property === 'all')
            ) {
              return async (...args: unknown[]) => {
                const method = Reflect.get(target, property, receiver) as (
                  ...methodArgs: unknown[]
                ) => Promise<unknown>;
                const result = await method.apply(target, args);
                await mutateAfterRuntimeLookup();
                return result;
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      mutableEnv.DATABASE = new Proxy(originalDatabase, {
        get(target, property, receiver) {
          if (property === 'prepare') {
            return (query: string) => {
              const normalized = query.toLowerCase();
              const isRuntimeLookup =
                normalized.includes('runtime') &&
                normalized.includes('from "nodes"') &&
                !normalized.includes('runtime_incarnation_id');
              return wrapStatement(target.prepare(query), isRuntimeLookup);
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      try {
        const deletionOutcome = await attemptWorkspaceDeletion({
          env: instance.env as unknown as Env,
          expected: expected!,
          attempt: 1,
          source: 'runtime_boundary_test',
          mode: 'explicit',
        });
        expect(runtimeLookupMutations).toBe(1);
        return deletionOutcome;
      } finally {
        mutableEnv.DATABASE = originalDatabase;
      }
    });

    expect(outcome).toEqual({ status: 'fenced', reason: 'workspace_assignment_changed' });
    expect(fetchMock).not.toHaveBeenCalled();
    const workspace = await env.DATABASE.prepare(
      `SELECT status,
              runtime_deletion_confirmed_at AS confirmedAt,
              runtime_deletion_proof AS proof
         FROM workspaces WHERE id = ?`
    )
      .bind(wsId)
      .first<{ status: string; confirmedAt: string | null; proof: string | null }>();
    expect(workspace).toEqual({ status: 'stopping', confirmedAt: null, proof: null });
    expect(
      await runInDurableObject(stub, async (instance) =>
        instance.ctx.storage.get(`ws-delete:${wsId}`)
      )
    ).toBeDefined();
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
    let workspace: { status: string } | null = null;
    await vi.waitFor(async () => {
      workspace = await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
        .bind(wsId)
        .first<{ status: string }>();
      expect(workspace?.status).toBe('deleted');
      expect(await getAgentSessionStatus(agentSessionId)).toMatchObject({
        status: 'completed',
        stopped_at: expect.any(String),
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(
        await runInDurableObject(stub, async (instance) =>
          instance.ctx.storage.get(`ws-delete:${wsId}`)
        )
      ).toBeUndefined();
      expect(await getAlarm(stub)).toBeNull();
    });
    expect(workspace?.status).toBe('deleted');
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

    let workspace: { status: string } | null = null;
    await vi.waitFor(async () => {
      workspace = await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
        .bind(wsId)
        .first<{ status: string }>();
      expect(workspace?.status).toBe('deleted');
      expect(await getAgentSessionStatus(agentSessionId)).toMatchObject({
        status: 'completed',
        stopped_at: expect.any(String),
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(
        await runInDurableObject(stub, async (instance) =>
          instance.ctx.storage.get(`ws-delete:${wsId}`)
        )
      ).toBeUndefined();
      expect(await getAlarm(stub)).toBeNull();
    });
    expect(workspace?.status).toBe('deleted');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await getAlarm(stub)).toBeNull();
  });

  it('preserves a ProjectData sleeping session when staged deletion finds a restorable snapshot', async () => {
    const nodeId = 'nl-test-preserve-sleeping-session-001';
    const wsId = 'ws-preserve-sleeping-session-001';
    const taskId = 'task-preserve-sleeping-session-001';
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
    await seedTask(taskId, TEST_PROJECT_ID, TEST_USER_ID, {
      status: 'in_progress',
      workspaceId: wsId,
      taskMode: 'conversation',
    });
    await env.DATABASE.prepare(`UPDATE tasks SET chat_session_id = ? WHERE id = ?`)
      .bind(chatSessionId, taskId)
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

    let workspace: { status: string } | null = null;
    await vi.waitFor(async () => {
      workspace = await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
        .bind(wsId)
        .first<{ status: string }>();
      expect(workspace?.status).toBe('deleted');
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(
        await runInDurableObject(stub, async (instance) =>
          instance.ctx.storage.get(`ws-delete:${wsId}`)
        )
      ).toBeUndefined();
      expect(await getAlarm(stub)).toBeNull();
    });
    expect(workspace?.status).toBe('deleted');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await getAlarm(stub)).toBeNull();

    const session = await projectData.getSession(chatSessionId);
    expect(session).toMatchObject({ id: chatSessionId, status: 'sleeping' });

    const snapshot = await env.DATABASE.prepare(
      `SELECT status, degradation, sleep_status, manifest_r2_key
       FROM session_snapshots
       WHERE chat_session_id = ?`
    )
      .bind(chatSessionId)
      .first<{
        status: string;
        degradation: string | null;
        sleep_status: string | null;
        manifest_r2_key: string | null;
      }>();
    expect(snapshot).toMatchObject({
      status: 'available',
      degradation: 'none',
      sleep_status: 'sleeping',
      manifest_r2_key: expect.any(String),
    });

    await expect(
      ensureSessionRecovery(env as unknown as Env, TEST_PROJECT_ID, chatSessionId, {
        taskId,
        projectId: TEST_PROJECT_ID,
        chatSessionId,
      })
    ).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'session_recovery_placement_credentials',
    });
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
