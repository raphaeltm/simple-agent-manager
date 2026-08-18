import { Hono } from 'hono';

import type { Env } from '../env';
import { applyCacheHeaders } from '../lib/cache-headers';
import { requireApproved, requireAuth } from '../middleware/auth';
import { getModelCatalogForAgent } from '../services/model-catalog';

const modelCatalogRoutes = new Hono<{ Bindings: Env }>();

modelCatalogRoutes.use('*', requireAuth(), requireApproved());

modelCatalogRoutes.get('/:agentType', async (c) => {
  const agentType = c.req.param('agentType');
  const catalog = await getModelCatalogForAgent(c.env, agentType);
  // Authenticated, but the body depends only on `agentType` — identical for every
  // caller. Still `private` + `Vary: Cookie` (see lib/cache-headers.ts): the
  // request is credentialed, so a shared cache must never hold it.
  applyCacheHeaders(c, 'model-catalog');
  return c.json(catalog);
});

export { modelCatalogRoutes };
