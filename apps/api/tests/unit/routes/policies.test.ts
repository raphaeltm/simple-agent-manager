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

import { errors } from '../../../src/middleware/error';
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
        0.9,
        'always',
        null
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
        expect.any(Number),
        'always',
        null
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

  /**
   * The REST boundary must enforce the same lifecycle invariant as the MCP boundary —
   * both call the shared `validatePolicyLifecycle`, so the rule cannot silently apply
   * in only one of them (rule 24).
   */
  describe('policy lifecycle (expiry + scope)', () => {
    async function post(body: unknown) {
      return app.request(
        BASE,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        makeEnv()
      );
    }

    async function patch(policyId: string, body: unknown) {
      return app.request(
        `${BASE}/${policyId}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        makeEnv()
      );
    }

    it('rejects a task-scoped policy with no expiry', async () => {
      const res = await post({
        category: 'constraint',
        title: 'Use profile X for the reliability wave',
        content: 'Applies to the 2026-08-21 workstream only.',
        scope: 'task',
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toMatch(/task-scoped policy must set expiresAt/);
      expect(mocks.createPolicy).not.toHaveBeenCalled();
    });

    it('rejects an expiry in the past', async () => {
      const res = await post({
        category: 'rule',
        title: 'Already lapsed',
        content: 'Content',
        expiresAt: Date.now() - 1000,
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toMatch(/must be in the future/);
      expect(mocks.createPolicy).not.toHaveBeenCalled();
    });

    it('rejects an unknown scope', async () => {
      const res = await post({ category: 'rule', title: 't', content: 'c', scope: 'forever' });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toMatch(/scope must be one of/);
      expect(mocks.createPolicy).not.toHaveBeenCalled();
    });

    it('forwards a valid task-scoped policy with its expiry', async () => {
      mocks.createPolicy.mockResolvedValueOnce({ id: 'policy-3' });
      const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;

      const res = await post({
        category: 'constraint',
        title: 'Scoped',
        content: 'Content',
        scope: 'task',
        expiresAt,
      });

      expect(res.status).toBe(201);
      expect(mocks.createPolicy).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        'constraint',
        'Scoped',
        'Content',
        'explicit',
        null,
        expect.any(Number),
        'task',
        expiresAt
      );
    });

    it('validates an update against the merged post-write state, not the patch alone', async () => {
      mocks.getPolicy.mockResolvedValueOnce({
        id: 'policy-1',
        scope: 'task',
        expiresAt: Date.now() + 60_000,
      });

      const res = await patch('policy-1', { expiresAt: null });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toMatch(/task-scoped policy must set expiresAt/);
      expect(mocks.updatePolicy).not.toHaveBeenCalled();
    });

    it('allows clearing the expiry when the scope is widened in the same update', async () => {
      mocks.getPolicy.mockResolvedValueOnce({
        id: 'policy-1',
        scope: 'task',
        expiresAt: Date.now() + 60_000,
      });
      mocks.updatePolicy.mockResolvedValueOnce(true);

      const res = await patch('policy-1', { scope: 'always', expiresAt: null });

      expect(res.status).toBe(200);
      expect(mocks.updatePolicy).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        'policy-1',
        expect.objectContaining({ scope: 'always', expiresAt: null })
      );
    });

    it('maps the DO guard rejection to a 400 rather than an opaque 500', async () => {
      // The DO re-validates against freshly-read state, so a concurrent PATCH landing
      // between the pre-check and the write can still make it throw. That error arrives
      // as a plain Error with only name and message (rule 63) — production RPC fidelity,
      // NOT a richer custom class — so the route must map it by message.
      mocks.getPolicy.mockResolvedValueOnce({
        id: 'policy-1',
        scope: 'always',
        expiresAt: null,
      });
      mocks.updatePolicy.mockRejectedValueOnce(
        new Error(
          "a task-scoped policy must set expiresAt so it cannot outlive the work it was captured for (use scope 'always' for a standing policy)"
        )
      );

      const res = await patch('policy-1', { scope: 'task', expiresAt: Date.now() + 60_000 });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).not.toBe('INTERNAL_ERROR');
      expect(body.message).toMatch(/task-scoped policy must set expiresAt/);
    });

    it('does not swallow a genuine AppError from the service layer', async () => {
      mocks.updatePolicy.mockRejectedValueOnce(errors.notFound('Policy not found'));

      const res = await patch('policy-1', { active: false });

      expect(res.status).toBe(404);
    });

    it('does not read the stored policy when the update touches no lifecycle field', async () => {
      // Guards the I/O budget (rule 60): the extra read exists only to merge scope and
      // expiry, so an ordinary title/active edit must not pay for it.
      mocks.updatePolicy.mockResolvedValueOnce(true);

      const res = await patch('policy-1', { active: false });

      expect(res.status).toBe(200);
      expect(mocks.getPolicy).not.toHaveBeenCalled();
    });
  });
});
