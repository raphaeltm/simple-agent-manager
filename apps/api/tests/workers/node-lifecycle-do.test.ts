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

import type { NodeLifecycle } from '../../src/durable-objects/node-lifecycle';
import { seedNode, seedUser, seedWorkspace } from './helpers/seed-d1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getStub(nodeId: string): DurableObjectStub<NodeLifecycle> {
  const id = env.NODE_LIFECYCLE.idFromName(nodeId);
  return env.NODE_LIFECYCLE.get(id) as DurableObjectStub<NodeLifecycle>;
}

const TEST_USER_ID = 'user-nl-test-001';

interface StoredNodeLifecycleState {
  nodeId: string;
  userId: string;
  status: 'active' | 'warm' | 'destroying';
  warmSince: number | null;
  claimedByTask: string | null;
  warmTimeoutOverrideMs?: number | null;
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

async function getStoredState(
  stub: DurableObjectStub<NodeLifecycle>
): Promise<StoredNodeLifecycleState | null> {
  return await runInDurableObject(stub, async (instance) => {
    return (await instance.ctx.storage.get<StoredNodeLifecycleState>('state')) ?? null;
  });
}

async function getAlarm(stub: DurableObjectStub<NodeLifecycle>): Promise<number | null> {
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
    await stub.markIdle(nodeId, TEST_USER_ID);

    const { claimed, state } = await stub.tryClaim('task-001');

    expect(claimed).toBe(true);
    expect(state.status).toBe('active');
    expect(state.claimedByTask).toBe('task-001');

    // D1 warm_since should be cleared
    const dbNode = await getNodeFromD1(nodeId);
    expect(dbNode!.warm_since).toBeNull();
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

    await expect(stub.markIdle(nodeId, TEST_USER_ID)).rejects.toThrow(
      'node_lifecycle_conflict: node is being destroyed'
    );
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
    await stub.scheduleWorkspaceDeletion(wsId, TEST_USER_ID);

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
    await stub.scheduleWorkspaceDeletion(wsId, TEST_USER_ID);
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
    await stub.markIdle(nodeId, TEST_USER_ID);
    await stub.scheduleWorkspaceDeletion(wsId, TEST_USER_ID);
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
    await seedTestNode(nodeId);
    await seedWorkspace(wsId, nodeId, TEST_USER_ID, { status: 'stopped' });

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
        workspaceId: wsId,
        userId: TEST_USER_ID,
        deleteAt: Date.now() - 1_000,
      });
      // Keep the platform alarm in the future while invoking alarm() directly.
      // A past alarm can fire automatically and race this explicit invocation,
      // making the VM deletion execute twice in newer workerd versions.
      await instance.ctx.storage.setAlarm(Date.now() + 60_000);
    });

    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    expect(await stub.getStatus()).toMatchObject({ status: 'active' });
    const workspace = await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
      .bind(wsId)
      .first<{ status: string }>();
    expect(workspace?.status).toBe('deleted');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await getAlarm(stub)).toBeNull();
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
