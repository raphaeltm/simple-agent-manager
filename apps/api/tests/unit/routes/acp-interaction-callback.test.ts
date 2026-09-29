import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { acpInteractionCallbackRoute } from '../../../src/routes/projects/acp-interaction-callback';

const mocks = vi.hoisted(() => ({
  createInteraction: vi.fn(),
  drizzle: vi.fn(),
  settleInteraction: vi.fn(),
  verifyCallbackToken: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => ({ drizzle: mocks.drizzle }));
vi.mock('../../../src/services/jwt', () => ({ verifyCallbackToken: mocks.verifyCallbackToken }));
vi.mock('../../../src/services/acp-interaction-store', () => ({
  createInteraction: mocks.createInteraction,
  settleInteraction: mocks.settleInteraction,
}));

const interactionId = '11111111-1111-4111-8111-111111111111';
const generation = '22222222-2222-4222-8222-222222222222';

function body() {
  return {
    protocolVersion: 1,
    interactionId,
    generation,
    runtimeIdentity: 'runtime-1',
    agentSessionId: 'agent-session-1',
    kind: 'permission',
    payloadHash: 'a'.repeat(64),
    detail: { permissionName: 'secret' },
    safeSummary: { toolCallId: 'tool-1', optionCount: 1 },
    deadlineAt: Date.now() + 60_000,
  };
}

function app() {
  const instance = new Hono<{ Bindings: Env }>();
  instance.onError(handleAppError);
  instance.route('/api/projects', acpInteractionCallbackRoute);
  return instance;
}

function env(agentSessionStatus = 'running'): Env {
  return {
    DATABASE: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue({ id: 'agent-session-1', status: agentSessionStatus }),
        })),
      })),
    } as unknown as D1Database,
  } as Env;
}

describe('ACP interaction callback routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyCallbackToken.mockResolvedValue({
      workspace: 'workspace-1',
      type: 'callback',
      scope: 'workspace',
    });
    mocks.drizzle.mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn().mockResolvedValue({
              projectId: 'project-1',
              chatSessionId: 'chat-1',
              userId: 'user-1',
              status: 'running',
            }),
          })),
        })),
      })),
    });
    mocks.createInteraction.mockResolvedValue({
      status: 'created',
      summary: { state: 'pending' },
    });
    mocks.settleInteraction.mockResolvedValue({ status: 'settled' });
  });

  it('binds create to callback workspace and server-resolved project and chat session', async () => {
    const response = await app().request(
      '/api/projects/project-1/workspaces/workspace-1/acp-interactions',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body(),
          projectId: 'attacker-project',
          chatSessionId: 'attacker-chat',
        }),
      },
      env()
    );

    expect(response.status).toBe(201);
    expect(mocks.verifyCallbackToken).toHaveBeenCalledWith('callback-token', expect.anything(), {
      expectedScope: 'workspace',
    });
    expect(mocks.createInteraction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        projectId: 'project-1',
        chatSessionId: 'chat-1',
        agentSessionId: 'agent-session-1',
      })
    );
  });

  it('rejects a callback token bound to another workspace before creating', async () => {
    mocks.verifyCallbackToken.mockResolvedValueOnce({
      workspace: 'workspace-2',
      type: 'callback',
      scope: 'workspace',
    });
    const response = await app().request(
      '/api/projects/project-1/workspaces/workspace-1/acp-interactions',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(body()),
      },
      env()
    );

    expect(response.status).toBe(401);
    expect(mocks.createInteraction).not.toHaveBeenCalled();
  });

  it('rejects a stale agent session and binds settle to the route interaction id', async () => {
    const stale = await app().request(
      '/api/projects/project-1/workspaces/workspace-1/acp-interactions',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(body()),
      },
      env('stopped')
    );
    expect(stale.status).toBe(409);
    expect(mocks.createInteraction).not.toHaveBeenCalled();

    const settle = await app().request(
      `/api/projects/project-1/workspaces/workspace-1/acp-interactions/${interactionId}/settle`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: 1,
          interactionId,
          generation,
          runtimeIdentity: 'runtime-1',
          agentSessionId: 'agent-session-1',
          reason: 'completed',
        }),
      },
      env()
    );
    expect(settle.status).toBe(200);
    expect(mocks.settleInteraction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectId: 'project-1', chatSessionId: 'chat-1', interactionId })
    );
  });
});
