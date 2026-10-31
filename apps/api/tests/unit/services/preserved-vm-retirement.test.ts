import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { NodeLifecycleWorkspaceDeletionQueue } from '../../../src/durable-objects/node-lifecycle-workspace-deletion';
import type { PendingWorkspaceDeletion } from '../../../src/durable-objects/node-lifecycle-workspace-deletion-support';
import type { Env } from '../../../src/env';
import {
  sweepIncompatibleVmAgentNodes,
  sweepStoppedHandoffNodes,
} from '../../../src/scheduled/node-cleanup/node-phases';
import {
  claimNodeForCleanup,
  emptyResult,
  resolveCleanupConfig,
} from '../../../src/scheduled/node-cleanup/shared';
import { preparePreservedVmRetirement } from '../../../src/services/preserved-vm-retirement';
import { repairRetiredVmSleepSnapshots } from '../../../src/services/retired-vm-sleep-repair';
import { buildSessionSnapshotR2Key } from '../../../src/services/session-snapshot-artifacts';
import { deleteNodeResourcesStrict } from '../../../src/services/strict-node-deletion';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const boundary = vi.hoisted(() => ({
  remove: vi.fn(),
  resolve: vi.fn(),
  finalize: vi.fn(),
  chat: vi.fn(),
  message: vi.fn(),
}));
vi.mock('../../../src/services/provider-credentials', async (actual) => ({
  ...(await actual<typeof import('../../../src/services/provider-credentials')>()),
  createProviderForUser: boundary.resolve,
}));
vi.mock('../../../src/services/project-data', () => ({
  getSession: boundary.chat,
  persistMessage: boundary.message,
}));
vi.mock('../../../src/services/observability', () => ({ persistError: vi.fn() }));
vi.mock('../../../src/services/workspace-lifecycle-finalizer', () => ({
  finalizeWorkspaceLifecycleClosure: boundary.finalize,
}));

describe('legacy VM retirement: real SQL, snapshot verifier and strict provider boundary', () => {
  let sqlite: Database.Database;
  let env: Env;
  let artifacts: Map<string, { size: number }>;
  let head: ReturnType<typeof vi.fn>;
  const now = () => new Date();
  beforeEach(() => {
    vi.resetAllMocks();
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    artifacts = new Map();
    head = vi.fn(async (key: string) =>
      artifacts.has(key) ? { ...artifacts.get(key), checksums: {} } : null
    );
    env = {
      DATABASE: createSqliteD1(sqlite),
      R2: { head },
      ENCRYPTION_KEY: 'test-key',
      VM_AGENT_REQUIRED_VERSION: 'new-agent',
      NODE_WORKSPACE_IDLE_TIMEOUT_MS: '1000',
    } as unknown as Env;
    boundary.resolve.mockResolvedValue({
      providerName: 'hetzner',
      provider: { deleteVM: boundary.remove },
    });
    sqlite.exec(`INSERT INTO nodes(id,user_id,status,node_role,node_class,runtime,provider_instance_id,runtime_incarnation_id,cloud_provider,placement_credential_source,placement_credential_reference,placement_credential_version,placement_credential_fingerprint,created_at,agent_version)
      VALUES ('node','owner','running','workspace','managed','vm','server','incarnation','hetzner','platform','platform_credentials:credential',1,'fingerprint','2000-01-01T00:00:00.000Z','old-agent');
      INSERT INTO tasks(id,status,auto_provisioned_node_id) VALUES ('task','completed','node');`);
    source('ws');
  });
  afterEach(() => sqlite.close());
  function source(id: string) {
    const chat = `chat-${id}`,
      generation = `capture-${id}`;
    const key = (type: 'home' | 'wip' | 'manifest') =>
      buildSessionSnapshotR2Key(env, chat, generation, type);
    const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const manifest = JSON.stringify({
      version: 1,
      workspaceId: id,
      chatSessionId: chat,
      status: 'available',
      degradation: 'none',
      artifacts: { home: { sizeBytes: 0, sha256: sha }, wip: { sizeBytes: 0, sha256: sha } },
    });
    for (const type of ['home', 'wip', 'manifest'] as const) artifacts.set(key(type), { size: 0 });
    sqlite
      .prepare(
        `INSERT INTO workspaces(id,node_id,user_id,project_id,chat_session_id,status,eviction_generation,updated_at,error_message)
      VALUES (?,'node','owner','project',?,'stopping','generation',?,'Workspace deletion unconfirmed: http_status_404')`
      )
      .run(id, chat, now().toISOString());
    sqlite
      .prepare(
        `INSERT INTO session_snapshots(id,workspace_id,node_id,user_id,project_id,chat_session_id,status,degradation,sleep_status,sleeping_at,expires_at,snapshot_generation,cleanup_identity_json,manifest_json,home_r2_key,wip_r2_key,manifest_r2_key,home_sha256,wip_sha256)
      VALUES (?,?,'node','owner','project',?,'available','none','sleeping','2000-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z',?,?,?,?,?,?,?,?)`
      )
      .run(
        `snapshot-${id}`,
        id,
        chat,
        generation,
        JSON.stringify({
          workspaceId: id,
          nodeId: 'node',
          userId: 'owner',
          workspaceGeneration: 'generation',
          nodeRuntimeIncarnationId: 'incarnation',
          snapshotGeneration: generation,
          preserved: 1,
        }),
        manifest,
        key('home'),
        key('wip'),
        key('manifest'),
        sha,
        sha
      );
  }
  async function sweep() {
    const result = emptyResult();
    await sweepIncompatibleVmAgentNodes(
      drizzle(env.DATABASE, { schema }),
      env,
      now(),
      resolveCleanupConfig(env),
      result
    );
    return result;
  }
  const workspace = () =>
    sqlite.prepare("SELECT status,runtime_deletion_proof FROM workspaces WHERE id='ws'").get();
  it('retires an old VM with multiple saved sources despite recent HTTP404 retry bookkeeping', async () => {
    source('second');
    boundary.remove.mockImplementation(async () => {
      expect(workspace()).toEqual({ status: 'stopping', runtime_deletion_proof: null });
      expect(sqlite.prepare('SELECT status FROM nodes').get()).toEqual({ status: 'destroying' });
    });
    expect((await sweep()).incompatibleDestroyed).toBe(1);
    expect(boundary.remove).toHaveBeenCalledExactlyOnceWith('server');
    expect(workspace()).toEqual({
      status: 'deleted',
      runtime_deletion_proof: 'node_runtime_terminated',
    });
    expect(boundary.finalize).toHaveBeenCalled();
    expect(head.mock.calls.length).toBeGreaterThanOrEqual(18);
  });
  async function handoff() {
    sqlite.exec("UPDATE nodes SET status='stopped'");
    const result = emptyResult();
    await sweepStoppedHandoffNodes(
      drizzle(env.DATABASE, { schema }),
      env,
      now(),
      resolveCleanupConfig(env),
      result
    );
    return result;
  }
  it('retires stopped handoff with recent 404 retries using exact preserved sources', async () => {
    expect((await handoff()).lifetimeDestroyed).toBe(1);
    expect(boundary.remove).toHaveBeenCalledExactlyOnceWith('server', expect.anything());
    expect(workspace()).toEqual({
      status: 'deleted',
      runtime_deletion_proof: 'node_runtime_terminated',
    });
    expect(sqlite.prepare('SELECT count(*) count FROM session_snapshots').get()).toEqual({
      count: 1,
    });
  });
  it('recovers completed preservation missing its legacy sleeping timestamp without fabricating stop proof', async () => {
    sqlite.exec(
      "UPDATE session_snapshots SET sleeping_at=NULL,updated_at='2000-01-01T00:00:00.000Z'"
    );
    boundary.remove.mockImplementation(async () => {
      expect(sqlite.prepare('SELECT sleeping_at FROM session_snapshots').get()).toEqual({
        sleeping_at: null,
      });
      expect(workspace()).toEqual({ status: 'stopping', runtime_deletion_proof: null });
    });
    expect((await handoff()).lifetimeDestroyed).toBe(1);
  });
  it('backs off an unsafe stopped source despite fresh retry writes, reaching safe work next tick', async () => {
    secondNode();
    sqlite.exec(
      "UPDATE nodes SET status='stopped'; DELETE FROM session_snapshots WHERE workspace_id='ws'; UPDATE workspaces SET created_at='2000-01-01',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='ws'"
    );
    env.NODE_CLEANUP_SWEEP_LIMIT = '1';
    expect((await handoff()).lifetimeDestroyed).toBe(0);
    expect(
      sqlite.prepare("SELECT cleanup_backoff_until FROM nodes WHERE id='node'").get()
    ).toMatchObject({ cleanup_backoff_until: expect.any(String) });
    expect((await handoff()).lifetimeDestroyed).toBe(1);
    expect(boundary.remove).toHaveBeenCalledExactlyOnceWith('next-server', expect.anything());
  });
  it('converges exhausted durable HTTP404 retries through strict handoff without discarding backups', async () => {
    const entries = new Map<string, unknown>();
    let alarm: number | null = null;
    const storage = {
      get: async (key: string) => structuredClone(entries.get(key)),
      put: async (key: string, value: unknown) => {
        entries.set(key, structuredClone(value));
      },
      delete: async (key: string) => entries.delete(key),
      list: async (options: { prefix: string; startAfter?: string; limit: number }) =>
        new Map(
          [...entries.entries()]
            .filter(
              ([key]) =>
                key.startsWith(options.prefix) && (!options.startAfter || key > options.startAfter)
            )
            .sort(([a], [b]) => a.localeCompare(b))
            .slice(0, options.limit)
        ),
      transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(storage),
      setAlarm: async (value: number) => {
        alarm = value;
      },
      getAlarm: async () => alarm,
      deleteAlarm: async () => {
        alarm = null;
      },
    };
    const queue = new NodeLifecycleWorkspaceDeletionQueue(
      env,
      storage as unknown as DurableObjectStorage,
      async () => null,
      async () => 'node'
    );
    expect(await queue.schedule('node', 'ws', 'owner')).toBe(true);
    const pending = entries.get('ws-delete:ws') as PendingWorkspaceDeletion;
    env.WORKSPACE_DELETION_MAX_RESIDENCE_MS = '100';
    entries.set('ws-delete:ws', {
      ...pending,
      firstScheduledAt: Date.now() - 1000,
      deleteAt: Date.now() - 1,
      attemptCount: 64,
      lastError: 'http_status_404',
    });
    const work: Promise<void>[] = [];
    await queue.processExpired((attempt) => {
      work.push(attempt);
    });
    await Promise.all(work);
    expect(entries.get('ws-delete:ws')).toMatchObject({
      attemptCount: 64,
      deadLetterReason: 'maximum retry residence exceeded',
    });
    expect(alarm).toBeNull();
    expect(workspace()).toEqual({ status: 'stopping', runtime_deletion_proof: null });
    expect((await handoff()).lifetimeDestroyed).toBe(1);
    expect(workspace()).toEqual({
      status: 'deleted',
      runtime_deletion_proof: 'node_runtime_terminated',
    });
    expect(sqlite.prepare('SELECT count(*) count FROM session_snapshots').get()).toEqual({
      count: 1,
    });
    expect(artifacts.size).toBe(3);
    const extraWork = vi.fn();
    await queue.processExpired(extraWork);
    expect(extraWork).not.toHaveBeenCalled();
  });
  it('does not reuse a successor snapshot with old eviction markers as original source preservation', async () => {
    secondNode();
    sqlite.exec(
      "UPDATE nodes SET status='stopped' WHERE id='node'; UPDATE workspaces SET status='evicted',chat_session_id=NULL,created_at='2000-01-01' WHERE id='ws'; DELETE FROM session_snapshots WHERE workspace_id='ws'; UPDATE session_snapshots SET eviction_recovery_workspace_id='ws',eviction_recovery_node_id='node',eviction_recovery_generation='generation',restore_status='restored',restored_at='2001-01-01' WHERE workspace_id='next-ws'"
    );
    const result = emptyResult();
    await sweepStoppedHandoffNodes(
      drizzle(env.DATABASE, { schema }),
      env,
      now(),
      resolveCleanupConfig(env),
      result
    );
    expect(result.lifetimeDestroyed).toBe(0);
    expect(boundary.remove).not.toHaveBeenCalled();
    expect(workspace()).toEqual({ status: 'evicted', runtime_deletion_proof: null });
  });
  it('repairs missing sleep confirmation on retry only from exact termination proof', async () => {
    sqlite.exec('UPDATE session_snapshots SET sleeping_at=NULL');
    await repairRetiredVmSleepSnapshots(env, 'node', 'owner');
    expect(sqlite.prepare('SELECT sleeping_at FROM session_snapshots').get()).toEqual({
      sleeping_at: null,
    });
    sqlite.exec(
      "UPDATE nodes SET runtime_termination_confirmed_at='2001-01-01'; UPDATE workspaces SET status='deleted',runtime_deletion_proof='node_runtime_terminated',runtime_deletion_confirmed_at='2001-01-01'"
    );
    await repairRetiredVmSleepSnapshots(env, 'node', 'foreign');
    expect(sqlite.prepare('SELECT sleeping_at FROM session_snapshots').get()).toEqual({
      sleeping_at: null,
    });
    await repairRetiredVmSleepSnapshots(env, 'node', 'owner');
    expect(sqlite.prepare('SELECT sleeping_at FROM session_snapshots').get()).toEqual({
      sleeping_at: '2001-01-01',
    });
  });
  it('drains bounded post-termination repairs across retries before terminal node closure', async () => {
    source('second');
    env.WORKSPACE_CLEANUP_SWEEP_LIMIT = '1';
    sqlite.exec(
      "UPDATE session_snapshots SET sleeping_at=NULL; UPDATE nodes SET runtime_termination_confirmed_at='2001-01-01'; UPDATE workspaces SET status='deleted',runtime_deletion_proof='node_runtime_terminated',runtime_deletion_confirmed_at='2001-01-01'"
    );
    await expect(repairRetiredVmSleepSnapshots(env, 'node', 'owner')).rejects.toThrow(
      'source budget'
    );
    expect(
      sqlite.prepare('SELECT count(*) count FROM session_snapshots WHERE sleeping_at IS NULL').get()
    ).toEqual({ count: 1 });
    await expect(repairRetiredVmSleepSnapshots(env, 'node', 'owner')).rejects.toThrow(
      'source budget'
    );
    await expect(repairRetiredVmSleepSnapshots(env, 'node', 'owner')).resolves.toBeUndefined();
    expect(
      sqlite.prepare('SELECT count(*) count FROM session_snapshots WHERE sleeping_at IS NULL').get()
    ).toEqual({ count: 0 });
  });
  function fallback() {
    const record = JSON.stringify({
      version: 1,
      outcome: 'slept',
      trigger: 'retry_ceiling',
      blockedReason: null,
      decidedAt: '2000-01-01T00:00:00Z',
      episodeStartedAt: '1999-12-31T00:00:00Z',
      failedAttempts: 3,
      lastError: null,
      recoveryPoint: null,
    });
    sqlite
      .prepare(
        "UPDATE session_snapshots SET status='degraded',degradation='transcript-only',sleep_fallback_json=?,cleanup_identity_json=json_remove(cleanup_identity_json,'$.preserved')"
      )
      .run(record);
    boundary.chat.mockResolvedValue({ workspaceId: 'ws', status: 'sleeping' });
  }
  it('honors bounded transcript-only fallback while retaining every snapshot object', async () => {
    fallback();
    artifacts.clear();
    expect((await handoff()).lifetimeDestroyed).toBe(1);
    expect(boundary.message).toHaveBeenCalled();
    expect(sqlite.prepare('SELECT status,degradation FROM session_snapshots').get()).toEqual({
      status: 'degraded',
      degradation: 'transcript-only',
    });
  });
  it.each([
    "UPDATE session_snapshots SET cleanup_identity_json='{}'",
    "UPDATE session_snapshots SET capture_generation='pending'",
    "UPDATE session_snapshots SET sleep_fallback_json=json_set(sleep_fallback_json,'$.outcome','blocked')",
    "UPDATE workspaces SET eviction_generation='successor'",
  ])('rejects invalid bounded fallback authority: %s', async (change) => {
    fallback();
    sqlite.exec(change);
    expect((await handoff()).lifetimeDestroyed).toBe(0);
    expect(boundary.remove).not.toHaveBeenCalled();
  });
  it('rolls forward a bounded fallback stuck stopping only with its exact durable claim', async () => {
    fallback();
    sqlite.exec(
      "UPDATE session_snapshots SET sleep_status='stopping',sleep_claim_id='claim',sleeping_at=NULL,sleep_stopping_since='2000-01-01'"
    );
    expect((await handoff()).lifetimeDestroyed).toBe(1);
    expect(
      sqlite.prepare('SELECT sleep_status,sleeping_at,sleep_claim_id FROM session_snapshots').get()
    ).toEqual({ sleep_status: 'sleeping', sleeping_at: expect.any(String), sleep_claim_id: null });
  });
  it('rejects stopping fallback without a durable claim', async () => {
    fallback();
    sqlite.exec(
      "UPDATE session_snapshots SET sleep_status='stopping',sleep_claim_id=NULL,sleeping_at=NULL,sleep_stopping_since='2000-01-01'"
    );
    expect((await handoff()).lifetimeDestroyed).toBe(0);
    expect(boundary.remove).not.toHaveBeenCalled();
  });
  it.each([
    "UPDATE session_snapshots SET capture_generation='new-capture'",
    "UPDATE session_snapshots SET sleep_fallback_json=json_set(sleep_fallback_json,'$.decidedAt','2001-01-01')",
    "UPDATE session_snapshots SET cleanup_identity_json='{}'",
  ])('fences fallback mutation immediately before provider deletion: %s', async (change) => {
    fallback();
    boundary.resolve.mockImplementation(async () => {
      sqlite.exec(change);
      return { providerName: 'hetzner', provider: { deleteVM: boundary.remove } };
    });
    expect((await handoff()).lifetimeDestroyed).toBe(0);
    expect(boundary.remove).not.toHaveBeenCalled();
  });
  it('downgrades an unavailable fallback recovery promise before releasing through transcript-only recovery', async () => {
    fallback();
    const point = {
      generation: 'capture-ws',
      commit: 'a'.repeat(40),
      branch: 'main',
      detached: false,
      upstream: null,
      capturedAt: null,
      snapshotStatus: 'available',
      degradation: 'none',
      workingTreeSaved: true,
      homeSaved: true,
    };
    sqlite
      .prepare(
        "UPDATE session_snapshots SET sleep_fallback_json=json_set(sleep_fallback_json,'$.recoveryPoint',json(?))"
      )
      .run(JSON.stringify(point));
    artifacts.clear();
    expect((await handoff()).lifetimeDestroyed).toBe(0);
    const row = sqlite.prepare('SELECT sleep_fallback_json FROM session_snapshots').get() as {
      sleep_fallback_json: string;
    };
    expect(JSON.parse(row.sleep_fallback_json).recoveryPoint).toBeNull();
    sqlite.exec('UPDATE nodes SET cleanup_backoff_until=NULL');
    expect((await handoff()).lifetimeDestroyed).toBe(1);
    expect(boundary.message).toHaveBeenCalledWith(
      env,
      'project',
      'chat-ws',
      'system',
      expect.stringContaining('An exact Git or filesystem restore was not verified'),
      null,
      expect.any(String)
    );
  });
  it('does not downgrade a recovery point when a wake claims it during artifact assessment', async () => {
    fallback();
    const point = {
      generation: 'capture-ws',
      commit: 'a'.repeat(40),
      branch: 'main',
      detached: false,
      upstream: null,
      capturedAt: null,
      snapshotStatus: 'available',
      degradation: 'none',
      workingTreeSaved: true,
      homeSaved: true,
    };
    sqlite
      .prepare(
        "UPDATE session_snapshots SET sleep_fallback_json=json_set(sleep_fallback_json,'$.recoveryPoint',json(?)),manifest_json=json_set(manifest_json,'$.git',json(?)),base_commit=?"
      )
      .run(
        JSON.stringify(point),
        JSON.stringify({ branch: 'main', detached: false }),
        'a'.repeat(40)
      );
    const original = sqlite.prepare('SELECT sleep_fallback_json FROM session_snapshots').get();
    head.mockImplementation(async () => {
      sqlite.exec(
        "UPDATE session_snapshots SET recovery_status='waking',recovery_attempt_id='new-wake'"
      );
      return null;
    });
    expect((await handoff()).lifetimeDestroyed).toBe(0);
    expect(sqlite.prepare('SELECT sleep_fallback_json FROM session_snapshots').get()).toEqual(
      original
    );
    expect(boundary.remove).not.toHaveBeenCalled();
  });
  it('fences a wake between fallback preparation and the atomic node claim', async () => {
    fallback();
    const preservedVm = await preparePreservedVmRetirement(env, 'node', 'owner');
    expect(preservedVm).toBeDefined();
    sqlite.exec(
      "UPDATE session_snapshots SET recovery_status='waking',recovery_attempt_id='new-wake'"
    );
    expect(
      await claimNodeForCleanup(
        env,
        { id: 'node', user_id: 'owner', status: 'running' },
        now().toISOString(),
        { preservedVm }
      )
    ).toBe(false);
    expect(boundary.remove).not.toHaveBeenCalled();
  });
  it('fences a wake claimed during the final transcript notice before provider deletion', async () => {
    fallback();
    let notices = 0;
    boundary.message.mockImplementation(async () => {
      if (++notices === 2)
        sqlite.exec(
          "UPDATE session_snapshots SET recovery_status='waking',recovery_attempt_id='new-wake'"
        );
    });
    expect((await handoff()).lifetimeDestroyed).toBe(0);
    expect(boundary.remove).not.toHaveBeenCalled();
  });
  it('blocks fallback retirement when the transcript notice cannot be retained', async () => {
    fallback();
    boundary.message.mockRejectedValue(new Error('ProjectData unavailable'));
    expect((await handoff()).errors).toBe(1);
    expect(boundary.remove).not.toHaveBeenCalled();
  });
  it('fences a fallback wake or reassignment before provider deletion', async () => {
    fallback();
    boundary.resolve.mockImplementation(async () => {
      boundary.chat.mockResolvedValue({ workspaceId: 'successor', status: 'active' });
      return { providerName: 'hetzner', provider: { deleteVM: boundary.remove } };
    });
    expect((await handoff()).lifetimeDestroyed).toBe(0);
    expect(boundary.remove).not.toHaveBeenCalled();
  });
  it.each(['stopped', 'evicted'])(
    'blocks a mixed VM with an unpreserved %s source across repeated ticks',
    async (status) => {
      sqlite
        .prepare(
          "INSERT INTO workspaces(id,node_id,user_id,status,updated_at,created_at) VALUES ('unsafe','node','owner',?,'2000-01-01','2000-01-01')"
        )
        .run(status);
      expect((await handoff()).lifetimeDestroyed).toBe(0);
      expect((await handoff()).lifetimeDestroyed).toBe(0);
      expect(boundary.remove).not.toHaveBeenCalled();
    }
  );
  it.each([
    "UPDATE workspaces SET status='running'",
    "UPDATE workspaces SET user_id='foreign'",
    "UPDATE session_snapshots SET status='failed'",
    "UPDATE session_snapshots SET degradation='wip-only'",
    "UPDATE session_snapshots SET expires_at='2000-01-01'",
    "UPDATE session_snapshots SET sleep_status='stopping'",
    "UPDATE session_snapshots SET capture_generation='pending'",
    "UPDATE session_snapshots SET snapshot_generation='successor'",
    "UPDATE session_snapshots SET cleanup_identity_json='{}'",
    "UPDATE workspaces SET eviction_generation='successor'",
    "UPDATE nodes SET runtime='cf-container'",
    "UPDATE nodes SET node_class='user-owned'",
    "UPDATE nodes SET node_role='deployment'",
  ])('preserves unsafe state: %s', async (sql) => {
    sqlite.exec(sql);
    expect((await sweep()).incompatibleDestroyed).toBe(0);
    expect(boundary.remove).not.toHaveBeenCalled();
  });
  it.each(['home', 'wip', 'manifest'] as const)(
    'refuses missing %s R2 artifact',
    async (artifact) => {
      artifacts.delete(buildSessionSnapshotR2Key(env, 'chat-ws', 'capture-ws', artifact));
      expect((await sweep()).incompatibleDestroyed).toBe(0);
      expect(boundary.remove).not.toHaveBeenCalled();
    }
  );
  it('refuses mismatched R2 size', async () => {
    artifacts.set(buildSessionSnapshotR2Key(env, 'chat-ws', 'capture-ws', 'wip'), { size: 99 });
    expect((await sweep()).incompatibleDestroyed).toBe(0);
  });
  it('fails closed on the configured source bound', async () => {
    source('second');
    env.WORKSPACE_CLEANUP_SWEEP_LIMIT = '1';
    expect((await sweep()).incompatibleDestroyed).toBe(0);
  });
  it.each([
    "INSERT INTO workspaces(id,user_id,node_id,status) VALUES ('new','owner','node','running')",
    "UPDATE workspaces SET eviction_generation='successor'",
    "UPDATE nodes SET runtime_incarnation_id='successor'",
    "INSERT INTO tasks(id,status,claimed_warm_node_id,claimed_warm_node_at) VALUES ('claim','in_progress','node',strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    "INSERT INTO session_snapshots(id,workspace_id,node_id,user_id) VALUES ('orphan','missing','node','owner')",
  ])('rejects a race at claim time: %s', async (change) => {
    const preservedVm = await preparePreservedVmRetirement(env, 'node', 'owner');
    expect(preservedVm).toBeDefined();
    sqlite.exec(change);
    expect(
      await claimNodeForCleanup(
        env,
        { id: 'node', user_id: 'owner', status: 'running' },
        now().toISOString(),
        { preservedVm }
      )
    ).toBe(false);
    expect(boundary.remove).not.toHaveBeenCalled();
  });
  it('rechecks preservation immediately before provider deletion', async () => {
    boundary.resolve.mockImplementation(async () => {
      artifacts.clear();
      return { providerName: 'hetzner', provider: { deleteVM: boundary.remove } };
    });
    expect((await sweep()).incompatibleDestroyed).toBe(0);
    expect(boundary.remove).not.toHaveBeenCalled();
    expect(workspace()).toEqual({ status: 'stopping', runtime_deletion_proof: null });
  });
  it('keeps wake fenced when provider deletion fails', async () => {
    boundary.remove.mockRejectedValue(new Error('provider unavailable'));
    expect((await sweep()).errors).toBe(1);
    expect(workspace()).toEqual({ status: 'stopping', runtime_deletion_proof: null });
  });
  it('does not reuse VM preservation authority for a replacement snapshot generation', async () => {
    const preservedVm = await preparePreservedVmRetirement(env, 'node', 'owner');
    sqlite.exec("UPDATE session_snapshots SET snapshot_generation='replacement'");
    await expect(
      deleteNodeResourcesStrict('node', 'owner', env, { preservedVm })
    ).rejects.toThrow();
    expect(boundary.remove).not.toHaveBeenCalled();
  });
  function secondNode() {
    const original = sqlite.prepare("SELECT * FROM nodes WHERE id='node'").get() as Record<
      string,
      unknown
    >;
    const row = { ...original, id: 'next-node', provider_instance_id: 'next-server' };
    sqlite
      .prepare(
        `INSERT INTO nodes (${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
          .map(() => '?')
          .join(',')})`
      )
      .run(...Object.values(row));
    sqlite.exec(
      "INSERT INTO tasks(id,status,auto_provisioned_node_id) VALUES ('next-task','completed','next-node')"
    );
    source('next-ws');
    sqlite.exec("UPDATE workspaces SET node_id='next-node' WHERE id='next-ws'");
    sqlite.exec(
      "UPDATE session_snapshots SET node_id='next-node',sleeping_at='2001-01-01T00:00:00.000Z',cleanup_identity_json=json_set(cleanup_identity_json,'$.nodeId','next-node') WHERE workspace_id='next-ws'"
    );
  }
  it('defers unsafe old candidates so a later tick reaches a valid node behind the full page', async () => {
    secondNode();
    env.NODE_CLEANUP_SWEEP_LIMIT = '1';
    sqlite.exec("UPDATE session_snapshots SET status='failed' WHERE workspace_id='ws'");
    expect((await sweep()).incompatibleSkipped).toBe(1);
    expect(
      sqlite.prepare("SELECT cleanup_backoff_until FROM nodes WHERE id='node'").get()
    ).toMatchObject({ cleanup_backoff_until: expect.any(String) });
    expect((await sweep()).incompatibleDestroyed).toBe(1);
    expect(boundary.remove).toHaveBeenCalledExactlyOnceWith('next-server');
    expect(workspace()).toEqual({ status: 'stopping', runtime_deletion_proof: null });
  });
  it('bounds artifact verification across the whole sweep, then continues on the next tick', async () => {
    secondNode();
    env.WORKSPACE_CLEANUP_SWEEP_LIMIT = '1';
    expect((await sweep()).incompatibleDestroyed).toBe(1);
    expect(boundary.remove).toHaveBeenCalledExactlyOnceWith('server');
    expect(head).toHaveBeenCalledTimes(9);
    expect((await sweep()).incompatibleDestroyed).toBe(1);
    expect(boundary.remove).toHaveBeenLastCalledWith('next-server');
  });
  it('backs off an R2 outage without claiming or destroying the node', async () => {
    head.mockRejectedValue(new Error('R2 unavailable'));
    expect((await sweep()).errors).toBe(1);
    expect(sqlite.prepare('SELECT status,cleanup_backoff_until FROM nodes').get()).toEqual({
      status: 'running',
      cleanup_backoff_until: expect.any(String),
    });
    expect(boundary.remove).not.toHaveBeenCalled();
  });
  it('leaves a valid larger candidate due when earlier invalid work partially spends the budget', async () => {
    secondNode();
    source('extra');
    sqlite.exec("UPDATE workspaces SET node_id='next-node' WHERE id='extra'");
    sqlite.exec(
      "UPDATE session_snapshots SET node_id='next-node',sleeping_at='2001-01-01T00:00:00.000Z',cleanup_identity_json=json_set(cleanup_identity_json,'$.nodeId','next-node') WHERE workspace_id='extra'"
    );
    env.WORKSPACE_CLEANUP_SWEEP_LIMIT = '2';
    sqlite.exec("UPDATE session_snapshots SET status='failed' WHERE workspace_id='ws'");
    expect((await sweep()).incompatibleDestroyed).toBe(0);
    expect(
      sqlite.prepare("SELECT cleanup_backoff_until FROM nodes WHERE id='next-node'").get()
    ).toEqual({ cleanup_backoff_until: null });
    expect((await sweep()).incompatibleDestroyed).toBe(1);
    expect(boundary.remove).toHaveBeenCalledExactlyOnceWith('next-server');
  });
});
