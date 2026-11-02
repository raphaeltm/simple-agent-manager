/**
 * GET /api/projects/:projectId/sessions/:sessionId/agent-credential — which account and
 * tier a chat's agent ran on. Real SQL for the D1 rows; the ProjectData lookups (the
 * chat and its own ACP session) are stubbed at the service boundary.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const projectData = vi.hoisted(() => ({
  acpSessions: [] as Array<{ id: string; workspaceId: string | null }>,
}));
vi.mock('../../../src/services/project-data', () => ({
  getSession: vi.fn(async () => ({ id: 'chat-1', workspaceId: 'w1' })),
  listAcpSessions: vi.fn(async () => ({
    sessions: projectData.acpSessions,
    total: projectData.acpSessions.length,
  })),
}));

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { AuthContext } from '../../../src/middleware/auth';
import { AppError } from '../../../src/middleware/error';
import { registerChatAgentCredentialRoute } from '../../../src/routes/chat-agent-credential';
import { listAcpSessions } from '../../../src/services/project-data';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const NOW = '2026-11-01T00:00:00.000Z';
let sqlite: Database.Database;
let env: Env;

async function read(caller: string) {
  const sessions = new Hono<{ Bindings: Env }>();
  registerChatAgentCredentialRoute(sessions);
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    const auth: AuthContext = {
      user: {
        id: caller,
        email: `${caller}@example.test`,
        name: caller,
        avatarUrl: null,
        role: 'user',
        status: 'active',
      },
      session: { id: `s-${caller}`, expiresAt: new Date('2027-01-01T00:00:00.000Z') },
    };
    c.set('auth', auth);
    await next();
  });
  app.onError((err, c) =>
    err instanceof AppError
      ? c.json(err.toJSON(), err.statusCode as never)
      : c.json({ error: String(err) }, 500)
  );
  app.route('/api/projects/:projectId/sessions', sessions);
  const response = await app.request('/api/projects/p1/sessions/chat-1/agent-credential', {}, env);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  env = { DATABASE: createSqliteD1(sqlite) } as Env;
  projectData.acpSessions = [{ id: 's1', workspaceId: 'w1' }];
  sqlite.exec(`
    INSERT INTO users (id, email, role, status) VALUES ('runner', 'r@example.com', 'user', 'active'),
      ('member', 'm@example.com', 'user', 'active');
    INSERT INTO projects (id, user_id, name, normalized_name, repository, status, created_by, created_at, updated_at)
      VALUES ('p1', 'runner', 'P', 'p', 'acme/repo', 'active', 'runner', '${NOW}', '${NOW}');
    INSERT INTO project_members (project_id, user_id, role, status, created_at, updated_at)
      VALUES ('p1', 'runner', 'owner', 'active', '${NOW}', '${NOW}'),
             ('p1', 'member', 'maintainer', 'active', '${NOW}', '${NOW}');
    INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv, created_at, updated_at)
      VALUES ('cred-max', 'runner', 'Claude Max (personal)', 'oauth-token', 'enc', 'iv', '${NOW}', '${NOW}');
    INSERT INTO nodes (id, user_id, status) VALUES ('n1', 'runner', 'running');
    INSERT INTO workspaces (id, user_id, node_id, project_id, status) VALUES ('w1', 'runner', 'n1', 'p1', 'running');
    INSERT INTO agent_sessions (id, user_id, workspace_id, status, agent_type, agent_credential_source,
        agent_credential_scope, agent_credential_reference, agent_credential_generation)
      VALUES ('s1', 'runner', 'w1', 'running', 'claude-code', 'user', 'profile', 'cc_credentials:cred-max', 1),
             ('s-other', 'runner', 'w1', 'running', 'claude-code', 'user', 'user', 'cc_credentials:cred-other', 1);
  `);
});

afterEach(() => sqlite.close());

describe('session agent credential', () => {
  it('shows the person who ran it the account and the tier that chose it', async () => {
    const { status, body } = await read('runner');

    expect(status).toBe(200);
    expect(body).toEqual({
      credential: {
        agentType: 'claude-code',
        credentialSource: 'user',
        credentialScope: 'profile',
        accountName: 'Claude Max (personal)',
        isOwnSession: true,
      },
    });
  });

  it('shows another member the tier but never the account name', async () => {
    const { body } = await read('member');

    expect(body).toMatchObject({
      credential: { credentialScope: 'profile', accountName: null, isOwnSession: false },
    });
    expect(JSON.stringify(body)).not.toContain('Claude Max');
  });

  it('reads the chat’s own ACP session, not the latest one in the workspace', async () => {
    await read('runner');
    expect(vi.mocked(listAcpSessions)).toHaveBeenCalledWith(env, 'p1', {
      chatSessionId: 'chat-1',
      limit: 1,
    });
  });

  it('returns no credential before the agent has received one', async () => {
    projectData.acpSessions = [];
    const { status, body } = await read('runner');

    expect(status).toBe(200);
    expect(body).toEqual({ credential: null });
  });

  it('refuses someone who is not a project member', async () => {
    sqlite.exec(
      `INSERT INTO users (id, email, role, status) VALUES ('stranger', 's@example.com', 'user', 'active')`
    );
    const { status } = await read('stranger');

    expect(status).toBe(404);
  });
});
