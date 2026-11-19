import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as observabilitySchema from '../../../src/db/observability-schema';
import { log } from '../../../src/lib/logger';
import { resolveCleanupConfig, runNodeCleanupSweep } from '../../../src/scheduled/node-cleanup';
import { invalidateAdminSettings } from '../../../src/services/admin-settings';
import { clearCapacityCatalogCache } from '../../../src/services/default-capacity-source-credentials';
import { buildSessionSnapshotR2Key } from '../../../src/services/session-snapshot-artifacts';
import { findRestorableOrInFlightSleepSnapshot } from '../../../src/services/session-snapshot-sleep-predicate';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
import { handoffFixture } from './node-cleanup-handoff-fixture';

vi.mock('../../../src/services/jwt', () => ({ signNodeCallbackToken: async () => 'test-token' }));
const NOW = new Date('2026-09-08T12:00:00.000Z');
const observabilityDatabases: Database.Database[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCapacityCatalogCache();
  observabilityDatabases.splice(0).forEach((db) => db.close());
});

async function strandedFixture(minutes = 31) {
  const f = await handoffFixture();
  const obs = new Database(':memory:');
  observabilityDatabases.push(obs);
  createAllSchemaTables(obs, observabilitySchema);
  f.env.OBSERVABILITY_DATABASE = createSqliteD1(obs);
  // These additive columns let the regression run against the unfixed schema,
  // so its initial failure discriminates behavior rather than missing DDL.
  const columns = f.sqlite.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>;
  for (const column of [
    'cleanup_blocked_since',
    'cleanup_blocked_reason',
    'cleanup_blocked_alerted_at',
    'cleanup_retirement_sources_json',
  ]) {
    if (!columns.some((entry) => entry.name === column))
      f.sqlite.exec(`ALTER TABLE nodes ADD COLUMN ${column} TEXT`);
  }
  const since = new Date(NOW.getTime() - minutes * 60_000).toISOString();
  f.sqlite
    .prepare(
      `UPDATE nodes SET cleanup_blocked_since = ?, cleanup_blocked_reason = 'unproven_workspace_deletion', runtime_incarnation_id = 'incarnation-host' WHERE id = 'host'`
    )
    .run(since);
  f.sqlite
    .exec(`UPDATE workspaces SET runtime_deletion_confirmed_at = NULL, runtime_deletion_proof = NULL;
    UPDATE session_snapshots SET status = 'failed', manifest_r2_key = NULL;`);
  const stub = f.env.PROJECT_DATA.get(f.env.PROJECT_DATA.idFromName('project-1'));
  const failSession = vi.fn(async () => undefined);
  Object.assign(stub, { failSession });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  return { ...f, obs, since, failSession };
}

function node(f: Awaited<ReturnType<typeof strandedFixture>>) {
  return f.sqlite
    .prepare(
      "SELECT status, cleanup_blocked_since, cleanup_blocked_reason FROM nodes WHERE id = 'host'"
    )
    .get();
}

describe('bounded stranded retirement through the real cleanup cron entry', () => {
  it('retires a 31-minute blocked old-agent source and records termination proof and unpreserved source', async () => {
    const f = await strandedFixture();
    const warn = vi.spyOn(log, 'warn');
    await runNodeCleanupSweep(f.env);
    expect(f.providerDeletes).toEqual(['https://api.hetzner.cloud/v1/servers/provider-host']);
    expect(node(f)).toMatchObject({ status: 'deleted', cleanup_blocked_since: null });
    expect(
      f.sqlite
        .prepare('SELECT runtime_deletion_proof, runtime_deletion_confirmed_at FROM workspaces')
        .get()
    ).toEqual({
      runtime_deletion_proof: 'node_runtime_terminated',
      runtime_deletion_confirmed_at: expect.any(String),
    });
    const errors = f.obs.prepare('SELECT level, context FROM platform_errors').all() as Array<{
      level: string;
      context: string;
    }>;
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'warn',
          context: expect.stringContaining('bounded_stranded_node_retirement'),
        }),
      ])
    );
    const loss = errors.find((row) => row.context.includes('bounded_stranded_node_retirement'))!;
    expect(loss.context).toContain('sleeping-workspace');
    expect(loss.context).toContain('snapshot-1');
    expect(loss.context).toContain(f.since);
    expect(warn).toHaveBeenCalledWith(
      'node_cleanup.stranded_node_force_retired',
      expect.objectContaining({ nodeId: 'host' })
    );
  });

  it('refuses a 29-minute source with a named guard and preserves its original blocked clock', async () => {
    const f = await strandedFixture(29);
    const warn = vi.spyOn(log, 'warn');
    await runNodeCleanupSweep(f.env);
    expect(f.providerDeletes).toEqual([]);
    expect(node(f)).toMatchObject({
      status: 'stopped',
      cleanup_blocked_since: f.since,
      cleanup_blocked_reason: expect.stringContaining('unproven_workspace_deletion'),
    });
    expect(
      warn.mock.calls.some(
        ([event, context]) =>
          event === 'node_cleanup.candidate_claim_refused' &&
          JSON.stringify(context).includes('unproven_workspace_deletion')
      )
    ).toBe(true);
  });

  it('caps a refusal backoff at the deadline and retires on the exact 30-minute tick', async () => {
    const f = await strandedFixture(29);
    await runNodeCleanupSweep(f.env);
    expect(f.providerDeletes).toEqual([]);
    const { cleanup_backoff_until } = f.sqlite
      .prepare("SELECT cleanup_backoff_until FROM nodes WHERE id = 'host'")
      .get() as { cleanup_backoff_until: string };
    const deadline = new Date(Date.parse(f.since) + 30 * 60_000);
    expect(Date.parse(cleanup_backoff_until)).toBeLessThanOrEqual(deadline.getTime());
    vi.setSystemTime(deadline);
    // No manual reset: the actual persisted retry schedule must admit this tick.
    await runNodeCleanupSweep(f.env);
    expect(f.providerDeletes).toEqual(['https://api.hetzner.cloud/v1/servers/provider-host']);
    expect(node(f)).toMatchObject({ status: 'deleted', cleanup_blocked_since: null });
  });

  it('never forces a running workspace even after the deadline', async () => {
    const f = await strandedFixture(90);
    f.sqlite.exec("UPDATE workspaces SET status = 'running'");
    await runNodeCleanupSweep(f.env);
    expect(f.providerDeletes).toEqual([]);
    expect(node(f)).toMatchObject({ status: 'stopped' });
  });

  it('keeps the first refusal clock despite updated_at heartbeat and retry writes', async () => {
    const f = await strandedFixture(29);
    await runNodeCleanupSweep(f.env);
    f.sqlite
      .prepare("UPDATE nodes SET updated_at = ?, cleanup_backoff_until = NULL WHERE id = 'host'")
      .run(NOW.toISOString());
    vi.setSystemTime(new Date(NOW.getTime() + 2 * 60_000));
    await runNodeCleanupSweep(f.env);
    expect(f.providerDeletes).toHaveLength(1);
    expect(node(f)).toMatchObject({ status: 'deleted', cleanup_blocked_since: null });
  });

  it('retires an already proven source through normal cleanup without forced-loss provenance', async () => {
    const f = await strandedFixture();
    f.sqlite
      .prepare(
        `UPDATE workspaces SET runtime_deletion_proof = 'vm_agent_confirmed', runtime_deletion_confirmed_at = ?`
      )
      .run(NOW.toISOString());
    f.sqlite.exec(
      "UPDATE session_snapshots SET status = 'available', manifest_r2_key = 'saved-manifest'"
    );
    await runNodeCleanupSweep(f.env);
    expect(f.providerDeletes).toHaveLength(1);
    expect(node(f)).toMatchObject({ status: 'deleted', cleanup_blocked_since: null });
    const errors = f.obs.prepare('SELECT context FROM platform_errors').all() as Array<{
      context: string;
    }>;
    expect(
      errors.filter((row) => row.context.includes('bounded_stranded_node_retirement'))
    ).toEqual([]);
    expect(f.sqlite.prepare('SELECT manifest_r2_key, status FROM session_snapshots').get()).toEqual(
      { manifest_r2_key: 'saved-manifest', status: 'available' }
    );
  });

  it('starts the blocked clock on the first refusal', async () => {
    const f = await strandedFixture();
    f.sqlite.exec('UPDATE nodes SET cleanup_blocked_since = NULL, cleanup_blocked_reason = NULL');
    await runNodeCleanupSweep(f.env);
    expect(f.providerDeletes).toEqual([]);
    expect(node(f)).toMatchObject({
      cleanup_blocked_since: NOW.toISOString(),
      cleanup_blocked_reason: expect.stringContaining('unproven_workspace_deletion'),
    });
  });

  it('honors an installation admin deadline override through the cron resolver', async () => {
    const f = await strandedFixture(29);
    f.sqlite
      .prepare('INSERT INTO platform_settings(key,value,updated_at) VALUES (?,?,?)')
      .run('operations.nodeCleanupBlockedRetirementMs', String(20 * 60_000), NOW.toISOString());
    // Direct SQL fixture writes model the invalidation performed by the admin mutation.
    invalidateAdminSettings(f.env);
    await runNodeCleanupSweep(f.env);
    expect(f.providerDeletes).toHaveLength(1);
    expect(node(f)).toMatchObject({ status: 'deleted' });
  });

  it('applies the shipped migration by adding nullable columns without changing existing rows', () => {
    const sqlite = new Database(':memory:');
    observabilityDatabases.push(sqlite);
    sqlite.exec(
      "CREATE TABLE nodes (id TEXT PRIMARY KEY, status TEXT); INSERT INTO nodes VALUES ('existing-node', 'stopped')"
    );
    const migration = readFileSync(
      new URL('../../../src/db/migrations/0214_node_cleanup_blocked.sql', import.meta.url),
      'utf8'
    );
    const statements = migration
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(4);
    expect(
      statements.every((statement) =>
        /^ALTER TABLE nodes ADD COLUMN (cleanup_blocked_(since|reason|alerted_at)|cleanup_retirement_sources_json) TEXT$/i.test(
          statement
        )
      )
    ).toBe(true);
    sqlite.exec(migration);
    expect(sqlite.prepare('SELECT * FROM nodes').get()).toEqual({
      id: 'existing-node',
      status: 'stopped',
      cleanup_blocked_since: null,
      cleanup_blocked_reason: null,
      cleanup_blocked_alerted_at: null,
      cleanup_retirement_sources_json: null,
    });
  });

  it('retires sources exceeding the external preservation budget and verifies deferred snapshots next tick', async () => {
    const f = await strandedFixture();
    f.env.WORKSPACE_CLEANUP_SWEEP_LIMIT = '1';
    f.sqlite.exec(`INSERT INTO session_snapshots
      (id,workspace_id,node_id,user_id,project_id,chat_session_id,runtime,status,degradation,expires_at,created_at,updated_at)
      SELECT 'snapshot-overflow',workspace_id,node_id,user_id,project_id,chat_session_id,runtime,status,degradation,expires_at,created_at,updated_at
      FROM session_snapshots WHERE id='snapshot-1'`);
    await runNodeCleanupSweep(f.env);
    expect(f.providerDeletes).toHaveLength(1);
    expect(f.sqlite.prepare('SELECT status FROM session_snapshots ORDER BY id').all()).toEqual([
      { status: 'expired' },
      { status: 'failed' },
    ]);
    expect(
      f.sqlite.prepare('SELECT cleanup_retirement_sources_json FROM nodes').get()
    ).toMatchObject({
      cleanup_retirement_sources_json: expect.stringContaining('snapshot-overflow'),
    });
    await runNodeCleanupSweep(f.env);
    expect(f.sqlite.prepare('SELECT status FROM session_snapshots').all()).toEqual([
      { status: 'expired' },
      { status: 'expired' },
    ]);
    expect(f.providerDeletes).toHaveLength(1);
  });

  it('retains a real R2-preserved source beyond the verification budget while expiring the lost source', async () => {
    const f = await strandedFixture();
    f.env.WORKSPACE_CLEANUP_SWEEP_LIMIT = '1';
    const workspaceId = 'zz-preserved-workspace';
    const snapshotId = 'zz-preserved-snapshot';
    const chatSessionId = 'preserved-chat';
    const generation = 'preserved-generation';
    const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const key = (artifact: 'home' | 'wip' | 'manifest') =>
      buildSessionSnapshotR2Key(f.env, chatSessionId, generation, artifact);
    const keys = new Set(
      ['home', 'wip', 'manifest'].map((artifact) => key(artifact as 'home' | 'wip' | 'manifest'))
    );
    const head = vi.fn(async (r2Key: string) =>
      keys.has(r2Key) ? { size: 0, checksums: {} } : null
    );
    f.env.R2 = { head } as unknown as R2Bucket;
    f.sqlite
      .prepare(
        `INSERT INTO workspaces(id,node_id,user_id,project_id,chat_session_id,status,created_at,updated_at)
      VALUES (?,'host','user-1','project-1',?,'deleted',?,?)`
      )
      .run(workspaceId, chatSessionId, f.since, f.since);
    const manifest = JSON.stringify({
      version: 1,
      workspaceId,
      chatSessionId,
      status: 'available',
      degradation: 'none',
      artifacts: { home: { sizeBytes: 0, sha256: sha }, wip: { sizeBytes: 0, sha256: sha } },
    });
    f.sqlite
      .prepare(
        `INSERT INTO session_snapshots(id,workspace_id,node_id,user_id,project_id,chat_session_id,runtime,status,degradation,sleep_status,sleeping_at,expires_at,snapshot_generation,cleanup_identity_json,manifest_json,home_r2_key,wip_r2_key,manifest_r2_key,home_sha256,wip_sha256)
      VALUES (?,?,'host','user-1','project-1',?,'vm','available','none','sleeping',?,'2099-01-01T00:00:00.000Z',?,?,?,?,?,?,?,?)`
      )
      .run(
        snapshotId,
        workspaceId,
        chatSessionId,
        f.since,
        generation,
        JSON.stringify({
          workspaceId,
          nodeId: 'host',
          userId: 'user-1',
          workspaceGeneration: '',
          nodeRuntimeIncarnationId: 'incarnation-host',
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
    await runNodeCleanupSweep(f.env);
    expect(f.providerDeletes).toHaveLength(1);
    expect(
      f.sqlite.prepare('SELECT status FROM session_snapshots WHERE id=?').get(snapshotId)
    ).toEqual({ status: 'available' });
    await runNodeCleanupSweep(f.env);
    expect(
      f.sqlite
        .prepare(
          'SELECT status,home_r2_key,wip_r2_key,manifest_r2_key FROM session_snapshots WHERE id=?'
        )
        .get(snapshotId)
    ).toEqual({
      status: 'available',
      home_r2_key: key('home'),
      wip_r2_key: key('wip'),
      manifest_r2_key: key('manifest'),
    });
    expect(
      f.sqlite.prepare("SELECT status FROM session_snapshots WHERE id='snapshot-1'").get()
    ).toEqual({ status: 'expired' });
    expect(head).toHaveBeenCalled();
    expect(
      f.failSession.mock.calls.every((args) => !JSON.stringify(args).includes(chatSessionId))
    ).toBe(true);
    expect(f.sqlite.prepare('SELECT cleanup_retirement_sources_json FROM nodes').get()).toEqual({
      cleanup_retirement_sources_json: null,
    });
    expect(f.providerDeletes).toHaveLength(1);
  });

  it('retries session loss notices after terminal deletion without another provider call', async () => {
    const f = await strandedFixture();
    f.failSession.mockRejectedValueOnce(new Error('ProjectData temporarily unavailable'));
    await runNodeCleanupSweep(f.env);
    expect(node(f)).toMatchObject({ status: 'deleted' });
    expect(f.sqlite.prepare('SELECT status FROM session_snapshots').get()).toEqual({
      status: 'expired',
    });
    expect(
      f.sqlite.prepare('SELECT cleanup_retirement_sources_json FROM nodes').get()
    ).toMatchObject({
      cleanup_retirement_sources_json: expect.stringContaining('snapshot-1'),
    });
    await runNodeCleanupSweep(f.env);
    expect(f.failSession).toHaveBeenCalledTimes(2);
    expect(f.providerDeletes).toHaveLength(1);
    expect(f.sqlite.prepare('SELECT cleanup_retirement_sources_json FROM nodes').get()).toEqual({
      cleanup_retirement_sources_json: null,
    });
  });

  it('does not let an older ownership refusal monopolize a one-node deadline page', async () => {
    const f = await strandedFixture();
    f.env.NODE_CLEANUP_SWEEP_LIMIT = '1';
    const columns = f.sqlite.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>;
    const names = columns.map(({ name }) => `"${name}"`);
    const values = columns.map(({ name }) =>
      name === 'id'
        ? "'older-deployment'"
        : name === 'node_role'
          ? "'deployment'"
          : name === 'placement_credential_reference'
            ? 'NULL'
            : name === 'cleanup_blocked_since'
              ? "'2026-09-08T10:00:00.000Z'"
              : `"${name}"`
    );
    f.sqlite.exec(
      `INSERT INTO nodes (${names.join(',')}) SELECT ${values.join(',')} FROM nodes WHERE id='host'`
    );
    await runNodeCleanupSweep(f.env);
    expect(f.providerDeletes).toHaveLength(0);
    vi.setSystemTime(new Date(NOW.getTime() + 5 * 60_000));
    await runNodeCleanupSweep(f.env);
    expect(f.providerDeletes).toHaveLength(1);
    expect(node(f)).toMatchObject({ status: 'deleted' });
  });

  it('uses the 30-minute default through the real resolver', async () => {
    const f = await strandedFixture();
    expect(resolveCleanupConfig(f.env)).toMatchObject({ blockedRetirementMs: 30 * 60_000 });
  });

  it('expires an unpreserved sleeping source so it cannot be offered as a restorable wake', async () => {
    const f = await strandedFixture();
    f.sqlite.exec(
      "UPDATE session_snapshots SET status = 'available', sleep_status = 'sleeping', manifest_r2_key = NULL"
    );
    await runNodeCleanupSweep(f.env);
    expect(f.providerDeletes).toHaveLength(1);
    expect(f.sqlite.prepare('SELECT status, sleep_status FROM session_snapshots').get()).toEqual({
      status: 'expired',
      sleep_status: 'failed',
    });
    expect(
      await findRestorableOrInFlightSleepSnapshot(f.env.DATABASE, f.env, {
        projectId: 'project-1',
        workspaceId: 'sleeping-workspace',
        chatSessionId: 'chat-1',
        now: NOW,
      })
    ).toBeNull();
    expect(f.failSession).toHaveBeenCalled();
    expect(f.sqlite.prepare('SELECT recovery_failed_at FROM session_snapshots').get()).toEqual({
      recovery_failed_at: NOW.toISOString(),
    });
  });

  it('retains the original refusal clock when deadline provider deletion fails', async () => {
    const f = await strandedFixture();
    f.rejectedProviderIds.add('provider-host');
    await runNodeCleanupSweep(f.env);
    expect(f.providerDeletes).toEqual(['https://api.hetzner.cloud/v1/servers/provider-host']);
    expect(node(f)).toMatchObject({ status: 'stopped', cleanup_blocked_since: f.since });
  });

  it('alerts once for an overdue deployment ownership failure and never calls the provider', async () => {
    const f = await strandedFixture();
    f.sqlite.exec(`DELETE FROM session_snapshots; DELETE FROM workspaces;
      UPDATE nodes SET node_role = 'deployment', status = 'destroying', placement_credential_reference = NULL;
      UPDATE tasks SET status = 'failed', auto_provisioned_node_id = 'host';`);
    const externalBackoff = new Date(NOW.getTime() + 60 * 60_000).toISOString();
    f.sqlite.prepare('UPDATE nodes SET cleanup_backoff_until = ?').run(externalBackoff);
    await runNodeCleanupSweep(f.env);
    // Another deployment controller's retry delay cannot postpone the first alert.
    expect(f.obs.prepare('SELECT COUNT(*) AS count FROM platform_errors').get()).toEqual({
      count: 1,
    });
    f.sqlite.prepare('UPDATE nodes SET cleanup_backoff_until = ?').run(externalBackoff);
    vi.setSystemTime(new Date(NOW.getTime() + 10 * 60_000));
    await runNodeCleanupSweep(f.env);
    // Also admit a later retry explicitly to verify dedup independently of backoff.
    f.sqlite.exec('UPDATE nodes SET cleanup_backoff_until = NULL');
    await runNodeCleanupSweep(f.env);
    expect(f.providerDeletes).toEqual([]);
    expect(f.providerGets).toEqual([]);
    const errors = f.obs.prepare('SELECT context FROM platform_errors').all() as Array<{
      context: string;
    }>;
    expect(errors.filter((row) => row.context.includes('host'))).toHaveLength(1);
    expect(errors[0]?.context).toContain('provenance');
    expect(node(f)).toMatchObject({ status: 'destroying' });
  });
});
