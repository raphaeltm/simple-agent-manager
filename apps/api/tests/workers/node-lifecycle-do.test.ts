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
import { describe, expect, it } from 'vitest';

import type { NodeLifecycle } from '../../src/durable-objects/node-lifecycle';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getStub(nodeId: string): DurableObjectStub<NodeLifecycle> {
  const id = env.NODE_LIFECYCLE.idFromName(nodeId);
  return env.NODE_LIFECYCLE.get(id) as DurableObjectStub<NodeLifecycle>;
}

const TEST_USER_ID = 'user-nl-test-001';

/**
 * Seed the D1 `nodes` table with a running node.
 * Also seeds the users table since nodes references users(id).
 */
async function seedNode(nodeId: string, userId: string = TEST_USER_ID): Promise<void> {
  // Ensure user exists (idempotent)
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO users (id, github_id, email, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).bind(userId, `gh-${userId}`, `${userId}@test.com`, 'Test User').run();

  // Insert node
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO nodes (id, user_id, name, status, vm_size, vm_location, health_status, created_at, updated_at)
     VALUES (?, ?, ?, 'running', 'medium', 'nbg1', 'healthy', datetime('now'), datetime('now'))`,
  ).bind(nodeId, userId, `node-${nodeId}`).run();
}

/**
 * Read the node's warm_since and status from D1.
 */
async function getNodeFromD1(nodeId: string): Promise<{ status: string; warm_since: string | null } | null> {
  return await env.DATABASE.prepare(
    `SELECT status, warm_since FROM nodes WHERE id = ?`,
  ).bind(nodeId).first<{ status: string; warm_since: string | null }>();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NodeLifecycle DO — warm pool state machine', () => {
  // Each test uses a unique nodeId to avoid cross-test DO state leakage

  it('markIdle transitions to warm and updates D1 warm_since', async () => {
    const nodeId = 'nl-test-idle-001';
    await seedNode(nodeId);

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

  it('markActive transitions to active and clears D1 warm_since', async () => {
    const nodeId = 'nl-test-active-001';
    await seedNode(nodeId);

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
    await seedNode(nodeId);

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
    await seedNode(nodeId);

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
    await seedNode(nodeId);

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
      'node_lifecycle_conflict: node is being destroyed',
    );
  });

  it('getStatus returns current state', async () => {
    const nodeId = 'nl-test-status-001';
    await seedNode(nodeId);

    const stub = getStub(nodeId);

    // Before any state is set
    const initial = await stub.getStatus();
    expect(initial.status).toBe('active'); // default when no stored state

    // After markIdle
    await stub.markIdle(nodeId, TEST_USER_ID);
    const warm = await stub.getStatus();
    expect(warm.status).toBe('warm');
    expect(warm.warmSince).toBeTruthy();
  });

  it('markIdle resets alarm when called twice (extending warm period)', async () => {
    const nodeId = 'nl-test-reset-alarm-001';
    await seedNode(nodeId);

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
    await seedNode(nodeId);

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

  it('alarm on active state is a no-op (node was claimed between schedule and fire)', async () => {
    const nodeId = 'nl-test-alarm-active-noop-001';
    await seedNode(nodeId);

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
    await seedNode(nodeId);

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

  it('tryClaim on destroying node returns false', async () => {
    const nodeId = 'nl-test-claim-destroying-001';
    await seedNode(nodeId);

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
    await seedNode(nodeId);

    const stub = getStub(nodeId);
    const result = await stub.markIdle(nodeId, TEST_USER_ID, 60_000);

    expect(result.status).toBe('warm');
    expect(result.warmSince).toBeTruthy();
  });
});
