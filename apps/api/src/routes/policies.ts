/**
 * Project Policies REST API routes.
 *
 * Mounted at /api/projects/:projectId/policies
 * Provides CRUD for dynamic project policies (Phase 4: Policy Propagation).
 */
import type { PolicyScope, UpdatePolicyRequest } from '@simple-agent-manager/shared';
import {
  isPolicyCategory,
  isPolicyScope,
  isPolicySource,
  POLICY_SCOPES,
  resolvePolicyLimits,
  validatePolicyLifecycle,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getAuth, requireApproved, requireAuth } from '../middleware/auth';
import { AppError, errors } from '../middleware/error';
import { requireProjectAccess, requireProjectCapability } from '../middleware/project-auth';
import { CreatePolicySchema, jsonValidator, UpdatePolicySchema } from '../schemas';
import * as projectDataService from '../services/project-data';
import { sanitizeUserInput } from './mcp/_helpers';

export const policyRoutes = new Hono<{ Bindings: Env }>();

/**
 * Parse the raw `scope` / `expiresAt` request fields into typed values.
 * Type-shape only — the scope/expiry *relationship* is owned by the shared
 * `validatePolicyLifecycle`, which the MCP tool handlers call too (rule 24).
 */
function parseLifecycleFields(body: { scope?: string; expiresAt?: unknown }): {
  scope?: PolicyScope;
  expiresAt?: number | null;
} {
  let scope: PolicyScope | undefined;
  if (body.scope !== undefined) {
    if (!isPolicyScope(body.scope)) {
      throw errors.badRequest(`scope must be one of: ${POLICY_SCOPES.join(', ')}`);
    }
    scope = body.scope;
  }

  let expiresAt: number | null | undefined;
  if (body.expiresAt !== undefined) {
    if (body.expiresAt === null) {
      expiresAt = null;
    } else if (typeof body.expiresAt !== 'number' || !Number.isFinite(body.expiresAt)) {
      throw errors.badRequest('expiresAt must be a number (epoch milliseconds) or null');
    } else {
      expiresAt = body.expiresAt;
    }
  }

  return { scope, expiresAt };
}

// ─── Middleware ──────────────────────────────────────────────────────────────

policyRoutes.use('/*', requireAuth(), requireApproved());

// ─── GET / — list policies ──────────────────────────────────────────────────

policyRoutes.get('/', async (c) => {
  const auth = getAuth(c);
  const projectId = c.req.param('projectId');
  if (!projectId) throw errors.badRequest('Missing projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectAccess(db, projectId, auth.user.id);

  const limits = resolvePolicyLimits(c.env);
  const category = c.req.query('category') || null;
  if (category && !isPolicyCategory(category)) {
    throw errors.badRequest('Invalid category filter');
  }
  const includeInactive = c.req.query('includeInactive') === 'true';
  const limit = Math.min(
    parseInt(c.req.query('limit') || String(limits.listPageSize), 10) || limits.listPageSize,
    limits.listMaxPageSize
  );
  const offset = parseInt(c.req.query('offset') || '0', 10) || 0;

  const result = await projectDataService.listPolicies(
    c.env,
    projectId,
    category,
    !includeInactive,
    limit,
    offset
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
  await requireProjectAccess(db, projectId, auth.user.id);

  const policy = await projectDataService.getPolicy(c.env, projectId, policyId);
  if (!policy) throw errors.notFound('Policy not found');

  return c.json(policy);
});

// ─── POST / — create policy ─────────────────────────────────────────────────

policyRoutes.post('/', jsonValidator(CreatePolicySchema), async (c) => {
  const auth = getAuth(c);
  const projectId = c.req.param('projectId');
  if (!projectId) throw errors.badRequest('Missing projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectCapability(db, projectId, auth.user.id, 'project:update');

  const body = c.req.valid('json');
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
    throw errors.badRequest(
      `content exceeds maximum length of ${limits.contentMaxLength} characters`
    );
  }
  if (body.source !== undefined && !isPolicySource(body.source)) {
    throw errors.badRequest('source must be one of: explicit, inferred');
  }
  if (
    body.confidence !== undefined &&
    (typeof body.confidence !== 'number' || body.confidence < 0 || body.confidence > 1)
  ) {
    throw errors.badRequest('confidence must be a number between 0.0 and 1.0');
  }

  const lifecycle = parseLifecycleFields(body);
  const scope: PolicyScope = lifecycle.scope ?? 'always';
  const expiresAt = lifecycle.expiresAt ?? null;
  const lifecycleError = validatePolicyLifecycle({
    scope,
    expiresAt,
    now: Date.now(),
    maxExpiryMs: limits.maxExpiryMs,
  });
  if (lifecycleError) throw errors.badRequest(lifecycleError);

  const result = await projectDataService.createPolicy(
    c.env,
    projectId,
    body.category,
    sanitizeUserInput(body.title.trim()),
    sanitizeUserInput(body.content.trim()),
    body.source || 'explicit',
    null, // sourceSessionId — REST has no task context
    body.confidence ?? limits.defaultConfidence,
    scope,
    expiresAt
  );

  return c.json(result, 201);
});

// ─── PATCH /:policyId — update policy ───────────────────────────────────────

policyRoutes.patch('/:policyId', jsonValidator(UpdatePolicySchema), async (c) => {
  const auth = getAuth(c);
  const projectId = c.req.param('projectId');
  const policyId = c.req.param('policyId');
  if (!projectId) throw errors.badRequest('Missing projectId');
  if (!policyId) throw errors.badRequest('Missing policyId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectCapability(db, projectId, auth.user.id, 'project:update');

  const body = c.req.valid('json');
  const limits = resolvePolicyLimits(c.env);

  const updates: UpdatePolicyRequest = {};

  if (body.title !== undefined) {
    if (!body.title.trim()) throw errors.badRequest('title must be non-empty');
    if (body.title.length > limits.titleMaxLength) {
      throw errors.badRequest(
        `title exceeds maximum length of ${limits.titleMaxLength} characters`
      );
    }
    updates.title = sanitizeUserInput(body.title.trim());
  }
  if (body.content !== undefined) {
    if (!body.content.trim()) throw errors.badRequest('content must be non-empty');
    if (body.content.length > limits.contentMaxLength) {
      throw errors.badRequest(
        `content exceeds maximum length of ${limits.contentMaxLength} characters`
      );
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

  const lifecycle = parseLifecycleFields(body);
  if (lifecycle.scope !== undefined) updates.scope = lifecycle.scope;
  if (lifecycle.expiresAt !== undefined) updates.expiresAt = lifecycle.expiresAt;

  if (Object.keys(updates).length === 0) {
    throw errors.badRequest('At least one update field must be provided');
  }

  // The scope/expiry invariant applies to the policy as it will be AFTER the write,
  // so validate the merge of the update against the stored row — not the patch alone.
  if (lifecycle.scope !== undefined || lifecycle.expiresAt !== undefined) {
    const existing = await projectDataService.getPolicy(c.env, projectId, policyId);
    if (!existing) throw errors.notFound('Policy not found');
    const lifecycleError = validatePolicyLifecycle({
      scope: lifecycle.scope ?? existing.scope,
      expiresAt: lifecycle.expiresAt !== undefined ? lifecycle.expiresAt : existing.expiresAt,
      now: Date.now(),
      maxExpiryMs: limits.maxExpiryMs,
    });
    if (lifecycleError) throw errors.badRequest(lifecycleError);
  }

  // The DO re-validates the scope/expiry invariant against freshly-read state at write
  // time, so a concurrent PATCH landing between the pre-check above and this write can
  // still make it throw. That error crosses the RPC boundary as a plain Error with only
  // name and message (rule 63), so map it by message — an `instanceof` check would miss
  // it and `app.onError` would return an opaque 500 for what is really a 400-class
  // conflict, and would additionally persist it to /admin/errors as an INTERNAL_ERROR.
  let updated: boolean;
  try {
    updated = await projectDataService.updatePolicy(c.env, projectId, policyId, updates);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw errors.badRequest(err instanceof Error ? err.message : String(err));
  }
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
  await requireProjectCapability(db, projectId, auth.user.id, 'project:update');

  const removed = await projectDataService.removePolicy(c.env, projectId, policyId);
  if (!removed) throw errors.notFound('Policy not found');

  return c.json({ removed: true, policyId });
});
