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
import { buildAcpInteractionRuntimeConfig } from '../../../src/services/acp-interaction-runtime-config';
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
      runtime: null,
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
    expect(body).toEqual({ credential: null, runtime: null });
  });

  it('refuses someone who is not a project member', async () => {
    sqlite.exec(
      `INSERT INTO users (id, email, role, status) VALUES ('stranger', 's@example.com', 'user', 'active')`
    );
    const { status } = await read('stranger');

    expect(status).toBe(404);
  });

  describe('effective configuration', () => {
    function setContract(sessionId: string, contract: unknown, skillId: string | null = null) {
      sqlite
        .prepare('UPDATE agent_sessions SET runtime_contract_json = ?, skill_id = ? WHERE id = ?')
        .run(
          typeof contract === 'string' ? contract : JSON.stringify(contract),
          skillId,
          sessionId
        );
    }
    const CONTRACT = {
      version: 1,
      agentType: 'claude-code',
      model: 'claude-opus-5-5',
      effort: 'max',
      permissionMode: 'acceptEdits',
      opencodeProvider: null,
      opencodeBaseUrl: 'https://private.example.test/v1',
      settingsResolved: true,
      acpInteractions: buildAcpInteractionRuntimeConfig({} as Env, 'task'),
      promptKind: 'task',
      taskContext: null,
    };

    beforeEach(() => {
      sqlite.exec(`
        INSERT INTO skills (id, project_id, user_id, name, created_at, updated_at)
          VALUES ('sk-project', 'p1', 'runner', 'do', '${NOW}', '${NOW}'),
                 ('sk-personal', NULL, 'runner', 'my secret recipe', '${NOW}', '${NOW}');
      `);
    });

    it('returns the model, effort, permission mode and skill the session froze', async () => {
      setContract('s1', CONTRACT, 'sk-project');
      const { body } = await read('member');

      expect(body.runtime).toEqual({
        agentType: 'claude-code',
        model: 'claude-opus-5-5',
        effort: 'max',
        permissionMode: 'acceptEdits',
        opencodeProvider: null,
        skillName: 'do',
      });
      // A custom OpenCode base URL can be private; it never leaves the server.
      expect(JSON.stringify(body)).not.toContain('private.example.test');
    });

    it('reads the chat’s own agent session row, not another one in the workspace', async () => {
      setContract('s-other', { ...CONTRACT, model: 'claude-haiku-5-5' });
      setContract('s1', CONTRACT);
      const { body } = await read('runner');

      expect(body.runtime).toMatchObject({ model: 'claude-opus-5-5' });
    });

    it('shows a personal skill’s name only to the person who ran it', async () => {
      setContract('s1', CONTRACT, 'sk-personal');

      expect((await read('runner')).body.runtime).toMatchObject({
        skillName: 'my secret recipe',
      });
      const member = await read('member');
      expect(member.body.runtime).toMatchObject({ skillName: null, model: 'claude-opus-5-5' });
      expect(JSON.stringify(member.body)).not.toContain('my secret recipe');
    });

    it('returns the configuration even before the agent has a credential', async () => {
      sqlite.exec(`UPDATE agent_sessions SET agent_credential_reference = NULL WHERE id = 's1'`);
      setContract('s1', CONTRACT);
      const { body } = await read('runner');

      expect(body.credential).toBeNull();
      expect(body.runtime).toMatchObject({ permissionMode: 'acceptEdits' });
    });

    it('omits an unreadable contract instead of failing the whole response', async () => {
      setContract('s1', '{"version":1,"agentType":');
      const { status, body } = await read('runner');

      expect(status).toBe(200);
      expect(body.runtime).toBeNull();
      expect(body.credential).toMatchObject({ credentialScope: 'profile' });
    });
  });
});
