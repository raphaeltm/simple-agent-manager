/**
 * Knowledge Graph REST API routes.
 *
 * Mounted at /api/projects/:projectId/knowledge
 * Provides CRUD for entities, observations, and search for the UI.
 */
import type {
  AddObservationRequest,
  CreateKnowledgeEntityRequest,
  UpdateKnowledgeEntityRequest,
  UpdateObservationRequest,
} from '@simple-agent-manager/shared';
import {
  KNOWLEDGE_DEFAULTS,
  KNOWLEDGE_ENTITY_TYPES,
  KNOWLEDGE_SOURCE_TYPES,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getAuth, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireOwnedProject } from '../middleware/project-auth';
import * as projectDataService from '../services/project-data';

const knowledgeRoutes = new Hono<{ Bindings: Env }>();

// ─── Middleware ──────────────────────────────────────────────────────────────

knowledgeRoutes.use('/*', requireAuth(), requireApproved());

// ─── Helper ─────────────────────────────────────────────────────────────────

function getLimit(env: Env, key: string, defaultVal: number): number {
  const val = (env as unknown as Record<string, string | undefined>)[key];
  return val ? parseInt(val, 10) || defaultVal : defaultVal;
}

function requireParam(value: string | undefined, name: string): string {
  if (!value) throw errors.badRequest(`Missing required parameter: ${name}`);
  return value;
}

// ─── GET / — list entities ──────────────────────────────────────────────────

knowledgeRoutes.get('/', async (c) => {
  const auth = getAuth(c);
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, auth.user.id);

  const entityType = c.req.query('entityType') || null;
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10) || 50, 200);
  const offset = parseInt(c.req.query('offset') || '0', 10) || 0;

  const result = await projectDataService.listKnowledgeEntities(
    c.env, projectId, entityType, limit, offset,
  );

  return c.json(result);
});

// ─── GET /search — search observations ──────────────────────────────────────

knowledgeRoutes.get('/search', async (c) => {
  const auth = getAuth(c);
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, auth.user.id);

  const query = c.req.query('q') || '';
  if (!query.trim()) throw errors.badRequest('Query parameter "q" is required');

  const entityType = c.req.query('entityType') || null;
  const minConfidence = c.req.query('minConfidence') ? parseFloat(c.req.query('minConfidence')!) : null;
  const searchLimit = getLimit(c.env, 'KNOWLEDGE_SEARCH_LIMIT', KNOWLEDGE_DEFAULTS.searchLimit);
  const limit = Math.min(parseInt(c.req.query('limit') || String(searchLimit), 10) || searchLimit, 100);

  const results = await projectDataService.searchKnowledgeObservations(
    c.env, projectId, query, entityType, minConfidence, limit,
  );

  return c.json({ results, total: results.length });
});

// ─── GET /:entityId — get entity with observations ──────────────────────────

knowledgeRoutes.get('/:entityId', async (c) => {
  const auth = getAuth(c);
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const entityId = requireParam(c.req.param('entityId'), 'entityId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, auth.user.id);

  const entity = await projectDataService.getKnowledgeEntity(c.env, projectId, entityId);
  if (!entity) throw errors.notFound('Entity not found');

  const observations = await projectDataService.getKnowledgeObservationsForEntity(
    c.env, projectId, entityId, c.req.query('includeInactive') === 'true',
  );
  const relations = await projectDataService.getKnowledgeRelated(c.env, projectId, entityId, null);

  return c.json({ entity, observations, relations });
});

// ─── POST / — create entity ─────────────────────────────────────────────────

knowledgeRoutes.post('/', async (c) => {
  const auth = getAuth(c);
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, auth.user.id);

  const body = await c.req.json<CreateKnowledgeEntityRequest>();
  if (!body.name?.trim()) throw errors.badRequest('name is required');
  if (!body.entityType || !KNOWLEDGE_ENTITY_TYPES.includes(body.entityType)) {
    throw errors.badRequest(`Invalid entityType. Valid: ${KNOWLEDGE_ENTITY_TYPES.join(', ')}`);
  }

  const nameMaxLen = getLimit(c.env, 'KNOWLEDGE_ENTITY_NAME_MAX_LENGTH', KNOWLEDGE_DEFAULTS.entityNameMaxLength);
  const name = body.name.trim().slice(0, nameMaxLen);
  const description = body.description?.trim().slice(0, getLimit(c.env, 'KNOWLEDGE_DESCRIPTION_MAX_LENGTH', KNOWLEDGE_DEFAULTS.descriptionMaxLength)) ?? null;

  const result = await projectDataService.createKnowledgeEntity(
    c.env, projectId, name, body.entityType, description,
  );

  return c.json(result, 201);
});

// ─── PATCH /:entityId — update entity ───────────────────────────────────────

knowledgeRoutes.patch('/:entityId', async (c) => {
  const auth = getAuth(c);
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const entityId = requireParam(c.req.param('entityId'), 'entityId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, auth.user.id);

  const body = await c.req.json<UpdateKnowledgeEntityRequest>();
  const updates: UpdateKnowledgeEntityRequest = {};

  if (body.name !== undefined) {
    const nameMaxLen = getLimit(c.env, 'KNOWLEDGE_ENTITY_NAME_MAX_LENGTH', KNOWLEDGE_DEFAULTS.entityNameMaxLength);
    updates.name = body.name.trim().slice(0, nameMaxLen);
  }
  if (body.entityType !== undefined) {
    if (!KNOWLEDGE_ENTITY_TYPES.includes(body.entityType)) {
      throw errors.badRequest(`Invalid entityType. Valid: ${KNOWLEDGE_ENTITY_TYPES.join(', ')}`);
    }
    updates.entityType = body.entityType;
  }
  if (body.description !== undefined) {
    updates.description = body.description?.trim().slice(0, getLimit(c.env, 'KNOWLEDGE_DESCRIPTION_MAX_LENGTH', KNOWLEDGE_DEFAULTS.descriptionMaxLength)) ?? null;
  }

  try {
    await projectDataService.updateKnowledgeEntity(c.env, projectId, entityId, updates);
  } catch (err) {
    throw errors.notFound((err as Error).message);
  }

  return c.json({ updated: true });
});

// ─── DELETE /:entityId — delete entity ──────────────────────────────────────

knowledgeRoutes.delete('/:entityId', async (c) => {
  const auth = getAuth(c);
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const entityId = requireParam(c.req.param('entityId'), 'entityId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, auth.user.id);

  await projectDataService.deleteKnowledgeEntity(c.env, projectId, entityId);
  return c.json({ deleted: true });
});

// ─── POST /:entityId/observations — add observation ─────────────────────────

knowledgeRoutes.post('/:entityId/observations', async (c) => {
  const auth = getAuth(c);
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const entityId = requireParam(c.req.param('entityId'), 'entityId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, auth.user.id);

  const body = await c.req.json<AddObservationRequest>();
  if (!body.content?.trim()) throw errors.badRequest('content is required');

  const obsMaxLen = getLimit(c.env, 'KNOWLEDGE_OBSERVATION_MAX_LENGTH', KNOWLEDGE_DEFAULTS.observationMaxLength);
  const content = body.content.trim().slice(0, obsMaxLen);
  const confidence = typeof body.confidence === 'number' ? Math.min(Math.max(0, body.confidence), 1) : KNOWLEDGE_DEFAULTS.defaultConfidence;
  const sourceType = body.sourceType && KNOWLEDGE_SOURCE_TYPES.includes(body.sourceType) ? body.sourceType : 'explicit';

  try {
    const result = await projectDataService.addKnowledgeObservation(
      c.env, projectId, entityId, content, confidence, sourceType, null,
    );
    return c.json(result, 201);
  } catch (err) {
    throw errors.badRequest((err as Error).message);
  }
});

// ─── PATCH /observations/:observationId — update observation ────────────────

knowledgeRoutes.patch('/observations/:observationId', async (c) => {
  const auth = getAuth(c);
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const observationId = requireParam(c.req.param('observationId'), 'observationId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, auth.user.id);

  const body = await c.req.json<UpdateObservationRequest>();
  if (body.content !== undefined && !body.content.trim()) {
    throw errors.badRequest('content cannot be empty');
  }

  const obsMaxLen = getLimit(c.env, 'KNOWLEDGE_OBSERVATION_MAX_LENGTH', KNOWLEDGE_DEFAULTS.observationMaxLength);
  const content = body.content?.trim().slice(0, obsMaxLen);
  const confidence = typeof body.confidence === 'number' ? Math.min(Math.max(0, body.confidence), 1) : null;

  if (!content && confidence === null) {
    throw errors.badRequest('At least content or confidence must be provided');
  }

  try {
    if (content) {
      const result = await projectDataService.updateKnowledgeObservation(
        c.env, projectId, observationId, content, confidence,
      );
      return c.json(result);
    } else {
      // confidence-only update — confirm pattern
      await projectDataService.confirmKnowledgeObservation(c.env, projectId, observationId);
      return c.json({ updated: true });
    }
  } catch (err) {
    throw errors.badRequest((err as Error).message);
  }
});

// ─── DELETE /observations/:observationId — remove observation ────────────────

knowledgeRoutes.delete('/observations/:observationId', async (c) => {
  const auth = getAuth(c);
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const observationId = requireParam(c.req.param('observationId'), 'observationId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, auth.user.id);

  try {
    await projectDataService.removeKnowledgeObservation(c.env, projectId, observationId);
    return c.json({ removed: true });
  } catch (err) {
    throw errors.badRequest((err as Error).message);
  }
});

export { knowledgeRoutes };
