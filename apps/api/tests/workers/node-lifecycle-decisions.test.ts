/**
 * Node lifecycle decision log, driven through the real triggers (rule 62):
 * the NodeLifecycle DO transitions and alarm, the warm handoff, and the cleanup
 * sweep's shared destroy path. Real D1 + DO storage via Miniflare.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { runNodeCleanupSweep } from '../../src/scheduled/node-cleanup';
import { destroyNodeForCleanup } from '../../src/scheduled/node-cleanup/shared';
import { listNodeLifecycleDecisions } from '../../src/services/node-lifecycle-decisions';
import { handOffEmptyWorkspaceNode } from '../../src/services/node-warm-handoff';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';
import type { NodeLifecycleTestDouble } from './support/expected-error-doubles';

const USER_ID = 'user-decisions';
const PROJECT_ID = 'project-decisions';
const INSTALL_ID = 'install-decisions';

function stub(nodeId: string): DurableObjectStub<NodeLifecycleTestDouble> {
  return env.NODE_LIFECYCLE.get(
    env.NODE_LIFECYCLE.idFromName(nodeId)
  ) as DurableObjectStub<NodeLifecycleTestDouble>;
}

async function decisions(nodeId: string) {
  return (await listNodeLifecycleDecisions(env.DATABASE, nodeId, 50)).reverse();
}

async function seedBase(): Promise<void> {
  await seedUser(USER_ID);
  await seedInstallation(INSTALL_ID, USER_ID);
  await seedProject(PROJECT_ID, USER_ID, INSTALL_ID);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('NodeLifecycle DO decisions', () => {
  it('records marked_warm with the teardown deadline, then the alarm expiry', async () => {
    await seedBase();
    const nodeId = 'node-decisions-warm';
    await seedNode(nodeId, USER_ID);

    const before = Date.now();
    expect((await stub(nodeId).markIdle(nodeId, USER_ID, 60_000)).status).toBe('warm');
    const [warm] = await decisions(nodeId);
    expect(warm).toMatchObject({
      source: 'node_lifecycle',
      decision: 'marked_warm',
      reason: 'last_workspace_left',
      workspaceCount: 0,
    });
    expect(warm!.detail?.warmTimeoutMs).toBe(60_000);
    expect(Date.parse(String(warm!.detail?.teardownDueAt))).toBeGreaterThanOrEqual(before + 60_000);

    // Age the warm state past its timeout and fire the real alarm.
    await runInDurableObject(stub(nodeId), async (instance) => {
      const state = await instance.ctx.storage.get<Record<string, unknown>>('state');
      await instance.ctx.storage.put('state', { ...state, warmSince: Date.now() - 600_000 });
      await instance.alarm();
    });
    expect((await decisions(nodeId)).map((row) => row.decision)).toEqual([
      'marked_warm',
      'warm_expired_destroying',
    ]);
  });

  it('records kept_active with the live workspace count when a workspace occupies the node', async () => {
    await seedBase();
    const nodeId = 'node-decisions-occupied';
    await seedNode(nodeId, USER_ID);
    await seedWorkspace('ws-decisions-a', nodeId, USER_ID, { status: 'running' });
    await seedWorkspace('ws-decisions-b', nodeId, USER_ID, { status: 'creating' });

    expect((await stub(nodeId).markIdle(nodeId, USER_ID)).status).toBe('active');
    expect(await decisions(nodeId)).toMatchObject([
      { decision: 'kept_active', reason: 'active_workspace', workspaceCount: 2 },
    ]);
  });

  it('records a warm claim by a task', async () => {
    await seedBase();
    const nodeId = 'node-decisions-claim';
    const taskId = 'task-decisions-claim';
    await seedNode(nodeId, USER_ID);
    await seedTask(taskId, PROJECT_ID, USER_ID, { status: 'queued' });

    await stub(nodeId).markIdle(nodeId, USER_ID);
    expect((await stub(nodeId).tryClaim(taskId)).claimed).toBe(true);
    const claimed = (await decisions(nodeId)).at(-1);
    expect(claimed).toMatchObject({ decision: 'claimed', reason: 'warm_node_reused' });
    expect(claimed!.detail?.taskId).toBe(taskId);
  });

  it('a decision-log write failure never fails the lifecycle transition', async () => {
    await seedBase();
    const nodeId = 'node-decisions-write-failure';
    await seedNode(nodeId, USER_ID);
    await env.DATABASE.exec('ALTER TABLE node_lifecycle_decisions RENAME TO nld_hidden');
    try {
      expect((await stub(nodeId).markIdle(nodeId, USER_ID)).status).toBe('warm');
      const row = await env.DATABASE.prepare('SELECT warm_since FROM nodes WHERE id = ?')
        .bind(nodeId)
        .first<{ warm_since: string | null }>();
      expect(row?.warm_since).toBeTruthy();
    } finally {
      await env.DATABASE.exec('ALTER TABLE nld_hidden RENAME TO node_lifecycle_decisions');
    }
  });
});

describe('warm handoff decisions', () => {
  it('records why an empty node was not handed to warm, once per dedupe window', async () => {
    await seedBase();
    const nodeId = 'node-decisions-handoff-skip';
    await seedNode(nodeId, USER_ID);
    await env.DATABASE.prepare(
      "UPDATE nodes SET runtime = 'vm', node_role = 'workspace' WHERE id = ?"
    )
      .bind(nodeId)
      .run();

    for (let i = 0; i < 2; i++) {
      const result = await handOffEmptyWorkspaceNode(env as Env, {
        nodeId,
        reason: 'test_removal',
      });
      expect(result).toEqual({ outcome: 'skipped', reason: 'no_teardown_provenance' });
    }
    expect(await decisions(nodeId)).toMatchObject([
      { source: 'warm_handoff', decision: 'handoff_skipped', reason: 'no_teardown_provenance' },
    ]);
  });

  it('records handed_to_warm alongside the DO marked_warm decision', async () => {
    await seedBase();
    const nodeId = 'node-decisions-handoff-warm';
    await seedNode(nodeId, USER_ID);
    await env.DATABASE.prepare(
      "UPDATE nodes SET runtime = 'vm', node_role = 'workspace' WHERE id = ?"
    )
      .bind(nodeId)
      .run();
    await seedTask('task-decisions-handoff', PROJECT_ID, USER_ID, {
      status: 'completed',
      autoProvisionedNodeId: nodeId,
    });

    const result = await handOffEmptyWorkspaceNode(env as Env, {
      nodeId,
      reason: 'task_run_cleanup',
    });
    expect(result).toEqual({ outcome: 'handed_to_warm' });
    const rows = await decisions(nodeId);
    expect(rows.map((row) => `${row.source}:${row.decision}`)).toEqual([
      'node_lifecycle:marked_warm',
      'warm_handoff:handed_to_warm',
    ]);
    expect(rows[1]!.detail?.removalPath).toBe('task_run_cleanup');
  });
});

describe('cleanup sweep decisions', () => {
  it('records destroy_attempted and destroyed with the provider result through the real sweep', async () => {
    await seedBase();
    const nodeId = 'node-decisions-orphan';
    const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await seedNode(nodeId, USER_ID, { createdAt: oldDate, updatedAt: oldDate });
    await seedTask('task-decisions-orphan', PROJECT_ID, USER_ID, {
      status: 'completed',
      autoProvisionedNodeId: nodeId,
      updatedAt: oldDate,
    });
    await env.DATABASE.prepare(`UPDATE nodes SET runtime = 'cf-container' WHERE id = ?`)
      .bind(nodeId)
      .run();
    const testEnv = {
      ...env,
      CF_CONTAINER_ENABLED: 'true',
      VM_AGENT_CONTAINER: {
        idFromName: (id: string) => id,
        get: () => ({ destroyForUser: vi.fn().mockResolvedValue(undefined) }),
      },
      NODE_WORKSPACE_IDLE_TIMEOUT_MS: '1000',
    } as unknown as Env;

    const result = await runNodeCleanupSweep(testEnv);
    expect(result.orphanedNodesDestroyed).toBe(1);
    const rows = (await decisions(nodeId)).filter((row) => row.source === 'cleanup_sweep');
    expect(rows.map((row) => row.decision)).toEqual(['destroy_attempted', 'destroyed']);
    expect(rows[1]!.reason).toBe('provider_no-instance');
    expect(rows[1]!.detail?.phase).toBe('idle_orphan_node_cleanup');
  });

  it('records a refused destroy with its reason, deduped across repeated sweeps', async () => {
    await seedBase();
    const nodeId = 'node-decisions-refused';
    await seedNode(nodeId, USER_ID, { status: 'stopped' });
    await seedWorkspace('ws-decisions-refused', nodeId, USER_ID, { status: 'running' });
    const db = drizzle(env.DATABASE, { schema });
    const options = {
      logEvent: 'test.destroy',
      failureLogEvent: 'test.destroy_failed',
      successMessage: 'destroyed',
      failureMessagePrefix: 'failed',
      recoveryType: 'test_phase',
      failureRecoveryType: 'test_phase_failed',
      failureBackoffMs: 60_000,
      context: {},
    };
    const node = { id: nodeId, user_id: USER_ID, status: 'stopped' };
    for (let i = 0; i < 2; i++) {
      expect(
        await destroyNodeForCleanup(db, env as Env, new Date().toISOString(), node, options)
      ).toBe('skipped');
    }
    const rows = await decisions(nodeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'cleanup_sweep', decision: 'skipped' });
    expect(rows[0]!.reason).toContain('active_workspace');
    expect(rows[0]!.workspaceCount).toBe(1);
  });
});
