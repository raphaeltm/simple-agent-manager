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
  let getSession: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.nodes,
      schema.workspaces,
      schema.agentSessions,
      schema.sessionSnapshots,
      schema.tasks,
    ]);
    sqlite.exec(`CREATE UNIQUE INDEX idx_tasks_chat_session_id_unique ON tasks(chat_session_id)
      WHERE chat_session_id IS NOT NULL`);
    sqlite.exec(`CREATE UNIQUE INDEX idx_workspaces_chat_session_id_unique ON workspaces(chat_session_id)
      WHERE chat_session_id IS NOT NULL`);
    sqlite.exec(`INSERT INTO nodes (id, user_id, runtime, status, health_status) VALUES ('node','owner','vm','running','healthy');
      INSERT INTO workspaces (id,node_id,project_id,user_id,chat_session_id,status,updated_at)
        VALUES ('workspace','node','project','owner','chat','running','2026-11-12T00:00:00Z');
      INSERT INTO agent_sessions (id,workspace_id,user_id,status) VALUES ('agent','workspace','owner','running');
      INSERT INTO tasks (id,project_id,user_id,chat_session_id,workspace_id,status)
        VALUES ('task','project','owner','chat','workspace','in_progress');
      INSERT INTO session_snapshots (id,project_id,user_id,chat_session_id,runtime,recovery_status,
        recovery_task_id,recovery_workspace_id,recovery_attempt_id)
        VALUES ('snapshot','project','owner','chat','vm','restored','task','workspace','attempt');`);
    signal = vi.fn().mockResolvedValue(0);
    getSession = vi.fn().mockResolvedValue({
      id: 'chat',
      status: 'active',
      workspaceId: 'workspace',
      taskId: 'current-task',
    });
    env = {
      DATABASE: createSqliteD1(sqlite),
      PROJECT_DATA: {
        idFromName: (id: string) => id,
        get: () => ({ signalSessionWakeReady: signal, getSession }),
      },
    } as unknown as Env;
  });
  afterEach(() => sqlite.close());

  function mutateAfterTargetRead(mutation: string): void {
    const database = env.DATABASE;
    env.DATABASE = {
      prepare(query: string) {
        const statement = database.prepare(query);
        if (!query.startsWith('SELECT w.id AS workspace_id')) return statement;
        return {
          ...statement,
          bind(...values: unknown[]) {
            const bound = statement.bind(...values);
            return {
              ...bound,
              async first<T = unknown>(column?: string): Promise<T | null> {
                const row = await bound.first<T>(column);
                sqlite.exec(mutation);
                return row;
              },
            };
          },
        };
      },
    } as D1Database;
  }

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
    {
      name: 'node assignment',
      allowWake: true,
      mutation: "UPDATE workspaces SET node_id = 'replacement-node' WHERE id = 'workspace'",
    },
    {
      name: 'node assignment',
      allowWake: false,
      mutation: "UPDATE workspaces SET node_id = 'replacement-node' WHERE id = 'workspace'",
    },
    {
      name: 'workspace generation',
      allowWake: true,
      mutation: "UPDATE workspaces SET callback_generation = 'newer' WHERE id = 'workspace'",
    },
    {
      name: 'workspace generation',
      allowWake: false,
      mutation: "UPDATE workspaces SET callback_generation = 'newer' WHERE id = 'workspace'",
    },
  ])(
    'rejects committed restore with changed $name after lookup, allowWake=$allowWake',
    async ({ allowWake, mutation }) => {
      sqlite.exec(`INSERT INTO nodes (id,user_id,runtime,status,health_status)
      VALUES ('replacement-node','owner','vm','running','healthy')`);
      mutateAfterTargetRead(mutation);
      expect(
        await resolveVmPromptDeliveryTarget(env, 'project', 'chat', undefined, async () => null, {
          allowWake,
        })
      ).toMatchObject({ kind: 'retry' });
      expect(signal).not.toHaveBeenCalled();
      expect(getSession).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      'node assignment',
      "UPDATE workspaces SET node_id = 'replacement-node' WHERE id = 'workspace'",
    ],
    [
      'workspace generation',
      "UPDATE workspaces SET callback_generation = 'newer' WHERE id = 'workspace'",
    ],
  ])(
    'rejects committed restore with changed %s while readiness RPC completes',
    async (_name, mutation) => {
      sqlite.exec(`INSERT INTO nodes (id,user_id,runtime,status,health_status)
      VALUES ('replacement-node','owner','vm','running','healthy')`);
      signal.mockImplementation(async () => {
        sqlite.exec(mutation);
        return 0;
      });
      expect(
        await resolveVmPromptDeliveryTarget(env, 'project', 'chat', undefined, async () => null)
      ).toMatchObject({ kind: 'retry' });
      expect(signal).toHaveBeenCalledOnce();
      expect(getSession).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['task owner', "UPDATE tasks SET user_id = 'foreign'"],
    ['snapshot owner', "UPDATE session_snapshots SET user_id = 'foreign'"],
    ['agent owner', "UPDATE agent_sessions SET user_id = 'foreign'"],
    ['node owner', "UPDATE nodes SET user_id = 'foreign'"],
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

  describe('a distinct committed start after a historical restore', () => {
    beforeEach(() => {
      sqlite.exec(`INSERT INTO workspaces (id,node_id,project_id,user_id,chat_session_id,status,updated_at)
          VALUES ('older-workspace','node','project','owner',NULL,'deleted','2026-11-11T00:00:00Z');
        UPDATE tasks SET workspace_id = 'older-workspace', status = 'delegated', chat_session_id = NULL WHERE id = 'task';
        UPDATE session_snapshots SET recovery_workspace_id = 'older-workspace';
        INSERT INTO tasks (id,project_id,user_id,chat_session_id,workspace_id,status)
          VALUES ('current-task','project','owner','chat','workspace','in_progress');
        UPDATE nodes SET user_id = 'owner';`);
      signal.mockResolvedValue(null);
    });

    it.each([true, false])(
      'admits an independently committed active chat, allowWake=%s',
      async (allowWake) => {
        const guard = vi.fn(async () => null);
        const before = sqlite.prepare('SELECT total_changes() AS count').get();
        expect(
          await resolveVmPromptDeliveryTarget(env, 'project', 'chat', undefined, guard, {
            allowWake,
          })
        ).toMatchObject({
          kind: 'ready',
          target: { workspaceId: 'workspace', agentSessionId: 'agent' },
        });
        expect(signal).not.toHaveBeenCalled();
        expect(guard).not.toHaveBeenCalled();
        expect(getSession).toHaveBeenCalledExactlyOnceWith('chat');
        expect(sqlite.prepare('SELECT total_changes() AS count').get()).toEqual(before);
      }
    );

    it('admits an unchanged explicit workspace generation', async () => {
      sqlite.exec(
        "UPDATE workspaces SET callback_generation = 'generation-1' WHERE id = 'workspace'"
      );
      expect(
        await resolveVmPromptDeliveryTarget(env, 'project', 'chat', undefined, async () => null, {
          allowWake: false,
        })
      ).toMatchObject({ kind: 'ready' });
      expect(signal).not.toHaveBeenCalled();
    });

    it.each([true, false])(
      'revalidates exact D1 authority after ProjectData, allowWake=%s',
      async (allowWake) => {
        const queries: string[] = [];
        const database = env.DATABASE;
        env.DATABASE = {
          prepare(query: string) {
            if (query.startsWith('SELECT current.id AS task_id')) queries.push(query);
            return database.prepare(query);
          },
        } as D1Database;
        expect(
          await resolveVmPromptDeliveryTarget(env, 'project', 'chat', undefined, async () => null, {
            allowWake,
          })
        ).toMatchObject({ kind: 'ready' });
        expect(getSession).toHaveBeenCalledExactlyOnceWith('chat');
        expect(queries).toHaveLength(2);
        expect(queries[1]).toContain('AND current.id = ?');
        expect(signal).not.toHaveBeenCalled();
      }
    );

    const duringProjectDataMutations = [
      [
        'node assignment',
        "UPDATE workspaces SET node_id = 'replacement-node' WHERE id = 'workspace'",
      ],
      [
        'workspace generation',
        "UPDATE workspaces SET callback_generation = 'newer' WHERE id = 'workspace'",
      ],
      ['snapshot attempt', "UPDATE session_snapshots SET recovery_attempt_id = 'newer'"],
      [
        'current task cancellation',
        "UPDATE tasks SET status = 'cancelled' WHERE id = 'current-task'",
      ],
      [
        'current task workspace',
        "UPDATE tasks SET workspace_id = 'older-workspace' WHERE id = 'current-task'",
      ],
      [
        'current task replacement',
        `UPDATE tasks SET status = 'cancelled', chat_session_id = NULL WHERE id = 'current-task';
        INSERT INTO tasks (id,project_id,user_id,chat_session_id,workspace_id,status)
        VALUES ('replacement-task','project','owner','chat','workspace','in_progress')`,
      ],
    ];
    it.each(
      duringProjectDataMutations.flatMap(([name, mutation]) => [
        { name, mutation, allowWake: true },
        { name, mutation, allowWake: false },
      ])
    )(
      'rejects $name changing during ProjectData read, allowWake=$allowWake',
      async ({ mutation, allowWake }) => {
        sqlite.exec(`INSERT INTO nodes (id,user_id,runtime,status,health_status)
        VALUES ('replacement-node','owner','vm','running','healthy')`);
        getSession.mockImplementation(async () => {
          sqlite.exec(mutation);
          return { id: 'chat', status: 'active', workspaceId: 'workspace', taskId: 'current-task' };
        });
        expect(
          await resolveVmPromptDeliveryTarget(env, 'project', 'chat', undefined, async () => null, {
            allowWake,
          })
        ).toMatchObject({ kind: 'retry' });
        expect(getSession).toHaveBeenCalledExactlyOnceWith('chat');
        expect(signal).not.toHaveBeenCalled();
      }
    );

    it.each([
      {
        name: 'node assignment',
        allowWake: true,
        mutation: "UPDATE workspaces SET node_id = 'replacement-node' WHERE id = 'workspace'",
      },
      {
        name: 'node assignment',
        allowWake: false,
        mutation: "UPDATE workspaces SET node_id = 'replacement-node' WHERE id = 'workspace'",
      },
      {
        name: 'workspace generation',
        allowWake: true,
        mutation: "UPDATE workspaces SET callback_generation = 'newer' WHERE id = 'workspace'",
      },
      {
        name: 'workspace generation',
        allowWake: false,
        mutation: "UPDATE workspaces SET callback_generation = 'newer' WHERE id = 'workspace'",
      },
    ])(
      'rejects a changed $name after lookup, allowWake=$allowWake',
      async ({ allowWake, mutation }) => {
        sqlite.exec(`INSERT INTO nodes (id,user_id,runtime,status,health_status)
        VALUES ('replacement-node','owner','vm','running','healthy')`);
        const database = env.DATABASE;
        env.DATABASE = {
          prepare(query: string) {
            // Keep both nodes valid; only the captured external target has become stale.
            if (query.startsWith('SELECT current.id AS task_id')) sqlite.exec(mutation);
            return database.prepare(query);
          },
        } as D1Database;
        expect(
          await resolveVmPromptDeliveryTarget(env, 'project', 'chat', undefined, async () => null, {
            allowWake,
          })
        ).toMatchObject({ kind: 'retry' });
        expect(signal).not.toHaveBeenCalled();
        expect(getSession).not.toHaveBeenCalled();
      }
    );

    it.each([
      [
        'same task rebound',
        "UPDATE tasks SET workspace_id = 'workspace', status = 'in_progress' WHERE id = 'task'",
      ],
      ['historical task owner', "UPDATE tasks SET user_id = 'foreign' WHERE id = 'task'"],
      ['historical task project', "UPDATE tasks SET project_id = 'foreign' WHERE id = 'task'"],
      ['current task cancelled', "UPDATE tasks SET status = 'cancelled' WHERE id = 'current-task'"],
      [
        'current task uncommitted',
        "UPDATE tasks SET status = 'delegated' WHERE id = 'current-task'",
      ],
      ['current task owner', "UPDATE tasks SET user_id = 'foreign' WHERE id = 'current-task'"],
      ['current task project', "UPDATE tasks SET project_id = 'foreign' WHERE id = 'current-task'"],
      [
        'current task chat',
        "UPDATE tasks SET chat_session_id = 'foreign' WHERE id = 'current-task'",
      ],
      [
        'current task workspace',
        "UPDATE tasks SET workspace_id = 'older-workspace' WHERE id = 'current-task'",
      ],
      ['snapshot owner', "UPDATE session_snapshots SET user_id = 'foreign'"],
      ['node owner', "UPDATE nodes SET user_id = 'foreign'"],
    ])('rejects a changed %s', async (_name, mutation) => {
      sqlite.exec(mutation);
      expect(
        await resolveVmPromptDeliveryTarget(env, 'project', 'chat', undefined, async () => null, {
          allowWake: false,
        })
      ).toMatchObject({ kind: 'retry' });
      expect(signal).not.toHaveBeenCalled();
    });

    it.each([
      ['recovery attempt', "UPDATE session_snapshots SET recovery_attempt_id = 'newer'"],
      ['recovery task', "UPDATE session_snapshots SET recovery_task_id = 'current-task'"],
    ])('rejects a stale %s after target lookup', async (_name, mutation) => {
      const database = env.DATABASE;
      env.DATABASE = {
        prepare(query: string) {
          if (query.startsWith('SELECT 1 AS ready')) sqlite.exec(mutation);
          return database.prepare(query);
        },
      } as D1Database;
      expect(
        await resolveVmPromptDeliveryTarget(env, 'project', 'chat', undefined, async () => null, {
          allowWake: false,
        })
      ).toMatchObject({ kind: 'retry' });
      expect(signal).not.toHaveBeenCalled();
    });

    it.each([
      null,
      { id: 'chat', status: 'sleeping', workspaceId: 'workspace', taskId: 'current-task' },
      { id: 'chat', status: 'stopped', workspaceId: 'workspace', taskId: 'current-task' },
      { id: 'chat', status: 'active', workspaceId: 'older-workspace', taskId: 'current-task' },
      { id: 'chat', status: 'active', workspaceId: 'workspace', taskId: 'task' },
      { id: 'foreign', status: 'active', workspaceId: 'workspace', taskId: 'current-task' },
      { id: 'chat', status: 'active', workspaceId: 'workspace', taskId: 1 },
    ])('rejects missing, stale or malformed ProjectData linkage %j', async (session) => {
      getSession.mockResolvedValue(session);
      expect(
        await resolveVmPromptDeliveryTarget(env, 'project', 'chat', undefined, async () => null, {
          allowWake: false,
        })
      ).toMatchObject({ kind: 'retry' });
      expect(signal).not.toHaveBeenCalled();
    });
  });
});
