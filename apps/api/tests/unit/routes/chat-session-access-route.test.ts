import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { registerChatSessionAccessRoutes } from '../../../src/routes/chat-session-access';

/**
 * Route-level coverage for "Share chat access" (idea 01M59MYE4GY91BWTE8TZF1ZB5D). Mocks sit at
 * the auth/project-auth boundary and the ProjectData DO stub — the same boundary-mocking
 * pattern as `chat-comment-send.test.ts` — so `src/services/project-data.ts` itself is real
 * and these tests exercise the actual DO-call plumbing (.claude/rules/35).
 */

const mocks = vi.hoisted(() => ({
  userId: 'owner-1',
  requireProjectCapability: vi.fn(),
  hasProjectCapability: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({ mockedDb: true })),
}));

vi.mock('../../../src/middleware/auth', () => ({
  getUserId: vi.fn(() => mocks.userId),
  getAuth: vi.fn(() => ({
    user: { id: mocks.userId, email: `${mocks.userId}@example.com`, name: `Name ${mocks.userId}` },
  })),
}));

vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectCapability: mocks.requireProjectCapability,
  hasProjectCapability: mocks.hasProjectCapability,
}));

vi.mock('../../../src/services/collaboration-settings', () => ({
  getSessionAccessMaxGrants: vi.fn().mockResolvedValue(2),
}));

vi.mock('../../../src/services/collaboration-notifications', () => ({
  notifySessionAccessChange: vi.fn().mockResolvedValue(undefined),
}));

type ProjectDataAccessStub = {
  ensureProjectId: ReturnType<typeof vi.fn>;
  getSessionAccess: ReturnType<typeof vi.fn>;
  getSessionWithAccessGrants: ReturnType<typeof vi.fn>;
  createSessionAccessGrant: ReturnType<typeof vi.fn>;
  revokeSessionAccessGrant: ReturnType<typeof vi.fn>;
};

function makeApp(): Hono<{ Bindings: Env }> {
  const root = new Hono<{ Bindings: Env }>();
  const sessionAccessRoutes = new Hono<{ Bindings: Env }>();
  registerChatSessionAccessRoutes(sessionAccessRoutes);
  root.route('/api/projects/:projectId/sessions', sessionAccessRoutes);
  root.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as never);
    }
    throw err;
  });
  return root;
}

function makeOwnerAccess(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    found: true,
    ownerUserId: 'owner-1',
    sessionStatus: 'active',
    role: 'owner' as const,
    grant: null,
    ...overrides,
  };
}

function makeProjectDataStub(
  overrides: Partial<ProjectDataAccessStub> = {}
): ProjectDataAccessStub {
  return {
    ensureProjectId: vi.fn().mockResolvedValue(undefined),
    getSessionAccess: vi.fn().mockResolvedValue({
      session: { id: 'session-1', status: 'active', topic: 'Test session' },
      access: makeOwnerAccess(),
    }),
    getSessionWithAccessGrants: vi.fn().mockResolvedValue({
      session: { id: 'session-1', status: 'active', topic: 'Test session' },
      access: makeOwnerAccess(),
      grants: [],
    }),
    createSessionAccessGrant: vi.fn(),
    revokeSessionAccessGrant: vi.fn(),
    ...overrides,
  };
}

function makeEnv(projectDataStub: ProjectDataAccessStub): Env {
  const doId = { toString: () => 'project-data-project-1' };
  return {
    DATABASE: { prepare: vi.fn() },
    PROJECT_DATA: {
      idFromName: vi.fn().mockReturnValue(doId),
      get: vi.fn().mockReturnValue(projectDataStub),
    },
  } as unknown as Env;
}

function postGrant(env: Env, body: Record<string, unknown>) {
  return makeApp().request(
    '/api/projects/project-1/sessions/session-1/access/grants',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env
  );
}

function getAccess(env: Env) {
  return makeApp().request('/api/projects/project-1/sessions/session-1/access', {}, env);
}

const validGrantBody = {
  userId: 'grantee-1',
  durationMinutes: 30,
  acknowledgeSharedCredentials: true,
};

describe('chat session access routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userId = 'owner-1';
    mocks.requireProjectCapability.mockResolvedValue({ id: 'project-1' });
    mocks.hasProjectCapability.mockResolvedValue(true);
  });

  describe('POST /:sessionId/access/grants', () => {
    it('maps a DO limit_exceeded result to 409 naming the configured limit', async () => {
      const stub = makeProjectDataStub({
        createSessionAccessGrant: vi.fn().mockResolvedValue({
          result: { status: 'limit_exceeded', limit: 2 },
          grants: [],
        }),
      });
      const env = makeEnv(stub);

      const response = await postGrant(env, validGrantBody);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: 'CONFLICT',
        message: 'A session can be shared with at most 2 people at a time',
      });
      expect(stub.createSessionAccessGrant).toHaveBeenCalledWith({
        sessionId: 'session-1',
        granteeUserId: 'grantee-1',
        grantedByUserId: 'owner-1',
        durationMinutes: 30,
        maxActiveGrants: 2,
      });
    });

    it('maps a DO forbidden result to 403', async () => {
      const stub = makeProjectDataStub({
        createSessionAccessGrant: vi.fn().mockResolvedValue({
          result: {
            status: 'forbidden',
            reason: 'Only people who control this session can share it',
          },
          grants: [],
        }),
      });
      const env = makeEnv(stub);

      const response = await postGrant(env, validGrantBody);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: 'FORBIDDEN',
        message: 'Only people who control this session can share it',
      });
    });

    it('maps a DO invalid result to 400', async () => {
      const stub = makeProjectDataStub({
        createSessionAccessGrant: vi.fn().mockResolvedValue({
          result: {
            status: 'invalid',
            reason: 'This session has no owner to share on behalf of',
          },
          grants: [],
        }),
      });
      const env = makeEnv(stub);

      const response = await postGrant(env, validGrantBody);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'BAD_REQUEST',
        message: 'This session has no owner to share on behalf of',
      });
    });

    it('rejects a grantee who is not an active project member without creating a grant in the DO', async () => {
      mocks.hasProjectCapability.mockResolvedValue(false);
      const stub = makeProjectDataStub();
      const env = makeEnv(stub);

      const response = await postGrant(env, validGrantBody);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'BAD_REQUEST',
        message: 'Only active project members who can run tasks can be added to a session',
      });
      expect(mocks.hasProjectCapability).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        'grantee-1',
        'task:write'
      );
      expect(stub.createSessionAccessGrant).not.toHaveBeenCalled();
    });

    it('rejects a request missing acknowledgeSharedCredentials before touching the DO', async () => {
      const stub = makeProjectDataStub();
      const env = makeEnv(stub);

      const response = await postGrant(env, { userId: 'grantee-1', durationMinutes: 30 });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe('BAD_REQUEST');
      expect(body.message).toContain('acknowledgeSharedCredentials');
      expect(stub.getSessionAccess).not.toHaveBeenCalled();
      expect(stub.createSessionAccessGrant).not.toHaveBeenCalled();
    });
  });

  describe('POST /:sessionId/access/grants requires a duration', () => {
    it.each([
      ['missing', undefined],
      ['15 minutes', 15],
      ['an unlimited marker', 0],
      ['a day', 1440],
      ['a numeric string', '30'],
    ])('refuses %s before touching the DO', async (_label, durationMinutes) => {
      const stub = makeProjectDataStub();
      const env = makeEnv(stub);

      const response = await postGrant(env, {
        userId: 'grantee-1',
        acknowledgeSharedCredentials: true,
        ...(durationMinutes === undefined ? {} : { durationMinutes }),
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.message).toContain('Choose how long access lasts: 5, 10, 30 or 60 minutes');
      expect(stub.getSessionAccess).not.toHaveBeenCalled();
      expect(stub.createSessionAccessGrant).not.toHaveBeenCalled();
    });

    it.each([5, 10, 30, 60])('passes a %i-minute choice to ProjectData', async (minutes) => {
      const stub = makeProjectDataStub({
        createSessionAccessGrant: vi.fn().mockResolvedValue({
          result: { status: 'limit_exceeded', limit: 2 },
          grants: [],
        }),
      });

      await postGrant(makeEnv(stub), { ...validGrantBody, durationMinutes: minutes });

      expect(stub.createSessionAccessGrant).toHaveBeenCalledWith(
        expect.objectContaining({ durationMinutes: minutes })
      );
    });
  });

  describe('GET /:sessionId/access', () => {
    it('returns 404 when the session does not exist in this project', async () => {
      const stub = makeProjectDataStub({
        getSessionWithAccessGrants: vi.fn().mockResolvedValue({
          session: null,
          access: {
            found: false,
            ownerUserId: null,
            sessionStatus: null,
            role: 'none',
            grant: null,
          },
          grants: [],
        }),
      });
      const env = makeEnv(stub);

      const response = await getAccess(env);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: 'NOT_FOUND',
        message: 'Chat session not found',
      });
    });
  });
});
