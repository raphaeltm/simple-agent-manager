/**
 * Tests for project policy REST routes (apps/api/src/routes/policies.ts).
 *
 * Covers the jsonValidator migration: valid bodies reach the service layer,
 * malformed bodies are rejected with the standard 400 shape before the
 * service is called, and the pre-existing handler-level allowlist/typeof
 * checks (with their exact messages) are preserved.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const mocks = vi.hoisted(() => ({
  requireProjectAccess: vi.fn(),
  requireProjectCapability: vi.fn(),
  createPolicy: vi.fn(),
  updatePolicy: vi.fn(),
  listPolicies: vi.fn(),
  getPolicy: vi.fn(),
  removePolicy: vi.fn(),
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  getAuth: () => ({
    user: { id: 'user-1', email: 'u@test.dev', name: 'U', role: 'user', status: 'active' },
  }),
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectAccess: mocks.requireProjectAccess,
  requireProjectCapability: mocks.requireProjectCapability,
}));
vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn().mockReturnValue({}),
}));
vi.mock('../../../src/services/project-data', () => ({
  createPolicy: mocks.createPolicy,
  updatePolicy: mocks.updatePolicy,
  listPolicies: mocks.listPolicies,
  getPolicy: mocks.getPolicy,
  removePolicy: mocks.removePolicy,
}));

import { policyRoutes } from '../../../src/routes/policies';

const ROUTE_PATH = '/api/projects/:projectId/policies';
const BASE = 'https://api.test.example.com/api/projects/project-1/policies';

function makeEnv(): Env {
  return { DATABASE: {} as unknown } as Env;
}

function makeApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json(
        { error: appError.error, message: appError.message },
        appError.statusCode as 400
      );
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route(ROUTE_PATH, policyRoutes);
  return app;
}

describe('policy routes', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireProjectAccess.mockResolvedValue({ id: 'project-1', userId: 'owner-1' });
    mocks.requireProjectCapability.mockResolvedValue({ id: 'project-1', userId: 'owner-1' });
    app = makeApp();
  });

  describe('POST / (create policy)', () => {
    it('creates a policy from a valid body', async () => {
      mocks.createPolicy.mockResolvedValueOnce({ id: 'policy-1' });

      const res = await app.request(
        BASE,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            category: 'rule',
            title: 'Always run tests',
            content: 'Run the full suite before merging',
            source: 'explicit',
            confidence: 0.9,
          }),
        },
        makeEnv()
      );

      expect(res.status).toBe(201);
      await expect(res.json()).resolves.toMatchObject({ id: 'policy-1' });
      expect(mocks.createPolicy).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        'rule',
        'Always run tests',
        'Run the full suite before merging',
        'explicit',
        null,
        0.9
      );
    });

    it('rejects a malformed body (wrong-type title) with the standard 400 shape before calling the service', async () => {
      const res = await app.request(
        BASE,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category: 'rule', title: 42, content: 'x' }),
        },
        makeEnv()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('BAD_REQUEST');
      expect(mocks.createPolicy).not.toHaveBeenCalled();
    });

    it('preserves the handler-level "category must be one of" message for an invalid category', async () => {
      const res = await app.request(
        BASE,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category: 'not-a-category', title: 't', content: 'c' }),
        },
        makeEnv()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toContain('category must be one of');
      expect(mocks.createPolicy).not.toHaveBeenCalled();
    });

    it('defaults confidence when omitted (preserves nullish-coalescing to limits.defaultConfidence)', async () => {
      mocks.createPolicy.mockResolvedValueOnce({ id: 'policy-2' });

      const res = await app.request(
        BASE,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category: 'preference', title: 't', content: 'c' }),
        },
        makeEnv()
      );

      expect(res.status).toBe(201);
      expect(mocks.createPolicy).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        'preference',
        't',
        'c',
        'explicit',
        null,
        expect.any(Number)
      );
    });
  });

  describe('PATCH /:policyId (update policy)', () => {
    it('updates a policy from a valid partial body', async () => {
      mocks.updatePolicy.mockResolvedValueOnce(true);

      const res = await app.request(
        `${BASE}/policy-1`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: false }),
        },
        makeEnv()
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ updated: true, policyId: 'policy-1' });
      expect(mocks.updatePolicy).toHaveBeenCalledWith(expect.anything(), 'project-1', 'policy-1', {
        active: false,
      });
    });

    it('rejects a malformed body (wrong-type active) with the standard 400 shape', async () => {
      const res = await app.request(
        `${BASE}/policy-1`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: 'yes' }),
        },
        makeEnv()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('BAD_REQUEST');
      expect(mocks.updatePolicy).not.toHaveBeenCalled();
    });

    it('rejects an empty update body with "At least one update field must be provided"', async () => {
      const res = await app.request(
        `${BASE}/policy-1`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        makeEnv()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toBe('At least one update field must be provided');
      expect(mocks.updatePolicy).not.toHaveBeenCalled();
    });
  });
});
