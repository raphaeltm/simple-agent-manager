/** Public cancellation writers share prompt retirement and atomic wake-claim revocation. */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { stopSubtask } from '../../src/durable-objects/sam-session/tools/stop-subtask';
import type { ToolContext } from '../../src/durable-objects/sam-session/types';
import type { Env } from '../../src/env';
import { stopChat } from '../../src/routes/chat-stop';
import { handleRemovePendingSubtask } from '../../src/routes/mcp/orchestration-dependency-tools';
import { handleStopSubtask } from '../../src/routes/mcp/orchestration-stop';
import { setTaskStatus } from '../../src/routes/tasks/_helpers';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const boundary = vi.hoisted(() => ({ retire: vi.fn() }));
vi.mock('../../src/services/project-data', () => ({
  cancelUnissuedSessionPrompts: (...args: unknown[]) => boundary.retire(...args),
  getSession: async () => ({
    id: 'chat',
    taskId: 'child',
    createdByUserId: 'user',
    status: 'sleeping',
  }),
  getSessionAccess: async () => ({
    session: { id: 'chat', taskId: 'child', createdByUserId: 'user', status: 'sleeping' },
    access: { found: true, role: 'owner', ownerUserId: 'user', grant: null },
  }),
  stopSession: vi.fn(async () => true),
}));
vi.mock('../../src/services/task-terminal-cleanup', () => ({
  cleanupTerminalTaskResources: vi.fn(),
}));
vi.mock('../../src/services/node-agent', () => ({ stopAgentSessionOnNode: vi.fn() }));

let sqlite: Database.Database;
afterEach(() => {
  sqlite?.close();
  vi.resetAllMocks();
  vi.useRealTimers();
});

const token = {
  taskId: 'parent',
  projectId: 'project',
  userId: 'user',
  workspaceId: 'parent-ws',
  createdAt: '2026-11-17T00:00:00Z',
};

describe('cancellation writer recovery contract', () => {
  it.each(
    (['mcp stop', 'sam stop', 'remove pending', 'chat archive'] as const).flatMap((writer) =>
      [false, true].map((fatalWins) => ({ writer, fatalWins }))
    )
  )(
    '$writer retires preparations and preserves a concurrent fatal verdict (fatal wins: $fatalWins)',
    async ({ writer, fatalWins }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
      sqlite = new Database(':memory:');
      createAllSchemaTables(sqlite, schema);
      const status = writer === 'remove pending' ? 'queued' : 'sleeping';
      sqlite.exec(`
        INSERT INTO users(id,email,status) VALUES('user','owner@example.test','active');
        INSERT INTO projects(id,user_id,name) VALUES('project','user','Project');
        INSERT INTO project_members(project_id,user_id,role,status) VALUES('project','user','owner','active');
        INSERT INTO tasks(id,project_id,user_id,title,status) VALUES('parent','project','user','Parent','in_progress');
        INSERT INTO nodes(id,user_id,status,runtime) VALUES('node','user','running','vm');
        INSERT INTO workspaces(id,user_id,project_id,node_id,chat_session_id,status)
          VALUES('workspace','user','project','node','chat','sleeping');
        INSERT INTO tasks(id,project_id,user_id,title,status,parent_task_id,workspace_id,chat_session_id)
          VALUES('child','project','user','Child','${status}','parent','workspace','chat');
        INSERT INTO agent_sessions(id,workspace_id,user_id,status) VALUES('agent','workspace','user','running');
        INSERT INTO session_snapshots(id,workspace_id,project_id,user_id,chat_session_id,runtime,status,
          degradation,manifest_r2_key,manifest_json,expires_at,sleeping_at,sleep_status,
          recovery_status,recovery_task_id,recovery_attempt_id,recovery_attempts)
          VALUES('snapshot','workspace','project','user','chat','vm','available','none','saved/manifest','{}',
          '2099-01-01T00:00:00Z','2026-11-17T00:00:00Z','sleeping','waking','child','old-attempt',1);
      `);
      const env = { DATABASE: createSqliteD1(sqlite) } as Env;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      boundary.retire.mockImplementationOnce(async () => {
        expect(sqlite.prepare("SELECT status FROM tasks WHERE id='child'").pluck().get()).toBe(
          status
        );
        expect(
          sqlite.prepare('SELECT recovery_attempt_id FROM session_snapshots').pluck().get()
        ).toBe('old-attempt');
        entered();
        await held;
        return { matched: true, cancelled: 1 };
      });
      const invoke = () =>
        writer === 'chat archive'
          ? stopChat(env, 'user', 'project', 'chat')
          : writer === 'mcp stop'
            ? handleStopSubtask(1, { taskId: 'child' }, token, env)
            : writer === 'remove pending'
              ? handleRemovePendingSubtask(1, { taskId: 'child' }, token, env)
              : stopSubtask({ taskId: 'child' }, { env, userId: 'user' } as unknown as ToolContext);
      const result = invoke();
      await started;
      expect(sqlite.prepare("SELECT status FROM tasks WHERE id='child'").pluck().get()).toBe(
        status
      );
      if (fatalWins) {
        const db = drizzle(env.DATABASE, { schema });
        const task = (await db.select().from(schema.tasks)).find((row) => row.id === 'child')!;
        await setTaskStatus(db, task, 'failed', 'system', null);
      }
      release();
      await expect(result).resolves.toBeTruthy();
      expect(boundary.retire).toHaveBeenCalledTimes(1);
      expect(sqlite.prepare("SELECT status FROM tasks WHERE id='child'").pluck().get()).toBe(
        fatalWins ? 'failed' : 'cancelled'
      );
      expect(
        sqlite
          .prepare(
            'SELECT recovery_attempt_id,recovery_status,status,recovery_attempts FROM session_snapshots'
          )
          .get()
      ).toEqual({
        recovery_attempt_id: fatalWins ? 'old-attempt' : null,
        recovery_status: fatalWins ? 'waking' : 'failed',
        status: 'available',
        recovery_attempts: 1,
      });
    }
  );
});
