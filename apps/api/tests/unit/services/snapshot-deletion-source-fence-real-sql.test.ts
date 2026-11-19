import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { deleteSessionSnapshotState } from '../../../src/services/session-snapshot-persistence';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

let sqlite: Database.Database;
let env: Env;
let db: ReturnType<typeof drizzle<typeof schema>>;
const expected = {
  workspaceId: 'source',
  nodeId: 'node',
  userId: 'owner',
  projectId: 'project',
  chatSessionId: 'chat',
  workspaceGeneration: 'generation',
  nodeRuntimeIncarnationId: 'incarnation',
  nodeUserId: 'owner',
  nodeRuntime: 'vm',
  nodeProviderInstanceId: 'provider',
};
function insertSnapshot(workspaceId = 'source', generation = 'old') {
  sqlite
    .prepare(
      `INSERT INTO session_snapshots(id,workspace_id,node_id,user_id,project_id,chat_session_id,snapshot_generation,home_r2_key,manifest_r2_key,cleanup_identity_json) VALUES ('snapshot',?,'node','owner','project','chat',?,?,?,?)`
    )
    .run(
      workspaceId,
      generation,
      `${generation}/home`,
      `${generation}/manifest`,
      JSON.stringify({ ...expected, workspaceId, snapshotGeneration: generation })
    );
}
beforeEach(() => {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  env = {
    DATABASE: createSqliteD1(sqlite),
    R2: { delete: vi.fn(async () => {}) },
  } as unknown as Env;
  db = drizzle(env.DATABASE, { schema });
});
afterEach(() => sqlite.close());
it('does not delete a successor snapshot or objects when deleting a handoff source', async () => {
  insertSnapshot('successor');
  expect(await deleteSessionSnapshotState(db, env, 'chat', expected)).toBe(false);
  expect(env.R2.delete).not.toHaveBeenCalled();
  expect(sqlite.prepare('SELECT workspace_id FROM session_snapshots').get()).toEqual({
    workspace_id: 'successor',
  });
});
it('keeps a source-associated snapshot currently restoring or handed off to a successor', async () => {
  insertSnapshot();
  sqlite.exec(
    "UPDATE session_snapshots SET recovery_workspace_id='successor',recovery_status='waking'"
  );
  expect(await deleteSessionSnapshotState(db, env, 'chat', expected)).toBe(false);
  expect(env.R2.delete).not.toHaveBeenCalled();
});
it('preserves a newer source generation', async () => {
  insertSnapshot();
  sqlite.exec(
    "UPDATE session_snapshots SET cleanup_identity_json=json_set(cleanup_identity_json,'$.workspaceGeneration','new-generation')"
  );
  expect(await deleteSessionSnapshotState(db, env, 'chat', expected)).toBe(false);
  expect(env.R2.delete).not.toHaveBeenCalled();
});
it('never deletes successor metadata or keys inserted while old R2 cleanup is suspended', async () => {
  insertSnapshot();
  vi.mocked(env.R2.delete).mockImplementationOnce(async (keys) => {
    expect(keys).toEqual(['old/home', 'old/manifest']);
    expect(sqlite.prepare('SELECT id FROM session_snapshots').get()).toBeUndefined();
    insertSnapshot('successor', 'new');
  });
  expect(await deleteSessionSnapshotState(db, env, 'chat', expected)).toBe(true);
  expect(
    sqlite.prepare('SELECT workspace_id,snapshot_generation FROM session_snapshots').get()
  ).toEqual({ workspace_id: 'successor', snapshot_generation: 'new' });
});
it('retains retry metadata after R2 failure without overwriting a successor', async () => {
  insertSnapshot();
  vi.mocked(env.R2.delete).mockRejectedValueOnce(new Error('R2 unavailable'));
  await expect(deleteSessionSnapshotState(db, env, 'chat', expected)).rejects.toThrow(
    'R2 unavailable'
  );
  expect(sqlite.prepare('SELECT snapshot_generation FROM session_snapshots').get()).toEqual({
    snapshot_generation: 'old',
  });
  vi.mocked(env.R2.delete).mockImplementationOnce(async () => {
    insertSnapshot('successor', 'new');
    throw new Error('R2 unavailable');
  });
  await expect(deleteSessionSnapshotState(db, env, 'chat', expected)).rejects.toThrow(
    'R2 unavailable'
  );
  expect(
    sqlite.prepare('SELECT workspace_id,snapshot_generation FROM session_snapshots').get()
  ).toEqual({ workspace_id: 'successor', snapshot_generation: 'new' });
});
it('loses the exact generation CAS if a capture replaces the row before deletion', async () => {
  insertSnapshot();
  const original = env.DATABASE;
  let changed = false;
  env.DATABASE = new Proxy(original, {
    get(target, key) {
      if (key === 'prepare')
        return (query: string) => {
          if (!changed && query.startsWith('delete from')) {
            changed = true;
            sqlite.exec(
              "UPDATE session_snapshots SET snapshot_generation='new',home_r2_key='new/home',manifest_r2_key='new/manifest'"
            );
          }
          return target.prepare(query);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  db = drizzle(env.DATABASE, { schema });
  expect(await deleteSessionSnapshotState(db, env, 'chat', expected)).toBe(false);
  expect(env.R2.delete).not.toHaveBeenCalled();
  expect(sqlite.prepare('SELECT snapshot_generation FROM session_snapshots').get()).toEqual({
    snapshot_generation: 'new',
  });
});

it('loses the source CAS when a same-generation handoff starts before deletion', async () => {
  insertSnapshot();
  const original = env.DATABASE;
  let changed = false;
  env.DATABASE = new Proxy(original, {
    get(target, key) {
      if (key === 'prepare')
        return (query: string) => {
          if (!changed && query.startsWith('delete from')) {
            changed = true;
            sqlite.exec(
              "UPDATE session_snapshots SET recovery_workspace_id='successor',recovery_status='waking',recovery_attempt_id='wake-attempt'"
            );
          }
          return target.prepare(query);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  db = drizzle(env.DATABASE, { schema });
  expect(await deleteSessionSnapshotState(db, env, 'chat', expected)).toBe(false);
  expect(env.R2.delete).not.toHaveBeenCalled();
  expect(sqlite.prepare('SELECT recovery_workspace_id FROM session_snapshots').get()).toEqual({
    recovery_workspace_id: 'successor',
  });
});
