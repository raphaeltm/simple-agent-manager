/**
 * Empty managed VM nodes reach NodeLifecycle (tasks/archive/2026-10-11-reap-empty-managed-vm-nodes.md).
 *
 * Production incident 2026-10-09: a healthy pool node ran 34 h with no workspace. Its last
 * task was failed by the runaway-cost ceiling, `cleanupTaskRun` only handed a node to
 * NodeLifecycle when the task had `auto_provisioned_node_id`, and that link had been cleared
 * by a conversation wake. Every running-node cron phase keyed on the same link.
 *
 * Real D1 + the real NodeLifecycle Durable Object via Miniflare. Only VM-agent and Hetzner
 * HTTP are stubbed at the fetch boundary.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { getCredentialEncryptionKey } from '../../src/lib/secrets';
import { runNodeCleanupSweep } from '../../src/scheduled/node-cleanup';
import { recoverStuckTasks } from '../../src/scheduled/stuck-tasks';
import { encrypt } from '../../src/services/encryption';
import { handOffEmptyWorkspaceNode } from '../../src/services/node-warm-handoff';
import { fingerprintEncryptedProviderCredential } from '../../src/services/provider-credential-exact';
import { cleanupWorkspaceForDeletion } from '../../src/services/workspace-cleanup';
import {
  seedInstallation,
  seedManagedVmAbsenceProof,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';
import type { NodeLifecycleTestDouble } from './support/expected-error-doubles';

const USER_ID = 'user-enw';
const OTHER_USER_ID = 'user-enw-other';
const INSTALL_ID = 'install-enw';
const PROJECT_ID = 'project-enw';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const originalFetch = globalThis.fetch;
let providerDeletes: string[] = [];

interface StoredState {
  nodeId: string;
  userId: string;
  status: 'active' | 'warm' | 'destroying';
  warmSince: number | null;
  claimedByTask: string | null;
  warmTimeoutOverrideMs?: number | null;
}

beforeEach(() => {
  providerDeletes = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('.vm.test.example.com')) {
        if (url.endsWith('/physical-deletion') && init?.method === 'DELETE') {
          const identity = JSON.parse(String(init.body));
          return Response.json({ ...identity, success: true, physicalDeleted: true });
        }
        return new Response(null, { status: 204 });
      }
      if (url.startsWith('https://api.hetzner.cloud/v1/servers/') && init?.method === 'DELETE') {
        providerDeletes.push(url);
        return new Response(null, { status: 204 });
      }
      return originalFetch(input, init);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

async function seedBase(): Promise<void> {
  await seedUser(USER_ID);
  await seedInstallation(INSTALL_ID, USER_ID);
  await seedProject(PROJECT_ID, USER_ID, INSTALL_ID);
}

interface PoolNodeOptions {
  userId?: string;
  createdAt?: string;
  healthStatus?: string;
  nodeClass?: 'managed' | 'user-owned';
  nodeRole?: 'workspace' | 'deployment';
  runtime?: 'vm' | 'cf-container';
  warmSince?: string | null;
  provenance?: boolean;
  cleanupBackoffUntil?: string;
}

/**
 * A running VM shaped like production pool placement: no task link, provenance only in the
 * server-written pool/credential snapshot (the incident node's exact shape).
 */
async function seedRunningPoolNode(nodeId: string, opts: PoolNodeOptions = {}): Promise<void> {
  const userId = opts.userId ?? USER_ID;
  const now = new Date().toISOString();
  await seedNode(nodeId, userId, {
    status: 'running',
    createdAt: opts.createdAt ?? ago(3 * HOUR),
    updatedAt: now,
    lastHeartbeatAt: now,
    healthStatus: opts.healthStatus ?? 'healthy',
    warmSince: opts.warmSince ?? null,
    nodeClass: opts.nodeClass ?? 'managed',
  });
  if (opts.provenance !== false) {
    await seedManagedVmAbsenceProof(nodeId, userId);
    // Running: the provider still holds the server, so there is no termination proof yet.
    await env.DATABASE.prepare(
      `UPDATE nodes SET provider_instance_id = ?, runtime_termination_confirmed_at = NULL
        WHERE id = ?`
    )
      .bind(`${nodeId}-server`, nodeId)
      .run();
  }
  if (opts.nodeRole === 'deployment') {
    await env.DATABASE.prepare(
      `UPDATE nodes SET node_role = 'deployment', workload_role = 'deployment' WHERE id = ?`
    )
      .bind(nodeId)
      .run();
  }
  if (opts.runtime) {
    await env.DATABASE.prepare('UPDATE nodes SET runtime = ? WHERE id = ?')
      .bind(opts.runtime, nodeId)
      .run();
  }
  if (opts.cleanupBackoffUntil) {
    await env.DATABASE.prepare('UPDATE nodes SET cleanup_backoff_until = ? WHERE id = ?')
      .bind(opts.cleanupBackoffUntil, nodeId)
      .run();
  }
}

/** Make the node's platform credential decryptable so strict provider teardown can run. */
async function bindDecryptableProviderCredential(nodeId: string): Promise<void> {
  const credentialId = `${nodeId}-proof-credential`;
  const token = await encrypt(
    'hetzner-test-token',
    getCredentialEncryptionKey(env as unknown as Env)
  );
  await env.DATABASE.prepare(
    'UPDATE platform_credentials SET encrypted_token = ?, iv = ?, is_enabled = 1 WHERE id = ?'
  )
    .bind(token.ciphertext, token.iv, credentialId)
    .run();
  await env.DATABASE.prepare(
    `UPDATE nodes SET placement_credential_reference = ?, placement_credential_fingerprint = ?
      WHERE id = ?`
  )
    .bind(
      `platform_credentials:${credentialId}`,
      await fingerprintEncryptedProviderCredential(token.ciphertext, token.iv),
      nodeId
    )
    .run();
}

async function seedWorkspaceOn(
  workspaceId: string,
  nodeId: string,
  status: string,
  at: string
): Promise<void> {
  await seedWorkspace(workspaceId, nodeId, USER_ID, {
    projectId: PROJECT_ID,
    status,
    createdAt: at,
    updatedAt: at,
  });
  await env.DATABASE.prepare('UPDATE workspaces SET eviction_generation=? WHERE id=?')
    .bind(`generation-${workspaceId}`, workspaceId)
    .run();
  // A logical tombstone is eligible for retirement only after physical proof.
  if (status === 'deleted') {
    await env.DATABASE.prepare(
      `UPDATE workspaces SET runtime_deletion_confirmed_at = ?, runtime_deletion_proof = 'vm_agent_confirmed' WHERE id = ?`
    )
      .bind(at, workspaceId)
      .run();
  }
}

async function nodeRow(nodeId: string): Promise<{
  status: string;
  warm_since: string | null;
  cleanup_backoff_until: string | null;
} | null> {
  return env.DATABASE.prepare(
    'SELECT status, warm_since, cleanup_backoff_until FROM nodes WHERE id = ?'
  )
    .bind(nodeId)
    .first();
}

function lifecycleStub(nodeId: string): DurableObjectStub<NodeLifecycleTestDouble> {
  return env.NODE_LIFECYCLE.get(
    env.NODE_LIFECYCLE.idFromName(nodeId)
  ) as DurableObjectStub<NodeLifecycleTestDouble>;
}

async function lifecycleState(nodeId: string): Promise<StoredState | null> {
  return runInDurableObject(
    lifecycleStub(nodeId),
    async (instance) => (await instance.ctx.storage.get<StoredState>('state')) ?? null
  );
}

async function handoffRecords(nodeId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await env.OBSERVABILITY_DATABASE.prepare(
    `SELECT context FROM platform_errors
      WHERE node_id = ? AND context LIKE '%empty_node_warm_handoff%'
      ORDER BY timestamp ASC`
  )
    .bind(nodeId)
    .all<{ context: string }>();
  return rows.results.map((row) => JSON.parse(row.context) as Record<string, unknown>);
}

function sweepEnv(overrides: Record<string, string> = {}): Env {
  return { ...env, TASK_RUN_CLEANUP_DELAY_MS: '0', ...overrides } as unknown as Env;
}

async function expectUntouched(nodeId: string): Promise<void> {
  expect(await nodeRow(nodeId)).toMatchObject({ status: 'running', warm_since: null });
  expect(await lifecycleState(nodeId)).toBeNull();
  expect(await handoffRecords(nodeId)).toEqual([]);
}

describe('cleanup backstop: empty managed nodes that missed their warm handoff', () => {
  it('hands the incident-shaped node to NodeLifecycle, and the normal warm timeout and teardown destroy it', async () => {
    await seedBase();
    const nodeId = 'node-enw-incident';
    await seedRunningPoolNode(nodeId, { createdAt: ago(36 * HOUR) });
    await bindDecryptableProviderCredential(nodeId);
    // The last workspace left long ago and nothing references the node as auto-provisioned.
    await seedWorkspaceOn('ws-enw-incident-old', nodeId, 'deleted', ago(34 * HOUR));
    await seedTask('task-enw-incident', PROJECT_ID, USER_ID, {
      status: 'failed',
      workspaceId: 'ws-enw-incident-old',
      updatedAt: ago(34 * HOUR),
    });

    const result = await runNodeCleanupSweep(sweepEnv());

    expect(result.emptyNodesHandedToWarm).toBe(1);
    expect(result.errors).toBe(0);
    const warmed = await nodeRow(nodeId);
    expect(warmed).toMatchObject({ status: 'running', cleanup_backoff_until: null });
    expect(warmed?.warm_since).toEqual(expect.any(String));
    const state = await lifecycleState(nodeId);
    expect(state).toMatchObject({ nodeId, userId: USER_ID, status: 'warm' });
    // The Worker test config deliberately uses a non-default warm timeout. The backstop must
    // preserve that entire configured retention window rather than introduce a shorter one.
    const configuredWarmTimeoutMs = Number(env.NODE_WARM_TIMEOUT_MS);
    expect(configuredWarmTimeoutMs).toBeGreaterThan(0);
    expect(await runInDurableObject(lifecycleStub(nodeId), (i) => i.ctx.storage.getAlarm())).toBe(
      state!.warmSince! + configuredWarmTimeoutMs
    );
    expect(await handoffRecords(nodeId)).toEqual([
      expect.objectContaining({
        recoveryType: 'empty_node_warm_handoff',
        reason: 'missed_warm_handoff',
        nodeId,
        graceMs: 30 * MINUTE,
      }),
    ]);
    // Destroying is not this phase's job: nothing was deleted at the provider yet.
    expect(providerDeletes).toEqual([]);

    // The warm window elapses and NodeLifecycle's own alarm hands the node to teardown.
    await runInDurableObject(lifecycleStub(nodeId), async (instance) => {
      const current = await instance.ctx.storage.get<StoredState>('state');
      await instance.ctx.storage.put('state', { ...current, warmSince: Date.now() - HOUR });
      await instance.alarm();
    });
    expect(await nodeRow(nodeId)).toMatchObject({ status: 'stopped', warm_since: null });

    const teardown = await runNodeCleanupSweep(sweepEnv());

    expect(teardown.errors).toBe(0);
    expect(providerDeletes).toEqual([`https://api.hetzner.cloud/v1/servers/${nodeId}-server`]);
    expect(await nodeRow(nodeId)).toMatchObject({ status: 'deleted' });
  });

  it.each([
    { name: 'former workspace project', poolTimeoutMs: null, expectedMs: 2 * HOUR },
    { name: 'pool project with a longer retention', poolTimeoutMs: 4 * HOUR, expectedMs: 4 * HOUR },
  ])('retains the full warm window from the $name', async ({ poolTimeoutMs, expectedMs }) => {
    await seedBase();
    const nodeId = `node-enw-project-retention-${poolTimeoutMs ?? 'workspace'}`;
    await seedRunningPoolNode(nodeId);
    await bindDecryptableProviderCredential(nodeId);
    await seedWorkspaceOn(
      `ws-enw-project-retention-${poolTimeoutMs ?? 'workspace'}`,
      nodeId,
      'deleted',
      ago(2 * HOUR)
    );
    await env.DATABASE.prepare('UPDATE projects SET warm_node_timeout_ms = ? WHERE id = ?')
      .bind(2 * HOUR, PROJECT_ID)
      .run();
    if (poolTimeoutMs !== null) {
      const poolProjectId = 'project-enw-pool-retention';
      await seedProject(poolProjectId, USER_ID, INSTALL_ID);
      await env.DATABASE.prepare('UPDATE projects SET warm_node_timeout_ms = ? WHERE id = ?')
        .bind(poolTimeoutMs, poolProjectId)
        .run();
      await env.DATABASE.prepare(
        `UPDATE capacity_pools SET scope = 'project', owner_user_id = NULL, owner_project_id = ?
          WHERE id = ?`
      )
        .bind(poolProjectId, `${nodeId}-proof-pool`)
        .run();
      await env.DATABASE.prepare(
        `UPDATE nodes SET capacity_pool_scope = 'project', capacity_pool_project_id = ? WHERE id = ?`
      )
        .bind(poolProjectId, nodeId)
        .run();
    }

    // The worker's normal setting is five seconds, deliberately shorter than either project's
    // retention. Exercise the actual sweep rather than calling markIdle with an override.
    expect(Number(env.NODE_WARM_TIMEOUT_MS)).toBe(5_000);
    const result = await runNodeCleanupSweep(sweepEnv());
    expect(result.emptyNodesHandedToWarm).toBe(1);
    expect(result.errors).toBe(0);
    const state = await lifecycleState(nodeId);
    expect(state).toMatchObject({ status: 'warm', warmTimeoutOverrideMs: expectedMs });
    expect(await runInDurableObject(lifecycleStub(nodeId), (i) => i.ctx.storage.getAlarm())).toBe(
      state!.warmSince! + expectedMs
    );

    // An alarm after the default has elapsed must preserve the VM until the full project window.
    const agedWarmSince = Date.now() - (expectedMs - HOUR);
    await runInDurableObject(lifecycleStub(nodeId), async (instance) => {
      const current = await instance.ctx.storage.get<StoredState>('state');
      await instance.ctx.storage.put('state', { ...current, warmSince: agedWarmSince });
      await instance.alarm();
    });
    expect(await nodeRow(nodeId)).toMatchObject({
      status: 'running',
      warm_since: expect.any(String),
    });
    expect((await lifecycleState(nodeId))?.status).toBe('warm');
    expect(await runInDurableObject(lifecycleStub(nodeId), (i) => i.ctx.storage.getAlarm())).toBe(
      agedWarmSince + expectedMs
    );
    expect(providerDeletes).toEqual([]);
  });

  it('preserves a workspace admitted after the backstop handoff when the warm alarm expires', async () => {
    await seedBase();
    const nodeId = 'node-enw-admitted-after-handoff';
    await seedRunningPoolNode(nodeId);
    await bindDecryptableProviderCredential(nodeId);

    const handoff = await runNodeCleanupSweep(sweepEnv());
    expect(handoff.emptyNodesHandedToWarm).toBe(1);
    expect((await lifecycleState(nodeId))?.status).toBe('warm');

    // A placement can win after selection or handoff. Its live reservation must fence the
    // expired warm alarm even if no separate markActive RPC reached NodeLifecycle.
    await seedWorkspaceOn('ws-enw-admitted-after-handoff', nodeId, 'creating', ago(MINUTE));
    await runInDurableObject(lifecycleStub(nodeId), async (instance) => {
      const current = await instance.ctx.storage.get<StoredState>('state');
      await instance.ctx.storage.put('state', { ...current, warmSince: Date.now() - HOUR });
      await instance.alarm();
    });
    await runNodeCleanupSweep(sweepEnv());

    expect(await nodeRow(nodeId)).toMatchObject({ status: 'running', warm_since: null });
    expect((await lifecycleState(nodeId))?.status).toBe('active');
    expect(providerDeletes).toEqual([]);
    expect(
      await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
        .bind('ws-enw-admitted-after-handoff')
        .first()
    ).toMatchObject({ status: 'creating' });
  });

  it('leaves every excluded shape alone while handing off the eligible node in the same sweep', async () => {
    await seedBase();
    await seedUser(OTHER_USER_ID);
    const eligible = 'node-enw-eligible';
    await seedRunningPoolNode(eligible);
    await seedWorkspaceOn('ws-enw-eligible', eligible, 'deleted', ago(2 * HOUR));

    const live = 'node-enw-live-workspace';
    await seedRunningPoolNode(live);
    await seedWorkspaceOn('ws-enw-live-old', live, 'deleted', ago(2 * HOUR));
    await seedWorkspaceOn('ws-enw-live', live, 'running', ago(2 * HOUR));

    // Deployment, user-owned and container nodes also carry a task link (Instant sessions really
    // record one for their container), so the class/role/runtime guards are the only thing
    // keeping them out: a task link alone satisfies the provenance check (rule 51).
    const linkTask = (nodeId: string) =>
      seedTask(`task-enw-link-${nodeId}`, PROJECT_ID, USER_ID, {
        status: 'completed',
        autoProvisionedNodeId: nodeId,
        updatedAt: ago(2 * HOUR),
      });

    const deployment = 'node-enw-deployment';
    await seedRunningPoolNode(deployment, { nodeRole: 'deployment' });
    await linkTask(deployment);

    const withinGrace = 'node-enw-within-grace';
    await seedRunningPoolNode(withinGrace);
    await seedWorkspaceOn('ws-enw-within-grace', withinGrace, 'deleted', ago(10 * MINUTE));

    const fresh = 'node-enw-fresh';
    await seedRunningPoolNode(fresh, { createdAt: ago(10 * MINUTE) });

    const userOwned = 'node-enw-user-owned';
    await seedRunningPoolNode(userOwned, { nodeClass: 'user-owned' });
    await linkTask(userOwned);

    const unhealthy = 'node-enw-unhealthy';
    await seedRunningPoolNode(unhealthy, { healthStatus: 'unhealthy' });

    // A sleeping Instant session: its container is retained for an in-place wake and its task
    // stays in_progress, so no other phase touches it either.
    const container = 'node-enw-sleeping-container';
    await seedRunningPoolNode(container, { runtime: 'cf-container' });
    await seedWorkspaceOn('ws-enw-sleeping-container', container, 'sleeping', ago(2 * HOUR));
    await seedTask('task-enw-sleeping-container', PROJECT_ID, USER_ID, {
      status: 'in_progress',
      workspaceId: 'ws-enw-sleeping-container',
      autoProvisionedNodeId: container,
      taskMode: 'conversation',
      updatedAt: ago(2 * HOUR),
    });

    const noProvenance = 'node-enw-no-provenance';
    await seedRunningPoolNode(noProvenance, { provenance: false });

    const backedOff = 'node-enw-backed-off';
    await seedRunningPoolNode(backedOff, { cleanupBackoffUntil: ago(-HOUR) });

    const claimed = 'node-enw-warm-claim';
    await seedRunningPoolNode(claimed);
    await seedTask('task-enw-claim', PROJECT_ID, USER_ID, { status: 'queued' });
    await env.DATABASE.prepare(
      `UPDATE tasks SET claimed_warm_node_id = ?, claimed_warm_node_at = ? WHERE id = ?`
    )
      .bind(claimed, ago(MINUTE), 'task-enw-claim')
      .run();

    const alreadyWarm = 'node-enw-already-warm';
    await seedRunningPoolNode(alreadyWarm, { warmSince: ago(5 * MINUTE) });

    const result = await runNodeCleanupSweep(sweepEnv());

    // Liveness: the sweep reached the phase and acted in this very run.
    expect(result.emptyNodesHandedToWarm).toBe(1);
    // Excluded shapes are never selected at all (rule 51), not merely skipped by the handoff.
    expect(result.emptyNodesHandoffSkipped).toBe(0);
    expect((await lifecycleState(eligible))?.status).toBe('warm');
    for (const nodeId of [
      live,
      deployment,
      withinGrace,
      fresh,
      userOwned,
      unhealthy,
      container,
      noProvenance,
      backedOff,
      claimed,
    ]) {
      await expectUntouched(nodeId);
    }
    expect(await nodeRow(alreadyWarm)).toMatchObject({ warm_since: expect.any(String) });
    expect(await lifecycleState(alreadyWarm)).toBeNull();
  });

  it('honors NODE_EMPTY_WARM_HANDOFF_GRACE_MS instead of a hardcoded window', async () => {
    await seedBase();
    const nodeId = 'node-enw-configured-grace';
    await seedRunningPoolNode(nodeId);
    await seedWorkspaceOn('ws-enw-configured-grace', nodeId, 'deleted', ago(2 * HOUR));

    await runNodeCleanupSweep(sweepEnv({ NODE_EMPTY_WARM_HANDOFF_GRACE_MS: String(3 * HOUR) }));
    await expectUntouched(nodeId);

    await runNodeCleanupSweep(sweepEnv({ NODE_EMPTY_WARM_HANDOFF_GRACE_MS: String(HOUR) }));
    expect((await lifecycleState(nodeId))?.status).toBe('warm');
  });

  it('fences a failed handoff with a backoff so the next sweep does not retry it', async () => {
    await seedBase();
    const nodeId = 'node-enw-handoff-fails';
    await seedRunningPoolNode(nodeId);
    await seedWorkspaceOn('ws-enw-handoff-fails', nodeId, 'deleted', ago(2 * HOUR));
    const markIdle = vi.fn(async () => {
      throw new Error('NodeLifecycle RPC unavailable');
    });
    // Fail at the Durable Object transport boundary; the sweep, SQL and records stay real.
    const failingEnv = {
      ...sweepEnv(),
      NODE_LIFECYCLE: { idFromName: (name: string) => name, get: () => ({ markIdle }) },
    } as unknown as Env;

    const first = await runNodeCleanupSweep(failingEnv);
    const second = await runNodeCleanupSweep(failingEnv);

    expect(first.errors).toBe(1);
    expect(markIdle).toHaveBeenCalledTimes(1);
    expect(second.errors).toBe(0);
    expect((await nodeRow(nodeId))?.cleanup_backoff_until).toEqual(expect.any(String));
    expect(await handoffRecords(nodeId)).toEqual([
      expect.objectContaining({
        reason: 'handoff_failed',
        nodeId,
        error: 'NodeLifecycle RPC unavailable',
      }),
    ]);
  });

  it('fences a handoff whose warm_since never reached D1 instead of restarting the warm timer every sweep', async () => {
    await seedBase();
    const nodeId = 'node-enw-warm-since-lost';
    await seedRunningPoolNode(nodeId);
    await seedWorkspaceOn('ws-enw-warm-since-lost', nodeId, 'deleted', ago(2 * HOUR));
    // Simulate NodeLifecycle's D1 warm_since write failing: the DO goes warm, D1 never does.
    await env.DATABASE.prepare(
      `CREATE TRIGGER enw_drop_warm_since AFTER UPDATE OF warm_since ON nodes
        WHEN NEW.id = '${nodeId}' AND NEW.warm_since IS NOT NULL
        BEGIN UPDATE nodes SET warm_since = NULL WHERE id = NEW.id; END`
    ).run();

    try {
      await runNodeCleanupSweep(sweepEnv());
      const firstWarmSince = (await lifecycleState(nodeId))?.warmSince;
      await runNodeCleanupSweep(sweepEnv());

      expect(firstWarmSince).toEqual(expect.any(Number));
      expect((await lifecycleState(nodeId))?.warmSince).toBe(firstWarmSince);
      expect((await nodeRow(nodeId))?.cleanup_backoff_until).toEqual(expect.any(String));
      expect(await handoffRecords(nodeId)).toEqual([
        expect.objectContaining({ reason: 'warm_since_not_persisted', nodeId }),
      ]);
    } finally {
      await env.DATABASE.prepare('DROP TRIGGER IF EXISTS enw_drop_warm_since').run();
    }
  });
});

describe('handOffEmptyWorkspaceNode', () => {
  async function handOff(nodeId: string, expectedUserId: string | null = USER_ID) {
    return handOffEmptyWorkspaceNode(env as unknown as Env, {
      nodeId,
      expectedUserId,
      reason: 'test',
    });
  }

  it('warms an empty managed node regardless of any task link', async () => {
    await seedBase();
    const nodeId = 'node-enw-helper-empty';
    await seedRunningPoolNode(nodeId);
    await seedWorkspaceOn('ws-enw-helper-empty', nodeId, 'stopped', ago(MINUTE));

    await expect(handOff(nodeId)).resolves.toEqual({ outcome: 'handed_to_warm' });
    expect((await lifecycleState(nodeId))?.status).toBe('warm');
    expect((await nodeRow(nodeId))?.warm_since).toEqual(expect.any(String));
  });

  it('preserves a stopped workspace project retention when no override is supplied', async () => {
    await seedBase();
    const nodeId = 'node-enw-helper-project-retention';
    await seedRunningPoolNode(nodeId);
    await seedWorkspaceOn('ws-enw-helper-project-retention', nodeId, 'stopped', ago(MINUTE));
    await env.DATABASE.prepare('UPDATE projects SET warm_node_timeout_ms = ? WHERE id = ?')
      .bind(2 * HOUR, PROJECT_ID)
      .run();

    await expect(handOff(nodeId)).resolves.toEqual({ outcome: 'handed_to_warm' });
    const state = await lifecycleState(nodeId);
    expect(state).toMatchObject({ status: 'warm', warmTimeoutOverrideMs: 2 * HOUR });
    expect(await runInDurableObject(lifecycleStub(nodeId), (i) => i.ctx.storage.getAlarm())).toBe(
      state!.warmSince! + 2 * HOUR
    );
  });

  it('honors an explicit shorter warm timeout override', async () => {
    await seedBase();
    const nodeId = 'node-enw-helper-explicit-retention';
    await seedRunningPoolNode(nodeId);
    await seedWorkspaceOn('ws-enw-helper-explicit-retention', nodeId, 'stopped', ago(MINUTE));
    await env.DATABASE.prepare('UPDATE projects SET warm_node_timeout_ms = ? WHERE id = ?')
      .bind(2 * HOUR, PROJECT_ID)
      .run();

    await expect(
      handOffEmptyWorkspaceNode(env as unknown as Env, {
        nodeId,
        expectedUserId: USER_ID,
        reason: 'test_explicit_retention',
        warmTimeoutOverrideMs: MINUTE,
      })
    ).resolves.toEqual({ outcome: 'handed_to_warm' });
    const state = await lifecycleState(nodeId);
    expect(state).toMatchObject({ status: 'warm', warmTimeoutOverrideMs: MINUTE });
    expect(await runInDurableObject(lifecycleStub(nodeId), (i) => i.ctx.storage.getAlarm())).toBe(
      state!.warmSince! + MINUTE
    );
  });

  it('leaves compute active if project retention cannot be read', async () => {
    await seedBase();
    const nodeId = 'node-enw-helper-retention-read-failure';
    await seedRunningPoolNode(nodeId);
    const retentionReads = vi.fn();
    const database = new Proxy(env.DATABASE, {
      get(target, property) {
        if (property === 'prepare')
          return (sql: string) => {
            if (/MAX\s*\(/i.test(sql) && /projects/i.test(sql)) {
              retentionReads();
              throw new Error('project retention lookup unavailable');
            }
            return target.prepare(sql);
          };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const markIdle = vi.fn();
    const failingEnv = {
      ...env,
      DATABASE: database,
      NODE_LIFECYCLE: { idFromName: (name: string) => name, get: () => ({ markIdle }) },
    } as unknown as Env;

    await expect(
      handOffEmptyWorkspaceNode(failingEnv, {
        nodeId,
        expectedUserId: USER_ID,
        reason: 'test_retention_read_failure',
      })
    ).resolves.toEqual({ outcome: 'failed', error: 'project retention lookup unavailable' });
    expect(retentionReads).toHaveBeenCalledTimes(1);
    expect(markIdle).not.toHaveBeenCalled();
    expect(await nodeRow(nodeId)).toMatchObject({ status: 'running', warm_since: null });
    expect(await lifecycleState(nodeId)).toBeNull();
  });

  it.each(['running', 'creating', 'recovery'] as const)(
    'keeps a node with a %s workspace out of the warm pool',
    async (status) => {
      await seedBase();
      const nodeId = `node-enw-helper-occupied-${status}`;
      await seedRunningPoolNode(nodeId);
      await seedWorkspaceOn(`ws-enw-helper-occupied-${status}`, nodeId, status, ago(MINUTE));

      await expect(handOff(nodeId)).resolves.toEqual({ outcome: 'skipped', reason: 'occupied' });
      expect(await lifecycleState(nodeId)).toBeNull();
    }
  );

  it('does not restart a warm timer another path already armed', async () => {
    await seedBase();
    const nodeId = 'node-enw-helper-warm';
    await seedRunningPoolNode(nodeId);
    expect((await handOff(nodeId)).outcome).toBe('handed_to_warm');
    const armedAt = (await lifecycleState(nodeId))?.warmSince;

    await expect(handOff(nodeId)).resolves.toEqual({
      outcome: 'skipped',
      reason: 'already_warm',
    });
    expect((await lifecycleState(nodeId))?.warmSince).toBe(armedAt);
  });

  it.each([
    ['not_workspace_role', { nodeRole: 'deployment' as const }],
    ['not_vm', { runtime: 'cf-container' as const }],
    ['not_managed', { nodeClass: 'user-owned' as const }],
    ['no_teardown_provenance', { provenance: false }],
  ])('skips %s nodes without touching NodeLifecycle', async (reason, opts) => {
    await seedBase();
    const nodeId = `node-enw-helper-${reason}`;
    await seedRunningPoolNode(nodeId, opts);

    await expect(handOff(nodeId)).resolves.toEqual({ outcome: 'skipped', reason });
    expect(await lifecycleState(nodeId)).toBeNull();
  });

  it('skips stopped, missing and foreign-owned nodes', async () => {
    await seedBase();
    await seedUser(OTHER_USER_ID);
    const stopped = 'node-enw-helper-stopped';
    await seedRunningPoolNode(stopped);
    await env.DATABASE.prepare(`UPDATE nodes SET status = 'stopped' WHERE id = ?`)
      .bind(stopped)
      .run();
    const foreign = 'node-enw-helper-foreign';
    await seedRunningPoolNode(foreign, { userId: OTHER_USER_ID });

    await expect(handOff(stopped)).resolves.toEqual({ outcome: 'skipped', reason: 'not_running' });
    await expect(handOff('node-enw-helper-missing')).resolves.toEqual({
      outcome: 'skipped',
      reason: 'node_missing',
    });
    await expect(handOff(foreign)).resolves.toEqual({
      outcome: 'skipped',
      reason: 'owner_mismatch',
    });
    // Owner-path control on the same row: its own user may hand it off.
    await expect(handOff(foreign, OTHER_USER_ID)).resolves.toEqual({
      outcome: 'handed_to_warm',
    });
  });
});

describe('last-workspace removal paths hand the node to NodeLifecycle', () => {
  it('runaway-cost ceiling on a pack-placed task warms its node (the incident path)', async () => {
    await seedBase();
    const nodeId = 'node-enw-ceiling';
    const workspaceId = 'ws-enw-ceiling';
    const taskId = 'task-enw-ceiling';
    await seedRunningPoolNode(nodeId, { createdAt: ago(26 * HOUR) });
    await seedWorkspace(workspaceId, nodeId, USER_ID, {
      projectId: PROJECT_ID,
      status: 'running',
      createdAt: ago(25 * HOUR),
      updatedAt: ago(MINUTE),
    });
    // Pack-placed onto an existing pool node: no auto_provisioned_node_id, like every task on
    // the incident node.
    await seedTask(taskId, PROJECT_ID, USER_ID, {
      status: 'in_progress',
      workspaceId,
      executionStep: 'awaiting_followup',
      startedAt: ago(25 * HOUR),
      updatedAt: ago(MINUTE),
    });

    const result = await recoverStuckTasks(sweepEnv());

    expect(result.failedInProgress).toBe(1);
    const task = await env.DATABASE.prepare('SELECT status, error_message FROM tasks WHERE id = ?')
      .bind(taskId)
      .first<{ status: string; error_message: string }>();
    expect(task?.status).toBe('failed');
    expect(task?.error_message).toContain('absolute runaway-cost ceiling');
    const workspace = await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
      .bind(workspaceId)
      .first<{ status: string }>();
    expect(workspace?.status).toBe('stopped');
    expect((await nodeRow(nodeId))?.warm_since).toEqual(expect.any(String));
    expect(await lifecycleState(nodeId)).toMatchObject({ status: 'warm', userId: USER_ID });
  });

  it('archiving the last conversation preserves project retention after deleting its workspace row', async () => {
    await seedBase();
    const nodeId = 'node-enw-archive';
    const workspaceId = 'ws-enw-archive';
    await env.DATABASE.prepare('UPDATE projects SET warm_node_timeout_ms = ? WHERE id = ?')
      .bind(2 * HOUR, PROJECT_ID)
      .run();
    await seedRunningPoolNode(nodeId);
    await seedWorkspaceOn(workspaceId, nodeId, 'running', ago(MINUTE));
    const db = drizzle(env.DATABASE, { schema });
    const workspace = await db.query.workspaces.findFirst({
      where: (row, { eq }) => eq(row.id, workspaceId),
    });
    if (!workspace) throw new Error('expected seeded workspace');

    const outcome = await cleanupWorkspaceForDeletion({
      db,
      env: env as unknown as Env,
      workspace,
      userId: USER_ID,
      logContext: { closePath: 'test_archive' },
      deleteConfirmedRow: true,
    });

    expect(outcome.status).toBe('confirmed');
    expect((await nodeRow(nodeId))?.warm_since).toEqual(expect.any(String));
    expect(
      await env.DATABASE.prepare('SELECT id FROM workspaces WHERE id = ?').bind(workspaceId).first()
    ).toBeNull();
    const state = await lifecycleState(nodeId);
    expect(state).toMatchObject({ status: 'warm', warmTimeoutOverrideMs: 2 * HOUR });
    expect(await runInDurableObject(lifecycleStub(nodeId), (i) => i.ctx.storage.getAlarm())).toBe(
      state!.warmSince! + 2 * HOUR
    );
  });

  it('archiving one of two live conversations keeps the node active', async () => {
    await seedBase();
    const nodeId = 'node-enw-archive-shared';
    await seedRunningPoolNode(nodeId);
    await seedWorkspaceOn('ws-enw-archive-shared-a', nodeId, 'running', ago(MINUTE));
    await seedWorkspaceOn('ws-enw-archive-shared-b', nodeId, 'running', ago(MINUTE));
    const db = drizzle(env.DATABASE, { schema });
    const workspace = await db.query.workspaces.findFirst({
      where: (row, { eq }) => eq(row.id, 'ws-enw-archive-shared-a'),
    });
    if (!workspace) throw new Error('expected seeded workspace');

    const outcome = await cleanupWorkspaceForDeletion({
      db,
      env: env as unknown as Env,
      workspace,
      userId: USER_ID,
      logContext: { closePath: 'test_archive' },
    });

    expect(outcome.status).toBe('confirmed');
    expect(await nodeRow(nodeId)).toMatchObject({ status: 'running', warm_since: null });
    expect(await lifecycleState(nodeId)).toBeNull();
  });
});
