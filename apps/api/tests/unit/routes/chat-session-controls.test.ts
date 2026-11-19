import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

/**
 * Session-scoped sleep and resume (apps/api/src/routes/chat-session-controls.ts) let the owner
 * or a grantee act on the OWNER's workspace. The workspace lookup is a SQL predicate on
 * `workspaces.user_id`, so it runs against real SQLite (.claude/rules/28): a decoy workspace
 * owned by the grantee and bound to the same chat proves the grantee's id never selects one.
 */

const mocks = vi.hoisted(() => ({
  userId: 'owner-1',
  roles: {} as Record<string, 'owner' | 'grantee' | 'none'>,
  sleepWorkspaceSession: vi.fn(),
  resumeOwnedAgentSession: vi.fn(),
}));

vi.mock('../../../src/middleware/auth', () => ({
  getUserId: () => mocks.userId,
}));

vi.mock('../../../src/services/project-data', () => ({
  getSessionAccess: async (
    _env: unknown,
    _projectId: string,
    sessionId: string,
    userId: string
  ) => {
    const role = mocks.roles[userId] ?? 'none';
    return {
      session: { id: sessionId, status: 'active', createdByUserId: 'owner-1' },
      access: {
        found: true,
        ownerUserId: 'owner-1',
        sessionStatus: 'active',
        role,
        grant:
          role === 'grantee'
            ? {
                id: `grant-${userId}`,
                sessionId,
                granteeUserId: userId,
                grantedByUserId: 'owner-1',
                parentGrantId: null,
                createdAt: 1,
              }
            : null,
      },
    };
  },
}));

vi.mock('../../../src/services/session-sleep', async (importOriginal) => ({
  // The real deferral classifier: the 409 mapping under test depends on it.
  isSafeSleepDeferral: (
    await importOriginal<typeof import('../../../src/services/session-sleep')>()
  ).isSafeSleepDeferral,
  sleepWorkspaceSession: mocks.sleepWorkspaceSession,
}));

vi.mock('../../../src/routes/workspaces/agent-session-suspend-resume', () => ({
  resumeOwnedAgentSession: mocks.resumeOwnedAgentSession,
}));

const { registerChatSessionControlRoutes } =
  await import('../../../src/routes/chat-session-controls');

function app() {
  const sessions = new Hono<{ Bindings: Env }>();
  registerChatSessionControlRoutes(sessions);
  const root = new Hono<{ Bindings: Env }>();
  root.route('/api/projects/:projectId/sessions', sessions);
  root.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as never);
    throw err;
  });
  return root;
}

describe('session-scoped sleep and resume', () => {
  let sqlite: Database.Database;
  let env: Env;

  function seedMember(userId: string, role: string) {
    sqlite
      .prepare(
        `INSERT INTO project_members (project_id, user_id, role, status, created_at, updated_at)
         VALUES ('project-1', ?, ?, 'active', '2026-10-19', '2026-10-19')`
      )
      .run(userId, role);
  }

  function seedWorkspace(id: string, userId: string, chatSessionId: string) {
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, node_id, project_id, user_id, chat_session_id, status, name,
           created_at, updated_at)
         VALUES (?, 'node-1', 'project-1', ?, ?, 'running', ?, '2026-10-19', '2026-10-19')`
      )
      .run(id, userId, chatSessionId, id);
  }

  function post(path: string) {
    return app().request(
      `/api/projects/project-1/sessions/session-1${path}`,
      { method: 'POST' },
      env
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite
      .prepare(
        `INSERT INTO projects (id, user_id, name, repository, created_at, updated_at)
         VALUES ('project-1', 'owner-1', 'Project', 'acme/app', '2026-10-19', '2026-10-19')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO nodes (id, user_id, status, runtime) VALUES ('node-1', 'owner-1', 'running', 'vm')`
      )
      .run();
    seedMember('owner-1', 'owner');
    seedMember('grantee-1', 'maintainer');
    seedMember('reader-1', 'maintainer');
    // The owner's workspace for this chat, and a decoy the grantee owns bound to the same chat:
    // resolving by the grantee's id would pick the decoy.
    seedWorkspace('ws-owner', 'owner-1', 'session-1');
    seedWorkspace('ws-decoy-grantee', 'grantee-1', 'session-1');
    env = { DATABASE: createSqliteD1(sqlite) } as unknown as Env;
    mocks.roles = { 'owner-1': 'owner', 'grantee-1': 'grantee' };
    mocks.sleepWorkspaceSession.mockResolvedValue({ status: 'sleeping' });
    mocks.resumeOwnedAgentSession.mockResolvedValue({ id: 'agent-1', status: 'running' });
  });

  afterEach(() => {
    sqlite.close();
  });

  it('sleeps the owner’s workspace for the owner', async () => {
    mocks.userId = 'owner-1';

    const response = await post('/sleep');

    expect(response.status).toBe(200);
    expect(mocks.sleepWorkspaceSession).toHaveBeenCalledWith(env, {
      workspaceId: 'ws-owner',
      userId: 'owner-1',
      reason: 'Explicit session sleep API request',
    });
  });

  it('sleeps the owner’s workspace, as the owner, for a grantee', async () => {
    mocks.userId = 'grantee-1';

    const response = await post('/sleep');

    expect(response.status).toBe(200);
    expect(mocks.sleepWorkspaceSession).toHaveBeenCalledWith(env, {
      workspaceId: 'ws-owner',
      userId: 'owner-1',
      reason: 'Explicit session sleep by a shared-access member',
    });
  });

  it('refuses a member the session was not shared with, without touching a workspace', async () => {
    mocks.userId = 'reader-1';

    const response = await post('/sleep');

    expect(response.status).toBe(403);
    expect(mocks.sleepWorkspaceSession).not.toHaveBeenCalled();
  });

  it('answers a safe sleep deferral with 409', async () => {
    mocks.userId = 'grantee-1';
    mocks.sleepWorkspaceSession.mockRejectedValue(
      new Error('Workspace idle interval has not elapsed')
    );

    const response = await post('/sleep');

    expect(response.status).toBe(409);
  });

  it('answers 404 when the owner has no live workspace for the chat', async () => {
    mocks.userId = 'grantee-1';
    sqlite.prepare(`UPDATE workspaces SET status = 'deleted' WHERE id = 'ws-owner'`).run();

    const response = await post('/sleep');

    expect(response.status).toBe(404);
    // The grantee's own decoy is still "running" but is never a candidate.
    expect(mocks.sleepWorkspaceSession).not.toHaveBeenCalled();
  });

  it('resumes the agent on the owner’s workspace for a grantee', async () => {
    mocks.userId = 'grantee-1';

    const response = await post('/agent-sessions/agent-1/resume');

    expect(response.status).toBe(200);
    expect(mocks.resumeOwnedAgentSession).toHaveBeenCalledWith(env, expect.anything(), {
      workspaceId: 'ws-owner',
      agentSessionId: 'agent-1',
      ownerUserId: 'owner-1',
    });
  });

  it('refuses resume for a member the session was not shared with', async () => {
    mocks.userId = 'reader-1';

    const response = await post('/agent-sessions/agent-1/resume');

    expect(response.status).toBe(403);
    expect(mocks.resumeOwnedAgentSession).not.toHaveBeenCalled();
  });
});
