import type { AgentInfo, AgentProviderMode } from '@simple-agent-manager/shared';
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
type AgentFallbackCredentialSource = 'scaleway-cloud' | 'platform-opencode' | 'platform-sam' | null;

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

function resolveFallbackCredentialSource(
  usesScalewayFallback: boolean,
  usesPlatformFallback: boolean,
  usesSamProvider: boolean,
): AgentFallbackCredentialSource {
  if (usesScalewayFallback) return 'scaleway-cloud';
  if (usesPlatformFallback) return 'platform-opencode';
  if (usesSamProvider) return 'platform-sam';
  return null;
}

/**
 * GET /api/agents - List supported agents with user's connection status
 */
agentsCatalogRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  // Fetch user credentials, provider modes, and platform availability in parallel.
  const [agentCredentials, scalewayCloudCreds, platformOpencode, agentProviderModes] = await Promise.all([
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
    getCatalogPlatformOpencodeAvailability(db, c.env),
    db
      .select({ agentType: schema.agentSettings.agentType, providerMode: schema.agentSettings.providerMode })
      .from(schema.agentSettings)
      .where(eq(schema.agentSettings.userId, userId)),
  ]);

  const configuredAgents = new Set(
    agentCredentials.map((c) => c.agentType).filter(Boolean)
  );
  const hasScalewayCloud = scalewayCloudCreds.length > 0;

  // Build a map of agentType -> providerMode for SAM provider checks.
  const providerModeMap = new Map<string, AgentProviderMode | null>(
    agentProviderModes.map((s) => [s.agentType, s.providerMode as AgentProviderMode | null])
  );

  const aiProxyEnabled = (c.env.AI_PROXY_ENABLED ?? 'true') !== 'false';

  const agents: AgentInfo[] = AGENT_CATALOG.map((agent) => {
    const hasDedicatedKey = configuredAgents.has(agent.id);
    // Agents with a fallbackCloudProvider can use the cloud credential when no dedicated key exists
    const usesScalewayFallback = !!agent.fallbackCloudProvider && !hasDedicatedKey && hasScalewayCloud;
    const usesPlatformFallback =
      agent.id === 'opencode' &&
      !hasDedicatedKey &&
      !usesScalewayFallback &&
      platformOpencode.available;
    // Claude Code / Codex: mark as configured if providerMode='sam' and proxy is enabled.
    const usesSamProvider =
      !hasDedicatedKey &&
      !usesScalewayFallback &&
      !usesPlatformFallback &&
      aiProxyEnabled &&
      (agent.id === 'claude-code' || agent.id === 'openai-codex') &&
      providerModeMap.get(agent.id) === 'sam';
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      supportsAcp: agent.supportsAcp,
      configured: hasDedicatedKey || usesScalewayFallback || usesPlatformFallback || usesSamProvider,
      credentialHelpUrl: agent.credentialHelpUrl,
      fallbackCredentialSource: resolveFallbackCredentialSource(
        usesScalewayFallback,
        usesPlatformFallback,
        usesSamProvider,
      ),
    };
  });

  return c.json({ agents });
});

export { agentsCatalogRoutes };
