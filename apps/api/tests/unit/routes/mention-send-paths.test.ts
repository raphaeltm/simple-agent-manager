/** Real HTTP handlers, auth/approval/project guards, enrichment, resolver and SQLite.
 * BetterAuth session lookup, ProjectData/TaskRunner RPC and VM HTTP are boundary fixtures.
 * createAllSchemaTables supplies column-compatible SQLite tables, not migration constraints.
 */
import { formatMentionName } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { requireApproved, requireAuth } from '../../../src/middleware/auth';
import { AppError } from '../../../src/middleware/error';
import { registerChatPromptRoute } from '../../../src/routes/chat-prompt-route';
import { submitRoutes } from '../../../src/routes/tasks/submit';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../../src/services/default-capacity-pools';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';
import { seedCloudCredential, seedProjectWithMember, seedUser } from './capacity-pool-test-seeds';

const boundary = vi.hoisted(() => ({
  userId: 'user-1' as string | null,
  creatorId: 'user-1',
  createSession: vi.fn(),
  persistMessage: vi.fn(),
  recordActivityEvent: vi.fn(),
  updateSessionTopic: vi.fn(),
  startTaskRunnerDO: vi.fn(),
  sendPromptToAgentOnNode: vi.fn(),
}));
vi.mock('../../../src/auth', () => ({
  createAuth: async () => ({
    api: {
      getSession: async () =>
        boundary.userId
          ? {
              user: {
                id: boundary.userId,
                email: `${boundary.userId}@example.com`,
                name: 'Test member',
                role: 'user',
                status: 'active',
              },
              session: {
                id: 'browser-session',
                token: 'fixture-session',
                expiresAt: new Date('2030-01-01'),
              },
            }
          : null,
    },
  }),
}));
vi.mock('../../../src/services/project-data', async (original) => {
  const { sessionAccessFromGetSession } = await import('../../helpers/session-access-mock');
  const getSession = async () => ({
    id: 'chat-1',
    status: 'active',
    workspaceId: 'workspace-1',
    taskId: null,
    topic: 'Mention regression',
    createdByUserId: boundary.creatorId,
  });
  return {
    ...(await original<typeof import('../../../src/services/project-data')>()),
    createSession: boundary.createSession,
    persistMessage: boundary.persistMessage,
    recordActivityEvent: boundary.recordActivityEvent,
    updateSessionTopic: boundary.updateSessionTopic,
    getSession,
    getSessionAccess: sessionAccessFromGetSession(getSession),
  };
});
vi.mock('../../../src/services/task-runner-do', async (original) => ({
  ...(await original<typeof import('../../../src/services/task-runner-do')>()),
  startTaskRunnerDO: boundary.startTaskRunnerDO,
}));
vi.mock('../../../src/services/node-agent', async (original) => ({
  ...(await original<typeof import('../../../src/services/node-agent')>()),
  sendPromptToAgentOnNode: boundary.sendPromptToAgentOnNode,
}));

function app() {
  const result = new Hono<{ Bindings: Env }>();
  result.onError((error, c) =>
    error instanceof AppError
      ? c.json(error.toJSON(), error.statusCode as never)
      : c.json({ error: 'INTERNAL_ERROR', message: error.message }, 500)
  );
  result.route('/api/projects/:projectId/tasks', submitRoutes);
  const chat = new Hono<{ Bindings: Env }>();
  chat.use('*', requireAuth(), requireApproved());
  registerChatPromptRoute(chat);
  result.route('/api/projects/:projectId/sessions', chat);
  return result;
}

let sqlite: Database.Database;
let env: Env;
const background: Promise<unknown>[] = [];
const executionCtx = {
  waitUntil: (promise: Promise<unknown>) => background.push(promise),
  passThroughOnException: () => undefined,
} as ExecutionContext;
async function request(
  path: 'submit' | 'prompt',
  message: string,
  extra: Record<string, unknown> = {}
) {
  return app().request(
    `/api/projects/project-1/${path === 'submit' ? 'tasks/submit' : 'sessions/chat-1/prompt'}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'fixture=authenticated' },
      body: JSON.stringify({ [path === 'submit' ? 'message' : 'content']: message, ...extra }),
    },
    env,
    executionCtx
  );
}
function addProfile(
  id: string,
  name: string,
  projectId: string | null = 'project-1',
  userId = 'user-1'
) {
  sqlite
    .prepare(
      'INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, effort, system_prompt_append) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, projectId, userId, name, 'openai-codex', 'auto', 'Profile context canary');
}
function taskDescription() {
  return (
    sqlite.prepare('SELECT description FROM tasks ORDER BY rowid DESC LIMIT 1').get() as {
      description: string;
    }
  ).description;
}

beforeEach(async () => {
  vi.clearAllMocks();
  background.length = 0;
  boundary.userId = 'user-1';
  boundary.creatorId = 'user-1';
  boundary.createSession.mockResolvedValue('chat-created');
  boundary.persistMessage.mockResolvedValue('message-created');
  boundary.recordActivityEvent.mockResolvedValue('activity-created');
  boundary.updateSessionTopic.mockResolvedValue(true);
  boundary.startTaskRunnerDO.mockResolvedValue(undefined);
  boundary.sendPromptToAgentOnNode.mockResolvedValue({ success: true, messageId: 'vm-message' });
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  env = {
    DATABASE: createSqliteD1WithBindLimit(sqlite, 100),
    BASE_DOMAIN: 'example.test',
    DURABLE_PROMPT_DELIVERY_ENABLED: 'false',
    TASK_TITLE_GENERATION_ENABLED: 'false',
  } as Env;
  seedUser(sqlite, 'user-1');
  seedUser(sqlite, 'user-2');
  seedProjectWithMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
  // Artifacts projects legitimately have no external GitHub access gate.
  sqlite.prepare("UPDATE projects SET repo_provider = 'artifacts' WHERE id = 'project-1'").run();
  seedCloudCredential(sqlite, { id: 'cloud-1', userId: 'user-1', projectId: 'project-1' });
  await ensureDefaultCapacityPoolsForExistingCredentials(drizzle(env.DATABASE, { schema }), {
    userId: 'user-1',
    projectId: 'project-1',
    includeInstallation: false,
  });
  sqlite
    .prepare(
      "INSERT INTO nodes (id, user_id, status, runtime) VALUES ('node-1', 'user-1', 'running', 'vm')"
    )
    .run();
  sqlite
    .prepare(
      "INSERT INTO workspaces (id, project_id, user_id, node_id, chat_session_id, status) VALUES ('workspace-1', 'project-1', 'user-1', 'node-1', 'chat-1', 'running')"
    )
    .run();
  sqlite
    .prepare(
      "INSERT INTO agent_sessions (id, workspace_id, user_id, status) VALUES ('agent-1', 'workspace-1', 'user-1', 'running')"
    )
    .run();
  addProfile('profile-full', 'gcp-deployer');
  addProfile('profile-prefix', 'gcp');
});
afterEach(async () => {
  await Promise.allSettled(background);
  sqlite.close();
});

for (const path of ['submit', 'prompt'] as const) {
  describe(`real authenticated ${path} mention send path`, () => {
    it.each([
      'hello world',
      'hello @unknown-handle',
      'email person@gcp-deployer.example',
      'install @gcp-deployer/package',
      'ask @gcp-deployer-unknown',
    ])('sends %s unchanged without accidental enrichment', async (message) => {
      const response = await request(path, message);
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(
        path === 'submit' ? 202 : 200
      );
      if (path === 'submit') {
        expect(taskDescription()).toBe(message);
        expect(boundary.persistMessage).toHaveBeenCalledWith(
          env,
          'project-1',
          'chat-created',
          'user',
          message,
          null
        );
      } else {
        expect(boundary.sendPromptToAgentOnNode).toHaveBeenCalledWith(
          'node-1',
          'workspace-1',
          'agent-1',
          message,
          env,
          'user-1',
          undefined,
          undefined
        );
      }
    });
    it.each(['Please ask @gcp-deployer and @missing', 'Please ask @gcp-deployer.'])(
      'enriches the exact known profile in %s while keeping display text clean',
      async (message) => {
        const response = await request(path, message);
        expect(response.status, JSON.stringify(await response.clone().json())).toBe(
          path === 'submit' ? 202 : 200
        );
        const enriched =
          path === 'submit'
            ? taskDescription()
            : boundary.sendPromptToAgentOnNode.mock.calls[0]![3];
        expect(enriched).toContain(message);
        expect(enriched).toContain('profileId: profile-full');
        expect(enriched).not.toContain('profileId: profile-prefix');
        expect(enriched).toContain('Profile context canary');
      }
    );
    it.each([
      'release.bot',
      'two words',
      '123',
      'under_score',
      'déployeur_日本',
      'say "hi"',
      'path\\profile',
    ])('enriches the formatted full name %s', async (name) => {
      addProfile('profile-special', name);
      const message = `Please ask ${formatMentionName(name)}`;
      const response = await request(path, message);
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(
        path === 'submit' ? 202 : 200
      );
      expect(
        path === 'submit' ? taskDescription() : boundary.sendPromptToAgentOnNode.mock.calls[0]![3]
      ).toContain('profileId: profile-special');
    });
    it('does not enrich profiles from another project or another user personal scope', async () => {
      addProfile('foreign-project', 'other-project', 'project-2');
      addProfile('foreign-personal', 'other-user', null, 'user-2');
      const message = 'Ask @other-project and @other-user';
      expect((await request(path, message)).status).toBe(path === 'submit' ? 202 : 200);
      expect(
        path === 'submit' ? taskDescription() : boundary.sendPromptToAgentOnNode.mock.calls[0]![3]
      ).toBe(message);
    });
    it('rejects unauthenticated requests', async () => {
      boundary.userId = null;
      expect((await request(path, '@gcp-deployer')).status).toBe(401);
      expect(boundary.startTaskRunnerDO).not.toHaveBeenCalled();
      expect(boundary.sendPromptToAgentOnNode).not.toHaveBeenCalled();
    });
    it('rejects a non-member before dispatch', async () => {
      boundary.userId = 'user-2';
      expect((await request(path, '@gcp-deployer')).status).toBe(404);
      expect(boundary.startTaskRunnerDO).not.toHaveBeenCalled();
      expect(boundary.sendPromptToAgentOnNode).not.toHaveBeenCalled();
    });
    it('propagates a real SQLite lookup failure rather than treating it as an unknown mention', async () => {
      sqlite.exec('DROP TABLE agent_profiles');
      const response = await request(path, '@gcp-deployer');
      expect(response.status).toBe(500);
      expect((await response.json()).message).toContain('agent_profiles');
      expect(boundary.startTaskRunnerDO).not.toHaveBeenCalled();
      expect(boundary.sendPromptToAgentOnNode).not.toHaveBeenCalled();
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 });
    });
  });
}

it('keeps invalid explicit task profile selection strict', async () => {
  const response = await request('submit', 'plain message @unknown', {
    agentProfileId: 'missing-profile',
  });
  expect(response.status).toBe(404);
  expect((await response.json()).error).toBe('NOT_FOUND');
  expect(boundary.createSession).not.toHaveBeenCalled();
  expect(boundary.startTaskRunnerDO).not.toHaveBeenCalled();
});
it('rejects writes to another member session even when the actor is a project member', async () => {
  boundary.creatorId = 'user-2';
  expect((await request('prompt', '@unknown')).status).toBe(403);
  expect(boundary.sendPromptToAgentOnNode).not.toHaveBeenCalled();
});
it('rejects a cross-user workspace bridge after valid project/session guards', async () => {
  sqlite.prepare("UPDATE workspaces SET user_id = 'user-2' WHERE id = 'workspace-1'").run();
  expect((await request('prompt', '@gcp-deployer')).status).toBe(404);
  expect(boundary.sendPromptToAgentOnNode).not.toHaveBeenCalled();
});
