/**
 * Vertical slice tests for node-cleanup scheduled job.
 *
 * Uses real D1 + OBSERVABILITY_DATABASE via Miniflare. VM-agent workspace calls
 * are stubbed at the external boundary while D1 and observability remain real.
 * Node-provider cleanup has no credentials in the test environment, and the job
 * handles that failure gracefully. We verify D1 state changes and observability
 * events that happen regardless of HTTP outcomes.
 *
 * Tests focus on:
 * - Orphaned workspace detection and D1 status update to 'stopped'
 * - Orphaned node detection and observability event recording
 * - Stopped workspace TTL deletion
 * - Stale warm nodes: error is caught (no Hetzner), counted in result
 */
import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { runNodeCleanupSweep } from '../../src/scheduled/node-cleanup';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

vi.mock('../../src/services/node-agent', () => ({
  deleteWorkspaceOnNode: vi.fn().mockResolvedValue(undefined),
  stopWorkspaceOnNode: vi.fn().mockResolvedValue(undefined),
}));

const USER_ID = 'user-nc-test';
const INSTALL_ID = 'install-nc-test';
const PROJECT_ID = 'project-nc-test';

async function seedBaseData(): Promise<void> {
  await seedUser(USER_ID);
  await seedInstallation(INSTALL_ID, USER_ID);
  await seedProject(PROJECT_ID, USER_ID, INSTALL_ID);
}

async function getNodeStatus(
  nodeId: string
): Promise<{ status: string; warm_since: string | null } | null> {
  return env.DATABASE.prepare('SELECT status, warm_since FROM nodes WHERE id = ?')
    .bind(nodeId)
    .first<{ status: string; warm_since: string | null }>();
}

async function getWorkspaceStatus(wsId: string): Promise<{ status: string } | null> {
  return env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
    .bind(wsId)
    .first<{ status: string }>();
}

async function getNodeRuntimeStatus(
  nodeId: string
): Promise<{ status: string; runtime: string } | null> {
  return env.DATABASE.prepare('SELECT status, runtime FROM nodes WHERE id = ?')
    .bind(nodeId)
    .first<{ status: string; runtime: string }>();
}

async function getObservabilityEvents(
  recoveryType: string
): Promise<{ id: string; message: string }[]> {
  const result = await env.OBSERVABILITY_DATABASE.prepare(
    `SELECT id, message FROM platform_errors WHERE context LIKE ? ORDER BY created_at DESC`
  )
    .bind(`%${recoveryType}%`)
    .all<{ id: string; message: string }>();
  return result.results;
}

describe('runNodeCleanupSweep — vertical slice', () => {
  describe('orphaned workspace stopping (Phase 3)', () => {
    it('destroys cf-container terminal task workspaces instead of leaving the container active', async () => {
      await seedBaseData();
      const nodeId = 'node-nc-cf-terminal';
      const wsId = 'ws-nc-cf-terminal';
      const taskId = 'task-nc-cf-terminal';
      const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const destroyForUser = vi.fn().mockResolvedValue(undefined);

      await seedNode(nodeId, USER_ID, {
        status: 'running',
        createdAt: oldDate,
        updatedAt: oldDate,
      });
      await env.DATABASE.prepare(`UPDATE nodes SET runtime = 'cf-container' WHERE id = ?`)
        .bind(nodeId)
        .run();
      await seedWorkspace(wsId, nodeId, USER_ID, {
        projectId: PROJECT_ID,
        status: 'running',
        chatSessionId: 'session-nc-cf-terminal',
        createdAt: oldDate,
      });
      await seedTask(taskId, PROJECT_ID, USER_ID, {
        status: 'completed',
        workspaceId: wsId,
        updatedAt: oldDate,
      });

      const testEnv = {
        ...env,
        CF_CONTAINER_ENABLED: 'true',
        VM_AGENT_CONTAINER: {
          idFromName: (id: string) => id,
          get: () => ({ destroyForUser }),
        },
        ORPHANED_WORKSPACE_GRACE_PERIOD_MS: '1000',
      } as unknown as Env;

      const result = await runNodeCleanupSweep(testEnv);

      expect(destroyForUser).toHaveBeenCalledTimes(1);
      expect(result.cfContainersDestroyed).toBeGreaterThanOrEqual(1);
      expect(await getWorkspaceStatus(wsId)).toMatchObject({ status: 'deleted' });
      expect(await getNodeRuntimeStatus(nodeId)).toMatchObject({
        status: 'deleted',
        runtime: 'cf-container',
      });
    });

    it('stops orphaned workspace (completed task, running workspace past grace period)', async () => {
      await seedBaseData();
      const nodeId = 'node-nc-orphan-ws';
      const wsId = 'ws-nc-orphan';
      const taskId = 'task-nc-orphan-completed';
      const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago

      await seedNode(nodeId, USER_ID);
      await seedWorkspace(wsId, nodeId, USER_ID, {
        projectId: PROJECT_ID,
        status: 'running',
        chatSessionId: 'session-nc-1',
        createdAt: oldDate,
      });
      await seedTask(taskId, PROJECT_ID, USER_ID, {
        status: 'completed',
        workspaceId: wsId,
      });

      const testEnv = {
        ...env,
        ORPHANED_WORKSPACE_GRACE_PERIOD_MS: '1000', // 1s — workspace was created 1h ago
      } as unknown as Env;

      const result = await runNodeCleanupSweep(testEnv);

      expect(result.orphanedWorkspacesFlagged).toBe(1);

      // Verify D1 state: workspace should be 'stopped'
      const ws = await getWorkspaceStatus(wsId);
      expect(ws?.status).toBe('stopped');

      // Verify observability event was recorded
      const events = await getObservabilityEvents('orphaned_workspace');
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].message).toContain('Orphaned workspace stopped');
    });

    it('stops orphaned recovery workspace so it no longer blocks node cleanup forever', async () => {
      await seedBaseData();
      const nodeId = 'node-nc-orphan-recovery-ws';
      const wsId = 'ws-nc-orphan-recovery';
      const taskId = 'task-nc-orphan-recovery-completed';
      const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      await seedNode(nodeId, USER_ID);
      await seedWorkspace(wsId, nodeId, USER_ID, {
        projectId: PROJECT_ID,
        status: 'recovery',
        chatSessionId: 'session-nc-recovery',
        createdAt: oldDate,
      });
      await seedTask(taskId, PROJECT_ID, USER_ID, {
        status: 'completed',
        workspaceId: wsId,
      });

      const testEnv = {
        ...env,
        ORPHANED_WORKSPACE_GRACE_PERIOD_MS: '1000',
      } as unknown as Env;

      const result = await runNodeCleanupSweep(testEnv);

      expect(result.orphanedWorkspacesFlagged).toBeGreaterThanOrEqual(1);

      const ws = await getWorkspaceStatus(wsId);
      expect(ws?.status).toBe('stopped');
    });

    it('does not stop workspace with an active task', async () => {
      await seedBaseData();
      const nodeId = 'node-nc-active-task';
      const wsId = 'ws-nc-active-task';
      const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      await seedNode(nodeId, USER_ID);
      await seedWorkspace(wsId, nodeId, USER_ID, {
        projectId: PROJECT_ID,
        status: 'running',
        createdAt: oldDate,
      });
      // One completed task AND one active task
      await seedTask('task-nc-completed-2', PROJECT_ID, USER_ID, {
        status: 'completed',
        workspaceId: wsId,
      });
      await seedTask('task-nc-active-2', PROJECT_ID, USER_ID, {
        status: 'in_progress',
        workspaceId: wsId,
      });

      const testEnv = {
        ...env,
        ORPHANED_WORKSPACE_GRACE_PERIOD_MS: '1000',
      } as unknown as Env;

      await runNodeCleanupSweep(testEnv);

      // Workspace should still be running (NOT EXISTS active task clause prevents it)
      const ws = await getWorkspaceStatus(wsId);
      expect(ws?.status).toBe('running');
    });
  });

  describe('orphaned node detection (Phase 4)', () => {
    it('flags orphaned node (running, no workspaces, no warm_since, past grace)', async () => {
      await seedBaseData();
      const nodeId = 'node-nc-orphan-node';
      const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      await seedNode(nodeId, USER_ID, {
        status: 'running',
        warmSince: null,
        updatedAt: oldDate,
      });
      // No workspaces on this node

      const testEnv = {
        ...env,
        ORPHANED_WORKSPACE_GRACE_PERIOD_MS: '1000',
      } as unknown as Env;

      const result = await runNodeCleanupSweep(testEnv);

      expect(result.orphanedNodesFlagged).toBe(1);

      // Verify observability event
      const events = await getObservabilityEvents('orphaned_node');
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].message).toContain('Orphaned node detected');
    });
  });

  describe('stopped workspace TTL deletion (Phase 5)', () => {
    it('deletes stopped workspace past TTL', async () => {
      await seedBaseData();
      const nodeId = 'node-nc-ttl';
      const wsId = 'ws-nc-stopped-ttl';
      const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      await seedNode(nodeId, USER_ID);
      await seedWorkspace(wsId, nodeId, USER_ID, {
        status: 'stopped',
        updatedAt: oldDate,
      });

      const testEnv = {
        ...env,
        WORKSPACE_STOPPED_TTL_MS: '1000', // 1s — workspace was stopped 1h ago
      } as unknown as Env;

      const result = await runNodeCleanupSweep(testEnv);

      expect(result.stoppedWorkspacesDeleted).toBeGreaterThanOrEqual(1);

      // Verify D1 state: workspace should now be 'deleted'
      const ws = await getWorkspaceStatus(wsId);
      expect(ws?.status).toBe('deleted');
    });

    it('does not delete recently stopped workspace', async () => {
      await seedBaseData();
      const nodeId = 'node-nc-ttl-recent';
      const wsId = 'ws-nc-stopped-recent';

      await seedNode(nodeId, USER_ID);
      await seedWorkspace(wsId, nodeId, USER_ID, {
        status: 'stopped',
        updatedAt: new Date().toISOString(), // just now
      });

      const testEnv = {
        ...env,
        WORKSPACE_STOPPED_TTL_MS: '86400000', // 24h
      } as unknown as Env;

      await runNodeCleanupSweep(testEnv);

      const ws = await getWorkspaceStatus(wsId);
      expect(ws?.status).toBe('stopped'); // still stopped, not deleted
    });
  });

  describe('stale warm node cleanup (Phase 1)', () => {
    it('attempts to destroy stale warm node and counts error (no Hetzner in test)', async () => {
      await seedBaseData();
      const nodeId = 'node-nc-stale-warm';
      const warmSince = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago

      await seedNode(nodeId, USER_ID, {
        status: 'running',
        warmSince,
      });
      // No workspaces → warm node should be destroyed

      const testEnv = {
        ...env,
        NODE_WARM_GRACE_PERIOD_MS: '1000', // 1s
      } as unknown as Env;

      const result = await runNodeCleanupSweep(testEnv);

      // deleteNodeResources will fail (no Hetzner credentials in test env)
      // but the error should be caught and counted
      expect(result.staleDestroyed + result.errors).toBeGreaterThanOrEqual(1);
    });

    it('clears warm_since for warm node that has active workspaces', async () => {
      await seedBaseData();
      const nodeId = 'node-nc-warm-active-ws';
      const warmSince = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      await seedNode(nodeId, USER_ID, {
        status: 'running',
        warmSince,
      });
      // Add a running workspace on this node
      await seedWorkspace('ws-nc-warm-running', nodeId, USER_ID, {
        status: 'running',
      });

      const testEnv = {
        ...env,
        NODE_WARM_GRACE_PERIOD_MS: '1000',
      } as unknown as Env;

      const result = await runNodeCleanupSweep(testEnv);

      expect(result.staleDestroyed).toBe(0);

      // warm_since should be cleared
      const node = await getNodeStatus(nodeId);
      expect(node?.warm_since).toBeNull();
    });
  });

  describe('DO alarm handoff node cleanup', () => {
    it('attempts to destroy stopped auto-provisioned node left by NodeLifecycle alarm', async () => {
      await seedBaseData();
      const nodeId = 'node-nc-stopped-handoff';
      const taskId = 'task-nc-stopped-handoff';
      const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      await seedNode(nodeId, USER_ID, {
        status: 'stopped',
        warmSince: null,
        createdAt: oldDate,
        updatedAt: oldDate,
      });
      await seedTask(taskId, PROJECT_ID, USER_ID, {
        status: 'completed',
        autoProvisionedNodeId: nodeId,
      });

      const testEnv = {
        ...env,
        MAX_AUTO_NODE_LIFETIME_MS: '1000',
        ORPHANED_WORKSPACE_GRACE_PERIOD_MS: '1000',
      } as unknown as Env;

      const result = await runNodeCleanupSweep(testEnv);

      expect(result.lifetimeDestroyed + result.errors).toBeGreaterThanOrEqual(1);
    });
  });

  describe('result structure', () => {
    it('returns all expected counters', async () => {
      await seedBaseData();
      const testEnv = {
        ...env,
        NODE_WARM_GRACE_PERIOD_MS: '999999999', // very large → nothing triggers
        MAX_AUTO_NODE_LIFETIME_MS: '999999999',
        ORPHANED_WORKSPACE_GRACE_PERIOD_MS: '999999999',
        WORKSPACE_STOPPED_TTL_MS: '999999999',
      } as unknown as Env;

      const result = await runNodeCleanupSweep(testEnv);

      expect(result).toMatchObject({
        staleDestroyed: expect.any(Number),
        lifetimeDestroyed: expect.any(Number),
        lifetimeSkipped: expect.any(Number),
        orphanedWorkspacesFlagged: expect.any(Number),
        orphanedNodesFlagged: expect.any(Number),
        stoppedWorkspacesDeleted: expect.any(Number),
        cfContainersDestroyed: expect.any(Number),
        errors: expect.any(Number),
      });
    });
  });
});
