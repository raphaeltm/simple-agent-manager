import type { AgentInfo, AgentProviderMode } from '@simple-agent-manager/shared';
import { AGENT_CATALOG } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';

const agentsCatalogRoutes = new Hono<{ Bindings: Env }>();
type AgentFallbackCredentialSource = 'platform-sam' | null;

// All routes require authentication
agentsCatalogRoutes.use('*', requireAuth(), requireApproved());

function resolveFallbackCredentialSource(usesSamProvider: boolean): AgentFallbackCredentialSource {
  if (usesSamProvider) return 'platform-sam';
  return null;
}

/**
 * GET /api/agents - List supported agents with user's connection status
 */
agentsCatalogRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  // Fetch user credentials and provider modes in parallel.
  const [agentCredentials, agentProviderSettings] = await Promise.all([
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
      .select({
        agentType: schema.agentSettings.agentType,
        providerMode: schema.agentSettings.providerMode,
      })
      .from(schema.agentSettings)
      .where(eq(schema.agentSettings.userId, userId)),
  ]);

  const configuredAgents = new Set(agentCredentials.map((c) => c.agentType).filter(Boolean));

  // Build a map of agentType -> providerMode for SAM provider checks.
  const providerModeMap = new Map<string, AgentProviderMode | null>(
    agentProviderSettings.map((s) => [s.agentType, s.providerMode as AgentProviderMode | null])
  );

  const aiProxyEnabled = (c.env.AI_PROXY_ENABLED ?? 'true') !== 'false';

  const agents: AgentInfo[] = AGENT_CATALOG.map((agent) => {
    const hasDedicatedKey = configuredAgents.has(agent.id);
    // Claude Code / Codex: mark as configured if providerMode='sam' and proxy is enabled.
    const usesSamProvider =
      !hasDedicatedKey &&
      aiProxyEnabled &&
      (agent.id === 'claude-code' || agent.id === 'openai-codex') &&
      providerModeMap.get(agent.id) === 'sam';
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      supportsAcp: agent.supportsAcp,
      configured: hasDedicatedKey || usesSamProvider,
      credentialHelpUrl: agent.credentialHelpUrl,
      fallbackCredentialSource: resolveFallbackCredentialSource(usesSamProvider),
    };
  });

  return c.json({ agents });
});

export { agentsCatalogRoutes };
