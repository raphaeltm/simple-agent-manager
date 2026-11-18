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
 * The guarded paths each have a sleeping VM control: a sleeping VM must still release its VM.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { workspaceDeletionDueIndexKey } from '../../src/durable-objects/node-lifecycle-workspace-deletion';
import {
  claimWorkspaceDeletionInD1,
  type NodeLifecycleDeletionEnv,
  type PendingWorkspaceDeletion,
} from '../../src/durable-objects/node-lifecycle-workspace-deletion-support';
import {
  keepWakeTarget,
  releaseExactAutomaticEntry,
} from '../../src/durable-objects/node-lifecycle-workspace-deletion-wake-target';
import type { Env } from '../../src/env';
import { emptyResult, resolveCleanupConfig } from '../../src/scheduled/node-cleanup/shared';
import { sweepStaleStoppedWorkspaces } from '../../src/scheduled/node-cleanup/workspace-phases';
import { findWakeableSleepingInstant } from '../../src/services/instant-sleeping-deletion-guard';
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

async function enableContainers(nodeId: string): Promise<void> {
  await runInDurableObject(lifecycle(nodeId), async (instance) => {
    (instance.env as unknown as Record<string, string>).CF_CONTAINER_ENABLED = 'true';
  });
}

/** The alarm dispatches attempts through `waitUntil`; give them time to land before asserting. */
async function settleDispatchedAttempts(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('which workspaces count as a wakeable sleeping Instant', () => {
  it('is the slept Instant workspace with its sleeping snapshot (control)', async () => {
    const instant = await seedSleptWorkspace('cf-container', 'pred-instant');
    expect(await findWakeableSleepingInstant(env.DATABASE, instant.workspaceId)).toMatchObject({
      status: 'sleeping',
    });
  });

  it.each([
    ['a sleeping VM workspace', 'vm', null],
    [
      'an Instant workspace with no snapshot',
      'cf-container',
      `DELETE FROM session_snapshots WHERE workspace_id = ?1`,
    ],
    [
      'an Instant workspace whose snapshot belongs to another chat',
      'cf-container',
      `UPDATE session_snapshots SET chat_session_id = 'other-chat' WHERE workspace_id = ?1`,
    ],
    [
      'an Instant workspace whose snapshot is awake',
      'cf-container',
      `UPDATE session_snapshots SET sleep_status = NULL WHERE workspace_id = ?1`,
    ],
    [
      'an Instant workspace whose node is not sleeping',
      'cf-container',
      `UPDATE nodes SET status = 'running' WHERE id = (SELECT node_id FROM workspaces WHERE id = ?1)`,
    ],
    [
      'an Instant workspace whose container termination is confirmed',
      'cf-container',
      `UPDATE nodes SET runtime_termination_confirmed_at = '2026-01-02T00:00:00.000Z'
        WHERE id = (SELECT node_id FROM workspaces WHERE id = ?1)`,
    ],
    [
      'an Instant workspace whose snapshot expired',
      'cf-container',
      `UPDATE session_snapshots SET expires_at = '2020-01-01T00:00:00.000Z' WHERE workspace_id = ?1`,
    ],
    [
      'an Instant workspace whose snapshot expiry is unparseable',
      'cf-container',
      `UPDATE session_snapshots SET expires_at = 'not-a-timestamp' WHERE workspace_id = ?1`,
    ],
    [
      'an Instant workspace stopping for a reason other than deletion',
      'cf-container',
      `UPDATE workspaces SET status = 'stopping', error_message = 'Managed node stop' WHERE id = ?1`,
    ],
  ] as const)('is not %s', async (_case, runtime, mutation) => {
    const suffix = `pred-${_case.length}-${runtime}`;
    const seeded = await seedSleptWorkspace(runtime, suffix);
    if (mutation) await env.DATABASE.prepare(mutation).bind(seeded.workspaceId).run();

    expect(await findWakeableSleepingInstant(env.DATABASE, seeded.workspaceId)).toBeNull();
  });
});

describe('the stale-workspace safety net and a sleeping Instant workspace', () => {
  it('leaves a sleeping Instant workspace asleep and wakeable', async () => {
    const instant = await seedSleptWorkspace('cf-container', 'net-instant');

    await runSafetyNet();

    // D1 is shared across this file, so assert on this workspace rather than sweep totals.
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

    await runSafetyNet();

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
    // Containers enabled, so a deletion that got past the guard would reach the container DO
    // and the `not.toBe('stopped')` assertion below can fail.
    await enableContainers(instant.nodeId);

    await runInDurableObject(lifecycle(instant.nodeId), async (instance) => instance.alarm());
    await settleDispatchedAttempts();

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

  it('still attempts a due automatic deletion of a stuck VM workspace (control)', async () => {
    const vm = await seedSleptWorkspace('vm', 'due-vm');
    await seedStuckAutomaticDeletion(vm.nodeId, vm.workspaceId, Date.now() - 1_000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Network connection lost.');
      })
    );

    await runInDurableObject(lifecycle(vm.nodeId), async (instance) => instance.alarm());
    await settleDispatchedAttempts();

    // The guard left it alone: the queue claimed attempt 9 rather than handing the row back.
    expect(await queuedEntry(vm.nodeId, vm.workspaceId)).toMatchObject({ attemptCount: 9 });
    expect((await workspaceRow(vm.workspaceId))?.status).toBe('stopping');
  });

  it('never reverts a claim that lands while it reads the row', async () => {
    const instant = await seedSleptWorkspace('cf-container', 'race-claim');
    await seedStuckAutomaticDeletion(instant.nodeId, instant.workspaceId, Date.now() - 1_000);
    const expected = await loadWorkspaceDeletionIdentity(env.DATABASE, instant.workspaceId);
    if (!expected) throw new Error('expected a deletion identity');
    const claimDiagnostic = 'Workspace deletion unconfirmed: durable attempt 9 claimed';

    const kept = await keepWakeTarget(
      env as unknown as NodeLifecycleDeletionEnv,
      undefined,
      instant.workspaceId,
      async () => {
        // A newer claim lands in the await gap, through the real claim writer.
        expect(
          await claimWorkspaceDeletionInD1(
            env as unknown as NodeLifecycleDeletionEnv,
            expected,
            9,
            claimDiagnostic,
            'automatic'
          )
        ).toBe(true);
        return true;
      }
    );

    expect(kept).toBe(true);
    expect(await workspaceRow(instant.workspaceId)).toMatchObject({
      status: 'stopping',
      error_message: claimDiagnostic,
    });
  });

  it('leaves the row alone when its queue entry was replaced', async () => {
    const instant = await seedSleptWorkspace('cf-container', 'race-entry');
    await seedStuckAutomaticDeletion(instant.nodeId, instant.workspaceId, Date.now() - 1_000);

    const kept = await keepWakeTarget(
      env as unknown as NodeLifecycleDeletionEnv,
      undefined,
      instant.workspaceId,
      async () => false
    );

    expect(kept).toBe(true);
    expect(await workspaceRow(instant.workspaceId)).toMatchObject({
      status: 'stopping',
      error_message: STUCK_DIAGNOSTIC,
    });
  });

  it('repairs a stuck row with no queue entry left on the next safety-net tick', async () => {
    // A restore that failed after its entry was released leaves exactly this: the row still
    // stopping, nothing queued. The safety net re-selects it, and the queue repairs it then.
    const instant = await seedSleptWorkspace('cf-container', 'tick-orphan');
    await env.DATABASE.prepare(
      `UPDATE workspaces SET status = 'stopping', error_message = ? WHERE id = ?`
    )
      .bind(STUCK_DIAGNOSTIC, instant.workspaceId)
      .run();

    await runSafetyNet();

    expect(await queuedEntry(instant.nodeId, instant.workspaceId)).toBeUndefined();
    expect(await workspaceRow(instant.workspaceId)).toMatchObject({
      status: 'sleeping',
      error_message: null,
    });
  });

  it('releases only the exact entry it judged, never a newer claim that replaced it', async () => {
    const instant = await seedSleptWorkspace('cf-container', 'release-exact');
    await seedStuckAutomaticDeletion(instant.nodeId, instant.workspaceId, Date.now() - 1_000);
    const key = `ws-delete:${instant.workspaceId}`;

    const outcome = await runInDurableObject(lifecycle(instant.nodeId), async (instance) => {
      const storage = instance.ctx.storage;
      const judged = await storage.get<PendingWorkspaceDeletion>(key);
      if (!judged) throw new Error('expected the stuck entry');
      // A newer attempt claims the same key between the read and the release.
      const newer = { ...judged, attemptCount: 9, claimId: 'newer-claim' };
      await storage.put(key, newer);
      const kept = await keepWakeTarget(
        env as unknown as NodeLifecycleDeletionEnv,
        judged,
        instant.workspaceId,
        () => releaseExactAutomaticEntry(storage, key, judged)
      );
      return { kept, stored: await storage.get<PendingWorkspaceDeletion>(key) };
    });

    expect(outcome.kept).toBe(true);
    expect(outcome.stored).toMatchObject({ claimId: 'newer-claim', attemptCount: 9 });
    expect(await workspaceRow(instant.workspaceId)).toMatchObject({
      status: 'stopping',
      error_message: STUCK_DIAGNOSTIC,
    });
  });

  it('releases the exact entry it judged when nothing replaced it (control)', async () => {
    const instant = await seedSleptWorkspace('cf-container', 'release-same');
    await seedStuckAutomaticDeletion(instant.nodeId, instant.workspaceId, Date.now() - 1_000);
    const key = `ws-delete:${instant.workspaceId}`;

    const released = await runInDurableObject(lifecycle(instant.nodeId), async (instance) => {
      const judged = await instance.ctx.storage.get<PendingWorkspaceDeletion>(key);
      return releaseExactAutomaticEntry(instance.ctx.storage, key, judged);
    });

    expect(released).toBe(true);
    expect(await queuedEntry(instant.nodeId, instant.workspaceId)).toBeUndefined();
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
