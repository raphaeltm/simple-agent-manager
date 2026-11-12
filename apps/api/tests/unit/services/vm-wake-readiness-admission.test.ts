import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { resolveVmPromptDeliveryTarget } from '../../../src/services/vm-prompt-delivery-target';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

describe('committed VM wake readiness admission', () => {
  let sqlite: Database.Database;
  let env: Env;
  let signal: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.nodes,
      schema.workspaces,
      schema.agentSessions,
      schema.sessionSnapshots,
      schema.tasks,
    ]);
    sqlite.exec(`INSERT INTO nodes (id, runtime, status, health_status) VALUES ('node','vm','running','healthy');
      INSERT INTO workspaces (id,node_id,project_id,user_id,chat_session_id,status,updated_at)
        VALUES ('workspace','node','project','owner','chat','running','2026-11-12T00:00:00Z');
      INSERT INTO agent_sessions (id,workspace_id,user_id,status) VALUES ('agent','workspace','owner','running');
      INSERT INTO tasks (id,project_id,user_id,chat_session_id,workspace_id,status)
        VALUES ('task','project','owner','chat','workspace','in_progress');
      INSERT INTO session_snapshots (id,project_id,user_id,chat_session_id,runtime,recovery_status,
        recovery_task_id,recovery_workspace_id,recovery_attempt_id)
        VALUES ('snapshot','project','owner','chat','vm','restored','task','workspace','attempt');`);
    signal = vi.fn().mockResolvedValue(0);
    env = {
      DATABASE: createSqliteD1(sqlite),
      PROJECT_DATA: {
        idFromName: (id: string) => id,
        get: () => ({ signalSessionWakeReady: signal }),
      },
    } as unknown as Env;
  });
  afterEach(() => sqlite.close());

  it('read-only steering verifies committed authority without an activation RPC or SQLite mutation', async () => {
    const guard = vi.fn(async () => null);
    const before = sqlite.prepare('SELECT total_changes() AS count').get();
    expect(
      await resolveVmPromptDeliveryTarget(env, 'project', 'chat', undefined, guard, {
        allowWake: false,
      })
    ).toMatchObject({
      kind: 'ready',
      target: { agentSessionId: 'agent', workspaceId: 'workspace' },
    });
    expect(signal).not.toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT total_changes() AS count').get()).toEqual(before);
  });

  it.each([
    ['task owner', "UPDATE tasks SET user_id = 'foreign'"],
    ['snapshot owner', "UPDATE session_snapshots SET user_id = 'foreign'"],
    ['agent owner', "UPDATE agent_sessions SET user_id = 'foreign'"],
    ['task workspace', "UPDATE tasks SET workspace_id = 'replacement'"],
    ['snapshot workspace', "UPDATE session_snapshots SET recovery_workspace_id = 'replacement'"],
    ['recovery attempt', "UPDATE session_snapshots SET recovery_attempt_id = 'newer'"],
    ['cancelled task', "UPDATE tasks SET status = 'cancelled'"],
  ])(
    'read-only steering rejects a changed %s after target lookup, without activation',
    async (_name, mutation) => {
      const database = env.DATABASE;
      env.DATABASE = {
        prepare(query: string) {
          // Change authority after the optimistic target read, before its authoritative admission.
          if (query.startsWith('SELECT 1 AS ready')) sqlite.exec(mutation);
          return database.prepare(query);
        },
      } as D1Database;
      expect(
        await resolveVmPromptDeliveryTarget(env, 'project', 'chat', undefined, async () => null, {
          allowWake: false,
        })
      ).toMatchObject({ kind: 'retry', reason: 'Committed wake authority is no longer current' });
      expect(signal).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['snapshot workspace', "UPDATE session_snapshots SET recovery_workspace_id = 'replacement'"],
    ['cancelled task', "UPDATE tasks SET status = 'cancelled'"],
  ])(
    'read-only steering rejects a %s mismatch already present at lookup',
    async (_name, mutation) => {
      sqlite.exec(mutation);
      expect(
        await resolveVmPromptDeliveryTarget(env, 'project', 'chat', undefined, async () => null, {
          allowWake: false,
        })
      ).toMatchObject({ kind: 'retry' });
      expect(signal).not.toHaveBeenCalled();
    }
  );

  it.each([null, undefined, -1, 0.5, NaN, '0', 0, 2])(
    'a transported RPC result %s grants readiness only when authority accepted it',
    async (released) => {
      signal.mockResolvedValue(released);
      const accepted =
        typeof released === 'number' && Number.isSafeInteger(released) && released >= 0;
      expect(
        await resolveVmPromptDeliveryTarget(env, 'project', 'chat', undefined, async () => null)
      ).toMatchObject({ kind: accepted ? 'ready' : 'retry' });
      expect(signal).toHaveBeenCalledOnce();
    }
  );
});
