import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { destroyContainer } = vi.hoisted(() => ({ destroyContainer: vi.fn() }));
vi.mock('../../../src/services/vm-agent-container', () => ({
  destroyVmAgentContainer: destroyContainer,
}));
import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { requireNodeWorkspaceArtifactsDeleted } from '../../../src/services/node-workspace-retirement-guard';
import { deleteNodeResourcesStrict } from '../../../src/services/strict-node-deletion';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

describe('automatic node retirement physical artifact gate — real SQL', () => {
  let sqlite: Database.Database;
  let env: Env;
  beforeEach(() => {
    destroyContainer.mockReset();
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.nodes,
      schema.workspaces,
      schema.tasks,
      schema.sessionSnapshots,
    ]);
    sqlite.prepare('INSERT INTO nodes (id, user_id) VALUES (?, ?)').run('node', 'owner');
    sqlite
      .prepare(
        "UPDATE nodes SET node_class = 'managed', runtime = 'cf-container', status = 'stopped', runtime_incarnation_id = 'incarnation'"
      )
      .run();
    env = { DATABASE: createSqliteD1(sqlite) } as Env;
  });
  afterEach(() => sqlite.close());

  function workspace(status: string, proof: string | null = null, owner = 'owner') {
    sqlite
      .prepare(
        `INSERT INTO workspaces
      (id, node_id, user_id, status, runtime_deletion_confirmed_at, runtime_deletion_proof)
      VALUES ('ws', 'node', ?, ?, ?, ?)`
      )
      .run(owner, status, proof ? new Date().toISOString() : null, proof);
  }
  const check = () => requireNodeWorkspaceArtifactsDeleted(env, 'node', 'owner');

  it.each(['deleted', 'stopped', 'error', 'sleeping', 'evicted', 'stopping', 'running'])(
    'preserves %s workspace with unconfirmed local artifacts',
    async (status) => {
      workspace(status);
      await expect(check()).rejects.toThrow('unconfirmed workspace artifacts');
    }
  );
  it('allows a physically confirmed workspace tombstone', async () => {
    workspace('deleted', 'vm_agent_confirmed');
    await expect(check()).resolves.toBeUndefined();
  });
  it('rejects an unrecognized deletion proof classifier', async () => {
    workspace('deleted', 'unknown-proof');
    await expect(check()).rejects.toThrow('unconfirmed workspace artifacts');
  });
  it('rejects an unknown owner even with a deletion marker', async () => {
    workspace('deleted', 'vm_agent_confirmed', 'other-owner');
    await expect(check()).rejects.toThrow('unconfirmed workspace artifacts');
  });
  it('does not trust an old deletion proof on an active recreated workspace', async () => {
    workspace('running', 'vm_agent_confirmed');
    await expect(check()).rejects.toThrow('unconfirmed workspace artifacts');
  });
  it('preserves a recent pending placement before its workspace exists', async () => {
    sqlite
      .prepare(
        `INSERT INTO tasks
      (id, status, claimed_warm_node_id, claimed_warm_node_at)
      VALUES ('task', 'in_progress', 'node', ?)`
      )
      .run(new Date().toISOString());
    await expect(check()).rejects.toThrow('placement claim');
  });
  it('allows an empty node after an abandoned bounded placement expires', async () => {
    sqlite
      .prepare(
        `INSERT INTO tasks
      (id, status, claimed_warm_node_id, claimed_warm_node_at)
      VALUES ('task', 'in_progress', 'node', '2000-01-01T00:00:00.000Z')`
      )
      .run();
    await expect(check()).resolves.toBeUndefined();
  });
  it.each(['failed', 'available', 'pending'])(
    'preserves %s snapshot sources after workspace relocation',
    async (status) => {
      workspace('deleted', 'vm_agent_confirmed');
      sqlite
        .prepare(
          `INSERT INTO session_snapshots (id, workspace_id, node_id, user_id, status)
      VALUES ('snapshot', 'ws', 'node', 'owner', ?)`
        )
        .run(status);
      sqlite.prepare("UPDATE workspaces SET node_id = 'replacement-node'").run();
      await expect(check()).rejects.toThrow('unconfirmed workspace artifacts');
    }
  );
  it('allows snapshot retention after its exact source was physically cleaned', async () => {
    workspace('deleted', 'vm_agent_confirmed');
    sqlite
      .prepare(
        `INSERT INTO session_snapshots (id, workspace_id, node_id, user_id, status)
      VALUES ('snapshot', 'ws', 'node', 'owner', 'available')`
      )
      .run();
    await expect(check()).resolves.toBeUndefined();
  });
  it('strict automatic teardown blocks provider I/O for a logically deleted workspace', async () => {
    workspace('deleted');
    await expect(
      deleteNodeResourcesStrict('node', 'owner', env, { cleanupDns: false })
    ).rejects.toThrow('unconfirmed workspace artifacts');
    expect(destroyContainer).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT status FROM nodes').get()).toEqual({ status: 'stopped' });
  });
  it('strict teardown destroys a container only after physical workspace confirmation', async () => {
    workspace('deleted', 'vm_agent_confirmed');
    const result = await deleteNodeResourcesStrict('node', 'owner', env, { cleanupDns: false });
    expect(destroyContainer).toHaveBeenCalledExactlyOnceWith(env, 'node');
    expect(result.runtimeTerminationConfirmedAt).toBeTruthy();
  });
  it('strict termination proof can finalize already destroyed sources without new I/O', async () => {
    workspace('stopping');
    sqlite
      .prepare(
        "UPDATE nodes SET status = 'destroying', runtime_termination_confirmed_at = 'proof-at'"
      )
      .run();
    const result = await deleteNodeResourcesStrict('node', 'owner', env, { cleanupDns: false });
    expect(result.runtimeTerminationConfirmedAt).toBe('proof-at');
    expect(destroyContainer).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT runtime_deletion_confirmed_at FROM workspaces').get()).toEqual({
      runtime_deletion_confirmed_at: 'proof-at',
    });
  });
  it('rechecks workspace artifacts after claiming the node and before container destruction', async () => {
    const database = env.DATABASE;
    let checks = 0;
    env.DATABASE = {
      ...database,
      prepare(query: string) {
        if (query.includes('artifact_workspace') && ++checks === 2) workspace('stopped');
        return database.prepare(query);
      },
    } as D1Database;
    await expect(
      deleteNodeResourcesStrict('node', 'owner', env, { cleanupDns: false })
    ).rejects.toThrow('unconfirmed workspace artifacts');
    expect(checks).toBe(2);
    expect(destroyContainer).not.toHaveBeenCalled();
  });
  it('rejects stale node incarnation authority before any destructive I/O', async () => {
    await expect(
      deleteNodeResourcesStrict('node', 'owner', env, {
        cleanupDns: false,
        expectedRuntime: {
          userId: 'owner',
          runtime: 'cf-container',
          providerInstanceId: null,
          runtimeIncarnationId: 'previous-incarnation',
        },
      })
    ).rejects.toThrow('reincarnated');
    expect(destroyContainer).not.toHaveBeenCalled();
  });
  function exactContainerAuthority() {
    return {
      cleanupDns: false,
      expectedRuntime: {
        userId: 'owner',
        runtime: 'cf-container',
        providerInstanceId: null,
        runtimeIncarnationId: 'incarnation',
      },
      workspaceDeletion: {
        workspaceId: 'ws',
        workspaceGeneration: 'generation',
        beforeDestroy: vi.fn().mockResolvedValue(undefined),
      },
    };
  }
  function stoppingSource() {
    workspace('stopping');
    sqlite.prepare("UPDATE workspaces SET eviction_generation = 'generation'").run();
    sqlite
      .prepare(
        `INSERT INTO session_snapshots (id, workspace_id, node_id, user_id, status)
      VALUES ('snapshot', 'ws', 'node', 'owner', 'available')`
      )
      .run();
  }
  it('allows exact sleeping-container source deletion with preservation authority rechecked', async () => {
    stoppingSource();
    const authority = exactContainerAuthority();
    await deleteNodeResourcesStrict('node', 'owner', env, authority);
    expect(authority.workspaceDeletion.beforeDestroy).toHaveBeenCalledTimes(2);
    expect(destroyContainer).toHaveBeenCalledExactlyOnceWith(env, 'node');
  });
  it.each(['generation', 'owner', 'extra-workspace', 'unknown-snapshot', 'placement'])(
    'rejects %s mismatch beside an authorized container target',
    async (mismatch) => {
      stoppingSource();
      if (mismatch === 'generation')
        sqlite.prepare("UPDATE workspaces SET eviction_generation = 'successor'").run();
      if (mismatch === 'owner') sqlite.prepare("UPDATE workspaces SET user_id = 'unknown'").run();
      if (mismatch === 'extra-workspace')
        sqlite
          .prepare(
            `INSERT INTO workspaces
      (id, node_id, user_id, status) VALUES ('other', 'node', 'owner', 'deleted')`
          )
          .run();
      if (mismatch === 'unknown-snapshot')
        sqlite
          .prepare(
            `INSERT INTO session_snapshots
      (id, workspace_id, node_id, user_id) VALUES ('other-snapshot', 'unknown', 'node', 'owner')`
          )
          .run();
      if (mismatch === 'placement')
        sqlite
          .prepare(
            `INSERT INTO tasks
      (id, status, claimed_warm_node_id, claimed_warm_node_at)
      VALUES ('claim', 'in_progress', 'node', ?)`
          )
          .run(new Date().toISOString());
      await expect(
        deleteNodeResourcesStrict('node', 'owner', env, exactContainerAuthority())
      ).rejects.toThrow('unconfirmed workspace artifacts');
      expect(destroyContainer).not.toHaveBeenCalled();
    }
  );
  it('refuses loss of preservation authority immediately before container destruction', async () => {
    stoppingSource();
    const authority = exactContainerAuthority();
    authority.workspaceDeletion.beforeDestroy
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('preservation no longer available'));
    await expect(deleteNodeResourcesStrict('node', 'owner', env, authority)).rejects.toThrow(
      'preservation no longer available'
    );
    expect(destroyContainer).not.toHaveBeenCalled();
  });
  it('never uses exact container authority to force VM retirement', async () => {
    stoppingSource();
    sqlite.prepare("UPDATE nodes SET runtime = 'vm'").run();
    const authority = exactContainerAuthority();
    authority.expectedRuntime.runtime = 'vm';
    await expect(deleteNodeResourcesStrict('node', 'owner', env, authority)).rejects.toThrow(
      'container deletion authority is incomplete'
    );
    expect(destroyContainer).not.toHaveBeenCalled();
  });
  it('explicit permanent operator deletion retains its destructive authority', async () => {
    workspace('running');
    await deleteNodeResourcesStrict('node', 'owner', env, {
      cleanupDns: false,
      explicitPermanentDeletion: true,
    });
    expect(destroyContainer).toHaveBeenCalledExactlyOnceWith(env, 'node');
  });
  it('rejects a stale node owner', async () => {
    sqlite.prepare("UPDATE nodes SET user_id = 'successor'").run();
    await expect(check()).rejects.toThrow('unconfirmed workspace artifacts');
  });
});
