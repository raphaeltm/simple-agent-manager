import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { cancelTask } from '../../src/services/cancel-task';
import { retireTaskCancellationPrompts } from '../../src/services/task-cancellation-prompts';
import { cleanupTerminalTaskResources } from '../../src/services/task-terminal-cleanup';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  retire: vi.fn(),
  link: vi.fn(),
  stop: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock('../../src/services/project-data', () => ({
  cancelUnissuedSessionPrompts: mocks.retire,
  linkSessionToTask: mocks.link,
  stopSession: mocks.stop,
  recordActivityEvent: vi.fn(async () => undefined),
}));
vi.mock('../../src/services/task-runner', () => ({ cleanupTaskRun: mocks.cleanup }));
vi.mock('../../src/services/vm-admission-control', () => ({
  cancelVmTaskAdmission: vi.fn(async () => undefined),
}));
vi.mock('../../src/services/project-lifecycle-events', () => ({
  recordTaskLifecycleEventBestEffort: vi.fn(async () => undefined),
}));

let sqlite: Database.Database;
let env: Env;
let db: ReturnType<typeof drizzle<typeof schema>>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.retire.mockResolvedValue({ matched: true, cancelled: 1 });
  mocks.link.mockResolvedValue(true);
  mocks.stop.mockResolvedValue(true);
  mocks.cleanup.mockResolvedValue(undefined);
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  env = { DATABASE: createSqliteD1(sqlite) } as Env;
  db = drizzle(env.DATABASE, { schema });
  sqlite.exec(`INSERT INTO users(id,name,email) VALUES('owner','Owner','owner@example.test');
    INSERT INTO projects(id,user_id,name,repository) VALUES('project','owner','Project','org/repo');
    INSERT INTO workspaces(id,user_id,name,status,project_id,chat_session_id,created_at,updated_at)
      VALUES('workspace','owner','Workspace','running','project','chat','2026-11-17T00:00:00Z','2026-11-17T00:00:00Z');
    INSERT INTO tasks(id,project_id,user_id,title,status,chat_session_id,workspace_id,created_by,created_at,updated_at)
      VALUES('task','project','owner','Task','cancelled','chat','workspace','owner','2026-11-17T00:00:00Z','2026-11-17T00:00:00Z');`);
});
afterEach(() => sqlite.close());

describe('task cancellation persistence and compute boundaries', () => {
  it.each(['retire', 'stop'] as const)(
    'still tears down compute when %s RPC fails, then reports failure',
    async (operation) => {
      mocks[operation].mockRejectedValueOnce(new Error('ProjectData unavailable'));
      await expect(
        cleanupTerminalTaskResources(env, 'task', {
          status: 'cancelled',
          requiredUserId: 'owner',
        })
      ).rejects.toThrow('ProjectData unavailable');
      expect(mocks.cleanup).toHaveBeenCalledWith('task', env, undefined, 'owner');
      if (operation === 'retire') expect(mocks.stop).not.toHaveBeenCalled();
    }
  );

  it('does not tear down compute after the callback authority is revoked', async () => {
    let revoked = false;
    mocks.retire.mockImplementationOnce(async () => {
      revoked = true;
      throw new Error('ProjectData unavailable');
    });
    await expect(
      cleanupTerminalTaskResources(env, 'task', {
        status: 'cancelled',
        requiredUserId: 'owner',
        beforeSideEffect: async () => {
          if (revoked) throw new Error('stale callback');
        },
      })
    ).rejects.toThrow('stale callback');
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it('cancels a historical task without stopping its successor conversation', async () => {
    sqlite.exec("UPDATE tasks SET status='in_progress' WHERE id='task'");
    mocks.retire.mockResolvedValue({ matched: false, reason: 'task_mismatch', cancelled: 0 });
    const task = await db.select().from(schema.tasks).where(eq(schema.tasks.id, 'task')).get();
    await expect(cancelTask(env, db, task!, 'owner')).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.cleanup).toHaveBeenCalled();
  });

  it('repairs only a canonical NULL task binding with the existing guarded linker', async () => {
    mocks.retire
      .mockResolvedValueOnce({ matched: false, reason: 'task_unbound', cancelled: 0 })
      .mockResolvedValueOnce({ matched: true, cancelled: 1 });
    await expect(
      retireTaskCancellationPrompts(env, { id: 'task', projectId: 'project', userId: 'owner' })
    ).resolves.toMatchObject({ matched: true, cancelled: 1, sessionId: 'chat' });
    expect(mocks.link).toHaveBeenCalledWith(env, 'project', 'chat', 'task');
  });

  it('does not repair NULL for an old task with a newer recovery family member', async () => {
    sqlite.exec(`INSERT INTO tasks(id,project_id,user_id,title,status,recovery_source_task_id,created_by,created_at,updated_at)
      VALUES('successor','project','owner','Successor','in_progress','task','owner','2026-11-17T00:01:00Z','2026-11-17T00:01:00Z')`);
    mocks.retire.mockResolvedValue({ matched: false, reason: 'task_unbound', cancelled: 0 });
    await expect(
      retireTaskCancellationPrompts(env, { id: 'task', projectId: 'project', userId: 'owner' })
    ).resolves.toMatchObject({ matched: false, reason: 'task_unbound' });
    expect(mocks.link).not.toHaveBeenCalled();
  });

  it('does not repair NULL using only a workspace pointer', async () => {
    sqlite.exec("UPDATE tasks SET chat_session_id=NULL WHERE id='task'");
    mocks.retire.mockResolvedValue({ matched: false, reason: 'task_unbound', cancelled: 0 });
    await expect(
      retireTaskCancellationPrompts(env, { id: 'task', projectId: 'project', userId: 'owner' })
    ).resolves.toMatchObject({ matched: false, reason: 'task_unbound' });
    expect(mocks.link).not.toHaveBeenCalled();
  });

  it('independently fences stop by task identity after prompt retirement', async () => {
    await cleanupTerminalTaskResources(env, 'task', {
      status: 'cancelled',
      requiredUserId: 'owner',
    });
    expect(mocks.stop).toHaveBeenCalledWith(env, 'project', 'chat', { guard: { taskId: 'task' } });
  });
});
