/**
 * Vertical slice tests for the node-lifecycle.ts proxy service.
 *
 * Verifies the Worker→DO contract: that the proxy correctly resolves the
 * DO stub via idFromName(nodeId) and forwards arguments to the NodeLifecycle DO.
 *
 * Uses Miniflare with real DOs — no vi.mock().
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { NodeLifecycle } from '../../src/durable-objects/node-lifecycle';
import {
  getStatus,
  markActive,
  markIdle,
  tryClaim,
} from '../../src/services/node-lifecycle';
import { seedNode, seedUser } from './helpers/seed-d1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_USER_ID = 'user-nlp-test-001';

function getStub(nodeId: string): DurableObjectStub<NodeLifecycle> {
  const id = env.NODE_LIFECYCLE.idFromName(nodeId);
  return env.NODE_LIFECYCLE.get(id) as DurableObjectStub<NodeLifecycle>;
}

async function seedTestNode(nodeId: string, userId: string = TEST_USER_ID): Promise<void> {
  await seedUser(userId);
  await seedNode(nodeId, userId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('node-lifecycle proxy — Worker→DO contract', () => {
  it('markIdle transitions to warm and passes userId + timeout override', async () => {
    const nodeId = 'nlp-idle-001';
    await seedTestNode(nodeId);

    const result = await markIdle(env, nodeId, TEST_USER_ID, 120_000);

    expect(result.status).toBe('warm');
    expect(result.warmSince).toBeTruthy();
    expect(result.nodeId).toBe(nodeId);

    // Verify D1 was updated
    const dbNode = await env.DATABASE.prepare(
      'SELECT warm_since FROM nodes WHERE id = ?',
    ).bind(nodeId).first<{ warm_since: string | null }>();
    expect(dbNode!.warm_since).toBeTruthy();
  });

  it('markIdle without timeout override uses platform default', async () => {
    const nodeId = 'nlp-idle-default-001';
    await seedTestNode(nodeId);

    const result = await markIdle(env, nodeId, TEST_USER_ID);

    expect(result.status).toBe('warm');
    expect(result.warmSince).toBeTruthy();
  });

  it('markIdle throws on destroying node', async () => {
    const nodeId = 'nlp-idle-destroying-001';
    await seedTestNode(nodeId);

    // Manually set destroying state
    const stub = getStub(nodeId);
    await runInDurableObject(stub, async (instance) => {
      await instance.ctx.storage.put('state', {
        nodeId,
        userId: TEST_USER_ID,
        status: 'destroying',
        warmSince: null,
        claimedByTask: null,
      });
    });

    await expect(markIdle(env, nodeId, TEST_USER_ID)).rejects.toThrow(
      'node_lifecycle_conflict: node is being destroyed',
    );
  });

  it('markActive transitions from warm to active and clears warm_since', async () => {
    const nodeId = 'nlp-active-001';
    await seedTestNode(nodeId);

    // First warm it up via proxy
    await markIdle(env, nodeId, TEST_USER_ID);

    // Then activate via proxy
    const result = await markActive(env, nodeId);

    expect(result.status).toBe('active');
    expect(result.warmSince).toBeNull();

    // Verify D1 warm_since is cleared
    const dbNode = await env.DATABASE.prepare(
      'SELECT warm_since FROM nodes WHERE id = ?',
    ).bind(nodeId).first<{ warm_since: string | null }>();
    expect(dbNode!.warm_since).toBeNull();
  });

  it('markActive throws on node with no DO state', async () => {
    const nodeId = 'nlp-active-no-state-001';
    await seedTestNode(nodeId);

    // Never called markIdle — DO has no stored state
    await expect(markActive(env, nodeId)).rejects.toThrow(
      'node_lifecycle_not_found',
    );
  });

  it('tryClaim on warm node succeeds', async () => {
    const nodeId = 'nlp-claim-warm-001';
    await seedTestNode(nodeId);

    await markIdle(env, nodeId, TEST_USER_ID);

    const { claimed, state } = await tryClaim(env, nodeId, 'task-claim-001');

    expect(claimed).toBe(true);
    expect(state.status).toBe('active');
    expect(state.claimedByTask).toBe('task-claim-001');

    // D1 warm_since should be cleared
    const dbNode = await env.DATABASE.prepare(
      'SELECT warm_since FROM nodes WHERE id = ?',
    ).bind(nodeId).first<{ warm_since: string | null }>();
    expect(dbNode!.warm_since).toBeNull();
  });

  it('tryClaim on active node returns false', async () => {
    const nodeId = 'nlp-claim-active-001';
    await seedTestNode(nodeId);

    // Warm then activate
    await markIdle(env, nodeId, TEST_USER_ID);
    await markActive(env, nodeId);

    const { claimed, state } = await tryClaim(env, nodeId, 'task-claim-002');

    expect(claimed).toBe(false);
    expect(state.status).toBe('active');
  });

  it('tryClaim on destroying node returns false', async () => {
    const nodeId = 'nlp-claim-destroying-001';
    await seedTestNode(nodeId);

    const stub = getStub(nodeId);
    await runInDurableObject(stub, async (instance) => {
      await instance.ctx.storage.put('state', {
        nodeId,
        userId: TEST_USER_ID,
        status: 'destroying',
        warmSince: null,
        claimedByTask: null,
      });
    });

    const { claimed } = await tryClaim(env, nodeId, 'task-claim-003');
    expect(claimed).toBe(false);
  });

  it('getStatus returns current state via proxy', async () => {
    const nodeId = 'nlp-status-001';
    await seedTestNode(nodeId);

    // Before any state is set, default is active
    const initial = await getStatus(env, nodeId);
    expect(initial.status).toBe('active');

    // After markIdle
    await markIdle(env, nodeId, TEST_USER_ID);
    const warm = await getStatus(env, nodeId);
    expect(warm.status).toBe('warm');
    expect(warm.warmSince).toBeTruthy();
    expect(warm.nodeId).toBe(nodeId);
  });

  it('proxy uses idFromName for deterministic DO resolution', async () => {
    const nodeId = 'nlp-deterministic-001';
    await seedTestNode(nodeId);

    await markIdle(env, nodeId, TEST_USER_ID);

    // Proxy and direct stub should access the same DO instance
    const proxyStatus = await getStatus(env, nodeId);
    const directStatus = await getStub(nodeId).getStatus();

    expect(proxyStatus.status).toBe(directStatus.status);
    expect(proxyStatus.nodeId).toBe(directStatus.nodeId);
    expect(proxyStatus.warmSince).toBe(directStatus.warmSince);
  });

  it('full lifecycle: idle → claim → active → idle', async () => {
    const nodeId = 'nlp-lifecycle-001';
    await seedTestNode(nodeId);

    // 1. Mark idle
    const idle = await markIdle(env, nodeId, TEST_USER_ID);
    expect(idle.status).toBe('warm');

    // 2. Claim
    const { claimed, state: claimed1 } = await tryClaim(env, nodeId, 'task-lc-001');
    expect(claimed).toBe(true);
    expect(claimed1.status).toBe('active');

    // 3. Mark idle again (task finished)
    const idle2 = await markIdle(env, nodeId, TEST_USER_ID, 30_000);
    expect(idle2.status).toBe('warm');

    // 4. Mark active (new workspace started before timeout)
    const active = await markActive(env, nodeId);
    expect(active.status).toBe('active');
  });
});
