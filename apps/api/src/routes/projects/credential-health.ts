import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { getUserId } from '../../middleware/auth';
import { requireProjectCapability } from '../../middleware/project-auth';
import { getProjectCredentialAttributionHealth } from '../../services/credential-attribution-health';
import { getProjectMultiplayerState } from '../../services/project-multiplayer';

const credentialHealthRoutes = new Hono<{ Bindings: Env }>();

credentialHealthRoutes.get('/:id/credential-attribution-health', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });
  const project = await requireProjectCapability(db, projectId, userId, 'project:read');
  const multiplayerState = await getProjectMultiplayerState(db, projectId);

  const summary = await getProjectCredentialAttributionHealth({
    db,
    project,
    defaultAgentType: c.env.DEFAULT_TASK_AGENT_TYPE || 'opencode',
    multiplayerActive: multiplayerState.multiplayerActive,
  });

  return c.json(summary);
});

export { credentialHealthRoutes };
