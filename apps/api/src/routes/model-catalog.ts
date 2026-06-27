import { Hono } from 'hono';

import type { Env } from '../env';
import { requireApproved, requireAuth } from '../middleware/auth';
import { getModelCatalogForAgent } from '../services/model-catalog';

const modelCatalogRoutes = new Hono<{ Bindings: Env }>();

modelCatalogRoutes.use('*', requireAuth(), requireApproved());

modelCatalogRoutes.get('/:agentType', async (c) => {
  const agentType = c.req.param('agentType');
  const catalog = await getModelCatalogForAgent(c.env, agentType);
  return c.json(catalog);
});

export { modelCatalogRoutes };
