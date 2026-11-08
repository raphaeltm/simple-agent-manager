/**
 * A sleeping Instant (cf-container) workspace is its chat's wake target. Before this guard,
 * the stale-workspace safety net queued it for deletion on staging. Every attempt threw (its
 * workspace generation is NULL), the automatic claim left the row `stopping`, and the next
 * follow-up was refused with "The sleeping container runtime is gone".
 *
 * Real: D1, the NodeLifecycle Durable Object and its deletion queue, the cron safety net
 * (`sweepStaleStoppedWorkspaces`), the preservation SQL and R2 artifact checks, and the strict
 * container teardown. Substituted: the container runtime (`VmAgentContainerTestDouble`, whose
 * `destroyForUser` records `stopped`).
 *
 * Every Instant case has a sleeping VM control. A sleeping VM must still release its VM.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import { workspaceDeletionDueIndexKey } from '../../src/durable-objects/node-lifecycle-workspace-deletion';
import type { PendingWorkspaceDeletion } from '../../src/durable-objects/node-lifecycle-workspace-deletion-support';
import type { Env } from '../../src/env';
import { emptyResult, resolveCleanupConfig } from '../../src/scheduled/node-cleanup/shared';
import { sweepStaleStoppedWorkspaces } from '../../src/scheduled/node-cleanup/workspace-phases';
import { buildSessionSnapshotR2Key } from '../../src/services/session-snapshot-artifacts';
import {
  attemptWorkspaceDeletion,
  loadWorkspaceDeletionIdentity,
} from '../../src/services/workspace-deletion';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';
import type { NodeLifecycleTestDouble } from './support/expected-error-doubles';

const USER_ID = 'user-instant-guard';
const STUCK_DIAGNOSTIC = 'Workspace deletion unconfirmed: VM attempt 8 (Error: request_failed)';
const LONG_AGO = '2026-01-01T00:00:00.000Z';
const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

type Runtime = 'cf-container' | 'vm';

function lifecycle(nodeId: string): DurableObjectStub<NodeLifecycleTestDouble> {
  return env.NODE_LIFECYCLE.get(
    env.NODE_LIFECYCLE.idFromName(nodeId)
  ) as DurableObjectStub<NodeLifecycleTestDouble>;
}

/**
 * The rows a completed sleep leaves. Instant: the node is `sleeping` and the container slept in
 * place. VM: the node keeps running and the VM must release the workspace. Both have a verified,
 * preserved snapshot marked `sleeping`, and, like every production row since October, a NULL
 * `eviction_generation`.
 */
async function seedSleptWorkspace(runtime: Runtime, suffix: string) {
  const nodeId = `node-${suffix}`;
  const workspaceId = `ws-${suffix}`;
  const projectId = `project-${suffix}`;
  const chatSessionId = `chat-${suffix}`;
  const installationId = `installation-${suffix}`;
  await seedUser(USER_ID);
  await seedInstallation(installationId, USER_ID);
  await seedProject(projectId, USER_ID, installationId);
  await seedNode(nodeId, USER_ID, {
    status: runtime === 'cf-container' ? 'sleeping' : 'running',
    healthStatus: runtime === 'cf-container' ? 'unhealthy' : 'healthy',
  });
  await env.DATABASE.prepare(
    `UPDATE nodes SET runtime = ?, node_role = 'workspace', runtime_incarnation_id = ?,
            provider_instance_id = ? WHERE id = ?`
  )
    .bind(runtime, `incarnation-${suffix}`, runtime === 'vm' ? `server-${suffix}` : null, nodeId)
    .run();
  await seedWorkspace(workspaceId, nodeId, USER_ID, {
    projectId,
    chatSessionId,
    status: 'sleeping',
    updatedAt: LONG_AGO,
  });
  const generation = `capture-${suffix}`;
  const home = buildSessionSnapshotR2Key(env as Env, chatSessionId, generation, 'home');
  const manifest = buildSessionSnapshotR2Key(env as Env, chatSessionId, generation, 'manifest');
  const manifestJson = JSON.stringify({
    version: 1,
    chatSessionId,
    workspaceId,
    status: 'available',
    degradation: 'none',
    artifacts: { home: { sizeBytes: 0, sha256: SHA } },
  });
  await env.R2.put(home, '');
  await env.R2.put(manifest, manifestJson);
  await env.DATABASE.prepare(
    `INSERT INTO session_snapshots (id, project_id, workspace_id, node_id, user_id, chat_session_id,
       runtime, status, degradation, manifest_r2_key, home_r2_key, home_sha256, manifest_json,
       snapshot_generation, cleanup_identity_json, expires_at, sleeping_at, sleep_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'available', 'none', ?, ?, ?, ?, ?, ?,
             '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'sleeping')`
  )
    .bind(
      `snapshot-${suffix}`,
      projectId,
      workspaceId,
      nodeId,
      USER_ID,
      chatSessionId,
      runtime,
      manifest,
      home,
      SHA,
      manifestJson,
      generation,
      JSON.stringify({
        workspaceId,
        nodeId,
        userId: USER_ID,
        nodeRuntimeIncarnationId: `incarnation-${suffix}`,
        workspaceGeneration: '',
        snapshotGeneration: generation,
        preserved: 1,
      })
    )
    .run();
  return { nodeId, workspaceId };
}

async function workspaceRow(workspaceId: string) {
  return await env.DATABASE.prepare(
    'SELECT status, error_message, runtime_deletion_confirmed_at FROM workspaces WHERE id = ?'
  )
    .bind(workspaceId)
    .first<{
      status: string;
      error_message: string | null;
      runtime_deletion_confirmed_at: string | null;
    }>();
}

async function nodeStatus(nodeId: string) {
  return await env.DATABASE.prepare('SELECT status FROM nodes WHERE id = ?')
    .bind(nodeId)
    .first<string>('status');
}

async function queuedEntry(nodeId: string, workspaceId: string) {
  return await runInDurableObject(lifecycle(nodeId), async (instance) =>
    instance.ctx.storage.get<PendingWorkspaceDeletion>(`ws-delete:${workspaceId}`)
  );
}

/** The cron safety net, at a time far past its stopped-workspace threshold. */
async function runSafetyNet() {
  const result = emptyResult();
  await sweepStaleStoppedWorkspaces(
    drizzle(env.DATABASE, { schema }),
    env as Env,
    new Date('2099-01-01T00:00:00.000Z'),
    resolveCleanupConfig(env as Env),
    result
  );
  return result;
}

/**
 * What the pre-fix safety net left behind on staging: an automatic queue entry that had
 * already failed eight times, and the workspace moved to `stopping` by its claim. The node and
 * snapshot stayed `sleeping`.
 */
async function seedStuckAutomaticDeletion(nodeId: string, workspaceId: string, deleteAt: number) {
  await env.DATABASE.prepare(
    `UPDATE workspaces SET status = 'stopping', error_message = ? WHERE id = ?`
  )
    .bind(STUCK_DIAGNOSTIC, workspaceId)
    .run();
  const identity = await loadWorkspaceDeletionIdentity(env.DATABASE, workspaceId);
  if (!identity) throw new Error('expected a deletion identity');
  const entry: PendingWorkspaceDeletion = {
    ...identity,
    nodeId,
    userId: USER_ID,
    deleteAt,
    attemptCount: 8,
    firstScheduledAt: Date.now() - 60_000,
    lastError: STUCK_DIAGNOSTIC,
    mode: 'automatic',
  } as PendingWorkspaceDeletion;
  await runInDurableObject(lifecycle(nodeId), async (instance) => {
    await instance.ctx.storage.put(`ws-delete:${workspaceId}`, entry);
    await instance.ctx.storage.put(workspaceDeletionDueIndexKey(entry), `ws-delete:${workspaceId}`);
  });
}

async function containerLifecycle(nodeId: string): Promise<unknown> {
  const stub = env.VM_AGENT_CONTAINER.get(env.VM_AGENT_CONTAINER.idFromName(nodeId.toLowerCase()));
  return await runInDurableObject(stub, async (instance) =>
    instance.ctx.storage.get('lifecycleStatus')
  );
}

describe('the stale-workspace safety net and a sleeping Instant workspace', () => {
  it('leaves a sleeping Instant workspace asleep and wakeable', async () => {
    const instant = await seedSleptWorkspace('cf-container', 'net-instant');

    const result = await runSafetyNet();

    expect(result.stoppedWorkspacesQueued).toBe(0);
    expect(await queuedEntry(instant.nodeId, instant.workspaceId)).toBeUndefined();
    // Liveness: the row is still exactly what the in-place wake reads.
    expect(await workspaceRow(instant.workspaceId)).toMatchObject({
      status: 'sleeping',
      error_message: null,
    });
    expect(await nodeStatus(instant.nodeId)).toBe('sleeping');
  });

  it('still queues a sleeping VM workspace, whose VM must be released (control)', async () => {
    const vm = await seedSleptWorkspace('vm', 'net-vm');

    const result = await runSafetyNet();

    expect(result.stoppedWorkspacesQueued).toBe(1);
    expect(await queuedEntry(vm.nodeId, vm.workspaceId)).toMatchObject({
      workspaceId: vm.workspaceId,
    });
  });
});

describe('the deletion queue and a sleeping Instant workspace', () => {
  it('refuses an automatic schedule from any writer', async () => {
    const instant = await seedSleptWorkspace('cf-container', 'sched-instant');

    const scheduled = await lifecycle(instant.nodeId).scheduleWorkspaceDeletion(
      instant.nodeId,
      instant.workspaceId,
      USER_ID,
      { retryAfterMs: 0 }
    );

    expect(scheduled).toBe(false);
    expect(await queuedEntry(instant.nodeId, instant.workspaceId)).toBeUndefined();
    expect((await workspaceRow(instant.workspaceId))?.status).toBe('sleeping');
  });

  it('still accepts an automatic schedule for a sleeping VM workspace (control)', async () => {
    const vm = await seedSleptWorkspace('vm', 'sched-vm');

    const scheduled = await lifecycle(vm.nodeId).scheduleWorkspaceDeletion(
      vm.nodeId,
      vm.workspaceId,
      USER_ID,
      { retryAfterMs: 60_000 }
    );

    expect(scheduled).toBe(true);
    expect(await queuedEntry(vm.nodeId, vm.workspaceId)).toBeDefined();
  });

  it('repairs a row an automatic claim left stopping when its entry comes due', async () => {
    const instant = await seedSleptWorkspace('cf-container', 'due-instant');
    await seedStuckAutomaticDeletion(instant.nodeId, instant.workspaceId, Date.now() - 1_000);

    await runInDurableObject(lifecycle(instant.nodeId), async (instance) => instance.alarm());

    expect(await queuedEntry(instant.nodeId, instant.workspaceId)).toBeUndefined();
    expect(await workspaceRow(instant.workspaceId)).toMatchObject({
      status: 'sleeping',
      error_message: null,
      runtime_deletion_confirmed_at: null,
    });
    expect(await nodeStatus(instant.nodeId)).toBe('sleeping');
    // The container was never destroyed, so the in-place wake still has a runtime to wake.
    expect(await containerLifecycle(instant.nodeId)).not.toBe('stopped');
  });

  it('repairs a stuck row on the next safety-net tick, before its entry is due', async () => {
    const instant = await seedSleptWorkspace('cf-container', 'tick-instant');
    await seedStuckAutomaticDeletion(
      instant.nodeId,
      instant.workspaceId,
      Date.now() + 60 * 60 * 1000
    );

    // The safety net selects the `stopping` row and re-schedules it; the queue repairs it.
    await runSafetyNet();

    expect(await queuedEntry(instant.nodeId, instant.workspaceId)).toBeUndefined();
    expect(await workspaceRow(instant.workspaceId)).toMatchObject({
      status: 'sleeping',
      error_message: null,
    });
  });

  it('leaves an explicit deletion of a slept Instant workspace to converge', async () => {
    const instant = await seedSleptWorkspace('cf-container', 'explicit-instant');
    const expected = await loadWorkspaceDeletionIdentity(env.DATABASE, instant.workspaceId);
    if (!expected) throw new Error('expected a deletion identity');
    expect(expected.workspaceGeneration).toBeNull();
    const stub = lifecycle(instant.nodeId);
    expect(
      await stub.claimWorkspaceDeletionAttempt(
        instant.nodeId,
        instant.workspaceId,
        USER_ID,
        expected,
        'explicit'
      )
    ).toBe('claimed');

    const outcome = await attemptWorkspaceDeletion({
      env: { ...(env as Env), CF_CONTAINER_ENABLED: 'true' },
      expected,
      attempt: 1,
      source: 'test',
      mode: 'explicit',
    });

    expect(outcome.status).toBe('confirmed');
    expect((await workspaceRow(instant.workspaceId))?.status).toBe('deleted');
    expect(await nodeStatus(instant.nodeId)).toBe('deleted');
    expect(await containerLifecycle(instant.nodeId)).toBe('stopped');
  });

  it('does not repair a stopping row whose entry is explicit', async () => {
    const instant = await seedSleptWorkspace('cf-container', 'explicit-entry');
    await seedStuckAutomaticDeletion(
      instant.nodeId,
      instant.workspaceId,
      Date.now() + 60 * 60 * 1000
    );
    await runInDurableObject(lifecycle(instant.nodeId), async (instance) => {
      const key = `ws-delete:${instant.workspaceId}`;
      const entry = await instance.ctx.storage.get<PendingWorkspaceDeletion>(key);
      await instance.ctx.storage.put(key, { ...entry, mode: 'explicit' });
    });

    await runSafetyNet();

    expect(await queuedEntry(instant.nodeId, instant.workspaceId)).toMatchObject({
      mode: 'explicit',
    });
    expect((await workspaceRow(instant.workspaceId))?.status).toBe('stopping');
  });
});
