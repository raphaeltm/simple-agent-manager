import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { OperatorController } from '../../../src/durable-objects/sam-session/operator/controller';
import { operatorTools } from '../../../src/durable-objects/sam-session/operator/operations';
import type { Env } from '../../../src/env';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
import { createSqlStorage } from './sql-storage-test-utils';

const databases: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((database) => database.close());
});

function fixture() {
  const database = new Database(':memory:');
  const privateDatabase = new Database(':memory:');
  databases.push(database, privateDatabase);
  createSchemaTables(database, [
    schema.users,
    schema.projects,
    schema.projectMembers,
    schema.tasks,
    schema.taskStatusEvents,
    schema.platformSettings,
    schema.agentProfiles,
    schema.sessionSnapshots,
  ]);
  database.exec(`
    INSERT INTO users(id,name,email,status,role) VALUES
      ('alice','Alice','alice@example.com','active','user'),
      ('bob','Bob','bob@example.com','active','user');
    INSERT INTO projects(id,name,status) VALUES
      ('project-alice','Alice project','active'),
      ('project-bob','Bob project','active');
    INSERT INTO project_members(project_id,user_id,role,status) VALUES
      ('project-alice','alice','owner','active'),
      ('project-bob','bob','owner','active');
    INSERT INTO tasks(id,project_id,user_id,title,status,task_mode,created_at,updated_at)
      VALUES('task-alice','project-alice','alice','Existing queued work','queued','task',
        '2026-10-20T00:00:00.000Z','2026-10-20T00:00:00.000Z');
  `);
  const env = {
    DATABASE: createSqliteD1(database),
    BASE_DOMAIN: 'example.com',
    PROJECT_DATA: {
      idFromName: (projectId: string) => projectId,
      get: () => ({
        recordActivityEvent: vi.fn(async () => undefined),
        admitProjectEvent: vi.fn(async () => ({ accepted: true, deduplicated: false })),
      }),
    },
  } as unknown as Env;
  const ctx = {
    storage: {
      transactionSync: <T>(callback: () => T) => privateDatabase.transaction(callback)(),
      setAlarm: vi.fn(async () => undefined),
      deleteAlarm: vi.fn(async () => undefined),
    },
    waitUntil: vi.fn(),
  } as unknown as DurableObjectState;
  const controller = new OperatorController(ctx, env, createSqlStorage(privateDatabase));
  controller.store.bindUser('alice');
  controller.store.setEnabled(true);
  return { database, env, controller };
}

function request(path: string, body: unknown, method = 'POST') {
  return new Request(`https://sam-session${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-sam-user-id': 'alice' },
    body: JSON.stringify(body),
  });
}

function toolsFor(f: ReturnType<typeof fixture>) {
  const { turn } = f.controller.store.accept('turn-key', 'Record the requested project idea');
  f.controller.store.setState(turn.id, 'running');
  const tools = operatorTools({
    env: f.env,
    store: f.controller.store,
    turn,
    userId: 'alice',
    executionContext: { waitUntil: vi.fn() },
    assertCurrent: () => {
      if (!f.controller.enabled() || !f.controller.store.isCurrent(turn)) {
        throw new Error('Turn fenced');
      }
    },
    onDispatch: vi.fn(),
  });
  return {
    turn,
    execute: (name: string, input: unknown) =>
      (tools[name]!.execute as (input: unknown) => Promise<unknown>)(input),
  };
}

/** Pause a real D1 read, preserving the actual SQL and returned membership row. */
function pauseMembershipRead(env: Env, table = 'project_members') {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const database = env.DATABASE;
  env.DATABASE = {
    ...database,
    prepare(sql: string) {
      const statement = database.prepare(sql);
      if (!sql.includes(`"${table}"`)) return statement;
      return {
        ...statement,
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          return {
            ...bound,
            async raw<T>(options?: { columnNames: boolean }) {
              const rows = await bound.raw<T>(options);
              entered();
              await gate;
              return rows;
            },
          };
        },
      } as D1PreparedStatement;
    },
  } as D1Database;
  return { waiting, release };
}

describe('SAM operator authorization and effect fencing', () => {
  it('executes an authorized idea once and returns the durable receipt on a repeated tool call', async () => {
    const f = fixture();
    const { execute, turn } = toolsFor(f);
    const input = { projectId: 'project-alice', title: 'Authorized idea' };
    const first = await execute('sam_idea_create', input);
    expect(first).toMatchObject({ title: input.title, status: 'draft' });
    expect(await execute('sam_idea_create', input)).toEqual(first);
    expect(f.database.prepare("SELECT id FROM tasks WHERE status='draft'").all()).toHaveLength(1);
    expect(f.controller.store.actions(turn.id)).toMatchObject([{ state: 'completed' }]);
  });

  it('cannot create work in another user’s project or after membership removal', async () => {
    const f = fixture();
    const { execute } = toolsFor(f);
    await execute('sam_idea_create', { projectId: 'project-bob', title: 'Must not exist' });
    f.database.prepare("UPDATE project_members SET status='removed' WHERE user_id='alice'").run();
    await execute('sam_idea_create', { projectId: 'project-alice', title: 'Also forbidden' });
    expect(f.database.prepare("SELECT id FROM tasks WHERE status='draft'").all()).toEqual([]);
  });

  it('does not expose cached project read results in turn history after membership revocation', async () => {
    const f = fixture();
    const canary = 'PRIVATE_REVOKED_PROJECT_TASK_CANARY';
    f.database.prepare("UPDATE tasks SET title=? WHERE id='task-alice'").run(canary);
    const { execute } = toolsFor(f);
    expect(
      await execute('sam_task_get', {
        projectId: 'project-alice',
        taskId: 'task-alice',
      })
    ).toMatchObject({ title: canary });
    f.database.prepare("UPDATE project_members SET status='removed' WHERE user_id='alice'").run();
    const response = await f.controller.handle(
      new Request('https://sam-session/turns', {
        headers: { 'x-sam-user-id': 'alice' },
      })
    );
    expect(response?.status).toBe(200);
    expect(await response?.text()).not.toContain(canary);
  });

  it.each([
    { operation: 'sam_chat_start', endpoint: 'reconcile' },
    { operation: 'sam_work_stop', endpoint: 'confirm' },
  ])(
    'redacts a completed $operation receipt on repeated $endpoint after project revocation',
    async ({ operation, endpoint }) => {
      const f = fixture();
      const { turn } = toolsFor(f);
      const canary = 'REVOKED_COMPLETED_RECEIPT_CANARY';
      f.database.prepare("UPDATE tasks SET id=? WHERE id='task-alice'").run(canary);
      const input =
        operation === 'sam_chat_start'
          ? { projectId: 'project-alice', message: 'Run the requested project task' }
          : { projectId: 'project-alice', taskId: canary };
      f.controller.store.reserveAction(
        'completed-action',
        turn.id,
        operation,
        JSON.stringify(input),
        false
      );
      f.controller.store.finishAction('completed-action', 'completed', {
        status: 'cancelled',
        taskId: canary,
        link: 'https://app.example.com/projects/project-alice',
      });
      f.controller.store.setState(turn.id, 'completed', 'Done');
      f.database.prepare("UPDATE project_members SET status='removed' WHERE user_id='alice'").run();
      const response = await f.controller.handle(
        request(`/actions/completed-action/${endpoint}`, { approved: true })
      );
      expect(response?.status).toBe(200);
      expect(await response?.text()).not.toContain(canary);
    }
  );

  it('redacts a shared-session write receipt when only the session grant is revoked', async () => {
    const f = fixture();
    f.database
      .prepare(
        "INSERT INTO project_members(project_id,user_id,role,status) VALUES('project-alice','bob','owner','active')"
      )
      .run();
    f.database
      .prepare(
        "INSERT INTO tasks(id,project_id,user_id,title,status,chat_session_id,task_mode) VALUES('task-bob','project-alice','bob','Shared session task','in_progress','session-bob','task')"
      )
      .run();
    let shared = true;
    const session = {
      id: 'session-bob',
      projectId: 'project-alice',
      createdByUserId: 'bob',
      status: 'active',
      taskId: 'task-bob',
      workspaceId: null,
      topic: 'Shared session',
      createdAt: 100,
      updatedAt: 100,
    };
    f.env.PROJECT_DATA = {
      idFromName: (projectId: string) => projectId,
      get: () => ({
        ensureProjectId: async () => undefined,
        getSessionAccess: async () => ({
          session,
          access: {
            found: true,
            ownerUserId: 'bob',
            sessionStatus: 'active',
            role: shared ? 'grantee' : 'none',
            grant: shared
              ? {
                  id: 'grant-alice',
                  sessionId: 'session-bob',
                  granteeUserId: 'alice',
                  grantedByUserId: 'bob',
                  parentGrantId: null,
                  createdAt: 100,
                  expiresAt: Date.now() + 300_000,
                  durationMinutes: 5,
                }
              : null,
          },
        }),
      }),
    } as unknown as Env['PROJECT_DATA'];
    const { turn } = toolsFor(f);
    const canary = 'REVOKED_SESSION_RECEIPT_CANARY';
    f.controller.store.reserveAction(
      'shared-action',
      turn.id,
      'sam_chat_send',
      JSON.stringify({
        projectId: 'project-alice',
        sessionId: 'session-bob',
        content: canary,
      }),
      false
    );
    f.controller.store.finishAction('shared-action', 'completed', {
      accepted: true,
      status: 'queued',
      deliveryId: 'delivery-bob',
      messageId: 'message-bob',
    });
    const history = () =>
      f.controller.handle(
        new Request('https://sam-session/turns', {
          headers: { 'x-sam-user-id': 'alice' },
        })
      );
    expect(await (await history())?.text()).toContain(canary);
    shared = false;
    expect(await (await history())?.text()).not.toContain(canary);
  });

  it('rejects a pending destructive confirmation after its turn is cancelled', async () => {
    const f = fixture();
    const { turn } = toolsFor(f);
    f.controller.store.reserveAction(
      'stop-action',
      turn.id,
      'sam_work_stop',
      JSON.stringify({ projectId: 'project-alice', taskId: 'task-alice' }),
      true
    );
    await f.controller.handle(request(`/turns/${turn.id}/cancel`, {}));
    await f.controller.handle(request('/actions/stop-action/confirm', { approved: true }));
    expect(f.database.prepare("SELECT status FROM tasks WHERE id='task-alice'").get()).toEqual({
      status: 'queued',
    });
    expect(f.controller.store.action('stop-action')?.state).toBe('rejected');
  });

  it('does not repeat an idea write after D1 commits but its response is lost', async () => {
    const f = fixture();
    const database = f.env.DATABASE;
    f.env.DATABASE = {
      ...database,
      prepare(sql: string) {
        const statement = database.prepare(sql);
        if (!sql.includes('INSERT INTO tasks')) return statement;
        return {
          ...statement,
          bind(...values: unknown[]) {
            const bound = statement.bind(...values);
            return {
              ...bound,
              async run() {
                await bound.run();
                throw new Error('D1 response connection lost after commit');
              },
            };
          },
        } as D1PreparedStatement;
      },
    } as D1Database;
    const { execute, turn } = toolsFor(f);
    const input = { projectId: 'project-alice', title: 'Committed but unacknowledged' };
    expect(await execute('sam_idea_create', input)).toMatchObject({ status: 'uncertain' });
    expect(await execute('sam_idea_create', input)).toMatchObject({ status: 'uncertain' });
    expect(f.database.prepare("SELECT title FROM tasks WHERE status='draft'").all()).toEqual([
      { title: input.title },
    ]);
    expect(f.controller.store.actions(turn.id)).toMatchObject([{ state: 'uncertain' }]);
  });

  it('does not create an idea when disabled during project authorization', async () => {
    const f = fixture();
    const { execute } = toolsFor(f);
    const paused = pauseMembershipRead(f.env);
    const pending = execute('sam_idea_create', {
      projectId: 'project-alice',
      title: 'Fenced idea',
    });
    await paused.waiting;
    const disabled = await f.controller.handle(request('/settings', { enabled: false }, 'PATCH'));
    expect(disabled?.status).toBe(200);
    paused.release();
    await pending;
    expect(f.database.prepare("SELECT id FROM tasks WHERE status='draft'").all()).toEqual([]);
  });

  it('does not create an idea if the account is suspended during project authorization', async () => {
    const f = fixture();
    const { execute } = toolsFor(f);
    const paused = pauseMembershipRead(f.env);
    const pending = execute('sam_idea_create', {
      projectId: 'project-alice',
      title: 'Suspended while authorizing',
    });
    await paused.waiting;
    f.database.prepare("UPDATE users SET status='suspended' WHERE id='alice'").run();
    paused.release();
    await pending;
    expect(f.database.prepare("SELECT id FROM tasks WHERE status='draft'").all()).toEqual([]);
  });

  it('applies a live installation kill-switch edit before an in-flight write reaches its effect', async () => {
    const f = fixture();
    const { execute } = toolsFor(f);
    const paused = pauseMembershipRead(f.env);
    const pending = execute('sam_idea_create', {
      projectId: 'project-alice',
      title: 'Stopped by installation settings',
    });
    await paused.waiting;
    f.database
      .prepare('INSERT INTO platform_settings(key,value,updated_at,updated_by) VALUES(?,?,?,NULL)')
      .run('operations.samOperatorDisabled', 'true', '2026-10-20T00:00:00.000Z');
    paused.release();
    await pending;
    expect(f.database.prepare("SELECT id FROM tasks WHERE status='draft'").all()).toEqual([]);
  });

  it('does not queue a follow-up if SAM is disabled during profile mention enrichment', async () => {
    const f = fixture();
    f.database
      .prepare(
        "INSERT INTO agent_profiles(id,project_id,user_id,name,agent_type) VALUES('profile-coder','project-alice','alice','Coder','claude-code')"
      )
      .run();
    f.database
      .prepare("UPDATE tasks SET chat_session_id='session-alice' WHERE id='task-alice'")
      .run();
    f.database
      .prepare(
        "INSERT INTO session_snapshots(id,project_id,user_id,chat_session_id,runtime,status,manifest_r2_key,expires_at,sleep_status) VALUES('snapshot-alice','project-alice','alice','session-alice','vm','pending','snapshots/alice/manifest','2026-10-27T00:00:00.000Z','scheduled')"
      )
      .run();
    const acceptPromptDelivery = vi.fn(async () => ({
      message: { id: 'delivery-new', sessionId: 'session-alice', status: 'queued' },
      transcriptMessageId: 'message-new',
    }));
    f.env.PROJECT_DATA = {
      idFromName: (projectId: string) => projectId,
      get: () => ({
        ensureProjectId: async () => undefined,
        getSessionAccess: async () => ({
          session: {
            id: 'session-alice',
            projectId: 'project-alice',
            taskId: 'task-alice',
            createdByUserId: 'alice',
            status: 'active',
            workspaceId: null,
          },
          access: {
            found: true,
            ownerUserId: 'alice',
            sessionStatus: 'active',
            role: 'owner',
            grant: null,
          },
        }),
        acceptPromptDelivery,
      }),
    } as unknown as Env['PROJECT_DATA'];
    const { execute } = toolsFor(f);
    const paused = pauseMembershipRead(f.env, 'agent_profiles');
    const pending = execute('sam_chat_send', {
      projectId: 'project-alice',
      sessionId: 'session-alice',
      content: '@Coder please continue',
    });
    await paused.waiting;
    await f.controller.handle(request('/settings', { enabled: false }, 'PATCH'));
    paused.release();
    expect(await pending).toMatchObject({ status: 'uncertain' });
    expect(acceptPromptDelivery).not.toHaveBeenCalled();
    expect(
      f.database
        .prepare("SELECT sleep_status FROM session_snapshots WHERE id='snapshot-alice'")
        .get()
    ).toEqual({ sleep_status: 'scheduled' });
  });

  it('does not issue any new action after the account is suspended', async () => {
    const f = fixture();
    const { execute } = toolsFor(f);
    f.database.prepare("UPDATE users SET status='suspended' WHERE id='alice'").run();
    await expect(
      execute('sam_idea_create', {
        projectId: 'project-alice',
        title: 'Suspended action',
      })
    ).rejects.toThrow('Account is not active');
    expect(f.database.prepare("SELECT id FROM tasks WHERE status='draft'").all()).toEqual([]);
  });
});
