import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/index';

// Use vi.hoisted to create mocks that can be referenced in vi.mock factories
const mockService = vi.hoisted(() => ({
  listProfiles: vi.fn(),
  getProfile: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
  resolveAgentProfile: vi.fn(),
}));

// Mock auth middleware
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => next()),
  requireApproved: () => vi.fn((c: any, next: any) => next()),
  getUserId: () => 'test-user-id',
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireOwnedProject: vi.fn().mockResolvedValue({
    id: 'test-project-id',
    userId: 'test-user-id',
  }),
}));
vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn().mockReturnValue({}),
}));
vi.mock('../../../src/services/agent-profiles', () => mockService);

import { agentProfileRoutes } from '../../../src/routes/agent-profiles';

const BASE_URL = 'https://api.test.example.com';
const ROUTE_PATH = '/api/projects/:projectId/agent-profiles';
const REQUEST_PATH = '/api/projects/test-project-id/agent-profiles';

function makeEnv(): Env {
  return {
    DATABASE: {} as any,
    DEFAULT_TASK_AGENT_TYPE: 'claude-code',
  } as Env;
}

const NOW = '2026-03-15T12:00:00.000Z';

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'profile-1',
    projectId: 'test-project-id',
    userId: 'test-user-id',
    name: 'default',
    description: 'General-purpose coding agent',
    agentType: 'claude-code',
    model: 'claude-sonnet-4-5-20250929',
    permissionMode: 'acceptEdits',
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: null,
    isBuiltin: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('Agent Profiles Routes', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route(ROUTE_PATH, agentProfileRoutes);
  });

  describe('GET /', () => {
    it('returns list of profiles', async () => {
      const profiles = [
        makeProfile({ id: 'p1', name: 'default' }),
        makeProfile({ id: 'p2', name: 'planner' }),
      ];
      mockService.listProfiles.mockResolvedValueOnce(profiles);

      const res = await app.request(`${BASE_URL}${REQUEST_PATH}`, { method: 'GET' }, makeEnv());

      expect(res.status).toBe(200);
      const body = await res.json<{ items: any[] }>();
      expect(body.items).toHaveLength(2);
      expect(body.items[0].name).toBe('default');
      expect(body.items[1].name).toBe('planner');
    });
  });

  describe('POST /', () => {
    it('creates a new profile and returns 201', async () => {
      const created = makeProfile({ id: 'new-id', name: 'my-custom', isBuiltin: false });
      mockService.createProfile.mockResolvedValueOnce(created);

      const res = await app.request(
        `${BASE_URL}${REQUEST_PATH}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'my-custom', agentType: 'claude-code' }),
        },
        makeEnv()
      );

      expect(res.status).toBe(201);
      const body = await res.json<any>();
      expect(body.name).toBe('my-custom');
      expect(body.isBuiltin).toBe(false);
      expect(mockService.createProfile).toHaveBeenCalledOnce();
    });
  });

  describe('GET /:profileId', () => {
    it('returns a single profile', async () => {
      const profile = makeProfile();
      mockService.getProfile.mockResolvedValueOnce(profile);

      const res = await app.request(
        `${BASE_URL}${REQUEST_PATH}/profile-1`,
        { method: 'GET' },
        makeEnv()
      );

      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.id).toBe('profile-1');
      expect(body.name).toBe('default');
    });

    it('returns 404 when profile not found', async () => {
      const notFoundError = new Error('Not found') as any;
      notFoundError.statusCode = 404;
      notFoundError.error = 'NOT_FOUND';
      mockService.getProfile.mockRejectedValueOnce(notFoundError);

      const res = await app.request(
        `${BASE_URL}${REQUEST_PATH}/nonexistent`,
        { method: 'GET' },
        makeEnv()
      );

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /:profileId', () => {
    it('updates and returns the profile', async () => {
      const updated = makeProfile({ model: 'claude-opus-4-6' });
      mockService.updateProfile.mockResolvedValueOnce(updated);

      const res = await app.request(
        `${BASE_URL}${REQUEST_PATH}/profile-1`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'claude-opus-4-6' }),
        },
        makeEnv()
      );

      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.model).toBe('claude-opus-4-6');
      expect(mockService.updateProfile).toHaveBeenCalledOnce();
    });
  });

  describe('DELETE /:profileId', () => {
    it('deletes a profile and returns success', async () => {
      mockService.deleteProfile.mockResolvedValueOnce(undefined);

      const res = await app.request(
        `${BASE_URL}${REQUEST_PATH}/profile-1`,
        { method: 'DELETE' },
        makeEnv()
      );

      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.success).toBe(true);
      expect(mockService.deleteProfile).toHaveBeenCalledOnce();
    });
  });

  describe('POST /resolve', () => {
    it('resolves a profile by name', async () => {
      mockService.resolveAgentProfile.mockResolvedValueOnce({
        profileId: 'p1',
        profileName: 'planner',
        agentType: 'claude-code',
        model: 'claude-opus-4-6',
        permissionMode: 'plan',
        systemPromptAppend: null,
        maxTurns: null,
        timeoutMinutes: null,
        vmSizeOverride: null,
      });

      const res = await app.request(
        `${BASE_URL}${REQUEST_PATH}/resolve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileNameOrId: 'planner' }),
        },
        makeEnv()
      );

      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.profileName).toBe('planner');
      expect(body.model).toBe('claude-opus-4-6');
      expect(body.permissionMode).toBe('plan');
    });

    it('returns defaults when no profile hint', async () => {
      mockService.resolveAgentProfile.mockResolvedValueOnce({
        profileId: null,
        profileName: null,
        agentType: 'claude-code',
        model: null,
        permissionMode: null,
        systemPromptAppend: null,
        maxTurns: null,
        timeoutMinutes: null,
        vmSizeOverride: null,
      });

      const res = await app.request(
        `${BASE_URL}${REQUEST_PATH}/resolve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileNameOrId: null }),
        },
        makeEnv()
      );

      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.profileId).toBeNull();
      expect(body.agentType).toBe('claude-code');
    });
  });
});
