/**
 * Agent model calls — the settings surface. Agents call models through the `list_ai_models` /
 * `run_ai_model` MCP tools; people choose the models and the monthly budget here.
 *
 *   GET /api/agent-models/catalog                — Cloudflare-hosted models (any signed-in user)
 *   GET /api/projects/:projectId/agent-models    — project selection, budget, usage (members)
 *   PUT /api/projects/:projectId/agent-models    — change selection or budget (owners, admins)
 */
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { applyCacheHeaders } from '../lib/cache-headers';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import {
  requireActiveProjectMembership,
  requireProjectCapability,
} from '../middleware/project-auth';
import { jsonValidator, UpdateProjectAgentModelsSchema } from '../schemas';
import { buildCatalogResponse, getAgentModelCatalog } from '../services/agent-models/catalog';
import {
  buildProjectAgentModelSettings,
  updateProjectAgentModelSettings,
} from '../services/agent-models/project-settings';
import { getAgentModelSettings } from '../services/agent-models/settings';

export const agentModelCatalogRoutes = new Hono<{ Bindings: Env }>();
agentModelCatalogRoutes.use('/*', requireAuth(), requireApproved());

agentModelCatalogRoutes.get('/catalog', async (c) => {
  const settings = await getAgentModelSettings(c.env);
  let catalog;
  try {
    catalog = await getAgentModelCatalog(c.env, settings.catalogCacheSeconds);
  } catch {
    throw errors.serviceUnavailable(
      'The Cloudflare model catalog is unavailable right now. Try again shortly.'
    );
  }
  applyCacheHeaders(c, 'model-catalog');
  return c.json(buildCatalogResponse(catalog, settings.defaultCategories));
});

export const projectAgentModelRoutes = new Hono<{ Bindings: Env }>();
projectAgentModelRoutes.use('/*', requireAuth(), requireApproved());

projectAgentModelRoutes.get('/', async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  const { project, membership } = await requireActiveProjectMembership(db, projectId, getUserId(c));
  return c.json(await buildProjectAgentModelSettings(c.env, project, membership.role));
});

projectAgentModelRoutes.put('/', jsonValidator(UpdateProjectAgentModelsSchema), async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectCapability(db, projectId, userId, 'project:update');
  await updateProjectAgentModelSettings(c.env, db, projectId, c.req.valid('json'));
  const { project, membership } = await requireActiveProjectMembership(db, projectId, userId);
  return c.json(await buildProjectAgentModelSettings(c.env, project, membership.role));
});
