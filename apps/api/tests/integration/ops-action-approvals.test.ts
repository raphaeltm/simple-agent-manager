/**
 * Operations actions behind a server-side approval, on a real SQL engine (`.claude/rules/28`,
 * `.claude/rules/62`): the real `POST /mcp` route → real `requireOperationsAccess` gate → real
 * approval store and its compare-and-set writes; the real superadmin decision route. Only three
 * edges are replaced: the executor (the shared teardown functions, covered separately), the
 * notification DO and the ProjectData prompt delivery.
 */
import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const edges = vi.hoisted(() => ({
  executeAction: vi.fn(),
  sendNotification: vi.fn(),
  acceptPromptDelivery: vi.fn(),
}));

vi.mock('../../src/services/operations-actions/executors', () => ({
  executeAction: edges.executeAction,
}));
vi.mock('../../src/services/notification', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/notification')>(
    '../../src/services/notification'
  )),
  sendNotification: edges.sendNotification,
}));
vi.mock('../../src/services/project-data', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/project-data')>(
    '../../src/services/project-data'
  )),
  acceptPromptDelivery: edges.acceptPromptDelivery,
}));

import {
  OPERATIONS_ACTION_TARGET_TYPES,
  OPERATIONS_ACTIONS,
  OPERATIONS_AUTO_SAFE_ACTIONS,
  type OperationsAction,
} from '@simple-agent-manager/shared';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { adminOperationsApprovalRoutes } from '../../src/routes/admin-operations-approvals';
import {
  callMcpTool,
  createJsonKv,
  createMcpApp,
  type McpToolResponse,
  storeMcpToken,
  toolResult,
} from '../helpers/mcp-route';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const OPS_PROJECT = 'proj-ops';
const NODE_A = 'NODE-A';
const NODE_B = 'NODE-B';

let main: Database.Database;
let env: Env;
let mcp: Awaited<ReturnType<typeof createMcpApp>>;
let admin: Hono<{ Bindings: Env }>;

beforeAll(async () => {
  mcp = await createMcpApp();
}, 60_000);

function insert(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  main
    .prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...Object.values(row));
}

function setMode(mode: string) {
  main
    .prepare(`UPDATE platform_settings SET value = ? WHERE key = 'operations.debuggerTools'`)
    .run(mode);
}

function seed() {
  main = new Database(':memory:');
  createAllSchemaTables(main, schema);
  main.exec(
    readFileSync(
      new URL('../../src/db/migrations/0196_admin_settings.sql', import.meta.url),
      'utf8'
    )
  );
  insert('platform_settings', {
    key: 'operations.debuggerTools',
    value: 'read_ask',
    updated_at: '2026-11-03T00:00:00Z',
  });
  for (const [id, role] of [
    ['admin', 'superadmin'],
    ['admin2', 'superadmin'],
    ['owner', 'user'],
  ] as const) {
    insert('users', { id, email: `${id}@example.test`, name: id, role, status: 'active' });
  }
  const task = (id: string, extra: Record<string, unknown> = {}) =>
    insert('tasks', {
      id,
      project_id: OPS_PROJECT,
      user_id: 'admin',
      title: 't',
      status: 'in_progress',
      ...extra,
    });
  task('task-admin', { chat_session_id: 'chat-admin' });
  // The same conversation after it woke from sleep: a session-recovery successor.
  task('task-admin-woken', {
    chat_session_id: 'chat-admin',
    recovery_source_task_id: 'task-admin',
    triggered_by: 'session-recovery',
  });
  // A different superadmin-owned task in the Operations project.
  task('task-other', { chat_session_id: 'chat-other' });
  for (const id of [NODE_A, NODE_B]) {
    insert('nodes', {
      id,
      user_id: 'owner',
      name: id,
      status: 'running',
      runtime: 'vm',
      health_status: 'healthy',
    });
  }
  insert('workspaces', {
    id: 'ws-1',
    user_id: 'owner',
    node_id: NODE_A,
    project_id: 'proj-user',
    chat_session_id: 'chat-user',
    name: 'w',
    status: 'running',
    repository: 'o/r',
    branch: 'main',
  });
  insert('tasks', {
    id: 'task-user',
    project_id: 'proj-user',
    user_id: 'owner',
    title: 'stuck',
    status: 'in_progress',
    chat_session_id: 'chat-user',
  });
  return main;
}

beforeEach(async () => {
  edges.executeAction.mockResolvedValue({ status: 'succeeded', message: 'done' });
  edges.sendNotification.mockResolvedValue({ id: 'n1' });
  edges.acceptPromptDelivery.mockResolvedValue({ message: { id: 'd1' } });
  env = {
    DATABASE: createSqliteD1(seed()),
    KV: createJsonKv(),
    BASE_DOMAIN: 'example.test',
    PLATFORM_FEEDBACK_PROJECT_ID: OPS_PROJECT,
  } as unknown as Env;
  for (const [token, taskId] of [
    ['tok-admin', 'task-admin'],
    ['tok-woken', 'task-admin-woken'],
    ['tok-other', 'task-other'],
  ] as const) {
    await storeMcpToken(env.KV, token, {
      taskId,
      projectId: OPS_PROJECT,
      userId: 'admin',
      workspaceId: `ws-${taskId}`,
    });
  }
  admin = new Hono<{ Bindings: Env }>();
  admin.onError(handleAppError);
  // `requireAuth` keeps an auth context that is already set, so the real superadmin gates run.
  admin.use('*', async (c, next) => {
    const id = c.req.header('x-test-user') ?? 'admin';
    const role = c.req.header('x-test-role') ?? 'superadmin';
    c.set('auth', {
      user: { id, email: `${id}@example.test`, name: id, avatarUrl: null, role, status: 'active' },
      session: { id: 's', expiresAt: new Date('2099-01-01T00:00:00Z') },
    } as never);
    await next();
  });
  admin.route('/approvals', adminOperationsApprovalRoutes);
});

afterEach(() => {
  main.close();
  vi.clearAllMocks();
});

type ApprovalJson = { id: string; status: string; autoApproved: boolean; expiresAt: string };

async function request(
  action: OperationsAction,
  targetId: string,
  token = 'tok-admin'
): Promise<ApprovalJson> {
  const response = await callMcpTool(mcp, env, token, 'ops_request_action', {
    action,
    targetId,
    reason: 'Node has no workspaces past the warm timeout',
    evidence: 'ops_why_is_node_alive: kept_active, 0 workspaces',
  });
  return toolResult<{ approval: ApprovalJson }>(response).approval;
}

function execute(
  approvalId: string,
  action: OperationsAction,
  targetId: string,
  token = 'tok-admin'
): Promise<McpToolResponse> {
  return callMcpTool(mcp, env, token, 'ops_execute_action', { approvalId, action, targetId });
}

async function decide(
  id: string,
  decision: 'approve' | 'deny',
  headers: Record<string, string> = {}
) {
  return admin.request(
    `/approvals/${id}/decision`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ decision, note: 'checked the node' }),
    },
    env
  );
}

function row(id: string) {
  return main.prepare('SELECT * FROM operations_action_approvals WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;
}

describe('request → approve → execute', () => {
  it('runs an approved action exactly once, then refuses a second execute', async () => {
    const approval = await request('delete_node', NODE_A);
    expect(approval.status).toBe('pending');
    expect((await execute(approval.id, 'delete_node', NODE_A)).error?.message).toContain(
      'not been decided'
    );

    const decided = await decide(approval.id, 'approve');
    expect(decided.status).toBe(200);
    expect(((await decided.json()) as { delivered: boolean }).delivered).toBe(true);

    const first = toolResult<{ result: { status: string } }>(
      await execute(approval.id, 'delete_node', NODE_A)
    );
    expect(first.result.status).toBe('succeeded');
    expect(edges.executeAction).toHaveBeenCalledTimes(1);
    expect(edges.executeAction.mock.calls[0]?.[2]).toBe('delete_node');
    expect(edges.executeAction.mock.calls[0]?.[3]).toMatchObject({ kind: 'node' });
    expect(row(approval.id)).toMatchObject({ status: 'executed' });
    expect(JSON.parse(String(row(approval.id).execution_result_json))).toMatchObject({
      status: 'succeeded',
    });

    const second = await execute(approval.id, 'delete_node', NODE_A);
    expect(second.error?.message).toContain('already executed');
    expect(edges.executeAction).toHaveBeenCalledTimes(1);
  });

  it('records a failed outcome when the target lookup throws after the approval was claimed', async () => {
    const approval = await request('delete_node', NODE_A);
    await decide(approval.id, 'approve');
    // Fails only the post-claim target read; the claim itself touches another table.
    main.exec('ALTER TABLE nodes RENAME TO nodes_unavailable');

    const outcome = toolResult<{ result: { status: string; message: string } }>(
      await execute(approval.id, 'delete_node', NODE_A)
    );

    expect(outcome.result.status).toBe('failed');
    expect(edges.executeAction).not.toHaveBeenCalled();
    expect(row(approval.id).status).toBe('executed');
    expect(JSON.parse(String(row(approval.id).execution_result_json))).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('Failed query'),
    });
  });

  it('two concurrent executes of one approval run the action once', async () => {
    const approval = await request('delete_workspace', 'ws-1');
    await decide(approval.id, 'approve');

    const results = await Promise.all([
      execute(approval.id, 'delete_workspace', 'ws-1'),
      execute(approval.id, 'delete_workspace', 'ws-1'),
    ]);

    expect(results.filter((r) => r.error === undefined)).toHaveLength(1);
    expect(edges.executeAction).toHaveBeenCalledTimes(1);
  });

  it('notifies the task owner with an Approve/Deny link, and delivers the decision as a prompt', async () => {
    const approval = await request('delete_workspace', 'ws-1');

    expect(edges.sendNotification).toHaveBeenCalledTimes(1);
    const [notifyEnv, userId, notification] = edges.sendNotification.mock.calls[0] ?? [];
    expect(notifyEnv).toBe(env);
    expect(userId).toBe('admin');
    expect(notification).toMatchObject({
      type: 'operations_approval',
      urgency: 'high',
      projectId: OPS_PROJECT,
      taskId: 'task-admin',
      sessionId: 'chat-admin',
      actionUrl: `/admin/approvals?approval=${approval.id}`,
    });

    await decide(approval.id, 'approve');
    expect(edges.acceptPromptDelivery).toHaveBeenCalledTimes(1);
    const [, projectId, delivery] = edges.acceptPromptDelivery.mock.calls[0] ?? [];
    expect(projectId).toBe(OPS_PROJECT);
    expect(delivery).toMatchObject({
      deliveryId: `operations-decision:${approval.id}`,
      targetSessionId: 'chat-admin',
      sourceTaskId: 'task-admin',
      sourceKind: 'operations_decision',
      senderType: 'system',
      senderId: 'admin',
    });
    expect(delivery.deliveryContent).toContain(`approvalId "${approval.id}"`);
  });

  it('a session-recovery successor of the requesting task may execute its approval', async () => {
    const approval = await request('delete_workspace', 'ws-1');
    await decide(approval.id, 'approve');

    const outcome = await execute(approval.id, 'delete_workspace', 'ws-1', 'tok-woken');

    expect(outcome.error).toBeUndefined();
    expect(edges.executeAction).toHaveBeenCalledTimes(1);
  });
});

describe('execute refusals (each is a guard in the claim CAS)', () => {
  async function approved(action: OperationsAction, targetId: string) {
    const approval = await request(action, targetId);
    expect((await decide(approval.id, 'approve')).status).toBe(200);
    return approval;
  }

  it('refuses a denied ticket', async () => {
    const approval = await request('delete_node', NODE_A);
    expect((await decide(approval.id, 'deny')).status).toBe(200);
    expect(edges.acceptPromptDelivery.mock.calls[0]?.[2].deliveryContent).toContain('denied');

    const outcome = await execute(approval.id, 'delete_node', NODE_A);

    expect(outcome.error?.message).toContain('denied');
    expect(edges.executeAction).not.toHaveBeenCalled();
    expect(row(approval.id).status).toBe('denied');
  });

  it('refuses an expired approval, and runs an unexpired control', async () => {
    const stale = await approved('delete_node', NODE_A);
    main
      .prepare('UPDATE operations_action_approvals SET expires_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', stale.id);
    const fresh = await approved('delete_node', NODE_B);

    expect((await execute(stale.id, 'delete_node', NODE_A)).error?.message).toContain('expired');
    expect(edges.executeAction).not.toHaveBeenCalled();
    expect((await execute(fresh.id, 'delete_node', NODE_B)).error).toBeUndefined();
    expect(edges.executeAction).toHaveBeenCalledTimes(1);
  });

  it('refuses a ticket for target A against target B, and runs it against A', async () => {
    const approval = await approved('delete_node', NODE_A);

    expect((await execute(approval.id, 'delete_node', NODE_B)).error?.message).toContain(
      'different target'
    );
    expect(edges.executeAction).not.toHaveBeenCalled();
    expect(row(approval.id).status).toBe('approved');
    expect((await execute(approval.id, 'delete_node', NODE_A)).error).toBeUndefined();
  });

  it('refuses a ticket for another action on the same target, and runs the approved one', async () => {
    const approval = await approved('rerun_node_cleanup', NODE_A);

    expect((await execute(approval.id, 'delete_node', NODE_A)).error?.message).toContain(
      'different action'
    );
    expect(edges.executeAction).not.toHaveBeenCalled();
    expect((await execute(approval.id, 'rerun_node_cleanup', NODE_A)).error).toBeUndefined();
  });

  it('refuses a ticket requested by another task, and runs it from the requester', async () => {
    const approval = await approved('delete_node', NODE_A);

    const stolen = await execute(approval.id, 'delete_node', NODE_A, 'tok-other');
    expect(stolen.error?.message).toContain('different task');
    expect(edges.executeAction).not.toHaveBeenCalled();
    expect(row(approval.id).status).toBe('approved');
    expect((await execute(approval.id, 'delete_node', NODE_A)).error).toBeUndefined();
  });

  it('refuses a ticket whose requesting project differs, and runs the Operations-project one', async () => {
    const approval = await approved('delete_node', NODE_A);
    // Same task authority, different project: only the project conjunct can refuse this.
    main
      .prepare('UPDATE operations_action_approvals SET requesting_project_id = ? WHERE id = ?')
      .run('proj-elsewhere', approval.id);

    expect((await execute(approval.id, 'delete_node', NODE_A)).error?.message).toContain(
      'different task'
    );
    expect(edges.executeAction).not.toHaveBeenCalled();
    main
      .prepare('UPDATE operations_action_approvals SET requesting_project_id = ? WHERE id = ?')
      .run(OPS_PROJECT, approval.id);
    expect((await execute(approval.id, 'delete_node', NODE_A)).error).toBeUndefined();
  });

  it('refuses an unknown approval ID', async () => {
    expect((await execute('nope', 'delete_node', NODE_A)).error?.message).toContain('No approval');
  });
});

describe('the action dial and matrix', () => {
  it('mode read refuses capability act for both tools, while read tools still work', async () => {
    const approval = await request('delete_node', NODE_A);
    await decide(approval.id, 'approve');
    setMode('read');

    const requested = await callMcpTool(mcp, env, 'tok-admin', 'ops_request_action', {
      action: 'delete_node',
      targetId: NODE_A,
      reason: 'x',
    });
    const executed = await execute(approval.id, 'delete_node', NODE_A);

    expect(requested.error?.message).toContain('read-only');
    expect(executed.error?.message).toContain('read-only');
    expect(edges.executeAction).not.toHaveBeenCalled();
    // Liveness: the same token still reads.
    expect(
      (await callMcpTool(mcp, env, 'tok-admin', 'ops_why_is_node_alive', { nodeId: NODE_A })).error
    ).toBeUndefined();
  });

  const targets: Record<OperationsAction, string> = {
    retry_snapshot: 'chat-user',
    rerun_node_cleanup: NODE_A,
    sleep_session: 'chat-user',
    delete_workspace: 'ws-1',
    delete_node: NODE_A,
    restart_vm_agent: NODE_A,
    cancel_stuck_task: 'task-user',
  };

  it.each(OPERATIONS_ACTIONS.map((action) => [action]))(
    '%s follows the approved matrix in read_ask and read_auto_safe',
    async (action) => {
      expect(OPERATIONS_ACTION_TARGET_TYPES[action]).toBeTruthy();
      const asked = await request(action, targets[action]);
      expect(asked.status).toBe('pending');

      setMode('read_auto_safe');
      vi.clearAllMocks();
      const auto = await request(action, targets[action]);
      const autoSafe = OPERATIONS_AUTO_SAFE_ACTIONS.includes(action);
      expect(auto.status).toBe(autoSafe ? 'approved' : 'pending');
      expect(auto.autoApproved).toBe(autoSafe);
      // An auto-approved ticket goes straight to the one execution path; no human is asked.
      expect(edges.sendNotification).toHaveBeenCalledTimes(autoSafe ? 0 : 1);
      if (autoSafe) {
        expect((await execute(auto.id, action, targets[action])).error).toBeUndefined();
        expect(edges.executeAction).toHaveBeenCalledTimes(1);
      }
    }
  );

  it('pins the approved matrix: only retry_snapshot and rerun_node_cleanup are auto-safe', () => {
    expect([...OPERATIONS_AUTO_SAFE_ACTIONS].sort()).toEqual([
      'rerun_node_cleanup',
      'retry_snapshot',
    ]);
  });

  it('refuses a request whose target does not exist, without creating a record', async () => {
    const response = await callMcpTool(mcp, env, 'tok-admin', 'ops_request_action', {
      action: 'delete_node',
      targetId: 'NODE-MISSING',
      reason: 'x',
    });
    expect(response.error?.message).toContain('not found');
    expect(main.prepare('SELECT COUNT(*) AS n FROM operations_action_approvals').get()).toEqual({
      n: 0,
    });
  });
});

describe('the superadmin decision route', () => {
  it('refuses a non-superadmin, leaving the request pending', async () => {
    const approval = await request('delete_node', NODE_A);

    const response = await decide(approval.id, 'approve', {
      'x-test-user': 'owner',
      'x-test-role': 'user',
    });

    expect(response.status).toBe(403);
    expect(row(approval.id).status).toBe('pending');
    expect(edges.acceptPromptDelivery).not.toHaveBeenCalled();
  });

  it('any active superadmin may decide; the decider is recorded', async () => {
    const approval = await request('delete_node', NODE_A);

    expect((await decide(approval.id, 'approve', { 'x-test-user': 'admin2' })).status).toBe(200);
    expect(row(approval.id)).toMatchObject({ status: 'approved', decided_by: 'admin2' });
  });

  it('decides once: a second decision is a conflict and does not re-deliver', async () => {
    const approval = await request('delete_node', NODE_A);
    expect((await decide(approval.id, 'deny')).status).toBe(200);

    const again = await decide(approval.id, 'approve');

    expect(again.status).toBe(409);
    expect(row(approval.id).status).toBe('denied');
    expect(edges.acceptPromptDelivery).toHaveBeenCalledTimes(1);
  });

  it('a decision cannot re-open an executed approval to run it again', async () => {
    const approval = await request('delete_node', NODE_A);
    await decide(approval.id, 'approve');
    expect((await execute(approval.id, 'delete_node', NODE_A)).error).toBeUndefined();

    // The executed row is still inside its execution window, so only the pending-status
    // conjunct of the decision CAS stops a second approval from re-arming it.
    const reopened = await decide(approval.id, 'approve');

    expect(reopened.status).toBe(409);
    expect(row(approval.id).status).toBe('executed');
    expect((await execute(approval.id, 'delete_node', NODE_A)).error?.message).toContain(
      'already executed'
    );
    expect(edges.executeAction).toHaveBeenCalledTimes(1);
  });

  it('cannot approve an expired request', async () => {
    const approval = await request('delete_node', NODE_A);
    main
      .prepare('UPDATE operations_action_approvals SET expires_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', approval.id);

    const response = await decide(approval.id, 'approve');

    expect(response.status).toBe(409);
    expect(row(approval.id).status).toBe('expired');
    expect(edges.acceptPromptDelivery).not.toHaveBeenCalled();
  });

  it('lists pending approvals first, without the internal authority column', async () => {
    const decided = await request('delete_node', NODE_A);
    await decide(decided.id, 'deny');
    const pending = await request('delete_node', NODE_B);

    const response = await admin.request('/approvals', {}, env);
    const body = (await response.json()) as { approvals: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.approvals.map((a) => a.id)).toEqual([pending.id, decided.id]);
    expect(body.approvals[0]).not.toHaveProperty('requestingAuthorityTaskId');
    expect(body.approvals[0]?.targetSummary).toMatchObject({
      nodeId: NODE_B,
      ownerUserId: 'owner',
    });
  });
});
