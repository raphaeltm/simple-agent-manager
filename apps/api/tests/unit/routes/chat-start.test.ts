import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const mocks = vi.hoisted(() => ({
  drizzle: vi.fn(),
  auth: {
    getUserId: vi.fn(),
  },
  projectAuth: {
    requireProjectCapability: vi.fn(),
  },
  repoAccess: {
    requireRepositoryUserAccess: vi.fn(),
  },
  instant: {
    acceptInstantSession: vi.fn(),
    continueInstantSessionLaunch: vi.fn(),
  },
  mention: {
    enrichMessageWithMentions: vi.fn(),
  },
  skills: {
    resolveSkillProfile: vi.fn(),
  },
  runtime: {
    resolveWorkspaceRuntime: vi.fn(),
  },
}));

/** The idea store this route validates against; seeded per test with real SQLite. */
const ideaDb = vi.hoisted(() => ({
  current: null as {
    prepare: (sql: string) => { get: (...args: unknown[]) => unknown };
    close: () => void;
  } | null,
}));

vi.mock('drizzle-orm/d1', () => ({ drizzle: mocks.drizzle }));
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: mocks.auth.getUserId,
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectCapability: mocks.projectAuth.requireProjectCapability,
}));
vi.mock('../../../src/routes/projects/_helpers', () => mocks.repoAccess);
vi.mock('../../../src/services/instant-session', () => mocks.instant);
vi.mock('../../../src/services/mention-enrichment', () => mocks.mention);
vi.mock('../../../src/services/skills', () => mocks.skills);
vi.mock('../../../src/services/workspace-runtime', () => mocks.runtime);

import { chatStartRoutes } from '../../../src/routes/chat-start';

const BASE_URL = 'https://api.test.example.com';
const ROUTE_PATH = '/api/projects/:projectId/sessions';
const REQUEST_PATH = '/api/projects/project-1/sessions/start';

function makeEnv(): Env {
  const sqlite = ideaDb.current;
  return {
    DATABASE: (sqlite
      ? {
          prepare: (sql: string) => ({
            bind: (...args: unknown[]) => ({
              first: async () => sqlite.prepare(sql).get(...args) ?? null,
            }),
          }),
        }
      : {}) as never,
    DEFAULT_TASK_AGENT_TYPE: 'opencode',
    MAX_TASK_MESSAGE_LENGTH: '16000',
  } as Env;
}

/** Real SQL, so the project predicate in the idea gate is actually evaluated. */
function seedIdeas(): void {
  const sqlite = new Database(':memory:');
  // `is_idea` is the idea discriminator (program decision 16, migration 0207). NOT NULL
  // DEFAULT 0 in the real schema, so the fixture carries it rather than relying on a default.
  sqlite.exec(
    `CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT,
       is_idea INTEGER NOT NULL DEFAULT 0)`
  );
  const insert = sqlite.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?)');
  insert.run('idea-open', 'project-1', 'Retry failed webhook deliveries', 'draft', 1);
  insert.run('idea-done', 'project-1', 'Already shipped', 'completed', 1);
  insert.run('idea-foreign', 'project-2', 'Another project idea', 'draft', 1);
  // Draft, same project, not an idea — the row only `is_idea` can tell apart from `idea-open`.
  insert.run('task-ordinary-draft', 'project-1', 'An ordinary task', 'draft', 0);
  ideaDb.current = sqlite;
}

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route(ROUTE_PATH, chatStartRoutes);
  return app;
}

describe('chatStartRoutes', () => {
  const db = {
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
    })),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.drizzle.mockReturnValue(db);
    mocks.auth.getUserId.mockReturnValue('user-1');
    mocks.projectAuth.requireProjectCapability.mockResolvedValue({
      id: 'project-1',
      repository: 'owner/repo',
      defaultBranch: 'main',
      defaultAgentType: 'claude-code',
      defaultProvider: null,
      installationId: 'installation-1',
    });
    mocks.repoAccess.requireRepositoryUserAccess.mockResolvedValue(undefined);
    mocks.skills.resolveSkillProfile.mockResolvedValue({
      profileId: 'profile-1',
      skillId: null,
      agentType: 'claude-code',
      model: 'claude-sonnet-4-5-20250929',
      effort: 'auto',
      permissionMode: 'acceptEdits',
      provider: null,
      runtime: 'cf-container',
      systemPromptAppend: 'Prefer concise answers.',
    });
    mocks.runtime.resolveWorkspaceRuntime.mockResolvedValue({
      runtime: 'cf-container',
      reason: 'explicit-cf-container',
    });
    mocks.mention.enrichMessageWithMentions.mockResolvedValue({
      enrichedMessage: 'enriched hello',
    });
    mocks.instant.continueInstantSessionLaunch.mockResolvedValue(undefined);
    mocks.instant.acceptInstantSession.mockResolvedValue({
      taskId: 'task-1',
      chatSessionId: 'chat-session-1',
      workspaceId: 'workspace-1',
      nodeId: 'node-1',
      workspaceUrl: 'https://ws-workspace-1.example.com',
    });
  });

  it('launches a cf-container instant session for a matching profile runtime', async () => {
    const app = makeApp();
    const res = await app.request(
      `${BASE_URL}${REQUEST_PATH}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello', agentProfileId: 'profile-1' }),
      },
      makeEnv()
    );

    expect(res.status).toBe(202);
    const body = await res.json<{
      taskId: string;
      sessionId: string;
      runtime: { runtime: string };
    }>();
    expect(body.taskId).toBe('task-1');
    expect(body.sessionId).toBe('chat-session-1');
    expect(body.runtime.runtime).toBe('cf-container');
    expect(mocks.repoAccess.requireRepositoryUserAccess).toHaveBeenCalledOnce();
    expect(mocks.instant.acceptInstantSession).toHaveBeenCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({
        initialPrompt: 'enriched hello\n\nPrefer concise answers.',
        displayMessage: 'hello',
        agentProfileId: 'profile-1',
        agentType: 'claude-code',
      })
    );
    expect(mocks.instant.continueInstantSessionLaunch).toHaveBeenCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({ taskId: expect.any(String) }),
      expect.objectContaining({ chatSessionId: 'chat-session-1' })
    );
  });

  function parentTaskDb(parent: {
    userId: string;
    credentialAttributionUserId: string;
    credentialAttributionSource: string;
  }) {
    return {
      ...db,
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                id: 'parent-task',
                projectId: 'project-1',
                parentTaskId: null,
                credentialAttributionProjectId: null,
                ...parent,
              },
            ]),
          })),
        })),
      })),
    };
  }

  async function forkParent(parentDb: ReturnType<typeof parentTaskDb>) {
    mocks.drizzle.mockReturnValueOnce(parentDb);
    return makeApp().request(
      `${BASE_URL}${REQUEST_PATH}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'continue the source chat',
          agentProfileId: 'profile-1',
          parentTaskId: 'parent-task',
          contextSummary: ['## Fork Context', 'Source summary'].join(String.fromCharCode(10)),
        }),
      },
      makeEnv()
    );
  }

  it('keeps a fork of your own task on the direct cf-container path with lineage and inherited attribution', async () => {
    const parentDb = parentTaskDb({
      userId: 'user-1',
      credentialAttributionUserId: 'user-1',
      credentialAttributionSource: 'platform',
    });

    const res = await forkParent(parentDb);

    expect(res.status).toBe(202);
    expect(parentDb.insert.mock.results[0]?.value.values).toHaveBeenCalledWith(
      expect.objectContaining({
        parentTaskId: 'parent-task',
        credentialAttributionUserId: 'user-1',
        credentialAttributionSource: 'platform',
      })
    );
    expect(mocks.instant.acceptInstantSession).toHaveBeenCalledWith(
      parentDb,
      expect.anything(),
      expect.objectContaining({
        agentProfileId: 'profile-1',
        contextSummary: ['## Fork Context', 'Source summary'].join(String.fromCharCode(10)),
      })
    );
  });

  it('bills the caller, never the parent owner, when forking a teammate task (gap G5)', async () => {
    const parentDb = parentTaskDb({
      userId: 'source-user',
      credentialAttributionUserId: 'source-user',
      credentialAttributionSource: 'platform',
    });

    const res = await forkParent(parentDb);

    expect(res.status).toBe(202);
    const inserted = parentDb.insert.mock.results[0]?.value.values.mock.calls[0]?.[0];
    expect(inserted).toMatchObject({
      parentTaskId: 'parent-task',
      credentialAttributionUserId: 'user-1',
      credentialAttributionSource: 'user',
    });
    expect(inserted.credentialAttributionUserId).not.toBe('source-user');
  });

  it('returns conflict when the selected runtime resolves to vm', async () => {
    mocks.runtime.resolveWorkspaceRuntime.mockResolvedValueOnce({
      runtime: 'vm',
      reason: 'user-cloud-credential',
    });
    const app = makeApp();

    const res = await app.request(
      `${BASE_URL}${REQUEST_PATH}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello', agentProfileId: 'profile-1' }),
      },
      makeEnv()
    );

    expect(res.status).toBe(409);
    expect(mocks.instant.acceptInstantSession).not.toHaveBeenCalled();
  });

  describe('sourceIdeaId', () => {
    beforeEach(() => seedIdeas());
    afterEach(() => {
      ideaDb.current?.close();
      ideaDb.current = null;
    });

    function start(body: Record<string, unknown>) {
      return makeApp().request(
        `${BASE_URL}${REQUEST_PATH}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'hello', agentProfileId: 'profile-1', ...body }),
        },
        makeEnv()
      );
    }

    // The link itself is written inside `acceptInstantSession`
    // (instant-session-idea-link.test.ts). What this route owes it is a validated id.
    it('passes a validated open idea through to the Instant acceptance', async () => {
      const res = await start({ sourceIdeaId: 'idea-open' });
      expect(res.status).toBe(202);
      expect(mocks.instant.acceptInstantSession).toHaveBeenCalledWith(
        db,
        expect.anything(),
        expect.objectContaining({ sourceIdeaId: 'idea-open' })
      );
    });

    it('passes null when the start did not come from an idea', async () => {
      const res = await start({});
      expect(res.status).toBe(202);
      expect(mocks.instant.acceptInstantSession.mock.calls[0]?.[2]).toMatchObject({
        sourceIdeaId: null,
      });
    });

    it('404s an idea from another project before anything is created', async () => {
      const res = await start({ sourceIdeaId: 'idea-foreign' });
      expect(res.status).toBe(404);
      expect(mocks.instant.acceptInstantSession).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    // The Instant counterpart of the VM path's "no orphaned queued task": a link failure
    // inside `acceptInstantSession` must reach the route's failure handling and stop,
    // never schedule the launch that gives the agent its first prompt.
    it('does not launch the agent when acceptance fails on the idea link', async () => {
      mocks.instant.acceptInstantSession.mockImplementation(() =>
        Promise.reject(new Error('Could not link this chat to the idea'))
      );
      const res = await start({ sourceIdeaId: 'idea-open' });
      expect(res.status).toBe(500);
      expect(mocks.instant.continueInstantSessionLaunch).not.toHaveBeenCalled();
      // Liveness: the task row WAS created, so this is the failure path and not a
      // rejection that happened before anything was written.
      expect(db.insert).toHaveBeenCalled();
    });

    it('409s a done idea before anything is created', async () => {
      const res = await start({ sourceIdeaId: 'idea-done' });
      expect(res.status).toBe(409);
      expect(await res.json<{ message: string }>()).toMatchObject({
        message: expect.stringMatching(/idea is done/i),
      });
      expect(mocks.instant.acceptInstantSession).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });
  });
});
