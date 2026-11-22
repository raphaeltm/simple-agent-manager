import {
  DEFAULT_AI_PROXY_ANTHROPIC_MODEL,
  DEFAULT_AI_PROXY_OPENAI_MODEL,
  getAgentDefinition,
  HARNESS_CAPABILITIES,
  isValidAgentType,
  resolveHarnessDialect,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { getCredentialEncryptionKey } from '../../lib/secrets';
import { errors } from '../../middleware/error';
import { AgentTypeBodySchema, jsonValidator } from '../../schemas';
import { resolveSessionProfileCredentialContext } from '../../services/composable-credentials/profile-context';
import { extractScalewaySecretKey } from '../../services/provider-credentials';
import { refuseHaltedRunAccount } from '../../services/run-agent-configuration';
import {
  isAiProxyEnabled,
  PROXY_ELIGIBLE_AGENTS,
  requiresExplicitSamProvider,
} from '../../services/sam-ai-proxy-fallback';
import {
  readAdminDefaultAIProxyModel,
  resolveEnvDefaultAIProxyModel,
} from '../ai-proxy-model-resolution';
import { getDecryptedAgentKey, getDecryptedCredentialRecord } from '../credentials';
import {
  assertWorkspaceCallbackIdentityCurrent,
  assertWorkspaceCallbackResourceById,
  verifyWorkspaceCallbackAuth,
} from './_helpers';
import {
  agentCredentialProviderFallback,
  credentialAttributionFromData,
  persistAgentCredentialAttribution,
  platformProxyAttribution,
} from './agent-credential-attribution';
import { callbackJsonWithJit } from './runtime-callback-response';
function getProxyCapability(agentType: string) {
  const capability = HARNESS_CAPABILITIES.find((entry) => entry.agentType === agentType);
  if (!capability?.proxyRouteSegment || !capability.proxyProviderTag) return null;
  return capability;
}

function buildPassthroughInferenceConfig(input: {
  agentType: string;
  baseDomain: string;
  defaultModel: string;
}) {
  const capability = getProxyCapability(input.agentType);
  if (!capability) return null;
  return {
    provider: capability.proxyProviderTag,
    baseURL: `https://api.${input.baseDomain}/ai/proxy/{wstoken}/${capability.proxyRouteSegment}`,
    model: input.defaultModel,
    apiKeySource: 'callback-token' as const,
  };
}

function buildPlatformInferenceConfig(input: {
  agentType: string;
  baseDomain: string;
  defaultModel: string;
}) {
  const capability = getProxyCapability(input.agentType);
  if (!capability) return null;
  let provider = 'openai-proxy';
  if (capability.proxyProviderTag === 'anthropic-passthrough') provider = 'anthropic-proxy';
  else if (capability.usesOpencodeConfig) provider = 'openai-compatible';
  const routeSegment = capability.proxyRouteSegment === 'anthropic' ? 'anthropic' : 'v1';
  return {
    provider,
    baseURL: `https://api.${input.baseDomain}/ai/${routeSegment}`,
    model: input.defaultModel,
    apiKeySource: 'callback-token' as const,
  };
}

const runtimeRoutes = new Hono<{ Bindings: Env }>();
runtimeRoutes.post('/:id/agent-key', jsonValidator(AgentTypeBodySchema), async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);
  const body = c.req.valid('json');

  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await assertWorkspaceCallbackResourceById(c.env, workspaceId, 'agent_key');

  // OpenCode always uses a user-supplied credential (zen/go/custom). It never
  // routes through the SAM platform proxy, so it always requires a dedicated key.
  const opencodeRequiresDedicatedCredential = body.agentType === 'opencode';

  const encryptionKey = getCredentialEncryptionKey(c.env);
  // The session's profile decides whether a personal profile pin applies; the AI
  // proxy and provider-limit admission resolve the same context.
  const profile = await resolveSessionProfileCredentialContext(db, {
    workspaceId,
    agentSessionId: body.agentSessionId,
  });
  let credentialData = await getDecryptedAgentKey(
    db,
    workspace.userId,
    body.agentType,
    encryptionKey,
    workspace.projectId,
    profile
  );
  let credentialProviderMode = 'direct';

  const persistAttribution = (
    attribution: Parameters<typeof persistAgentCredentialAttribution>[2]['attribution']
  ) =>
    persistAgentCredentialAttribution(c.env, workspace, {
      workspaceId,
      agentSessionId: body.agentSessionId,
      agentType: body.agentType,
      attribution,
    });
  const returnCredential = async (
    data: NonNullable<typeof credentialData>,
    providerMode: string,
    inferenceConfig?: NonNullable<ReturnType<typeof buildPassthroughInferenceConfig>>
  ) => {
    const persistedAttribution = await persistAttribution(
      credentialAttributionFromData(data, body.agentType, providerMode)
    );
    return callbackJsonWithJit(
      c,
      workspace,
      'agent_key',
      {
        apiKey: inferenceConfig ? '__sam_proxy__' : data.credential,
        credentialKind: data.credentialKind,
        credentialSource: data.credentialSource,
        credentialReference: data.credentialReference,
        credentialProvider:
          data.credentialProvider ??
          (inferenceConfig ? data.providerDialect : undefined) ??
          agentCredentialProviderFallback(body.agentType),
        providerMode,
        credentialGeneration: persistedAttribution?.credentialGeneration,
        ...(inferenceConfig ? { inferenceConfig } : {}),
      },
      persistedAttribution?.agentSessionId
    );
  };
  const trackTaskCredentialSource = async (
    source: NonNullable<typeof credentialData>['credentialSource']
  ) => {
    const [task] = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.workspaceId, workspaceId))
      .limit(1);
    if (task) {
      await assertWorkspaceCallbackIdentityCurrent(c.env, workspace, 'agent_key');
      await db
        .update(schema.tasks)
        .set({ agentCredentialSource: source })
        .where(eq(schema.tasks.id, task.id));
    }
  };

  // An account chosen for this run that can no longer be used (paused, removed) must stop
  // the run here. Without this, "no credential" would continue to the platform proxy or a
  // fallback below and run the chat on an account nobody chose for it.
  if (!credentialData && profile?.runConfigurationId) {
    await refuseHaltedRunAccount(db, {
      workspaceId,
      userId: workspace.userId,
      projectId: workspace.projectId,
      agentType: body.agentType,
      encryptionKey,
      profile,
    });
  }

  // SECURITY: Never return raw platform-managed credentials to tenant workspaces.
  // Platform credentials are control-plane secrets and must only be used via
  // SAM-mediated proxy flows (callback-token auth), not injected into tenant
  // containers as env vars or auth files.
  if (credentialData?.credentialSource === 'platform') {
    credentialData = null;
  }

  // Cloud provider credential fallback: if no dedicated agent key, check if the agent
  // definition specifies a cloud provider whose credential can be used instead.
  const agentDef = isValidAgentType(body.agentType)
    ? getAgentDefinition(body.agentType)
    : undefined;
  const fallbackCloudProvider = agentDef?.fallbackCloudProvider;
  if (!credentialData && fallbackCloudProvider) {
    const fallbackCredential = await getDecryptedCredentialRecord(
      db,
      workspace.userId,
      fallbackCloudProvider,
      encryptionKey
    );
    if (fallbackCredential) {
      const secretKey = extractScalewaySecretKey(fallbackCredential.credential);
      if (secretKey) {
        credentialData = {
          credential: secretKey,
          credentialKind: 'api-key',
          credentialSource: 'user',
          credentialScope: 'user',
          credentialReference: fallbackCredential.credentialReference,
          credentialProvider: fallbackCredential.credentialProvider,
        };
        credentialProviderMode = 'fallback-cloud-provider';
      } else {
        log.warn('agent_key.scaleway_credential_missing_secret_key', {
          workspaceId,
          userId: workspace.userId,
          agentType: body.agentType,
        });
      }
    }
  }

  if (credentialData && !credentialData.baseUrl && opencodeRequiresDedicatedCredential) {
    return returnCredential(credentialData, credentialProviderMode);
  }

  if (!credentialData && opencodeRequiresDedicatedCredential) {
    log.info('agent_key.opencode_byo_provider_missing_credential', {
      workspaceId,
      userId: workspace.userId,
      agentType: body.agentType,
    });
    throw errors.notFound('Agent credential');
  }

  // AI proxy: when enabled and agent is eligible, return proxy config when the
  // credential can be forwarded to the upstream provider.
  // Two modes:
  // - Claude/Codex with no user credential + providerMode='sam' → platform proxy (callback-token auth)
  // - User has upstream-compatible credential → passthrough proxy (user credential
  //   forwarded via auth headers, wstoken in URL path for analytics/rate-limiting)
  // Note: platform proxy fallback requires explicit provider selection.
  // Without it, users with no credential get a 404 (agent not configured).
  if (PROXY_ELIGIBLE_AGENTS.has(body.agentType) && (await isAiProxyEnabled(c.env))) {
    const baseDomain = c.env.BASE_DOMAIN;
    const isClaudeCode = body.agentType === 'claude-code';
    const isCodex = body.agentType === 'openai-codex';
    let explicitProviderMode: string | null | undefined;
    const getExplicitProviderMode = async (): Promise<string | null> => {
      if (explicitProviderMode !== undefined) return explicitProviderMode;
      const settingsRows = await db
        .select({ providerMode: schema.agentSettings.providerMode })
        .from(schema.agentSettings)
        .where(
          and(
            eq(schema.agentSettings.userId, workspace.userId),
            eq(schema.agentSettings.agentType, body.agentType)
          )
        )
        .limit(1);
      explicitProviderMode = settingsRows[0]?.providerMode ?? null;
      return explicitProviderMode;
    };

    // Resolve default model: KV (admin-set) > env var > shared constant
    let defaultModel: string;
    if (isClaudeCode) {
      defaultModel = c.env.AI_PROXY_DEFAULT_ANTHROPIC_MODEL ?? DEFAULT_AI_PROXY_ANTHROPIC_MODEL;
    } else if (isCodex) {
      defaultModel = c.env.AI_PROXY_DEFAULT_OPENAI_MODEL ?? DEFAULT_AI_PROXY_OPENAI_MODEL;
    } else {
      defaultModel = resolveEnvDefaultAIProxyModel(c.env).model;
      try {
        const adminDefault = await readAdminDefaultAIProxyModel(c.env);
        if (adminDefault) defaultModel = adminDefault.model;
      } catch {
        /* KV unavailable — use env/default */
      }
    }

    // Claude Code/Codex explicit SAM mode must route through the SAM proxy,
    // not through legacy platform agent credentials as user-style passthrough.
    if ((isClaudeCode || isCodex) && credentialData?.credentialSource === 'platform') {
      credentialData = null;
    }

    if (
      credentialData &&
      credentialData.baseUrl &&
      credentialData.providerDialect &&
      resolveHarnessDialect(body.agentType, credentialData.providerDialect) &&
      !((isClaudeCode || isCodex) && credentialData.credentialKind === 'oauth-token')
    ) {
      // User has their own credential — use passthrough proxy routes.
      // URL-path auth: wstoken embedded in URL, user credential in auth headers.
      const inferenceConfig = buildPassthroughInferenceConfig({
        agentType: body.agentType,
        baseDomain,
        defaultModel,
      });
      if (!inferenceConfig) {
        throw errors.notFound('Agent credential');
      }

      log.info('agent_key.ai_proxy_passthrough', {
        workspaceId,
        userId: workspace.userId,
        proxyBaseUrl: inferenceConfig.baseURL,
        agentType: body.agentType,
      });

      await trackTaskCredentialSource(credentialData.credentialSource);

      return returnCredential(credentialData, 'proxy-passthrough', inferenceConfig);
    }

    if (credentialData?.baseUrl) {
      log.warn('agent_key.ai_proxy_incompatible_passthrough_credential', {
        workspaceId,
        userId: workspace.userId,
        agentType: body.agentType,
        providerDialect: credentialData.providerDialect ?? null,
      });
      throw errors.notFound('Agent credential');
    }

    if (credentialData) {
      return returnCredential(credentialData, credentialProviderMode);
    }

    // Claude Code and Codex require an explicit SAM provider selection before
    // using platform proxy. OpenCode never reaches this block — it always
    // requires a dedicated user credential and returns/throws above.
    if (requiresExplicitSamProvider(body.agentType)) {
      const providerMode = await getExplicitProviderMode();

      if (providerMode !== 'sam') {
        log.info('agent_key.no_credential_no_sam_provider', {
          workspaceId,
          userId: workspace.userId,
          agentType: body.agentType,
          providerMode,
        });
        throw errors.notFound('Agent credential');
      }
    }

    // Activate platform proxy.
    // Auth via callback token in headers.
    const inferenceConfig = buildPlatformInferenceConfig({
      agentType: body.agentType,
      baseDomain,
      defaultModel,
    });
    if (!inferenceConfig) {
      throw errors.notFound('Agent credential');
    }

    log.info('agent_key.ai_proxy_sam_provider', {
      workspaceId,
      userId: workspace.userId,
      proxyBaseUrl: inferenceConfig.baseURL,
      agentType: body.agentType,
    });

    await trackTaskCredentialSource('platform');

    const platformAttribution = platformProxyAttribution(body.agentType);
    const persistedAttribution = await persistAttribution(platformAttribution);

    return callbackJsonWithJit(
      c,
      workspace,
      'agent_key',
      {
        apiKey: '__platform_proxy__',
        credentialKind: 'api-key' as const,
        credentialSource: 'platform' as const,
        credentialReference: platformAttribution.credentialReference,
        credentialProvider: platformAttribution.credentialProvider,
        providerMode: platformAttribution.providerMode,
        credentialGeneration: persistedAttribution?.credentialGeneration,
        inferenceConfig,
      },
      persistedAttribution?.agentSessionId
    );
  }

  if (!credentialData || credentialData.baseUrl) {
    throw errors.notFound('Agent credential');
  }

  // Track credential source on associated task if applicable
  if (credentialData.credentialSource === 'platform') {
    await trackTaskCredentialSource('platform');
  }

  return returnCredential(credentialData, credentialProviderMode);
});

/**
 * POST /:id/agent-settings — VM agent callback to fetch user's agent settings.
 * Uses workspace callback auth (same as agent-key).
 */

export { runtimeRoutes as agentKeyRoutes };
