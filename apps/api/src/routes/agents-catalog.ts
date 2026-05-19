import type { AgentInfo } from '@simple-agent-manager/shared';
import { AGENT_CATALOG } from '@simple-agent-manager/shared';
import { and,eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getUserId,requireApproved, requireAuth } from '../middleware/auth';
import { getPlatformOpencodeAvailability, type PlatformOpencodeAvailability } from '../services/platform-trial';

const agentsCatalogRoutes = new Hono<{ Bindings: Env }>();

const SAM_PROVIDER_AGENT_TYPES = new Set(['claude-code', 'openai-codex']);

// All routes require authentication
agentsCatalogRoutes.use('*', requireAuth(), requireApproved());

function unavailablePlatformOpencode(): PlatformOpencodeAvailability {
  return {
    available: false,
    hasInfraCredential: false,
    hasAgentCredential: false,
  };
}

async function getCatalogPlatformOpencodeAvailability(
  db: ReturnType<typeof drizzle>,
  env: Env,
): Promise<PlatformOpencodeAvailability> {
  try {
    return await getPlatformOpencodeAvailability(db, env);
  } catch (err) {
    const error = err instanceof Error ? err.message : 'unknown';
    log.warn('agents_catalog.platform_opencode_availability_failed', { error });
    return unavailablePlatformOpencode();
  }
}

/**
 * GET /api/agents - List supported agents with user's connection status
 */
agentsCatalogRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  // Fetch user credentials and platform availability in parallel.
  const [agentCredentials, scalewayCloudCreds, agentSettings, platformOpencode] = await Promise.all([
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
    db
      .select({
        agentType: schema.agentSettings.agentType,
        inferenceProvider: schema.agentSettings.inferenceProvider,
        opencodeProvider: schema.agentSettings.opencodeProvider,
      })
      .from(schema.agentSettings)
      .where(eq(schema.agentSettings.userId, userId)),
    getCatalogPlatformOpencodeAvailability(db, c.env),
  ]);

  const configuredAgents = new Set(
    agentCredentials.map((c) => c.agentType).filter(Boolean)
  );
  const settingsByAgent = new Map(agentSettings.map((settings) => [settings.agentType, settings]));
  const hasScalewayCloud = scalewayCloudCreds.length > 0;

  const agents: AgentInfo[] = AGENT_CATALOG.map((agent) => {
    const hasDedicatedKey = configuredAgents.has(agent.id);
    const settings = settingsByAgent.get(agent.id);
    // Agents with a fallbackCloudProvider can use the cloud credential when no dedicated key exists
    const usesScalewayFallback = !!agent.fallbackCloudProvider && !hasDedicatedKey && hasScalewayCloud;
    const usesSamProvider =
      !hasDedicatedKey &&
      !usesScalewayFallback &&
      (
        (SAM_PROVIDER_AGENT_TYPES.has(agent.id) && settings?.inferenceProvider === 'sam') ||
        (agent.id === 'opencode' && settings?.opencodeProvider === 'platform')
      );
    const usesPlatformFallback =
      agent.id === 'opencode' &&
      !hasDedicatedKey &&
      !usesScalewayFallback &&
      !usesSamProvider &&
      platformOpencode.available;
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      supportsAcp: agent.supportsAcp,
      configured: hasDedicatedKey || usesScalewayFallback || usesSamProvider || usesPlatformFallback,
      credentialHelpUrl: agent.credentialHelpUrl,
      fallbackCredentialSource: usesScalewayFallback
        ? 'scaleway-cloud' as const
        : usesSamProvider
          ? (agent.id === 'opencode' ? 'platform-opencode' as const : 'platform-ai' as const)
          : usesPlatformFallback ? 'platform-opencode' as const : null,
    };
  });

  return c.json({ agents });
});

export { agentsCatalogRoutes };
