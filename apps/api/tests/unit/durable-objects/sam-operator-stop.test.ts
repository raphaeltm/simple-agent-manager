import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { OperatorController } from '../../../src/durable-objects/sam-session/operator/controller';
import type { Env } from '../../../src/env';
import { samWorkStop } from '../../../src/operations/connector-operations';
import * as nodeAgent from '../../../src/services/node-agent';
import { cleanupTerminalTaskResources } from '../../../src/services/task-terminal-cleanup';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
import { createSqlStorage } from './sql-storage-test-utils';

const databases: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((database) => database.close());
});

function fixture(sessionBacked: boolean, actor = 'owner') {
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
    schema.nodes,
    schema.workspaces,
    schema.agentSessions,
    schema.computeUsage,
    schema.sessionSnapshots,
    schema.vmTaskAdmissions,
    schema.taskSubmissionCheckpoints,
    schema.reservedTaskSessionRevocations,
  ]);
  database.exec(`
    INSERT INTO users(id,name,email,status,role) VALUES ('owner','Owner','owner@example.test','active','user'),('grantee','Grantee','grantee@example.test','active','user');
    INSERT INTO projects(id,name,status) VALUES ('project','Project','active');
    INSERT INTO project_members(project_id,user_id,role,status) VALUES ('project','owner','owner','active'),('project','grantee','maintainer','active');
    INSERT INTO nodes(id,user_id,name,status,runtime) VALUES ('node','owner','Node','running','vm');
    INSERT INTO workspaces(id,project_id,user_id,node_id,name,repository,vm_size,vm_location,status) VALUES ('workspace','project','owner','node','Workspace','org/repo','small','fsn1','running');
    INSERT INTO tasks(id,project_id,user_id,title,status,workspace_id) VALUES ('task','project','owner','Work','in_progress','workspace');
    INSERT INTO agent_sessions(id,workspace_id,user_id,agent_type,status) VALUES ('agent','workspace','owner','codex','running');
  `);
  if (sessionBacked)
    database.exec(
      "UPDATE tasks SET chat_session_id='chat'; UPDATE workspaces SET chat_session_id='chat'"
    );
  const session = {
    id: 'chat',
    taskId: 'task',
    workspaceId: 'workspace',
    createdByUserId: 'owner',
    status: 'active',
  };
  // Only external Node Agent and Durable Object boundaries are replaced. Authorization,
  // cleanup, SQL lifecycle writes, operation dispatch and receipt persistence are real.
  const stop = vi.spyOn(nodeAgent, 'stopWorkspaceOnNode').mockResolvedValue({ status: 'stopped' });
  vi.spyOn(nodeAgent, 'cancelAgentSessionOnNode').mockResolvedValue({});
  vi.spyOn(nodeAgent, 'stopAgentSessionOnNode').mockResolvedValue({});
  const scheduleDeletion = vi.fn(async () => undefined);
  const env = {
    DATABASE: createSqliteD1(database),
    BASE_DOMAIN: 'example.test',
    TASK_RUN_CLEANUP_DELAY_MS: '0',
    PROJECT_DATA: {
      idFromName: (id: string) => id,
      get: () => ({
        ensureProjectId: async () => undefined,
        getSession: async () => session,
        getSessionAccess: async ({ userId }: { userId: string }) => ({
          session,
          access: {
            found: true,
            ownerUserId: 'owner',
            role: userId === 'owner' ? 'owner' : 'grantee',
            grant: userId === 'owner' ? null : { id: 'grant' },
          },
        }),
        stopSession: async () => {
          session.status = 'stopped';
          return true;
        },
        recordActivityEvent: async () => undefined,
        admitProjectEvent: async () => ({ accepted: true, deduplicated: false }),
        cleanupWorkspaceActivity: async () => undefined,
      }),
    },
    NODE_LIFECYCLE: {
      idFromName: (id: string) => id,
      get: () => ({ scheduleWorkspaceDeletion: scheduleDeletion }),
    },
  } as unknown as Env;
  const ctx = {
    storage: {
      transactionSync: <T>(fn: () => T) => privateDatabase.transaction(fn)(),
      setAlarm: vi.fn(),
      deleteAlarm: vi.fn(),
    },
    waitUntil: vi.fn(),
  } as unknown as DurableObjectState;
  const controller = new OperatorController(ctx, env, createSqlStorage(privateDatabase));
  controller.store.bindUser(actor);
  controller.store.setEnabled(true);
  const { turn } = controller.store.accept('stop-turn', 'Stop this work');
  controller.store.setState(turn.id, 'running');
  const input = {
    projectId: 'project',
    ...(sessionBacked ? { sessionId: 'chat' } : { taskId: 'task' }),
    requestKey: 'stop-key',
  };
  controller.store.reserveAction(
    'stop-action',
    turn.id,
    'sam_work_stop',
    JSON.stringify(input),
    true
  );
  const confirm = () =>
    controller.handle(
      new Request('https://sam-session/actions/stop-action/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sam-user-id': actor },
        body: JSON.stringify({ approved: true }),
      })
    );
  return { database, controller, stop, scheduleDeletion, confirm, env };
}

describe('SAM confirmed stop acknowledgement through real cleanup and SQLite', () => {
  it('rejects a strict terminal cleanup whose task disappeared before cleanup', async () => {
    const f = fixture(false);
    f.database.exec('DELETE FROM tasks');
    await expect(
      cleanupTerminalTaskResources(f.env, 'task', {
        status: 'cancelled',
        requireStopAcknowledgement: true,
      })
    ).rejects.toThrow('SAM stop target');
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.database.prepare('SELECT status FROM workspaces').get()).toEqual({
      status: 'running',
    });
  });

  it.each(['completed', 'failed'])(
    'does not substitute queued sleep/preservation for a %s task stop',
    async (status) => {
      const f = fixture(false);
      f.database.prepare('UPDATE tasks SET status=?').run(status);
      f.database.exec("UPDATE workspaces SET chat_session_id='chat'");
      await f.confirm();
      expect(f.controller.store.action('stop-action')?.state).toBe('uncertain');
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.database.prepare('SELECT status FROM workspaces').get()).toEqual({
        status: 'running',
      });
      expect(f.database.prepare('SELECT COUNT(*) AS count FROM session_snapshots').get()).toEqual({
        count: 0,
      });
    }
  );

  it.each(['stopped', 'creating', 'sleeping', 'error', 'stopping'])(
    'does not certify an unacknowledged %s workspace',
    async (status) => {
      const f = fixture(true);
      f.database.prepare('UPDATE workspaces SET status=?').run(status);
      await f.confirm();
      expect(f.controller.store.action('stop-action')?.state).toBe('uncertain');
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.scheduleDeletion).not.toHaveBeenCalled();
      expect(f.database.prepare('SELECT status FROM workspaces').get()).toEqual({ status });
      await f.confirm();
      expect(f.stop).not.toHaveBeenCalled();
    }
  );

  it.each(['workspace-owner', 'node-owner', 'node-missing', 'workspace-node-missing'])(
    'does not certify ambiguous resource identity (%s)',
    async (variant) => {
      const f = fixture(false);
      if (variant === 'workspace-owner') f.database.exec("UPDATE workspaces SET user_id='grantee'");
      if (variant === 'node-owner') f.database.exec("UPDATE nodes SET user_id='grantee'");
      if (variant === 'node-missing') f.database.exec('DELETE FROM nodes');
      if (variant === 'workspace-node-missing')
        f.database.exec('UPDATE workspaces SET node_id=NULL');
      await f.confirm();
      expect(f.controller.store.action('stop-action')?.state).toBe('uncertain');
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.scheduleDeletion).not.toHaveBeenCalled();
      expect(f.database.prepare('SELECT status FROM workspaces').get()).toEqual({
        status: 'running',
      });
    }
  );

  it('accepts a genuinely absent workspace without dispatching a stop', async () => {
    const f = fixture(false);
    f.database.exec('DELETE FROM workspaces');
    await f.confirm();
    expect(f.controller.store.action('stop-action')?.state).toBe('completed');
    const result = JSON.parse(f.controller.store.action('stop-action')!.result_json!);
    expect(result).toMatchObject({
      status: 'stopped',
      workspaceStopped: true,
      taskStatus: 'cancelled',
    });
    expect(result).not.toHaveProperty('workspaceDeleted');
    expect(result).not.toHaveProperty('runtimeStopAcknowledged');
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.scheduleDeletion).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'preserves legacy non-SAM operation behavior (session=%s)',
    async (sessionBacked) => {
      const f = fixture(sessionBacked);
      f.stop.mockRejectedValueOnce(new Error('Node stop acknowledgement unavailable'));
      const result = await samWorkStop.run(
        {
          env: f.env,
          requestId: 'legacy-stop',
          actor: { userId: 'owner', via: 'web', scopes: new Set(['sam.read', 'sam.write']) },
        },
        {
          projectId: 'project',
          ...(sessionBacked ? { sessionId: 'chat' } : { taskId: 'task' }),
          requestKey: 'legacy-key',
        }
      );
      if (sessionBacked) expect(result).toEqual({ status: 'stopped', workspaceDeleted: true });
      else expect(result).toMatchObject({ status: 'cancelled', taskId: 'task' });
      expect(result).not.toHaveProperty('workspaceStopped');
      expect(f.stop).toHaveBeenCalledOnce();
      expect(f.database.prepare('SELECT status FROM workspaces').get()).toEqual({
        status: 'stopped',
      });
      expect(f.scheduleDeletion).toHaveBeenCalledOnce();
    }
  );

  it.each([false, true])(
    'keeps failed stop uncertain and never retries the same confirmation (session=%s)',
    async (sessionBacked) => {
      const f = fixture(sessionBacked);
      f.stop.mockRejectedValueOnce(new Error('Node stop acknowledgement unavailable'));
      expect((await f.confirm())?.status).toBe(200);
      expect(f.stop).toHaveBeenCalledExactlyOnceWith(
        'node',
        'workspace',
        expect.anything(),
        'owner'
      );
      expect(f.controller.store.action('stop-action')?.state).toBe('uncertain');
      expect(f.database.prepare('SELECT status FROM workspaces').get()).toEqual({
        status: 'running',
      });
      expect(f.database.prepare('SELECT status FROM agent_sessions').get()).toEqual({
        status: 'running',
      });
      expect(f.scheduleDeletion).not.toHaveBeenCalled();
      const receipt = f.controller.store.action('stop-action');
      await f.confirm();
      expect(f.stop).toHaveBeenCalledOnce();
      expect(f.controller.store.action('stop-action')).toEqual(receipt);
    }
  );

  it.each([
    { sessionBacked: false, actor: 'owner' },
    { sessionBacked: true, actor: 'owner' },
    { sessionBacked: true, actor: 'grantee' },
  ])(
    'completes acknowledged stop without changing resource owner ($sessionBacked/$actor)',
    async ({ sessionBacked, actor }) => {
      const f = fixture(sessionBacked, actor);
      expect((await f.confirm())?.status).toBe(200);
      expect(f.stop).toHaveBeenCalledExactlyOnceWith(
        'node',
        'workspace',
        expect.anything(),
        'owner'
      );
      expect(f.controller.store.action('stop-action')?.state).toBe('completed');
      const result = JSON.parse(f.controller.store.action('stop-action')!.result_json!);
      expect(result).toMatchObject({ status: 'stopped', workspaceStopped: true });
      expect(result).not.toHaveProperty('workspaceDeleted');
      expect(result).not.toHaveProperty('runtimeStopAcknowledged');
      if (!sessionBacked) expect(result.taskStatus).toBe('cancelled');
      expect(f.database.prepare('SELECT status FROM workspaces').get()).toEqual({
        status: 'stopped',
      });
      expect(f.scheduleDeletion).toHaveBeenCalledOnce();
      const receipt = f.controller.store.action('stop-action');
      await f.confirm();
      expect(f.stop).toHaveBeenCalledOnce();
      expect(f.controller.store.action('stop-action')).toEqual(receipt);
    }
  );
});
