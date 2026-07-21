import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';

// Must match RUNTIME_REQUEST_INTERRUPTED_MESSAGE in
// src/durable-objects/vm-agent-container-recovery.ts (inlined to keep this unit
// test free of the DO module's drizzle/project-data import side effects).
const RUNTIME_REQUEST_INTERRUPTED_MESSAGE =
  'Your message is saved, but delivery was interrupted and its execution outcome is unknown. It was not replayed automatically. After restore finishes, check the transcript and partial output before deciding whether to send it again.';

const mocks = vi.hoisted(() => ({
  getOwnedWorkspace: vi.fn(),
  getOwnedNode: vi.fn(),
  resumeVmAgentContainer: vi.fn(),
  resumeAgentSessionOnNode: vi.fn(),
  updateSet: vi.fn(),
  session: {
    id: 'agent-session-1',
    workspaceId: 'workspace-1',
    userId: 'user-1',
    status: 'error',
    label: 'Instant',
    agentType: 'codex',
    agentProfileId: null,
    skillId: null,
    worktreePath: null,
    stoppedAt: null,
    suspendedAt: null,
    errorMessage: 'Runtime unavailable',
    lastPrompt: null,
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
  },
}));

vi.mock('../../../src/auth', () => ({
  createAuth: () => ({
    api: {
      getSession: vi.fn().mockResolvedValue({
        user: {
          id: 'user-1',
          email: 'user@example.com',
          name: 'Test User',
          role: 'user',
          status: 'active',
        },
        session: { id: 'auth-session-1', expiresAt: new Date('2030-01-01T00:00:00Z') },
      }),
    },
  }),
}));

vi.mock('../../../src/routes/workspaces/_helpers', () => ({
  assertNodeOperational: vi.fn(),
  getOwnedWorkspace: mocks.getOwnedWorkspace,
  getOwnedNode: mocks.getOwnedNode,
}));

vi.mock('../../../src/services/node-agent', () => ({
  createAgentSessionOnNode: vi.fn(),
  resumeAgentSessionOnNode: mocks.resumeAgentSessionOnNode,
  stopAgentSessionOnNode: vi.fn(),
  suspendAgentSessionOnNode: vi.fn(),
}));

vi.mock('../../../src/services/vm-agent-container', () => ({
  resumeVmAgentContainer: mocks.resumeVmAgentContainer,
}));

// The resume route reads the session via select().from().where().limit(1) both
// BEFORE recovery (initial snapshot) and AFTER a successful cf-container recovery
// (re-fetch). Returning a fresh COPY of mocks.session each call models D1: the
// initial read captures the pre-recovery row, and the re-fetch reflects whatever
// the DO's persistRuntimeRecovered wrote during resumeVmAgentContainer.
vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          // Session reads use .limit(1); unrelated middleware lookups use .get().
          limit: () => Promise.resolve([{ ...mocks.session }]),
          get: () => Promise.resolve(undefined),
        }),
      }),
    }),
    update: () => ({
      set: (values: unknown) => {
        mocks.updateSet(values);
        return { where: () => Promise.resolve() };
      },
    }),
  }),
}));

async function createTestApp() {
  const { agentSessionRoutes } = await import('../../../src/routes/workspaces/agent-sessions');
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/workspaces', agentSessionRoutes);
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(error.toJSON(), error.statusCode as 409);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: 'Internal server error' }, 500);
  });
  return app;
}

async function postResume(app: Hono<{ Bindings: Env }>): Promise<Response> {
  return app.request(
    '/api/workspaces/workspace-1/agent-sessions/agent-session-1/resume',
    { method: 'POST' },
    { DATABASE: {} } as Env
  );
}

describe('agent session Instant recovery route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.status = 'error';
    mocks.session.errorMessage = 'Runtime unavailable';
    mocks.session.suspendedAt = null;
    mocks.session.stoppedAt = null;
    mocks.getOwnedWorkspace.mockResolvedValue({
      id: 'workspace-1',
      userId: 'user-1',
      nodeId: 'node-1',
    });
    mocks.getOwnedNode.mockResolvedValue({
      id: 'node-1',
      userId: 'user-1',
      runtime: 'cf-container',
      status: 'error',
    });
    mocks.resumeVmAgentContainer.mockResolvedValue({
      ok: true,
      status: 'running',
      degraded: false,
    });
  });

  it('marks the session running only after the container reports recovery', async () => {
    let resolveRecovery!: (value: unknown) => void;
    mocks.resumeVmAgentContainer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRecovery = resolve;
        })
    );
    const app = await createTestApp();

    const responsePromise = postResume(app);
    await vi.waitFor(() =>
      expect(mocks.resumeVmAgentContainer).toHaveBeenCalledWith(
        expect.objectContaining({ DATABASE: {} }),
        'node-1',
        'agent-session-1'
      )
    );
    // Response is still pending until the DO reports recovery.
    // The route never rewrites the row itself on the recovery path — the DO owns
    // the reconciliation, so updateSet must not be called at all.
    expect(mocks.updateSet).not.toHaveBeenCalled();

    // Simulate the DO's persistRuntimeRecovered reconciling D1 to running.
    mocks.session.status = 'running';
    mocks.session.errorMessage = null;
    mocks.session.updatedAt = '2026-07-21T00:05:00.000Z';
    resolveRecovery({ ok: true, status: 'running', degraded: false });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    // No route-side rewrite — the DO reconciled D1; the route re-fetches + returns.
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(await response.json()).toEqual(expect.objectContaining({ status: 'running' }));
  });

  it('returns the DO-reconciled manual_retry state without clobbering error_message', async () => {
    // A mutating prompt was interrupted; the DO recovers and persists the
    // manual-retry notice into agent_sessions.error_message in the SAME request.
    mocks.resumeVmAgentContainer.mockImplementationOnce(async () => {
      mocks.session.status = 'running';
      mocks.session.errorMessage = RUNTIME_REQUEST_INTERRUPTED_MESSAGE;
      mocks.session.updatedAt = '2026-07-21T00:05:00.000Z';
      return { ok: true, status: 'running', degraded: false };
    });
    const app = await createTestApp();

    const response = await postResume(app);

    expect(response.status).toBe(200);
    // The route must NOT run its own status rewrite (which nulls error_message).
    expect(mocks.updateSet).not.toHaveBeenCalled();
    const body = (await response.json()) as { status: string; errorMessage: string | null };
    expect(body.status).toBe('running');
    expect(body.errorMessage).toBe(RUNTIME_REQUEST_INTERRUPTED_MESSAGE);
  });

  it('returns a stable degraded error without falsely marking the session running', async () => {
    mocks.resumeVmAgentContainer.mockResolvedValueOnce({
      ok: false,
      status: 'degraded',
      degraded: true,
      code: 'RUNTIME_RECOVERY_DEGRADED',
      message:
        'The Instant session could not restore its last safe checkpoint. Your transcript and partial output are still available.',
    });
    const app = await createTestApp();

    const response = await postResume(app);

    const body = await response.json();
    expect(body).toEqual({
      error: 'RUNTIME_RECOVERY_DEGRADED',
      message:
        'The Instant session could not restore its last safe checkpoint. Your transcript and partial output are still available.',
    });
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it('preserves an explicit stop as terminal', async () => {
    mocks.resumeVmAgentContainer.mockResolvedValueOnce({
      ok: false,
      status: 'stopped',
      degraded: false,
      code: 'RUNTIME_STOPPED',
      message: 'This Instant session was stopped and cannot be resumed.',
    });
    const app = await createTestApp();

    const response = await postResume(app);

    expect(response.status).toBe(410);
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it('never triggers container recovery for a VM-runtime node (T13)', async () => {
    // VM-runtime suspended session: recovery is a cf-container-only concern; the
    // route must use the suspended VM resume path, not resumeVmAgentContainer.
    mocks.getOwnedNode.mockResolvedValue({
      id: 'node-1',
      userId: 'user-1',
      runtime: 'vm',
      status: 'running',
    });
    mocks.session.status = 'suspended';
    mocks.session.suspendedAt = '2026-07-21T00:01:00.000Z';
    mocks.session.errorMessage = null;
    const app = await createTestApp();

    const response = await postResume(app);

    expect(response.status).toBe(200);
    expect(mocks.resumeVmAgentContainer).not.toHaveBeenCalled();
    expect(mocks.resumeAgentSessionOnNode).toHaveBeenCalledWith(
      'node-1',
      'workspace-1',
      'agent-session-1',
      expect.anything(),
      'user-1'
    );
    // VM path DOES rewrite the row to running (legacy lifecycle).
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'running', errorMessage: null })
    );
    expect(await response.json()).toEqual(expect.objectContaining({ status: 'running' }));
  });
});
