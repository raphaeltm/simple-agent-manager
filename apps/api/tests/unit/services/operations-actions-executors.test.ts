/**
 * Each Operations executor reuses the shared function the UI uses, and runs it as the
 * resource's OWNER, read from the row (the shared functions re-check ownership against the
 * user they are given). Targets are resolved on a real SQL engine; only the shared teardown
 * functions are replaced, so these tests pin the call each executor makes and how it maps the
 * outcome. The approval/CAS path is covered by `tests/integration/ops-action-approvals.test.ts`.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  cleanupWorkspaceForDeletion: vi.fn(),
  deleteOwnedNode: vi.fn(),
  sleepWorkspaceSession: vi.fn(),
  cancelTask: vi.fn(),
  listAcpSessions: vi.fn(),
  hibernateAgentSessionOnNode: vi.fn(),
  nodeAgentRequest: vi.fn(),
  handOffEmptyWorkspaceNode: vi.fn(),
}));

vi.mock('../../../src/services/workspace-cleanup', () => ({
  cleanupWorkspaceForDeletion: shared.cleanupWorkspaceForDeletion,
}));
vi.mock('../../../src/routes/nodes/delete', () => ({ deleteOwnedNode: shared.deleteOwnedNode }));
vi.mock('../../../src/services/session-sleep', async () => ({
  ...(await vi.importActual<typeof import('../../../src/services/session-sleep')>(
    '../../../src/services/session-sleep'
  )),
  sleepWorkspaceSession: shared.sleepWorkspaceSession,
}));
vi.mock('../../../src/services/cancel-task', () => ({ cancelTask: shared.cancelTask }));
vi.mock('../../../src/services/project-data', () => ({ listAcpSessions: shared.listAcpSessions }));
vi.mock('../../../src/services/node-agent', async () => ({
  ...(await vi.importActual<typeof import('../../../src/services/node-agent')>(
    '../../../src/services/node-agent'
  )),
  hibernateAgentSessionOnNode: shared.hibernateAgentSessionOnNode,
  nodeAgentRequest: shared.nodeAgentRequest,
}));
vi.mock('../../../src/services/node-warm-handoff', () => ({
  handOffEmptyWorkspaceNode: shared.handOffEmptyWorkspaceNode,
}));

import type { OperationsAction } from '@simple-agent-manager/shared';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { errors } from '../../../src/middleware/error';
import { NodeAgentHttpError } from '../../../src/services/node-agent';
import type { OperationsAccessContext } from '../../../src/services/operations-access';
import { executeAction } from '../../../src/services/operations-actions/executors';
import { resolveActionTarget } from '../../../src/services/operations-actions/targets';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const GRANT: OperationsAccessContext = {
  mode: 'read_ask',
  projectId: 'proj-ops',
  taskId: 'task-ops',
  userId: 'operator',
};

let db: Database.Database;
let env: Env;

function insert(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
  ).run(...Object.values(row));
}

beforeEach(() => {
  db = new Database(':memory:');
  createAllSchemaTables(db, schema);
  for (const id of ['operator', 'owner']) {
    insert('users', { id, email: `${id}@x.test`, name: id, role: 'user', status: 'active' });
  }
  insert('nodes', {
    id: 'node-1',
    user_id: 'owner',
    name: 'n',
    status: 'running',
    runtime: 'vm',
    health_status: 'healthy',
    cleanup_backoff_until: '2099-01-01T00:00:00.000Z',
  });
  insert('nodes', {
    id: 'node-container',
    user_id: 'owner',
    name: 'c',
    status: 'running',
    runtime: 'cf-container',
    health_status: 'healthy',
  });
  insert('workspaces', {
    id: 'ws-1',
    user_id: 'owner',
    node_id: 'node-1',
    project_id: 'proj-user',
    chat_session_id: 'chat-1',
    name: 'w',
    status: 'running',
    repository: 'o/r',
    branch: 'main',
  });
  insert('tasks', {
    id: 'task-1',
    project_id: 'proj-user',
    user_id: 'owner',
    title: 'stuck',
    status: 'in_progress',
  });
  env = { DATABASE: createSqliteD1(db) } as unknown as Env;
});

afterEach(() => {
  db.close();
  vi.clearAllMocks();
});

async function run(action: OperationsAction, targetId: string) {
  const target = await resolveActionTarget(env, GRANT, action, targetId);
  expect(target, `target ${targetId}`).not.toBeNull();
  return executeAction(env, GRANT, action, target!);
}

describe('delete_workspace → cleanupWorkspaceForDeletion', () => {
  it('runs explicit deletion as the workspace owner and maps each outcome', async () => {
    shared.cleanupWorkspaceForDeletion.mockResolvedValueOnce({ status: 'confirmed' });
    expect(await run('delete_workspace', 'ws-1')).toMatchObject({ status: 'succeeded' });
    expect(shared.cleanupWorkspaceForDeletion).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner',
        mode: 'explicit',
        workspace: expect.objectContaining({ id: 'ws-1', userId: 'owner' }),
      })
    );

    shared.cleanupWorkspaceForDeletion.mockResolvedValueOnce({
      status: 'retry',
      reason: 'runtime_deletion_unconfirmed',
    });
    expect(await run('delete_workspace', 'ws-1')).toMatchObject({ status: 'accepted' });

    shared.cleanupWorkspaceForDeletion.mockResolvedValueOnce({
      status: 'fenced',
      reason: 'workspace_active',
    });
    expect(await run('delete_workspace', 'ws-1')).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('workspace_active'),
    });
  });
});

describe('delete_node → deleteOwnedNode', () => {
  it('runs strict owner deletion as the node owner', async () => {
    shared.deleteOwnedNode.mockResolvedValueOnce(undefined);
    expect(await run('delete_node', 'node-1')).toMatchObject({ status: 'succeeded' });
    const [, , node, userId] = shared.deleteOwnedNode.mock.calls[0] ?? [];
    expect(node).toMatchObject({ id: 'node-1', userId: 'owner' });
    expect(userId).toBe('owner');
  });

  it('reports unproven termination as failed, not succeeded', async () => {
    shared.deleteOwnedNode.mockRejectedValueOnce(
      errors.conflict('Node runtime termination is not confirmed: provider timeout')
    );
    expect(await run('delete_node', 'node-1')).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('not confirmed'),
    });
  });
});

describe('sleep_session → sleepWorkspaceSession', () => {
  it('sleeps the live workspace bridging the chat, as its owner', async () => {
    shared.sleepWorkspaceSession.mockResolvedValueOnce({
      status: 'sleeping',
      workspaceId: 'ws-1',
      chatSessionId: 'chat-1',
      snapshotExpiresAt: '2026-11-10T00:00:00Z',
    });
    expect(await run('sleep_session', 'chat-1')).toMatchObject({ status: 'succeeded' });
    expect(shared.sleepWorkspaceSession).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ workspaceId: 'ws-1', userId: 'owner' })
    );
  });

  it('a safe sleep deferral is unsupported, not a failure', async () => {
    shared.sleepWorkspaceSession.mockRejectedValueOnce(
      new Error('Workspace agent is not idle (prompting)')
    );
    expect(await run('sleep_session', 'chat-1')).toMatchObject({ status: 'unsupported' });
  });

  it('a chat with no live workspace is unsupported, without calling sleep', async () => {
    db.prepare(`UPDATE workspaces SET status = 'deleted' WHERE id = 'ws-1'`).run();
    insert('tasks', {
      id: 'task-chat',
      project_id: 'proj-user',
      user_id: 'owner',
      title: 't',
      status: 'completed',
      chat_session_id: 'chat-1',
    });
    expect(await run('sleep_session', 'chat-1')).toMatchObject({ status: 'unsupported' });
    expect(shared.sleepWorkspaceSession).not.toHaveBeenCalled();
  });
});

describe('cancel_stuck_task → cancelTask', () => {
  it('cancels as the task owner, so cleanup also tears down the owner’s workspace', async () => {
    shared.cancelTask.mockImplementationOnce(async (_env, _db, task) => ({
      ...task,
      status: 'cancelled',
    }));
    expect(await run('cancel_stuck_task', 'task-1')).toMatchObject({
      status: 'succeeded',
      detail: { previousStatus: 'in_progress', status: 'cancelled' },
    });
    const [, , task, userId, options] = shared.cancelTask.mock.calls[0] ?? [];
    expect(task).toMatchObject({ id: 'task-1' });
    expect(userId).toBe('owner');
    expect(options).toMatchObject({ source: 'operations.cancel_stuck_task' });
  });
});

describe('retry_snapshot → hibernateAgentSessionOnNode (background, no sleep)', () => {
  it('queues a background capture of the live agent session, as the workspace owner', async () => {
    shared.listAcpSessions.mockResolvedValueOnce({
      sessions: [
        { id: 'acp-old', status: 'completed', acpSdkSessionId: 'sdk-old', workspaceId: 'ws-1' },
        {
          id: 'acp-live',
          status: 'running',
          acpSdkSessionId: 'sdk-live',
          workspaceId: 'ws-1',
          agentType: 'claude-code',
        },
      ],
      total: 2,
    });
    shared.hibernateAgentSessionOnNode.mockResolvedValueOnce({});

    expect(await run('retry_snapshot', 'chat-1')).toMatchObject({ status: 'accepted' });
    expect(shared.hibernateAgentSessionOnNode).toHaveBeenCalledWith(
      'node-1',
      'ws-1',
      'sdk-live',
      env,
      'owner',
      { chatSessionId: 'chat-1', runtime: 'vm', agentType: 'claude-code', background: true }
    );
    expect(shared.sleepWorkspaceSession).not.toHaveBeenCalled();
  });

  it('is unsupported when no agent session is live, without capturing', async () => {
    shared.listAcpSessions.mockResolvedValueOnce({ sessions: [], total: 0 });
    expect(await run('retry_snapshot', 'chat-1')).toMatchObject({ status: 'unsupported' });
    expect(shared.hibernateAgentSessionOnNode).not.toHaveBeenCalled();
  });
});

describe('rerun_node_cleanup → clear backoff + handOffEmptyWorkspaceNode', () => {
  it('clears the sweep backoff once, records the decision, and hands off as the owner', async () => {
    shared.handOffEmptyWorkspaceNode.mockResolvedValueOnce({ outcome: 'handed_to_warm' });

    expect(await run('rerun_node_cleanup', 'node-1')).toMatchObject({
      status: 'succeeded',
      detail: { backoffCleared: true, handoff: 'handed_to_warm' },
    });
    expect(db.prepare(`SELECT cleanup_backoff_until FROM nodes WHERE id = 'node-1'`).get()).toEqual(
      {
        cleanup_backoff_until: null,
      }
    );
    expect(shared.handOffEmptyWorkspaceNode).toHaveBeenCalledWith(env, {
      nodeId: 'node-1',
      expectedUserId: 'owner',
      reason: 'operations_rerun_node_cleanup',
    });
    expect(
      db
        .prepare('SELECT source, decision FROM node_lifecycle_decisions WHERE node_id = ?')
        .all('node-1')
    ).toEqual([{ source: 'operations_action', decision: 'cleanup_rerun_requested' }]);
  });

  it('a failed handoff is a failed action', async () => {
    shared.handOffEmptyWorkspaceNode.mockResolvedValueOnce({ outcome: 'failed', error: 'DO down' });
    expect(await run('rerun_node_cleanup', 'node-1')).toMatchObject({ status: 'failed' });
  });
});

describe('restart_vm_agent → POST /admin/restart-agent', () => {
  it('posts a node-scoped restart and reports it accepted', async () => {
    shared.nodeAgentRequest.mockResolvedValueOnce({ accepted: true, restartInMs: 0 });
    expect(await run('restart_vm_agent', 'node-1')).toMatchObject({ status: 'accepted' });
    const [nodeId, , path, options] = shared.nodeAgentRequest.mock.calls[0] ?? [];
    expect(nodeId).toBe('node-1');
    expect(path).toBe('/admin/restart-agent');
    expect(options).toMatchObject({ method: 'POST', userId: 'operator' });
    // Node-scoped: the agent refuses a token carrying a workspace claim.
    expect(options).not.toHaveProperty('workspaceId');
  });

  it('an older agent without the endpoint (404) is unsupported, not failed (rule 54)', async () => {
    shared.nodeAgentRequest.mockRejectedValueOnce(new NodeAgentHttpError(404, 'not found'));
    expect(await run('restart_vm_agent', 'node-1')).toMatchObject({ status: 'unsupported' });
  });

  it('a cf-container node is unsupported without calling it', async () => {
    expect(await run('restart_vm_agent', 'node-container')).toMatchObject({
      status: 'unsupported',
    });
    expect(shared.nodeAgentRequest).not.toHaveBeenCalled();
  });
});

describe('executeAction never throws', () => {
  it('turns an unexpected error into a failed result', async () => {
    shared.cancelTask.mockRejectedValueOnce(new Error('D1 unavailable'));
    expect(await run('cancel_stuck_task', 'task-1')).toEqual({
      status: 'failed',
      message: 'D1 unavailable',
    });
  });

  it('refuses a target of the wrong kind for the action', async () => {
    const target = await resolveActionTarget(env, GRANT, 'delete_node', 'node-1');
    expect(await executeAction(env, GRANT, 'delete_workspace', target!)).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('Expected a workspace target'),
    });
    expect(shared.cleanupWorkspaceForDeletion).not.toHaveBeenCalled();
  });
});
