import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  getAcpSession: vi.fn(),
  reportAcpSessionActivity: vi.fn(),
  transitionAcpSession: vi.fn(),
  failSession: vi.fn(),
  recordActivityEvent: vi.fn(),
  markContainerWorkEnded: vi.fn(),
}));

vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn(async () => ({
    workspace: 'workspace-race',
    type: 'callback',
    scope: 'workspace',
  })),
}));

vi.mock('../../../src/services/project-data', () => ({
  getAcpSession: mocks.getAcpSession,
  getSessionState: vi.fn(async () => ({ runtimeWorkState: 'inactive' })),
  reportAcpSessionActivity: mocks.reportAcpSessionActivity,
  transitionAcpSession: mocks.transitionAcpSession,
  failSession: mocks.failSession,
  recordActivityEvent: mocks.recordActivityEvent,
}));

vi.mock('../../../src/services/node-agent', () => ({
  hibernateAgentSessionOnNode: vi.fn(),
}));

vi.mock('../../../src/services/vm-agent-container', () => ({
  markVmAgentContainerActiveWorkEndedBestEffort: mocks.markContainerWorkEnded,
}));

const { agentActivityCallbackRoute } =
  await import('../../../src/routes/projects/agent-activity-callback');

let sqlite: Database.Database;
let env: Env;

function makeApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json(error.toJSON(), error.statusCode as never)
      : c.json({ error: 'INTERNAL_ERROR', message: String(error) }, 500)
  );
  app.route('/api/projects', agentActivityCallbackRoute);
  return app;
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.nodes,
    schema.workspaces,
    schema.agentSessions,
    schema.workspaceCallbackSignalClaims,
  ]);
  env = { DATABASE: createSqliteD1(sqlite) } as Env;
  vi.clearAllMocks();

  sqlite
    .prepare(
      `INSERT INTO nodes
        (id, user_id, name, status, health_status, vm_size, vm_location, runtime,
         node_role, node_class, created_at, updated_at)
       VALUES ('node-race', 'user-race', 'race node', 'running', 'healthy', 'small',
               'nbg1', 'vm', 'workspace', 'managed', ?, ?)`
    )
    .run('2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z');
  sqlite
    .prepare(
      `INSERT INTO workspaces
        (id, node_id, user_id, project_id, name, repository, branch, status,
         vm_size, vm_location, chat_session_id, created_at, updated_at)
       VALUES ('workspace-race', 'node-race', 'user-race', 'project-race',
               'race workspace', 'org/repo', 'main', 'running', 'small', 'nbg1',
               'chat-race', ?, ?)`
    )
    .run('2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z');
  sqlite
    .prepare(
      `INSERT INTO agent_sessions
        (id, workspace_id, user_id, status, agent_type, created_at, updated_at)
       VALUES ('agent-race', 'workspace-race', 'user-race', 'running',
               'openai-codex', ?, ?)`
    )
    .run('2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z');

  mocks.getAcpSession.mockResolvedValue({
    id: 'agent-race',
    projectId: 'project-race',
    chatSessionId: 'chat-race',
    workspaceId: 'workspace-race',
    nodeId: 'node-race',
    acpSdkSessionId: 'sdk-race',
    status: 'active',
    agentType: 'openai-codex',
  });
  mocks.reportAcpSessionActivity.mockImplementation(async () => {
    sqlite.prepare(`UPDATE workspaces SET status = 'stopping' WHERE id = 'workspace-race'`).run();
  });
  mocks.transitionAcpSession.mockResolvedValue({});
  mocks.failSession.mockResolvedValue(undefined);
  mocks.recordActivityEvent.mockResolvedValue(undefined);
});

afterEach(() => sqlite.close());

describe('ACP activity callback deletion race with real D1 SQL', () => {
  it('rejects all failure fanout when deletion starts after the ProjectData activity mirror', async () => {
    const response = await makeApp().request(
      '/api/projects/project-race/acp-sessions/agent-race/activity',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer callback-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          activity: 'error',
          nodeId: 'node-race',
          agentType: 'openai-codex',
          statusError: 'late runtime failure',
        }),
      },
      env
    );

    expect(response.status).toBe(410);
    expect(
      sqlite.prepare(`SELECT status FROM agent_sessions WHERE id = 'agent-race'`).pluck().get()
    ).toBe('running');
    expect(mocks.reportAcpSessionActivity).toHaveBeenCalledOnce();
    expect(mocks.transitionAcpSession).not.toHaveBeenCalled();
    expect(mocks.failSession).not.toHaveBeenCalled();
    expect(mocks.markContainerWorkEnded).not.toHaveBeenCalled();
    expect(mocks.recordActivityEvent).toHaveBeenCalledWith(
      env,
      'project-race',
      'workspace.deletion_unconfirmed_callback',
      'workspace_callback',
      'workspace-race',
      'workspace-race',
      'chat-race',
      null,
      {
        callback: 'acp_activity',
        workspaceStatus: 'stopping',
        nodeId: 'node-race',
        action: 'rejected',
      }
    );
  });
});
