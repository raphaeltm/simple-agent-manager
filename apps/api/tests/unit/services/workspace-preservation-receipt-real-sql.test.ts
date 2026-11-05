/**
 * Source-artifact cleanup after a pressure eviction, through the real writers on one real
 * SQL engine: snapshot prepare/complete, the eviction callback route, wake completion,
 * the successor's first capture, the preservation check and the deletion attempt.
 *
 * Production 2026-11-05: node 01M6MCE1 evicted three workspaces; every conversation
 * resumed elsewhere, yet no evicted source was ever deleted and the node stayed pinned.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { workspaceEvictionCallbackRoute } from '../../../src/routes/projects/workspace-eviction-callback';
import { emptyResult, resolveCleanupConfig } from '../../../src/scheduled/node-cleanup/shared';
import { sweepStaleStoppedWorkspaces } from '../../../src/scheduled/node-cleanup/workspace-phases';
import {
  evictionRecoveryFenceMatches,
  evictionRecoveryRestoredByRunner,
} from '../../../src/services/session-recovery-eviction';
import { completeSessionSnapshot } from '../../../src/services/session-snapshot-persistence';
import { prepareSessionSnapshot } from '../../../src/services/session-snapshot-prepare';
import { finalizeSessionSnapshotSleeping } from '../../../src/services/session-snapshot-sleep-lifecycle';
import { completeSessionSnapshotRecovery } from '../../../src/services/session-snapshot-wake-outcome';
import { cleanupWorkspaceForDeletion } from '../../../src/services/workspace-cleanup';
import {
  attemptWorkspaceDeletion,
  loadWorkspaceDeletionIdentity,
} from '../../../src/services/workspace-deletion';
import { automaticDeletionPreservationExpiresAt } from '../../../src/services/workspace-deletion-preservation';
import {
  finalizeWorkspaceEvictionInNode,
  type WorkspaceEvictionIdentity,
} from '../../../src/services/workspace-eviction-lifecycle';
import {
  parsePreservationReceipt,
  releaseRestoredSourceWorkspaces,
} from '../../../src/services/workspace-preservation-receipt';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  verifyCallbackToken: vi.fn(),
  stopSession: vi.fn(),
  sleepSession: vi.fn(),
  cleanupWorkspaceActivity: vi.fn(),
  recordActivityEvent: vi.fn(),
  recoverWorkspaceAfterEviction: vi.fn(),
  scheduleWorkspaceDeletion: vi.fn(),
  deleteWorkspaceOnNode: vi.fn(),
}));
vi.mock('../../../src/services/jwt', () => ({ verifyCallbackToken: mocks.verifyCallbackToken }));
vi.mock('../../../src/services/project-data', () => ({
  getSession: vi.fn(async () => null),
  persistMessage: vi.fn(async () => undefined),
  repairFailedSessionForSnapshotRecovery: vi.fn(async () => undefined),
  linkSessionToWorkspace: vi.fn(async () => undefined),
  sleepSession: mocks.sleepSession,
  stopSession: mocks.stopSession,
  cleanupWorkspaceActivity: mocks.cleanupWorkspaceActivity,
  recordActivityEvent: mocks.recordActivityEvent,
}));
vi.mock('../../../src/services/workspace-eviction-recovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/workspace-eviction-recovery')>()),
  recoverWorkspaceAfterEviction: mocks.recoverWorkspaceAfterEviction,
}));
vi.mock('../../../src/services/task-runner-do', () => ({
  ensureTaskRunnerStarted: vi.fn(async () => false),
  startTaskRunnerDO: vi.fn(async () => undefined),
}));
vi.mock('../../../src/services/project-lifecycle-events', () => ({
  recordTaskLifecycleEventBestEffort: vi.fn(async () => undefined),
  isLifecycleTaskStatus: () => true,
}));
vi.mock('../../../src/services/node-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/node-agent')>()),
  deleteWorkspaceOnNode: mocks.deleteWorkspaceOnNode,
}));

const SHA_HOME = 'a'.repeat(64);
const SHA_WIP = 'b'.repeat(64);

function fakeR2() {
  const objects = new Map<string, number>();
  return {
    objects,
    put: vi.fn(async (key: string, value: string) => {
      objects.set(key, value.length);
    }),
    head: vi.fn(async (key: string) =>
      objects.has(key) ? { size: objects.get(key), checksums: {} } : null
    ),
    delete: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    }),
  };
}

describe('evicted source cleanup through real writers and real SQL', () => {
  let sqlite: Database.Database;
  let env: Env;
  let r2: ReturnType<typeof fakeR2>;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyCallbackToken.mockResolvedValue({ scope: 'node', workspace: 'node' });
    mocks.recoverWorkspaceAfterEviction.mockResolvedValue({ status: 'waking', taskId: 'wake' });
    mocks.scheduleWorkspaceDeletion.mockResolvedValue(true);
    mocks.stopSession.mockResolvedValue(undefined);
    mocks.sleepSession.mockResolvedValue(undefined);
    mocks.cleanupWorkspaceActivity.mockResolvedValue(undefined);
    mocks.recordActivityEvent.mockResolvedValue(undefined);
    mocks.deleteWorkspaceOnNode.mockImplementation(
      async (
        _node: string,
        _workspace: string,
        _env: Env,
        _user: string,
        options: { identity: object; beforeExternalMutation?: () => Promise<void> }
      ) => {
        await options.beforeExternalMutation?.();
        return { ...options.identity, physicalDeleted: true, success: true };
      }
    );
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(`
      INSERT INTO nodes (id, user_id, status, health_status, runtime, provider_instance_id, runtime_incarnation_id)
        VALUES ('node', 'user', 'running', 'healthy', 'vm', 'server', 'incarnation'),
               ('target-node', 'user', 'running', 'healthy', 'vm', 'server-2', 'incarnation-2'),
               ('other-node', 'other-user', 'running', 'healthy', 'vm', 'server-3', 'incarnation-3');
      INSERT INTO workspaces (id, user_id, project_id, node_id, chat_session_id, status, eviction_generation, updated_at)
        VALUES ('workspace', 'user', 'project', 'node', 'chat', 'running', 'generation', '2026-11-05T01:00:00.000Z'),
               ('neighbor', 'other-user', 'other-project', 'other-node', 'other-chat', 'running', 'g', '2026-11-05T01:00:00.000Z');
    `);
    r2 = fakeR2();
    let finalizationQueue: Promise<unknown> = Promise.resolve();
    env = {
      DATABASE: createSqliteD1(sqlite),
      R2: r2,
      NODE_LIFECYCLE: {
        idFromName: (name: string) => name,
        get: () => ({
          scheduleWorkspaceDeletion: mocks.scheduleWorkspaceDeletion,
          claimWorkspaceDeletionAttempt: async () => 'claimed',
          confirmWorkspaceDeletion: async () => undefined,
          markIdle: async () => ({ status: 'active' }),
          getWorkspaceDeletionAttemptState: async () => ({ pending: false }),
          finalizeWorkspaceEviction: (identity: WorkspaceEvictionIdentity) => {
            const result = finalizationQueue
              .catch(() => undefined)
              .then(() => finalizeWorkspaceEvictionInNode(env, identity));
            finalizationQueue = result;
            return result;
          },
        }),
      },
    } as unknown as Env;
    app = new Hono<{ Bindings: Env }>();
    app.onError((error, c) =>
      error instanceof AppError
        ? c.json(error.toJSON(), error.statusCode as never)
        : c.json({ error: error.message }, 500)
    );
    app.route('/projects', workspaceEvictionCallbackRoute);
  });
  afterEach(() => sqlite.close());

  const db = () => drizzle(env.DATABASE, { schema });

  /** The VM agent's prepare → upload → complete for one capture of the conversation. */
  async function capture(workspaceId: string, nodeId: string, quiesced: boolean) {
    const prepared = await prepareSessionSnapshot(db(), env, {
      workspaceId,
      nodeId,
      projectId: 'project',
      userId: 'user',
      chatSessionId: 'chat',
      agentSessionId: null,
      runtime: 'vm',
    });
    r2.objects.set(prepared.keys.home, 10);
    r2.objects.set(prepared.keys.wip, 20);
    await completeSessionSnapshot(db(), env, {
      workspaceId,
      chatSessionId: 'chat',
      agentSessionId: null,
      runtime: 'vm',
      baseCommit: null,
      status: 'available',
      degradation: 'none',
      captureGeneration: prepared.generation,
      artifactSha256: { homeSha256: SHA_HOME, wipSha256: SHA_WIP },
      artifactSizes: { homeBytes: 10, wipBytes: 20 },
      manifest: {
        version: 1,
        chatSessionId: 'chat',
        workspaceId,
        status: 'available',
        degradation: 'none',
        skipped: [],
        artifacts: {
          home: { sizeBytes: 10, sha256: SHA_HOME },
          wip: { sizeBytes: 20, sha256: SHA_WIP },
        },
        createdAt: '2026-11-05T01:00:00Z',
      } as never,
      quiesced,
    });
    return prepared;
  }

  async function evict() {
    const response = await app.fetch(
      new Request('https://api.test/projects/project/workspaces/workspace/eviction', {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId: 'node',
          workspaceId: 'workspace',
          reason: 'memory_pressure',
          snapshotCaptured: true,
          containerStopped: true,
          evictionGeneration: 'generation',
        }),
      }),
      env,
      { waitUntil: () => undefined } as unknown as ExecutionContext
    );
    if (response.status !== 204)
      throw new Error(`eviction ${response.status}: ${await response.text()}`);
  }

  /** The wake claimed the snapshot (claimSessionSnapshotRecovery) and released the binding. */
  async function wakeOnto(target: string) {
    sqlite.exec(`
      INSERT INTO workspaces (id, user_id, project_id, node_id, chat_session_id, status, eviction_generation)
        VALUES ('${target}', 'user', 'project', 'target-node', NULL, 'running', 'target-generation');
      UPDATE session_snapshots SET recovery_status = 'waking', recovery_task_id = 'wake-task';
      UPDATE workspaces SET chat_session_id = NULL WHERE id = 'workspace';
      UPDATE workspaces SET chat_session_id = 'chat' WHERE id = '${target}';
    `);
    expect(await completeSessionSnapshotRecovery(db(), 'chat', 'wake-task', target)).toBe(true);
  }

  const receipt = () =>
    parsePreservationReceipt(
      (
        sqlite
          .prepare('SELECT preservation_receipt_json AS r FROM workspaces WHERE id = ?')
          .get('workspace') as { r: string | null }
      ).r
    );

  async function sourcePreservation() {
    const identity = await loadWorkspaceDeletionIdentity(env.DATABASE, 'workspace');
    if (!identity) throw new Error('source workspace missing');
    return automaticDeletionPreservationExpiresAt(env, identity);
  }

  it('a quiesced final capture grants a durable receipt; the source is released only by a restore', async () => {
    await capture('workspace', 'node', false); // live pre-stop capture
    const final = await capture('workspace', 'node', true); // final capture after docker stop
    await evict();

    const row = sqlite
      .prepare(
        'SELECT cleanup_identity_json AS identity, sleep_status AS sleep FROM session_snapshots'
      )
      .get() as { identity: string; sleep: string };
    expect(JSON.parse(row.identity)).toMatchObject({
      snapshotGeneration: final.generation,
      quiesced: 1,
      preserved: 1,
    });
    expect(receipt()).toMatchObject({
      reason: 'quiesced_eviction',
      snapshotGeneration: final.generation,
      workspaceId: 'workspace',
      nodeId: 'node',
      nodeRuntimeIncarnationId: 'incarnation',
      workspaceGeneration: 'generation',
    });
    // Staging 2026-11-05: releasing the source before its wake committed failed the wake's
    // eviction fence. Until a replacement restores this generation the source anchors it.
    expect(await sourcePreservation()).toBeNull();
    await wakeOnto('target');
    await releaseRestoredSourceWorkspaces(env, {
      chatSessionId: 'chat',
      restoredWorkspaceId: 'target',
    });
    expect(await sourcePreservation()).not.toBeNull();
  });

  it('a live-only eviction capture never grants preservation (control)', async () => {
    await capture('workspace', 'node', false);
    await evict();

    const row = sqlite
      .prepare(
        'SELECT cleanup_identity_json AS identity, sleeping_at AS sleepingAt FROM session_snapshots'
      )
      .get() as { identity: string; sleepingAt: string | null };
    expect(row.sleepingAt).not.toBeNull(); // still relocatable from the live capture
    expect(JSON.parse(row.identity).preserved).toBeUndefined();
    expect(receipt()).toBeNull();
    expect(await sourcePreservation()).toBeNull();
  });

  it('the source stays deletable after the successor rewrites the snapshot row (restored receipt)', async () => {
    await capture('workspace', 'node', true);
    await evict();
    await wakeOnto('target');
    expect(
      await releaseRestoredSourceWorkspaces(env, {
        chatSessionId: 'chat',
        restoredWorkspaceId: 'target',
      })
    ).toBe(1);
    expect(mocks.scheduleWorkspaceDeletion).toHaveBeenCalledWith(
      'node',
      'workspace',
      'user',
      expect.objectContaining({ retryAfterMs: 0, onlyIfAbsent: true })
    );
    expect(receipt()?.restoredWorkspaceId).toBe('target');

    // The successor's first capture rewrites the per-chat row and deletes the old objects.
    const sourceKeys = [...r2.objects.keys()];
    await capture('target', 'target-node', false);
    expect(sourceKeys.every((key) => !r2.objects.has(key))).toBe(true);
    expect(sqlite.prepare('SELECT workspace_id AS w FROM session_snapshots').get()).toEqual({
      w: 'target',
    });

    expect(await sourcePreservation()).not.toBeNull();
  });

  it('without the restore record the rewritten row strands the source (incident control)', async () => {
    await capture('workspace', 'node', true);
    await evict();
    await wakeOnto('target');
    // No releaseRestoredSourceWorkspaces: the pre-fix state of every evicted source.
    await capture('target', 'target-node', false);
    expect(await sourcePreservation()).toBeNull();
  });

  it('a restore of a different generation does not stamp the receipt', async () => {
    await capture('workspace', 'node', true);
    await evict();
    await wakeOnto('target');
    sqlite.exec("UPDATE session_snapshots SET snapshot_generation = 'some-other-generation'");
    expect(
      await releaseRestoredSourceWorkspaces(env, {
        chatSessionId: 'chat',
        restoredWorkspaceId: 'target',
      })
    ).toBe(0);
    expect(receipt()?.restoredAt ?? null).toBeNull();
  });

  it.each([
    [
      'the workspace restarted (generation changed)',
      "UPDATE workspaces SET eviction_generation = 'generation-2' WHERE id = 'workspace'",
    ],
    [
      'the node was re-provisioned (incarnation changed)',
      "UPDATE nodes SET runtime_incarnation_id = 'incarnation-new' WHERE id = 'node'",
    ],
    [
      'the workspace moved to another project',
      "UPDATE workspaces SET project_id = 'project-2' WHERE id = 'workspace'",
    ],
  ])('a receipt is refused when %s', async (_case, sql) => {
    await capture('workspace', 'node', true);
    await evict();
    await wakeOnto('target');
    await releaseRestoredSourceWorkspaces(env, {
      chatSessionId: 'chat',
      restoredWorkspaceId: 'target',
    });
    sqlite.exec(sql);
    expect(await sourcePreservation()).toBeNull();
  });

  it('an unrestored eviction receipt never releases its source, through either path', async () => {
    await capture('workspace', 'node', true);
    await evict();
    // Verified artifacts, the eviction's sleeping row and a valid receipt: still anchored.
    expect(await sourcePreservation()).toBeNull();
    sqlite.exec("UPDATE session_snapshots SET workspace_id = 'elsewhere'");
    expect(await sourcePreservation()).toBeNull();
  });

  it('the stopped-workspace sweep leaves an unrestored evicted source to its wake', async () => {
    // The fixture helper does not apply column defaults; the sweep excludes non-managed nodes.
    sqlite.exec("UPDATE nodes SET node_class = 'managed'");
    await capture('workspace', 'node', true);
    await evict();
    const sweep = async () => {
      mocks.scheduleWorkspaceDeletion.mockClear();
      await sweepStaleStoppedWorkspaces(
        db(),
        env,
        new Date('2099-01-01T00:00:00Z'),
        resolveCleanupConfig(env),
        emptyResult()
      );
      return mocks.scheduleWorkspaceDeletion.mock.calls.map((call) => call[1]);
    };
    // Refused by the queue anyway; selecting it would pin the head of the bounded page.
    expect(await sweep()).toEqual([]);
    await wakeOnto('target');
    // Restored (snapshot row): selectable.
    expect(await sweep()).toEqual(['workspace']);
    await releaseRestoredSourceWorkspaces(env, {
      chatSessionId: 'chat',
      restoredWorkspaceId: 'target',
    });
    await capture('target', 'target-node', false);
    // The successor moved the row; the receipt's restoredAt still selects it.
    expect(await sweep()).toEqual(['workspace']);
  });

  it('a restore stamped at commit survives a lost release and the successor moving the row', async () => {
    sqlite.exec("UPDATE nodes SET node_class = 'managed'");
    await capture('workspace', 'node', true);
    await evict();
    await wakeOnto('target');
    // The TaskRunner stamps right after the restore commits; then the release is lost.
    expect(
      await releaseRestoredSourceWorkspaces(env, {
        chatSessionId: 'chat',
        restoredWorkspaceId: 'target',
        stampOnly: true,
      })
    ).toBe(1);
    expect(mocks.scheduleWorkspaceDeletion).not.toHaveBeenCalled();
    const stampedAt = receipt()?.restoredAt;
    expect(stampedAt).toBeTruthy();
    // The release, when it does run, re-matches and keeps the first stamp.
    expect(
      await releaseRestoredSourceWorkspaces(env, {
        chatSessionId: 'chat',
        restoredWorkspaceId: 'target',
      })
    ).toBe(1);
    expect(receipt()?.restoredAt).toBe(stampedAt);
    mocks.scheduleWorkspaceDeletion.mockClear();
    // Without that release, the successor's first capture moves the row away.
    await capture('target', 'target-node', false);
    expect(await sourcePreservation()).not.toBeNull();
    await sweepStaleStoppedWorkspaces(
      db(),
      env,
      new Date('2099-01-01T00:00:00Z'),
      resolveCleanupConfig(env),
      emptyResult()
    );
    expect(mocks.scheduleWorkspaceDeletion.mock.calls.map((call) => call[1])).toEqual([
      'workspace',
    ]);
  });

  it('the eviction fence accepts only the wake that restored the snapshot', async () => {
    await capture('workspace', 'node', true);
    await evict();
    const fence = { workspaceId: 'workspace', nodeId: 'node', generation: 'generation' };
    const runner = { taskId: 'wake-task', workspaceId: 'target', recoveryAttemptId: null };
    expect(await evictionRecoveryFenceMatches(env, fence)).toBe(true);
    // Claimed but not yet restored: the fence alone decides.
    sqlite.exec(`
      INSERT INTO workspaces (id, user_id, project_id, node_id, chat_session_id, status)
        VALUES ('target', 'user', 'project', 'target-node', 'chat', 'running');
      UPDATE session_snapshots SET recovery_status = 'waking', recovery_task_id = 'wake-task';
    `);
    expect(await evictionRecoveryRestoredByRunner(env, runner)).toBe(false);
    expect(await completeSessionSnapshotRecovery(db(), 'chat', 'wake-task', 'target')).toBe(true);
    sqlite.exec("UPDATE workspaces SET status = 'deleted' WHERE id = 'workspace'");
    expect(await evictionRecoveryFenceMatches(env, fence)).toBe(false);
    expect(await evictionRecoveryRestoredByRunner(env, runner)).toBe(true);
    // Another task, another workspace, or another wake attempt is not this restore.
    expect(await evictionRecoveryRestoredByRunner(env, { ...runner, taskId: 'other' })).toBe(false);
    expect(
      await evictionRecoveryRestoredByRunner(env, { ...runner, workspaceId: 'workspace' })
    ).toBe(false);
    expect(
      await evictionRecoveryRestoredByRunner(env, { ...runner, recoveryAttemptId: 'attempt-2' })
    ).toBe(false);
  });

  it('without a receipt, the eviction snapshot row also waits for a restore (legacy path)', async () => {
    await capture('workspace', 'node', true);
    await evict();
    // A row preserved before receipts existed, or a receipt write that was lost.
    sqlite.exec("UPDATE workspaces SET preservation_receipt_json = NULL WHERE id = 'workspace'");
    expect(await sourcePreservation()).toBeNull();
    await wakeOnto('target');
    expect(await sourcePreservation()).not.toBeNull();
  });

  it('an unrestored sleep receipt needs its artifacts and an unexpired bound', async () => {
    await capture('workspace', 'node', true);
    await evict();
    // Isolate the receipt path: a sleep receipt, and the per-chat row moved away.
    sqlite.exec(
      "UPDATE workspaces SET preservation_receipt_json = json_set(preservation_receipt_json, '$.reason', 'sleep')"
    );
    sqlite.exec("UPDATE session_snapshots SET workspace_id = 'elsewhere'");
    expect(await sourcePreservation()).not.toBeNull();
    const home = receipt()?.homeR2Key ?? '';
    r2.objects.delete(home);
    expect(await sourcePreservation()).toBeNull();
    r2.objects.set(home, 10);
    sqlite.exec(
      "UPDATE workspaces SET preservation_receipt_json = json_set(preservation_receipt_json, '$.expiresAt', '2000-01-01T00:00:00Z')"
    );
    expect(await sourcePreservation()).toBeNull();
  });

  it('deletes the evicted source with proof after its chat moved, and never touches the successor', async () => {
    await capture('workspace', 'node', true);
    const queued = await loadWorkspaceDeletionIdentity(env.DATABASE, 'workspace'); // chat still bound
    await evict();
    await wakeOnto('target');
    await releaseRestoredSourceWorkspaces(env, {
      chatSessionId: 'chat',
      restoredWorkspaceId: 'target',
    });
    await capture('target', 'target-node', false);
    mocks.stopSession.mockClear();

    const outcome = await attemptWorkspaceDeletion({
      env,
      expected: { ...queued!, chatSessionId: 'chat' }, // identity captured before the wake
      attempt: 1,
      source: 'test',
      mode: 'automatic',
    });

    expect(outcome).toMatchObject({ status: 'confirmed', proof: 'vm_agent_confirmed' });
    expect(mocks.deleteWorkspaceOnNode).toHaveBeenCalledOnce();
    expect(
      sqlite
        .prepare('SELECT status, runtime_deletion_proof AS proof FROM workspaces WHERE id = ?')
        .get('workspace')
    ).toEqual({ status: 'deleted', proof: 'vm_agent_confirmed' });
    expect(mocks.stopSession).not.toHaveBeenCalled();
    expect(
      sqlite
        .prepare('SELECT status, chat_session_id AS chat FROM workspaces WHERE id = ?')
        .get('target')
    ).toEqual({ status: 'running', chat: 'chat' });
    expect(sqlite.prepare('SELECT status FROM workspaces WHERE id = ?').get('neighbor')).toEqual({
      status: 'running',
    });
  });

  it.each([
    [
      'rebound to a different chat',
      "UPDATE workspaces SET chat_session_id = 'other-chat' WHERE id = 'workspace'",
      'chat',
    ],
    [
      'bound after being queued unbound',
      "UPDATE workspaces SET chat_session_id = 'chat' WHERE id = 'workspace'",
      null,
    ],
  ] as const)(
    'a source %s is still fenced (directional control)',
    async (_case, sql, queuedChat) => {
      await capture('workspace', 'node', true);
      await evict();
      await wakeOnto('target');
      await releaseRestoredSourceWorkspaces(env, {
        chatSessionId: 'chat',
        restoredWorkspaceId: 'target',
      });
      const queued = await loadWorkspaceDeletionIdentity(env.DATABASE, 'workspace');
      sqlite.exec(sql);

      const outcome = await attemptWorkspaceDeletion({
        env,
        expected: { ...queued!, chatSessionId: queuedChat },
        attempt: 1,
        source: 'test',
        mode: 'automatic',
      });

      expect(outcome.status).toBe('fenced');
      expect(mocks.deleteWorkspaceOnNode).not.toHaveBeenCalled();
    }
  );

  it('a verified full sleep writes the receipt; a fallback sleep does not', async () => {
    for (const [fallback, expected] of [
      [true, null],
      [false, 'sleep'],
    ] as const) {
      const prepared = await capture('workspace', 'node', false);
      sqlite.exec(
        "UPDATE session_snapshots SET sleep_status = 'stopping', sleep_claim_id = 'claim', sleeping_at = NULL, sleep_fallback_json = json_object('outcome','slept','recoveryPoint','x')"
      );
      await finalizeSessionSnapshotSleeping(db(), env, 'chat', 'claim', new Date(), {
        expectedGeneration: prepared.generation,
        fallback,
      });
      expect(receipt()?.reason ?? null).toBe(expected);
      sqlite.exec(
        'UPDATE session_snapshots SET sleep_status = NULL, sleeping_at = NULL, sleep_fallback_json = NULL'
      );
    }
  });

  it('end to end through the real eviction recovery and wake writers', async () => {
    sqlite.exec(`
      INSERT INTO users (id, name, email, github_id, status) VALUES ('user', 'User', 'u@example.com', 'gh-u', 'active');
      INSERT INTO credentials (id, user_id, provider, credential_type, credential_kind, is_active, encrypted_token, iv, created_at, updated_at)
        VALUES ('credential', 'user', 'hetzner', 'cloud-provider', 'api-key', 1, 'encrypted', 'iv', '2026-11-05T00:00:00Z', '2026-11-05T00:00:00Z');
      INSERT INTO projects (id, name, repository, installation_id, default_branch, created_by, created_at, updated_at)
        VALUES ('project', 'Project', 'owner/repo', 'install', 'main', 'user', '2026-11-05T00:00:00Z', '2026-11-05T00:00:00Z');
      INSERT INTO project_members (project_id, user_id, role, status) VALUES ('project', 'user', 'owner', 'active');
      INSERT INTO tasks (id, project_id, user_id, chat_session_id, workspace_id, title, description, status, priority, task_mode, dispatch_depth, created_by, created_at, updated_at)
        VALUES ('conversation', 'project', 'user', 'chat', 'workspace', 'Conversation', 'Work', 'sleeping', 0, 'conversation', 0, 'user', '2026-11-05T00:00:00Z', '2026-11-05T00:00:00Z');
    `);
    await capture('workspace', 'node', false); // live pre-stop capture
    await capture('workspace', 'node', true); // final capture after docker stop
    const queued = await loadWorkspaceDeletionIdentity(env.DATABASE, 'workspace');
    await evict();

    // The eviction callback's own recovery entry point (mocked for the route above).
    const { recoverWorkspaceAfterEviction } = await vi.importActual<
      typeof import('../../../src/services/workspace-eviction-recovery')
    >('../../../src/services/workspace-eviction-recovery');
    expect(
      await recoverWorkspaceAfterEviction(env, {
        projectId: 'project',
        workspaceId: 'workspace',
        chatSessionId: 'chat',
        nodeId: 'node',
        generation: 'generation',
      })
    ).toMatchObject({ status: 'waking' });
    // What the real wake writer left: the source unbound, the snapshot claimed.
    expect(
      sqlite
        .prepare(
          "SELECT w.chat_session_id AS chat, s.recovery_status AS recovery, s.recovery_task_id AS task FROM workspaces w JOIN session_snapshots s ON s.workspace_id = w.id WHERE w.id = 'workspace'"
        )
        .get()
    ).toEqual({ chat: null, recovery: 'waking', task: 'conversation' });

    // The TaskRunner places the replacement and binds the chat (outside this slice).
    sqlite.exec(`INSERT INTO workspaces (id, user_id, project_id, node_id, chat_session_id, status, eviction_generation)
      VALUES ('target', 'user', 'project', 'target-node', 'chat', 'running', 'target-generation')`);
    expect(await completeSessionSnapshotRecovery(db(), 'chat', 'conversation', 'target')).toBe(
      true
    );
    expect(
      await releaseRestoredSourceWorkspaces(env, {
        chatSessionId: 'chat',
        restoredWorkspaceId: 'target',
      })
    ).toBe(1);
    await capture('target', 'target-node', false); // successor's first capture

    const outcome = await attemptWorkspaceDeletion({
      env,
      expected: queued!,
      attempt: 1,
      source: 'test',
      mode: 'automatic',
    });
    expect(outcome).toMatchObject({ status: 'confirmed', proof: 'vm_agent_confirmed' });
    expect(mocks.stopSession).not.toHaveBeenCalledWith(
      expect.anything(),
      'project',
      'chat',
      expect.anything()
    );
    expect(
      sqlite
        .prepare("SELECT chat_session_id AS chat, status FROM workspaces WHERE id = 'target'")
        .get()
    ).toEqual({
      chat: 'chat',
      status: 'running',
    });
  });

  it('a lost deletion response leaves the workspace stopping and the retry reaches proof', async () => {
    await capture('workspace', 'node', true);
    await evict();
    await wakeOnto('target');
    await releaseRestoredSourceWorkspaces(env, {
      chatSessionId: 'chat',
      restoredWorkspaceId: 'target',
    });
    const queued = await loadWorkspaceDeletionIdentity(env.DATABASE, 'workspace');
    // The VM deleted everything, but the response never arrived.
    mocks.deleteWorkspaceOnNode.mockRejectedValueOnce(new Error('Request timed out after 5000ms'));
    const first = await attemptWorkspaceDeletion({
      env,
      expected: { ...queued!, chatSessionId: 'chat' },
      attempt: 1,
      source: 'test',
      mode: 'automatic',
    });
    expect(first.status).toBe('retry');
    expect(
      sqlite
        .prepare(
          "SELECT status, runtime_deletion_proof AS proof FROM workspaces WHERE id = 'workspace'"
        )
        .get()
    ).toEqual({
      status: 'stopping',
      proof: null,
    });
    // The retry reaches the VM's durable tombstone, which answers success idempotently.
    const second = await attemptWorkspaceDeletion({
      env,
      expected: { ...queued!, chatSessionId: 'chat' },
      attempt: 2,
      source: 'test',
      mode: 'automatic',
    });
    expect(second).toMatchObject({ status: 'confirmed', proof: 'vm_agent_confirmed' });
  });

  it.each([
    ['released by a wake', null, 'confirmed'],
    ['rebound to another chat (control)', 'other-chat', 'fenced'],
  ] as const)(
    'automatic cleanup from a row read before the binding was %s',
    async (_case, currentChat, expected) => {
      await capture('workspace', 'node', true);
      await evict();
      await wakeOnto('target');
      await releaseRestoredSourceWorkspaces(env, {
        chatSessionId: 'chat',
        restoredWorkspaceId: 'target',
      });
      // A sweep read the row while it was still bound (terminal-node-lifecycle-repair, trial-expire).
      const stale = (await db().query.workspaces.findFirst({
        where: (w, { eq }) => eq(w.id, 'workspace'),
      }))!;
      sqlite
        .prepare("UPDATE workspaces SET chat_session_id = ? WHERE id = 'workspace'")
        .run(currentChat);
      const outcome = await cleanupWorkspaceForDeletion({
        db: db(),
        env,
        workspace: { ...stale, chatSessionId: 'chat' },
        userId: 'user',
        mode: 'automatic',
        deleteConfirmedRow: false,
      });
      expect(outcome.status).toBe(expected);
      expect(mocks.deleteWorkspaceOnNode).toHaveBeenCalledTimes(expected === 'confirmed' ? 1 : 0);
    }
  );

  it('backfills the receipt for a workspace preserved before receipts existed', async () => {
    const prepared = await capture('workspace', 'node', false);
    sqlite.exec(
      "UPDATE workspaces SET status = 'sleeping'; UPDATE session_snapshots SET sleep_status = 'stopping', sleep_claim_id = 'claim'"
    );
    await finalizeSessionSnapshotSleeping(db(), env, 'chat', 'claim', new Date(), {
      expectedGeneration: prepared.generation,
    });
    // Rows slept before migration 0224 carry the grant but no receipt.
    sqlite.exec('UPDATE workspaces SET preservation_receipt_json = NULL');

    expect(await sourcePreservation()).not.toBeNull(); // legacy snapshot-row path
    expect(receipt()).toMatchObject({ reason: 'sleep', snapshotGeneration: prepared.generation });

    // The backfilled receipt then survives a wake and the successor's first capture.
    await wakeOnto('target');
    expect(
      await releaseRestoredSourceWorkspaces(env, {
        chatSessionId: 'chat',
        restoredWorkspaceId: 'target',
      })
    ).toBe(1);
    await capture('target', 'target-node', false);
    expect(await sourcePreservation()).not.toBeNull();
  });
});
