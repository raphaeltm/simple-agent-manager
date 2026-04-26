/**
 * Project Policies REST API routes.
 *
 * Mounted at /api/projects/:projectId/policies
 * Provides CRUD for dynamic project policies (Phase 4: Policy Propagation).
 */
import type { CreatePolicyRequest, UpdatePolicyRequest } from '@simple-agent-manager/shared';
import { isPolicyCategory, isPolicySource, resolvePolicyLimits } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getAuth, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireOwnedProject } from '../middleware/project-auth';
import * as projectDataService from '../services/project-data';
import { sanitizeUserInput } from './mcp/_helpers';

export const policyRoutes = new Hono<{ Bindings: Env }>();

// ─── Middleware ──────────────────────────────────────────────────────────────

policyRoutes.use('/*', requireAuth(), requireApproved());

// ─── GET / — list policies ──────────────────────────────────────────────────

policyRoutes.get('/', async (c) => {
  const auth = getAuth(c);
  const projectId = c.req.param('projectId');
  if (!projectId) throw errors.badRequest('Missing projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, auth.user.id);

  const limits = resolvePolicyLimits(c.env);
  const category = c.req.query('category') || null;
  if (category && !isPolicyCategory(category)) {
    throw errors.badRequest('Invalid category filter');
  }
  const includeInactive = c.req.query('includeInactive') === 'true';
  const limit = Math.min(
    parseInt(c.req.query('limit') || String(limits.listPageSize), 10) || limits.listPageSize,
    limits.listMaxPageSize,
  );
  const offset = parseInt(c.req.query('offset') || '0', 10) || 0;

  const result = await projectDataService.listPolicies(
    c.env, projectId, category, !includeInactive, limit, offset,
  );

  return c.json(result);
});

// ─── GET /:policyId — get single policy ─────────────────────────────────────

policyRoutes.get('/:policyId', async (c) => {
  const auth = getAuth(c);
  const projectId = c.req.param('projectId');
  const policyId = c.req.param('policyId');
  if (!projectId) throw errors.badRequest('Missing projectId');
  if (!policyId) throw errors.badRequest('Missing policyId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, auth.user.id);

  const policy = await projectDataService.getPolicy(c.env, projectId, policyId);
  if (!policy) throw errors.notFound('Policy not found');

  return c.json(policy);
});

// ─── POST / — create policy ─────────────────────────────────────────────────

policyRoutes.post('/', async (c) => {
  const auth = getAuth(c);
  const projectId = c.req.param('projectId');
  if (!projectId) throw errors.badRequest('Missing projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, auth.user.id);

  const body = await c.req.json<CreatePolicyRequest>();
  const limits = resolvePolicyLimits(c.env);

  if (!body.category || !isPolicyCategory(body.category)) {
    throw errors.badRequest('category must be one of: rule, constraint, delegation, preference');
  }
  if (!body.title?.trim()) throw errors.badRequest('title is required');
  if (body.title.length > limits.titleMaxLength) {
    throw errors.badRequest(`title exceeds maximum length of ${limits.titleMaxLength} characters`);
  }
  if (!body.content?.trim()) throw errors.badRequest('content is required');
  if (body.content.length > limits.contentMaxLength) {
    throw errors.badRequest(`content exceeds maximum length of ${limits.contentMaxLength} characters`);
  }
  if (body.source !== undefined && !isPolicySource(body.source)) {
    throw errors.badRequest('source must be one of: explicit, inferred');
  }
  if (body.confidence !== undefined && (typeof body.confidence !== 'number' || body.confidence < 0 || body.confidence > 1)) {
    throw errors.badRequest('confidence must be a number between 0.0 and 1.0');
  }

  const result = await projectDataService.createPolicy(
    c.env, projectId,
    body.category, sanitizeUserInput(body.title.trim()), sanitizeUserInput(body.content.trim()),
    body.source || 'explicit',
    null, // sourceSessionId — REST has no task context
    body.confidence ?? limits.defaultConfidence,
  );

  return c.json(result, 201);
});

// ─── PATCH /:policyId — update policy ───────────────────────────────────────

policyRoutes.patch('/:policyId', async (c) => {
  const auth = getAuth(c);
  const projectId = c.req.param('projectId');
  const policyId = c.req.param('policyId');
  if (!projectId) throw errors.badRequest('Missing projectId');
  if (!policyId) throw errors.badRequest('Missing policyId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, auth.user.id);

  const body = await c.req.json<UpdatePolicyRequest>();
  const limits = resolvePolicyLimits(c.env);

  const updates: UpdatePolicyRequest = {};

  if (body.title !== undefined) {
    if (!body.title.trim()) throw errors.badRequest('title must be non-empty');
    if (body.title.length > limits.titleMaxLength) {
      throw errors.badRequest(`title exceeds maximum length of ${limits.titleMaxLength} characters`);
    }
    updates.title = sanitizeUserInput(body.title.trim());
  }
  if (body.content !== undefined) {
    if (!body.content.trim()) throw errors.badRequest('content must be non-empty');
    if (body.content.length > limits.contentMaxLength) {
      throw errors.badRequest(`content exceeds maximum length of ${limits.contentMaxLength} characters`);
    }
    updates.content = sanitizeUserInput(body.content.trim());
  }
  if (body.category !== undefined) {
    if (!isPolicyCategory(body.category)) {
      throw errors.badRequest('category must be one of: rule, constraint, delegation, preference');
    }
    updates.category = body.category;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') throw errors.badRequest('active must be a boolean');
    updates.active = body.active;
  }
  if (body.confidence !== undefined) {
    if (typeof body.confidence !== 'number' || body.confidence < 0 || body.confidence > 1) {
      throw errors.badRequest('confidence must be a number between 0.0 and 1.0');
    }
    updates.confidence = body.confidence;
  }

  if (Object.keys(updates).length === 0) {
    throw errors.badRequest('At least one update field must be provided');
  }

  const updated = await projectDataService.updatePolicy(c.env, projectId, policyId, updates);
  if (!updated) throw errors.notFound('Policy not found');

  return c.json({ updated: true, policyId });
});

// ─── DELETE /:policyId — soft-delete policy ─────────────────────────────────

policyRoutes.delete('/:policyId', async (c) => {
  const auth = getAuth(c);
  const projectId = c.req.param('projectId');
  const policyId = c.req.param('policyId');
  if (!projectId) throw errors.badRequest('Missing projectId');
  if (!policyId) throw errors.badRequest('Missing policyId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, auth.user.id);

  const removed = await projectDataService.removePolicy(c.env, projectId, policyId);
  if (!removed) throw errors.notFound('Policy not found');

  return c.json({ removed: true, policyId });
});
