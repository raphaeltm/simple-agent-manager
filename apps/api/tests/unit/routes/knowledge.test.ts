/**
 * Tests for knowledge graph REST routes (apps/api/src/routes/knowledge.ts).
 *
 * Covers the jsonValidator migration: valid bodies reach the service layer,
 * malformed bodies are rejected with the standard 400 shape before the
 * service is called, and the pre-existing graceful-degrade behavior for
 * confidence/sourceType on AddObservation is preserved exactly.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const mocks = vi.hoisted(() => ({
  requireProjectAccess: vi.fn(),
  requireProjectCapability: vi.fn(),
  createKnowledgeEntity: vi.fn(),
  updateKnowledgeEntity: vi.fn(),
  deleteKnowledgeEntity: vi.fn(),
  getKnowledgeEntity: vi.fn(),
  listKnowledgeEntities: vi.fn(),
  searchKnowledgeObservations: vi.fn(),
  getKnowledgeObservationsForEntity: vi.fn(),
  getKnowledgeRelated: vi.fn(),
  addKnowledgeObservation: vi.fn(),
  updateKnowledgeObservation: vi.fn(),
  confirmKnowledgeObservation: vi.fn(),
  removeKnowledgeObservation: vi.fn(),
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
  createKnowledgeEntity: mocks.createKnowledgeEntity,
  updateKnowledgeEntity: mocks.updateKnowledgeEntity,
  deleteKnowledgeEntity: mocks.deleteKnowledgeEntity,
  getKnowledgeEntity: mocks.getKnowledgeEntity,
  listKnowledgeEntities: mocks.listKnowledgeEntities,
  searchKnowledgeObservations: mocks.searchKnowledgeObservations,
  getKnowledgeObservationsForEntity: mocks.getKnowledgeObservationsForEntity,
  getKnowledgeRelated: mocks.getKnowledgeRelated,
  addKnowledgeObservation: mocks.addKnowledgeObservation,
  updateKnowledgeObservation: mocks.updateKnowledgeObservation,
  confirmKnowledgeObservation: mocks.confirmKnowledgeObservation,
  removeKnowledgeObservation: mocks.removeKnowledgeObservation,
}));

import { knowledgeRoutes } from '../../../src/routes/knowledge';

const ROUTE_PATH = '/api/projects/:projectId/knowledge';
const BASE = 'https://api.test.example.com/api/projects/project-1/knowledge';

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
  app.route(ROUTE_PATH, knowledgeRoutes);
  return app;
}

describe('knowledge routes', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireProjectAccess.mockResolvedValue({ id: 'project-1', userId: 'owner-1' });
    mocks.requireProjectCapability.mockResolvedValue({ id: 'project-1', userId: 'owner-1' });
    app = makeApp();
  });

  describe('POST / (create entity)', () => {
    it('creates an entity from a valid body', async () => {
      mocks.createKnowledgeEntity.mockResolvedValueOnce({ id: 'entity-1', createdAt: 123 });

      const res = await app.request(
        BASE,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Prefers concise replies',
            entityType: 'preference',
            description: 'noted',
          }),
        },
        makeEnv()
      );

      expect(res.status).toBe(201);
      await expect(res.json()).resolves.toMatchObject({ id: 'entity-1' });
      expect(mocks.createKnowledgeEntity).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        'Prefers concise replies',
        'preference',
        'noted'
      );
    });

    it('rejects a malformed body (wrong-type name) with the standard 400 shape before calling the service', async () => {
      const res = await app.request(
        BASE,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 42, entityType: 'preference' }),
        },
        makeEnv()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('BAD_REQUEST');
      expect(mocks.createKnowledgeEntity).not.toHaveBeenCalled();
    });

    it('preserves the handler-level "Invalid entityType" message for an out-of-range value', async () => {
      const res = await app.request(
        BASE,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'x', entityType: 'not-a-real-type' }),
        },
        makeEnv()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('BAD_REQUEST');
      expect(body.message).toContain('Invalid entityType');
      expect(mocks.createKnowledgeEntity).not.toHaveBeenCalled();
    });

    it('preserves the handler-level "name is required" message for a missing name', async () => {
      const res = await app.request(
        BASE,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entityType: 'preference' }),
        },
        makeEnv()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toBe('name is required');
    });
  });

  describe('PATCH /:entityId (update entity)', () => {
    it('updates an entity from a valid partial body', async () => {
      mocks.updateKnowledgeEntity.mockResolvedValueOnce(undefined);

      const res = await app.request(
        `${BASE}/entity-1`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: 'updated note' }),
        },
        makeEnv()
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ updated: true });
      expect(mocks.updateKnowledgeEntity).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        'entity-1',
        { description: 'updated note' }
      );
    });

    it('rejects a malformed body (wrong-type entityType) with the standard 400 shape', async () => {
      const res = await app.request(
        `${BASE}/entity-1`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entityType: 42 }),
        },
        makeEnv()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('BAD_REQUEST');
      expect(mocks.updateKnowledgeEntity).not.toHaveBeenCalled();
    });
  });

  describe('POST /:entityId/observations (add observation)', () => {
    it('adds an observation from a valid body', async () => {
      mocks.addKnowledgeObservation.mockResolvedValueOnce({ id: 'obs-1', createdAt: 123 });

      const res = await app.request(
        `${BASE}/entity-1/observations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: 'Likes dark mode',
            confidence: 0.9,
            sourceType: 'inferred',
          }),
        },
        makeEnv()
      );

      expect(res.status).toBe(201);
      await expect(res.json()).resolves.toMatchObject({ id: 'obs-1' });
      expect(mocks.addKnowledgeObservation).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        'entity-1',
        'Likes dark mode',
        0.9,
        'inferred',
        null
      );
    });

    it('rejects a malformed body (wrong-type content) with the standard 400 shape', async () => {
      const res = await app.request(
        `${BASE}/entity-1/observations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: { nested: true } }),
        },
        makeEnv()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('BAD_REQUEST');
      expect(mocks.addKnowledgeObservation).not.toHaveBeenCalled();
    });

    it('preserves the "content is required" message for a missing content field', async () => {
      const res = await app.request(
        `${BASE}/entity-1/observations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        makeEnv()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toBe('content is required');
    });

    it('preserves the pre-existing graceful degrade for an out-of-type confidence/sourceType (never rejects, silently defaults)', async () => {
      mocks.addKnowledgeObservation.mockResolvedValueOnce({ id: 'obs-2', createdAt: 456 });

      const res = await app.request(
        `${BASE}/entity-1/observations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // confidence and sourceType are the WRONG type on purpose — the handler
          // has always tolerated this by silently falling back to defaults rather
          // than rejecting, and the migration must not change that.
          body: JSON.stringify({ content: 'hello', confidence: 'high', sourceType: 123 }),
        },
        makeEnv()
      );

      expect(res.status).toBe(201);
      expect(mocks.addKnowledgeObservation).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        'entity-1',
        'hello',
        // KNOWLEDGE_DEFAULTS.defaultConfidence
        0.7,
        'explicit',
        null
      );
    });
  });

  describe('PATCH /observations/:observationId (update observation)', () => {
    it('updates an observation from a valid body', async () => {
      mocks.updateKnowledgeObservation.mockResolvedValueOnce({ id: 'obs-1', updatedAt: 789 });

      const res = await app.request(
        `${BASE}/observations/obs-1`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'Revised note' }),
        },
        makeEnv()
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ id: 'obs-1' });
    });

    it('rejects a malformed body (wrong-type content) with the standard 400 shape', async () => {
      const res = await app.request(
        `${BASE}/observations/obs-1`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: ['not', 'a', 'string'] }),
        },
        makeEnv()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('BAD_REQUEST');
      expect(mocks.updateKnowledgeObservation).not.toHaveBeenCalled();
    });
  });
});
