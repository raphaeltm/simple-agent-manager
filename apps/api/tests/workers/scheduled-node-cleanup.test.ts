/**
 * Vertical slice tests for node-cleanup scheduled job.
 *
 * Uses real D1 + OBSERVABILITY_DATABASE via Miniflare. VM-agent HTTP calls
 * against fake *.vm.test.example.com nodes are stubbed at the system boundary;
 * cloud-provider deletion still has no real Hetzner credentials, and the job
 * handles those errors gracefully. We verify D1 state changes and observability
 * events that happen regardless of HTTP outcomes.
 *
 * Tests focus on:
 * - Orphaned workspace detection and D1 status update to 'stopped'
 * - Orphaned node detection and observability event recording
 * - Stopped workspace TTL deletion
 * - Stale warm nodes: error is caught (no Hetzner), counted in result
 */
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { runNodeCleanupSweep } from '../../src/scheduled/node-cleanup';
import { sweepTerminalCfContainers } from '../../src/scheduled/node-cleanup/node-phases';
import { emptyResult, resolveCleanupConfig } from '../../src/scheduled/node-cleanup/shared';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const USER_ID = 'user-nc-test';
const INSTALL_ID = 'install-nc-test';
const PROJECT_ID = 'project-nc-test';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('.vm.test.example.com')) {
        return new Response(null, { status: 204 });
      }
      return originalFetch(input);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    it('destroys failed cf-container task workspaces instead of leaving the container active', async () => {
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
        status: 'failed',
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

    it('preserves completed persistent chats when the final snapshot is absent or degraded', async () => {
      await seedBaseData();
      const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const destroyForUser = vi.fn().mockResolvedValue(undefined);

      for (const suffix of ['missing', 'degraded']) {
        const nodeId = `node-nc-cf-preserve-${suffix}`;
        const wsId = `ws-nc-cf-preserve-${suffix}`;
        const taskId = `task-nc-cf-preserve-${suffix}`;
        const chatSessionId = `session-nc-cf-preserve-${suffix}`;
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
          chatSessionId,
          createdAt: oldDate,
        });
        await seedTask(taskId, PROJECT_ID, USER_ID, {
          status: 'completed',
          workspaceId: wsId,
          updatedAt: oldDate,
        });

        if (suffix === 'degraded') {
          await env.DATABASE.prepare(
            `INSERT INTO session_snapshots
               (id, project_id, workspace_id, node_id, user_id, chat_session_id, runtime,
                status, degradation, manifest_r2_key, expires_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'cf-container', 'degraded', 'entries-skipped', ?, ?, ?, ?)`
          )
            .bind(
              `snapshot-nc-cf-${suffix}`,
              PROJECT_ID,
              wsId,
              nodeId,
              USER_ID,
              chatSessionId,
              `session-snapshots/${chatSessionId}/manifest.json`,
              new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
              oldDate,
              oldDate
            )
            .run();
        }
      }

      const testEnv = {
        ...env,
        CF_CONTAINER_ENABLED: 'true',
        VM_AGENT_CONTAINER: {
          idFromName: (id: string) => id,
          get: () => ({ destroyForUser }),
        },
        ORPHANED_WORKSPACE_GRACE_PERIOD_MS: '1000',
      } as unknown as Env;
      const result = emptyResult();

      await sweepTerminalCfContainers(testEnv, new Date(), resolveCleanupConfig(testEnv), result);

      expect(destroyForUser).not.toHaveBeenCalled();
      expect(result.cfContainersDestroyed).toBe(0);
      await expect(getWorkspaceStatus('ws-nc-cf-preserve-missing')).resolves.toMatchObject({
        status: 'running',
      });
      await expect(getWorkspaceStatus('ws-nc-cf-preserve-degraded')).resolves.toMatchObject({
        status: 'running',
      });

      const fullSweep = await runNodeCleanupSweep(testEnv);
      expect(fullSweep.orphanedWorkspacesFlagged).toBe(0);
      expect(destroyForUser).not.toHaveBeenCalled();
      await expect(getWorkspaceStatus('ws-nc-cf-preserve-missing')).resolves.toMatchObject({
        status: 'running',
      });
      await expect(getWorkspaceStatus('ws-nc-cf-preserve-degraded')).resolves.toMatchObject({
        status: 'running',
      });

      await env.DATABASE.prepare(
        `DELETE FROM tasks WHERE id IN ('task-nc-cf-preserve-missing', 'task-nc-cf-preserve-degraded')`
      ).run();
      await env.DATABASE.prepare(
        `DELETE FROM session_snapshots WHERE id = 'snapshot-nc-cf-degraded'`
      ).run();
      await env.DATABASE.prepare(
        `DELETE FROM workspaces WHERE id IN ('ws-nc-cf-preserve-missing', 'ws-nc-cf-preserve-degraded')`
      ).run();
      await env.DATABASE.prepare(
        `DELETE FROM nodes WHERE id IN ('node-nc-cf-preserve-missing', 'node-nc-cf-preserve-degraded')`
      ).run();
    });

    it('stops an orphaned workspace after a failed task', async () => {
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
        status: 'failed',
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
      const taskId = 'task-nc-orphan-recovery-failed';
      const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      await seedNode(nodeId, USER_ID);
      await seedWorkspace(wsId, nodeId, USER_ID, {
        projectId: PROJECT_ID,
        status: 'recovery',
        chatSessionId: 'session-nc-recovery',
        createdAt: oldDate,
      });
      await seedTask(taskId, PROJECT_ID, USER_ID, {
        status: 'failed',
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

  describe('orphaned node cleanup (Phase 5)', () => {
    it('destroys an idle orphan node (running, no workspaces, no warm_since)', async () => {
      await seedBaseData();
      const nodeId = 'node-nc-orphan-node';
      const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      await seedNode(nodeId, USER_ID, {
        status: 'running',
        warmSince: null,
        createdAt: oldDate,
        updatedAt: oldDate,
      });
      // No workspaces on this node

      const testEnv = {
        ...env,
        NODE_ORPHAN_IDLE_TIMEOUT_MS: '1000',
      } as unknown as Env;

      const result = await runNodeCleanupSweep(testEnv);

      expect(result.orphanedNodesDestroyed).toBe(1);
      expect(await getNodeStatus(nodeId)).toMatchObject({ status: 'deleted' });

      // Verify observability event
      const events = await getObservabilityEvents('idle_orphan_node_cleanup');
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].message).toContain('Destroyed idle orphan node');
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
    it('releases a real D1 cleanup claim when container teardown fails', async () => {
      await seedBaseData();
      const nodeId = 'node-nc-stale-warm-container-failure';
      const warmSince = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const destroyForUser = vi.fn().mockRejectedValue(new Error('container teardown unavailable'));

      await seedNode(nodeId, USER_ID, { status: 'running', warmSince });
      await env.DATABASE.prepare(`UPDATE nodes SET runtime = 'cf-container' WHERE id = ?`)
        .bind(nodeId)
        .run();

      const testEnv = {
        ...env,
        CF_CONTAINER_ENABLED: 'true',
        VM_AGENT_CONTAINER: {
          idFromName: (id: string) => id,
          get: () => ({ destroyForUser }),
        },
        NODE_WARM_GRACE_PERIOD_MS: '1000',
      } as unknown as Env;

      const result = await runNodeCleanupSweep(testEnv);
      const node = await env.DATABASE.prepare(
        'SELECT status, cleanup_backoff_until FROM nodes WHERE id = ?'
      )
        .bind(nodeId)
        .first<{ status: string; cleanup_backoff_until: string | null }>();

      expect(destroyForUser).toHaveBeenCalledTimes(1);
      expect(result.staleDestroyed).toBe(0);
      expect(result.errors).toBeGreaterThanOrEqual(1);
      expect(node?.status).toBe('running');
      expect(node?.cleanup_backoff_until).not.toBeNull();
    });

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

      // A record with no provider instance is safe to finalize without credentials.
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
        orphanedNodesDestroyed: expect.any(Number),
        orphanedNodesSkipped: expect.any(Number),
        stoppedWorkspacesDeleted: expect.any(Number),
        cfContainersDestroyed: expect.any(Number),
        incompatibleDestroyed: expect.any(Number),
        incompatibleSkipped: expect.any(Number),
        errors: expect.any(Number),
      });
    });
  });
});
