import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and } from 'drizzle-orm';
import type { Env } from '../index';
import { requireAuth, requireApproved, getUserId } from '../middleware/auth';
import * as schema from '../db/schema';
import { AGENT_CATALOG } from '@simple-agent-manager/shared';
import type { AgentInfo } from '@simple-agent-manager/shared';

const agentsCatalogRoutes = new Hono<{ Bindings: Env }>();

// All routes require authentication
agentsCatalogRoutes.use('*', requireAuth(), requireApproved());

/**
 * GET /api/agents - List supported agents with user's connection status
 */
agentsCatalogRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  // Fetch the user's agent API key credentials
  const agentCredentials = await db
    .select({
      agentType: schema.credentials.agentType,
    })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.credentialType, 'agent-api-key')
      )
    );

  const configuredAgents = new Set(
    agentCredentials.map((c) => c.agentType).filter(Boolean)
  );

  const agents: AgentInfo[] = AGENT_CATALOG.map((agent) => ({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    supportsAcp: agent.supportsAcp,
    configured: configuredAgents.has(agent.id),
    credentialHelpUrl: agent.credentialHelpUrl,
  }));

  return c.json({ agents });
});

export { agentsCatalogRoutes };
