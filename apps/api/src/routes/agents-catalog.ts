import type { AgentInfo } from '@simple-agent-manager/shared';
import { AGENT_CATALOG } from '@simple-agent-manager/shared';
import { and,eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../index';
import { getUserId,requireApproved, requireAuth } from '../middleware/auth';

const agentsCatalogRoutes = new Hono<{ Bindings: Env }>();

// All routes require authentication
agentsCatalogRoutes.use('*', requireAuth(), requireApproved());

/**
 * GET /api/agents - List supported agents with user's connection status
 */
agentsCatalogRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  // Fetch agent credentials and Scaleway cloud credential in parallel
  const [agentCredentials, scalewayCloudCreds] = await Promise.all([
    db
      .select({ agentType: schema.credentials.agentType })
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.userId, userId),
          eq(schema.credentials.credentialType, 'agent-api-key')
        )
      ),
    db
      .select({ id: schema.credentials.id })
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.userId, userId),
          eq(schema.credentials.credentialType, 'cloud-provider'),
          eq(schema.credentials.provider, 'scaleway')
        )
      )
      .limit(1),
  ]);

  const configuredAgents = new Set(
    agentCredentials.map((c) => c.agentType).filter(Boolean)
  );
  const hasScalewayCloud = scalewayCloudCreds.length > 0;

  const agents: AgentInfo[] = AGENT_CATALOG.map((agent) => {
    const hasDedicatedKey = configuredAgents.has(agent.id);
    // Agents with a fallbackCloudProvider can use the cloud credential when no dedicated key exists
    const usesScalewayFallback = !!agent.fallbackCloudProvider && !hasDedicatedKey && hasScalewayCloud;
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      supportsAcp: agent.supportsAcp,
      configured: hasDedicatedKey || usesScalewayFallback,
      credentialHelpUrl: agent.credentialHelpUrl,
      fallbackCredentialSource: usesScalewayFallback ? 'scaleway-cloud' as const : null,
    };
  });

  return c.json({ agents });
});

export { agentsCatalogRoutes };
