import { buildCapacityPoolSelection } from '@simple-agent-manager/scheduler-core';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { readDefaultPoolSummary } from '../../src/services/default-capacity-pool-summaries';
import { resolveTaskStartPlacement } from '../../src/services/placement-resolver';
import { ensureSessionRecovery } from '../../src/services/session-recovery';
import { classifySessionRecoveryRefusal } from '../../src/services/session-recovery-refusals';
import { createAllSchemaTables } from '../helpers/sqlite-d1';
import {
  createEvictionEnv,
  pickEvictionPools,
  seedEvictionOwnerAndNode,
} from '../helpers/workspace-eviction-route-harness';

const runner = vi.hoisted(() => ({ start: vi.fn(async () => undefined) }));
vi.mock('../../src/services/project-data', () => ({
  getSession: vi.fn(async () => ({
    status: 'sleeping',
    workspaceId: 'workspace-1',
    taskId: 'task-1',
  })),
  recordActivityEvent: vi.fn(async () => undefined),
}));
vi.mock('../../src/services/task-runner-do', () => ({
  ensureTaskRunnerStarted: vi.fn(async () => false),
  startTaskRunnerDO: runner.start,
}));

let sqlite: Database.Database;
let env: Env;
const scope = { scope: 'user' as const, ownerUserId: 'user-1', ownerProjectId: null };
const clock = Date.parse('2026-11-14T10:00:00.000Z');

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(clock);
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  seedEvictionOwnerAndNode(sqlite);
  env = createEvictionEnv(sqlite);
  await pickEvictionPools(env);
  sqlite.exec(`
    INSERT INTO workspaces (id,user_id,project_id,node_id,chat_session_id,status,branch,vm_size,
      vm_location,workspace_profile,created_at,updated_at)
    VALUES ('workspace-1','user-1','project-1','node-1','chat-1','deleted','main','small',
      'nbg1','lightweight',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    INSERT INTO tasks (id,project_id,user_id,chat_session_id,workspace_id,title,status,
      task_mode,triggered_by,created_by,placement_explanation_json,created_at,updated_at)
    VALUES ('task-1','project-1','user-1','chat-1','workspace-1','Sleeping','sleeping',
      'conversation','mcp','user-1','{"kind":"direct_placement","explicitVmLocation":false}',
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    INSERT INTO session_snapshots (id,project_id,workspace_id,node_id,user_id,chat_session_id,
      runtime,status,degradation,manifest_r2_key,manifest_json,expires_at,sleeping_at,created_at,updated_at)
    VALUES ('snapshot-1','project-1','workspace-1','node-1','user-1','chat-1','vm','available','none',
      'snapshot/manifest.json','{}','2099-01-01T00:00:00.000Z',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    UPDATE session_snapshots SET recovery_attempts=0;
    UPDATE workspaces SET runtime_deletion_confirmed_at=CURRENT_TIMESTAMP;
    UPDATE capacity_pools SET migration_state='pending', catalog_published_at=NULL
      WHERE scope='user';
  `);
  sqlite
    .prepare(
      `UPDATE capacity_pool_refreshes SET state='pending',attempts=1,started_at=?,deadline_at=?
    WHERE scope='user'`
    )
    .run(clock - 1000, clock + 60000);
});
afterEach(() => {
  vi.restoreAllMocks();
  sqlite.close();
});

async function expectRefusal(reason: string, action: 'retry' | 'report') {
  expect(await ensureSessionRecovery(env, 'project-1', 'chat-1')).toEqual({
    status: 'unavailable',
    reason,
  });
  expect(classifySessionRecoveryRefusal(reason).action).toBe(action);
  expect(
    sqlite.prepare('SELECT recovery_attempts,recovery_attempt_id FROM session_snapshots').get()
  ).toEqual({ recovery_attempts: 0, recovery_attempt_id: null });
  expect(runner.start).not.toHaveBeenCalled();
}

describe('catalog wake failure classification through real placement', () => {
  it('keeps an excluded account plus an active account ready, but reports all sources disabled', async () => {
    const db = drizzle(env.DATABASE, { schema });
    const [source] = await db.select().from(schema.capacitySources).limit(1);
    const candidates = await db.select().from(schema.capacityPoolCandidates);
    const candidate = candidates.find(
      (row) => row.workloadRole === 'workspace' && row.status === 'active'
    );
    if (!source || !candidate) throw new Error('Expected selected owner source and offering');
    sqlite.exec(`INSERT INTO credentials (id,user_id,provider,credential_type,credential_kind,
      is_active,encrypted_token,iv,created_at,updated_at)
      SELECT 'credential-two',user_id,provider,credential_type,credential_kind,
        is_active,encrypted_token,iv,created_at,updated_at FROM credentials WHERE id='credential-1'`);
    await db.insert(schema.capacitySources).values({
      ...source,
      id: 'source-two',
      credentialId: 'credential-two',
      credentialReference: 'credentials:credential-two',
    });
    await db.insert(schema.capacityPoolCandidates).values({
      ...candidate,
      id: 'candidate-two',
      capacitySourceId: 'source-two',
    });
    sqlite
      .prepare(
        `UPDATE capacity_pools SET migration_state='complete',
      catalog_published_at='2026-11-14T09:00:00.000Z',excluded_source_ids_json=? WHERE scope='user'`
      )
      .run(JSON.stringify([source.id]));

    const mixed = await readDefaultPoolSummary(db, scope, { includeDisabled: true });
    expect(mixed).toMatchObject({ effectiveState: 'configured-ready', activeCandidateCount: 1 });
    if (!mixed) throw new Error('Expected the owner pool summary');
    const placement = resolveTaskStartPlacement({
      entryPoint: 'task-submit',
      taskId: 'task-1',
      projectId: 'project-1',
      userId: 'user-1',
      project: { id: 'project-1', defaultVmSize: 'small' },
      credentialProjectPolicy: 'current-project',
      taskModeDefault: 'task',
      resourceRequirements: {},
    });
    expect(
      buildCapacityPoolSelection(mixed, placement, 'workspace')?.candidates.map((row) => row.id)
    ).toEqual(['candidate-two']);

    sqlite.exec("UPDATE capacity_sources SET status='disabled'");
    expect(await readDefaultPoolSummary(db, scope, { includeDisabled: true })).toMatchObject({
      effectiveState: 'source-disabled',
      activeCandidateCount: 0,
    });
    await expectRefusal('placement_sources_disabled', 'report');
  });
  it('waits only while a started publication remains pending before its deadline', async () => {
    await expectRefusal('session_recovery_placement_transient', 'retry');
  });
  it('waits for a durably queued first attempt whose execution budget has not started', async () => {
    sqlite.exec(
      `UPDATE capacity_pool_refreshes SET attempts=0,started_at=0,deadline_at=0 WHERE scope='user'`
    );
    await expectRefusal('session_recovery_placement_transient', 'retry');
  });
  it('waits for queued work before sources or candidates have been materialized', async () => {
    sqlite.exec(`DELETE FROM capacity_pool_candidates; DELETE FROM capacity_sources;
      UPDATE capacity_pool_refreshes SET attempts=0,started_at=0,deadline_at=0 WHERE scope='user'`);
    await expectRefusal('session_recovery_placement_transient', 'retry');
  });
  it.each([
    ['credential', 'UPDATE cc_credentials SET is_active=0'],
    ['configuration', 'UPDATE cc_configurations SET is_active=0'],
    ['attachment', 'UPDATE cc_attachments SET is_active=0'],
    ['rotation', "UPDATE cc_credentials SET updated_at='2098-01-01T00:00:00.000Z'"],
  ])('checks composable %s authority before pending bootstrap', async (_name, mutation) => {
    sqlite.exec(`
      UPDATE credentials SET is_active=0 WHERE id='credential-1';
      INSERT INTO cc_credentials (id,owner_id,name,kind,encrypted_token,iv,is_active,created_at,updated_at)
        VALUES ('cc-1','user-1','Compute','cloud-provider','encrypted','iv',1,'2026-11-14T09:00:00.000Z','2026-11-14T09:00:00.000Z');
      INSERT INTO cc_configurations (id,owner_id,name,consumer_kind,consumer_target,credential_id,is_active,created_at,updated_at)
        VALUES ('config-1','user-1','Compute','compute','hetzner','cc-1',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
      INSERT INTO cc_attachments (id,configuration_id,consumer_kind,consumer_target,user_id,is_active,created_at,updated_at)
        VALUES ('attachment-1','config-1','compute','hetzner','user-1',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
      UPDATE capacity_sources SET credential_id=NULL,credential_reference='cc_credentials:cc-1',
        external_source_ref='cc_attachments:attachment-1',credential_version=${Date.parse('2026-11-14T09:00:00.000Z')}
        WHERE scope='user';
    `);
    await expectRefusal('session_recovery_placement_transient', 'retry');
    sqlite.exec(mutation);
    await expectRefusal('placement_sources_disabled', 'report');
  });
  it('checks platform credential authority before pending bootstrap', async () => {
    sqlite.exec(`
      DELETE FROM capacity_pool_candidates WHERE pool_id IN (SELECT id FROM capacity_pools WHERE scope='installation');
      DELETE FROM capacity_pools WHERE scope='installation';
      UPDATE capacity_pools SET scope='installation',owner_user_id=NULL WHERE scope='user';
      UPDATE capacity_pool_refreshes SET scope='installation',owner_user_id=NULL WHERE scope='user';
      INSERT INTO platform_credentials (id,credential_type,provider,label,encrypted_token,iv,is_enabled,created_by,created_at,updated_at)
        VALUES ('platform-1','cloud-provider','hetzner','Compute','encrypted','iv',1,'user-1',
          '2026-11-14T09:00:00.000Z','2026-11-14T09:00:00.000Z');
      UPDATE capacity_sources SET scope='installation',owner_user_id=NULL,credential_source='platform',
        credential_id=NULL,platform_credential_id='platform-1',credential_reference='platform_credentials:platform-1',
        credential_version=${Date.parse('2026-11-14T09:00:00.000Z')} WHERE scope='user';
    `);
    await expectRefusal('session_recovery_placement_transient', 'retry');
    sqlite.exec('UPDATE platform_credentials SET is_enabled=0');
    await expectRefusal('placement_sources_disabled', 'report');
  });
  it('does not let an unselected account hide revocation of the only selected source', async () => {
    sqlite.exec(`
      UPDATE credentials SET is_active=0 WHERE id='credential-1';
      INSERT INTO credentials (id,user_id,provider,credential_type,is_active,encrypted_token,iv,created_at,updated_at)
        VALUES ('unselected-credential','user-1','hetzner','cloud-provider',1,'encrypted','iv',
          '2026-11-14T09:00:00.000Z','2026-11-14T09:00:00.000Z');
      INSERT INTO capacity_sources (id,scope,owner_user_id,source_kind,provider,status,credential_source,
        credential_id,credential_reference,credential_version)
        VALUES ('unselected-source','user','user-1','cloud-provider-credential','hetzner','active','user',
          'unselected-credential','credentials:unselected-credential',${Date.parse('2026-11-14T09:00:00.000Z')});
    `);
    await expectRefusal('placement_sources_disabled', 'report');
  });
  it.each([
    ['disabled pool', `UPDATE capacity_pools SET status='disabled' WHERE scope='user'`],
    ['disabled source', `UPDATE capacity_sources SET status='disabled' WHERE scope='user'`],
    [
      'excluded source',
      `UPDATE capacity_pools SET excluded_source_ids_json=(SELECT json_group_array(id) FROM capacity_sources WHERE scope='user') WHERE scope='user'`,
    ],
    ['revoked credential', `UPDATE credentials SET is_active=0 WHERE id='credential-1'`],
    ['removed credential', `DELETE FROM credentials WHERE id='credential-1'`],
    [
      'rotated credential',
      `UPDATE credentials SET updated_at='2098-01-01T00:00:00.000Z' WHERE id='credential-1'`,
    ],
  ])('reports %s before pending-publication state', async (_name, mutation) => {
    sqlite.exec(mutation);
    const summary = await readDefaultPoolSummary(drizzle(env.DATABASE, { schema }), scope, {
      includeDisabled: true,
    });
    expect(summary?.effectiveState).toBe('source-disabled');
    await expectRefusal('placement_sources_disabled', 'report');
  });
  it.each([
    [
      'failed',
      `UPDATE capacity_pool_refreshes SET state='failed',last_error='Catalog refresh deadline exceeded' WHERE scope='user'`,
    ],
    ['expired', `UPDATE capacity_pool_refreshes SET deadline_at=${clock} WHERE scope='user'`],
    [
      'complete without publication',
      `UPDATE capacity_pool_refreshes SET state='complete' WHERE scope='user'`,
    ],
    ['no durable operation', `DELETE FROM capacity_pool_refreshes WHERE scope='user'`],
  ])(
    'reports an actionable %s bootstrap instead of retaining an endless wait',
    async (_name, mutation) => {
      sqlite.exec(mutation);
      await expectRefusal('placement_catalog_refresh_unavailable', 'report');
      expect(sqlite.prepare('SELECT recovery_error FROM session_snapshots').get()).toMatchObject({
        recovery_error: expect.stringContaining('Infrastructure'),
      });
    }
  );
  it.each([
    ['pending', "UPDATE capacity_pool_refreshes SET state='pending' WHERE scope='user'", true],
    [
      'queued',
      "UPDATE capacity_pool_refreshes SET state='pending',attempts=0,started_at=0,deadline_at=0 WHERE scope='user'",
      true,
    ],
    ['complete', "UPDATE capacity_pool_refreshes SET state='complete' WHERE scope='user'", false],
    [
      'failed replacement',
      "UPDATE capacity_pool_refreshes SET state='failed',last_error='Catalog refresh deadline exceeded' WHERE scope='user'",
      false,
    ],
    [
      'expired pending',
      `UPDATE capacity_pool_refreshes SET deadline_at=${clock} WHERE scope='user'`,
      false,
    ],
    ['no durable operation', "DELETE FROM capacity_pool_refreshes WHERE scope='user'", false],
  ] as const)(
    'classifies unavailable published picks with %s refresh work without spending a claim',
    async (_state, mutation, refreshPending) => {
      sqlite.exec(`UPDATE capacity_pools SET catalog_published_at='2026-11-14T09:00:00.000Z' WHERE scope='user';
        UPDATE capacity_pool_candidates SET catalog_availability='last-known-unavailable'`);
      sqlite.exec(mutation);
      const summary = await readDefaultPoolSummary(drizzle(env.DATABASE, { schema }), scope, {
        includeDisabled: true,
      });
      expect(summary).toMatchObject({
        catalogPublished: true,
        catalogRefreshPending: refreshPending,
        effectiveState: 'catalog-unavailable',
      });
      await expectRefusal(
        refreshPending
          ? 'session_recovery_placement_transient'
          : 'placement_catalog_refresh_unavailable',
        refreshPending ? 'retry' : 'report'
      );
      expect(sqlite.prepare('SELECT recovery_error FROM session_snapshots').get()).toMatchObject({
        recovery_error: refreshPending ? null : expect.stringContaining('Infrastructure'),
      });
      expect(sqlite.prepare("SELECT status FROM tasks WHERE id='task-1'").get()).toEqual({
        status: 'sleeping',
      });
    }
  );
});
