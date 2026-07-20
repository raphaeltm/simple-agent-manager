import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    launchInstantSession: vi.fn(),
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
  return {
    DATABASE: {} as never,
    DEFAULT_TASK_AGENT_TYPE: 'opencode',
    MAX_TASK_MESSAGE_LENGTH: '16000',
  } as Env;
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
    mocks.instant.launchInstantSession.mockResolvedValue({
      taskId: 'task-1',
      chatSessionId: 'chat-session-1',
      workspaceId: 'workspace-1',
      nodeId: 'node-1',
      agentSessionId: 'agent-session-1',
      acpSessionId: 'agent-session-1',
      workspaceUrl: 'https://ws-workspace-1.example.com',
      timings: { setupDurationMs: 1 },
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

    expect(res.status).toBe(201);
    const body = await res.json<{
      taskId: string;
      sessionId: string;
      runtime: { runtime: string };
    }>();
    expect(body.taskId).toBe('task-1');
    expect(body.sessionId).toBe('chat-session-1');
    expect(body.runtime.runtime).toBe('cf-container');
    expect(mocks.repoAccess.requireRepositoryUserAccess).toHaveBeenCalledOnce();
    expect(mocks.instant.launchInstantSession).toHaveBeenCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({
        initialPrompt: 'enriched hello\n\nPrefer concise answers.',
        displayMessage: 'hello',
        agentProfileId: 'profile-1',
        agentType: 'claude-code',
      })
    );
    expect(db.update).toHaveBeenCalledTimes(2);
    expect(db.update.mock.results[1]?.value.set).toHaveBeenCalledWith(
      expect.objectContaining({
        agentProfileId: 'profile-1',
        skillId: null,
      })
    );
  });

  it('keeps a fork on the direct cf-container path with lineage and inherited attribution', async () => {
    const parentDb = {
      ...db,
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                id: 'parent-task',
                projectId: 'project-1',
                userId: 'source-user',
                parentTaskId: null,
                credentialAttributionUserId: 'source-user',
                credentialAttributionProjectId: null,
                credentialAttributionSource: 'platform',
              },
            ]),
          })),
        })),
      })),
    };
    mocks.drizzle.mockReturnValueOnce(parentDb);
    const app = makeApp();

    const res = await app.request(
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

    expect(res.status).toBe(201);
    expect(parentDb.insert.mock.results[0]?.value.values).toHaveBeenCalledWith(
      expect.objectContaining({
        parentTaskId: 'parent-task',
        credentialAttributionUserId: 'source-user',
        credentialAttributionSource: 'platform',
      })
    );
    expect(mocks.instant.launchInstantSession).toHaveBeenCalledWith(
      parentDb,
      expect.anything(),
      expect.objectContaining({
        agentProfileId: 'profile-1',
        contextSummary: ['## Fork Context', 'Source summary'].join(String.fromCharCode(10)),
      })
    );
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
    expect(mocks.instant.launchInstantSession).not.toHaveBeenCalled();
  });
});
