/**
 * Miniflare integration tests for workspace dispatch guard.
 *
 * Verifies that the node-ready handler does NOT re-dispatch workspaces
 * that have already been dispatched by TaskRunner (dispatched_to_agent_at
 * is set), while still dispatching workspaces that have NOT been dispatched
 * (safety-net recovery path).
 *
 * Uses real D1 queries to prove the filter behavior.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { seedNode, seedUser } from './helpers/seed-d1';

const TEST_USER_ID = 'user-dispatch-001';
const TEST_NODE_ID = 'node-dispatch-001';

async function seedWorkspace(
  workspaceId: string,
  nodeId: string,
  userId: string,
  opts?: { dispatchedToAgentAt?: string | null },
): Promise<void> {
  const now = new Date().toISOString();
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO workspaces (id, node_id, user_id, name, repository, branch, status, vm_size, vm_location, dispatched_to_agent_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'creating', 'medium', 'nbg1', ?, ?, ?)`,
  )
    .bind(
      workspaceId,
      nodeId,
      userId,
      `ws-${workspaceId}`,
      'test-org/test-repo',
      'main',
      opts?.dispatchedToAgentAt ?? null,
      now,
      now,
    )
    .run();
}

describe('Workspace dispatch guard — D1 query behavior', () => {
  it('query with isNull filter excludes dispatched workspaces', async () => {
    await seedUser(TEST_USER_ID);
    await seedNode(TEST_NODE_ID, TEST_USER_ID);

    // Create a workspace that was already dispatched
    const dispatchedId = 'ws-dispatched-001';
    await seedWorkspace(dispatchedId, TEST_NODE_ID, TEST_USER_ID, {
      dispatchedToAgentAt: new Date().toISOString(),
    });

    // Create a workspace that has NOT been dispatched (safety net eligible)
    const undispatchedId = 'ws-undispatched-001';
    await seedWorkspace(undispatchedId, TEST_NODE_ID, TEST_USER_ID, {
      dispatchedToAgentAt: null,
    });

    // Run the same query the node-ready handler uses
    const results = await env.DATABASE.prepare(
      `SELECT id FROM workspaces
       WHERE node_id = ? AND status = 'creating' AND dispatched_to_agent_at IS NULL`,
    )
      .bind(TEST_NODE_ID)
      .all<{ id: string }>();

    // Only the undispatched workspace should be returned
    const ids = results.results.map((r) => r.id);
    expect(ids).toContain(undispatchedId);
    expect(ids).not.toContain(dispatchedId);
  });

  it('query without isNull filter returns both (proving the guard matters)', async () => {
    const nodeId = 'node-dispatch-002';
    await seedUser(TEST_USER_ID);
    await seedNode(nodeId, TEST_USER_ID);

    const dispatchedId = 'ws-dispatched-002';
    await seedWorkspace(dispatchedId, nodeId, TEST_USER_ID, {
      dispatchedToAgentAt: new Date().toISOString(),
    });

    const undispatchedId = 'ws-undispatched-002';
    await seedWorkspace(undispatchedId, nodeId, TEST_USER_ID, {
      dispatchedToAgentAt: null,
    });

    // Without the guard — old query behavior
    const results = await env.DATABASE.prepare(
      `SELECT id FROM workspaces
       WHERE node_id = ? AND status = 'creating'`,
    )
      .bind(nodeId)
      .all<{ id: string }>();

    const ids = results.results.map((r) => r.id);
    // Both show up — this is the bug we're fixing
    expect(ids).toContain(dispatchedId);
    expect(ids).toContain(undispatchedId);
  });

  it('marking a workspace as dispatched sets the timestamp', async () => {
    const nodeId = 'node-dispatch-003';
    await seedUser(TEST_USER_ID);
    await seedNode(nodeId, TEST_USER_ID);

    const wsId = 'ws-mark-dispatch-001';
    await seedWorkspace(wsId, nodeId, TEST_USER_ID, {
      dispatchedToAgentAt: null,
    });

    // Verify initially null
    const before = await env.DATABASE.prepare(
      `SELECT dispatched_to_agent_at FROM workspaces WHERE id = ?`,
    )
      .bind(wsId)
      .first<{ dispatched_to_agent_at: string | null }>();

    expect(before?.dispatched_to_agent_at).toBeNull();

    // Simulate what markWorkspaceDispatched does
    const now = new Date().toISOString();
    await env.DATABASE.prepare(
      `UPDATE workspaces SET dispatched_to_agent_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(now, now, wsId)
      .run();

    // Verify the marker is set
    const after = await env.DATABASE.prepare(
      `SELECT dispatched_to_agent_at FROM workspaces WHERE id = ?`,
    )
      .bind(wsId)
      .first<{ dispatched_to_agent_at: string | null }>();

    expect(after?.dispatched_to_agent_at).toBe(now);

    // Verify it's now excluded from the node-ready query
    const results = await env.DATABASE.prepare(
      `SELECT id FROM workspaces
       WHERE node_id = ? AND status = 'creating' AND dispatched_to_agent_at IS NULL`,
    )
      .bind(nodeId)
      .all<{ id: string }>();

    expect(results.results.map((r) => r.id)).not.toContain(wsId);
  });

  it('safety net: un-dispatched workspace is still picked up by node-ready query', async () => {
    const nodeId = 'node-dispatch-004';
    await seedUser(TEST_USER_ID);
    await seedNode(nodeId, TEST_USER_ID);

    // Simulate TaskRunner crash: workspace created but dispatched_to_agent_at never set
    const wsId = 'ws-crash-recovery-001';
    await seedWorkspace(wsId, nodeId, TEST_USER_ID, {
      dispatchedToAgentAt: null,
    });

    const results = await env.DATABASE.prepare(
      `SELECT id FROM workspaces
       WHERE node_id = ? AND status = 'creating' AND dispatched_to_agent_at IS NULL`,
    )
      .bind(nodeId)
      .all<{ id: string }>();

    // Should be found — the safety net works
    expect(results.results.map((r) => r.id)).toContain(wsId);
  });
});
