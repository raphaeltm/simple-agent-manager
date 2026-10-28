import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { markSessionSnapshotSleeping } from '../../../src/services/session-snapshot-sleep-lifecycle';
import {
  attemptWorkspaceDeletion,
  loadWorkspaceDeletionIdentity,
} from '../../../src/services/workspace-deletion';
import { automaticDeletionPreservationAvailable } from '../../../src/services/workspace-deletion-preservation';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const network = vi.hoisted(() => ({ remove: vi.fn(), verify: vi.fn() }));
vi.mock('../../../src/services/node-agent', () => ({ deleteWorkspaceOnNode: network.remove }));
vi.mock('../../../src/services/session-snapshot-artifacts', async (importActual) => ({
  ...await importActual<typeof import('../../../src/services/session-snapshot-artifacts')>(),
  verifySessionSnapshotArtifactsForSleep: network.verify,
}));
vi.mock('../../../src/services/workspace-lifecycle-finalizer', () => ({
  finalizeWorkspaceLifecycleClosure: vi.fn(async () => ({})),
}));

const identity = {
  workspaceId: 'ws',
  nodeId: 'node',
  nodeUserId: 'owner',
  userId: 'owner',
  nodeRuntime: 'vm',
  nodeProviderInstanceId: 'server',
  nodeRuntimeIncarnationId: 'incarnation',
  workspaceGeneration: 'generation',
  projectId: 'project',
  chatSessionId: 'chat',
};

describe('automatic deletion preservation and generation fences — real SQL', () => {
  let sqlite: Database.Database;
  let env: Env;
  beforeEach(() => {
    vi.clearAllMocks();
    network.verify.mockResolvedValue(true);
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    env = { DATABASE: createSqliteD1(sqlite) } as Env;
    sqlite
      .prepare(
        `INSERT INTO nodes(id,user_id,runtime,provider_instance_id,runtime_incarnation_id) VALUES ('node','owner','vm','server','incarnation')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO workspaces(id,user_id,node_id,project_id,chat_session_id,status,eviction_generation) VALUES ('ws','owner','node','project','chat','sleeping','generation')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO session_snapshots(id,workspace_id,node_id,user_id,project_id,chat_session_id,status,degradation,sleep_status,sleeping_at,expires_at,snapshot_generation,cleanup_identity_json) VALUES ('snapshot','ws','node','owner','project','chat','available','none','sleeping','2026-10-28T00:00:00Z','2099-01-01T00:00:00Z','capture',?)`
      )
      .run(JSON.stringify({ ...identity, snapshotGeneration: 'capture', preserved: 1 }));
  });
  afterEach(() => sqlite.close());
  it('allows a fully verified sleep checkpoint for the exact owner/incarnation/generation', async () => {
    expect(await automaticDeletionPreservationAvailable(env, identity)).toBe(true);
    expect(network.verify).toHaveBeenCalledOnce();
  });
  it.each([
    'DELETE FROM session_snapshots',
    "UPDATE session_snapshots SET status = 'failed'",
    "UPDATE session_snapshots SET degradation = 'transcript-only'",
    'UPDATE session_snapshots SET cleanup_identity_json = NULL',
    "UPDATE session_snapshots SET capture_generation = 'pending'",
    "UPDATE session_snapshots SET sleep_status = 'failed'",
    'UPDATE session_snapshots SET sleep_status = NULL',
    "UPDATE session_snapshots SET user_id = 'other'",
    "UPDATE session_snapshots SET snapshot_generation = 'old-capture'",
    "UPDATE session_snapshots SET cleanup_identity_json = json_set(cleanup_identity_json, '$.workspaceGeneration','old-generation')",
    "UPDATE session_snapshots SET cleanup_identity_json = json_set(cleanup_identity_json, '$.nodeRuntimeIncarnationId','old-node')",
  ])('protects data when preservation authority is absent or stale: %s', async (sql) => {
    sqlite.exec(sql);
    expect(await automaticDeletionPreservationAvailable(env, identity)).toBe(false);
    expect(network.verify).not.toHaveBeenCalled();
  });
  it('grants preservation authority only to the completed snapshot generation', async () => {
    sqlite.exec("UPDATE session_snapshots SET cleanup_identity_json=json_remove(cleanup_identity_json,'$.preserved'),sleep_status='stopping',sleeping_at=NULL");
    const db = drizzle(env.DATABASE,{schema});
    expect(await markSessionSnapshotSleeping(db,env,'chat',new Date(),'stale-capture')).toBe(false);
    expect(await automaticDeletionPreservationAvailable(env,identity)).toBe(false);
    expect(await markSessionSnapshotSleeping(db,env,'chat',new Date(),'capture')).toBe(true);
    expect(await automaticDeletionPreservationAvailable(env,identity)).toBe(true);
  });
  it('permits a verified restored handoff while protecting missing or foreign targets', async () => {
    sqlite.exec(
      "UPDATE session_snapshots SET sleep_status=NULL,sleeping_at=NULL,recovery_status='restored',recovery_workspace_id='target',restored_at='2026-10-28T00:00:00Z'"
    );
    expect(await automaticDeletionPreservationAvailable(env, identity)).toBe(false);
    sqlite.exec(
      "INSERT INTO workspaces(id,user_id,node_id,project_id,chat_session_id,status) VALUES ('target','other','target-node','project','chat','running')"
    );
    expect(await automaticDeletionPreservationAvailable(env, identity)).toBe(false);
    sqlite.exec("UPDATE workspaces SET user_id='owner' WHERE id='target'");
    expect(await automaticDeletionPreservationAvailable(env, identity)).toBe(true);
  });
  it('allows the same durable operation to physically delete a verified preserved source', async () => {
    network.remove.mockResolvedValueOnce(undefined);
    expect(
      await attemptWorkspaceDeletion({
        env,
        expected: identity,
        attempt: 1,
        source: 'test',
        mode: 'automatic',
      })
    ).toMatchObject({ status: 'confirmed', proof: 'vm_agent_confirmed' });
    expect(sqlite.prepare('SELECT status,runtime_deletion_proof FROM workspaces').get()).toEqual({
      status: 'deleted',
      runtime_deletion_proof: 'vm_agent_confirmed',
    });
  });
  it('retains failed artifacts and makes no network deletion or stopping claim', async () => {
    network.verify.mockResolvedValue(false);
    const result = await attemptWorkspaceDeletion({
      env,
      expected: identity,
      attempt: 1,
      source: 'test',
      mode: 'automatic',
    });
    expect(result).toMatchObject({ status: 'retry', reason: 'preservation_unconfirmed' });
    expect(network.remove).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT status FROM workspaces').get()).toEqual({ status: 'sleeping' });
  });
  it('fences a restart on the same node and workspace ID before deletion', async () => {
    sqlite.exec("UPDATE workspaces SET eviction_generation = 'successor'");
    expect(
      await attemptWorkspaceDeletion({
        env,
        expected: identity,
        attempt: 1,
        source: 'test',
        mode: 'explicit',
      })
    ).toMatchObject({ status: 'fenced' });
    expect(network.remove).not.toHaveBeenCalled();
  });
  it('does not finalize a successor when an old deletion finishes late', async () => {
    network.remove.mockImplementationOnce(async () => {
      sqlite.exec("UPDATE workspaces SET eviction_generation='successor',status='running'");
    });
    expect(
      await attemptWorkspaceDeletion({
        env,
        expected: identity,
        attempt: 1,
        source: 'test',
        mode: 'explicit',
      })
    ).toMatchObject({ status: 'superseded' });
    expect(
      sqlite.prepare('SELECT status,runtime_deletion_confirmed_at FROM workspaces').get()
    ).toEqual({ status: 'running', runtime_deletion_confirmed_at: null });
  });
  it('loads the source generation as part of the durable operation identity', async () => {
    expect(await loadWorkspaceDeletionIdentity(env.DATABASE, 'ws')).toMatchObject(identity);
  });
});
