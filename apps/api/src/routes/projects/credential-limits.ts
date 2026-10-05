import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireProjectCapability } from '../../middleware/project-auth';
import {
  listProjectCredentialLimits,
  resolveAgentSessionCredentialReference,
} from '../../services/credential-limit-events/read';

const AGENT_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;

/**
 * GET /api/projects/:id/credential-limits[?agentSessionId=…]
 *
 * Browser-session route (inside `projectsRoutes`). Returns the latest provider
 * usage windows for credentials visible to the member in this project. With
 * `agentSessionId`, narrows to the credential that session is attributed to,
 * resolved server-side from `agent_sessions` (canonical identity, never a
 * client-supplied credential reference).
 *
 * I/O budget: project membership check (2 parallel D1 reads) + optional session
 * lookup (1) + windows (1) = 4-5 round trips (rule 60 GET budget: 8).
 */
const credentialLimitRoutes = new Hono<{ Bindings: Env }>();

credentialLimitRoutes.get('/:id/credential-limits', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectCapability(db, projectId, userId, 'project:read');

  const rawAgentSessionId = c.req.query('agentSessionId')?.trim();
  let credentialReference: string | null | undefined;
  if (rawAgentSessionId) {
    if (!AGENT_SESSION_ID_PATTERN.test(rawAgentSessionId)) {
      throw errors.badRequest('Invalid agentSessionId');
    }
    credentialReference = await resolveAgentSessionCredentialReference(c.env, {
      projectId,
      agentSessionId: rawAgentSessionId,
    });
    if (!credentialReference) {
      return c.json({ credentials: [], generatedAt: Date.now() });
    }
  }

  return c.json(
    await listProjectCredentialLimits(c.env, { projectId, userId, credentialReference })
  );
});

export { credentialLimitRoutes };
