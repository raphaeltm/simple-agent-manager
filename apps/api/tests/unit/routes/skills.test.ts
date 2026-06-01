import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const mocks = vi.hoisted(() => ({
  requireOwnedProject: vi.fn(),
  listSkills: vi.fn(),
  getSkill: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => next()),
  requireApproved: () => vi.fn((c: any, next: any) => next()),
  getUserId: () => 'user-1',
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireOwnedProject: mocks.requireOwnedProject,
}));
vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn().mockReturnValue({}),
}));
vi.mock('../../../src/services/skills', () => ({
  listSkills: mocks.listSkills,
  getSkill: mocks.getSkill,
  createSkill: mocks.createSkill,
  updateSkill: mocks.updateSkill,
  deleteSkill: mocks.deleteSkill,
}));

import { skillRoutes } from '../../../src/routes/skills';

const NOW = '2026-05-31T00:00:00.000Z';
const ROUTE_PATH = '/api/projects/:projectId/skills';
const REQUEST_PATH = 'https://api.test.example.com/api/projects/project-1/skills';

function makeEnv(): Env {
  return {
    DATABASE: {} as any,
    DEFAULT_TASK_AGENT_TYPE: 'opencode',
  } as Env;
}

function makeSkill(overrides: Record<string, unknown> = {}) {
  return {
    id: 'skill-1',
    projectId: 'project-1',
    userId: 'user-1',
    name: 'Fix CI',
    description: 'Repeatable CI repair task',
    agentType: 'opencode',
    model: null,
    permissionMode: null,
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: null,
    devcontainerConfigName: null,
    taskMode: 'task',
    resourceRequirementsJson: null,
    defaultProfileId: null,
    isBuiltin: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('Skill Routes', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOwnedProject.mockResolvedValue({ id: 'project-1', userId: 'user-1' });
    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route(ROUTE_PATH, skillRoutes);
  });

  it('lists skills for an owned project', async () => {
    mocks.listSkills.mockResolvedValueOnce([makeSkill()]);

    const res = await app.request(REQUEST_PATH, { method: 'GET' }, makeEnv());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ items: [{ id: 'skill-1' }] });
    expect(mocks.requireOwnedProject).toHaveBeenCalled();
    expect(mocks.listSkills).toHaveBeenCalledWith(expect.anything(), 'project-1', 'user-1');
  });

  it('creates a skill and defaults to task mode through the service payload', async () => {
    mocks.createSkill.mockResolvedValueOnce(makeSkill({ id: 'skill-new', name: 'Release' }));

    const res = await app.request(REQUEST_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Release', resourceRequirementsJson: '{"cpu":4}' }),
    }, makeEnv());

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ id: 'skill-new', name: 'Release' });
    expect(mocks.createSkill).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      'user-1',
      expect.objectContaining({ name: 'Release', resourceRequirementsJson: '{"cpu":4}' }),
      expect.anything()
    );
  });

  it('rejects invalid create payloads before calling the service', async () => {
    const res = await app.request(REQUEST_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'missing name' }),
    }, makeEnv());

    expect(res.status).toBe(400);
    expect(mocks.createSkill).not.toHaveBeenCalled();
  });

  it('reads, updates, and deletes a skill', async () => {
    mocks.getSkill.mockResolvedValueOnce(makeSkill());
    mocks.updateSkill.mockResolvedValueOnce(makeSkill({ description: 'Updated' }));
    mocks.deleteSkill.mockResolvedValueOnce(undefined);

    const getRes = await app.request(`${REQUEST_PATH}/skill-1`, { method: 'GET' }, makeEnv());
    expect(getRes.status).toBe(200);
    await expect(getRes.json()).resolves.toMatchObject({ id: 'skill-1' });

    const patchRes = await app.request(`${REQUEST_PATH}/skill-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Updated' }),
    }, makeEnv());
    expect(patchRes.status).toBe(200);
    expect(mocks.updateSkill).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      'skill-1',
      'user-1',
      expect.objectContaining({ description: 'Updated' })
    );

    const deleteRes = await app.request(`${REQUEST_PATH}/skill-1`, { method: 'DELETE' }, makeEnv());
    expect(deleteRes.status).toBe(200);
    await expect(deleteRes.json()).resolves.toEqual({ success: true });
  });
});
