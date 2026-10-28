import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { sweepIncompatibleVmAgentNodes } from '../../../src/scheduled/node-cleanup/node-phases';
import {
  claimNodeForCleanup,
  emptyResult,
  resolveCleanupConfig,
} from '../../../src/scheduled/node-cleanup/shared';
import { preparePreservedVmRetirement } from '../../../src/services/preserved-vm-retirement';
import { deleteNodeResourcesStrict } from '../../../src/services/strict-node-deletion';
import { buildSessionSnapshotR2Key } from '../../../src/services/session-snapshot-artifacts';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const boundary = vi.hoisted(() => ({ remove: vi.fn(), resolve: vi.fn(), finalize: vi.fn() }));
vi.mock('../../../src/services/provider-credentials', async (actual) => ({
  ...(await actual<typeof import('../../../src/services/provider-credentials')>()),
  createProviderForUser: boundary.resolve,
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
});
