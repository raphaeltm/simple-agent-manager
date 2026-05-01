/**
 * Admin AI Proxy configuration routes.
 *
 * GET  /api/admin/ai-proxy/config — read current config (default model, available models)
 * PUT  /api/admin/ai-proxy/config — update default model selection
 *
 * Config is stored in KV so admins can change the default model without redeploying.
 */
import {
  AI_PROXY_DEFAULT_MODEL_KV_KEY,
  type AIProxyConfig,
  DEFAULT_AI_PROXY_MODEL,
  PLATFORM_AI_MODELS,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import { getPlatformAgentCredential } from '../services/platform-credentials';

const adminAIProxyRoutes = new Hono<{ Bindings: Env }>();

adminAIProxyRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

/**
 * Check whether a platform credential exists for a given agent type.
 */
async function hasPlatformCredential(env: Env, agentType: string): Promise<boolean> {
  try {
    const db = drizzle(env.DATABASE, { schema });
    const encryptionKey = getCredentialEncryptionKey(env);
    const cred = await getPlatformAgentCredential(db, agentType, encryptionKey);
    return !!cred?.credential;
  } catch {
    return false;
  }
}

/**
 * Determine availability for a model based on its provider and configured credentials.
 * Models are available if:
 * - Workers AI: always available (free, no key needed)
 * - Anthropic: requires Claude Code platform credential OR Unified Billing token
 * - OpenAI: requires Codex platform credential OR Unified Billing token
 */
function isModelAvailable(
  provider: string,
  hasAnthropic: boolean,
  hasOpenAI: boolean,
  hasUnifiedBilling: boolean,
): boolean {
  if (provider === 'workers-ai') return true;
  if (provider === 'anthropic') return hasAnthropic || hasUnifiedBilling;
  if (provider === 'openai') return hasOpenAI || hasUnifiedBilling;
  return false;
}

/**
 * GET /api/admin/ai-proxy/config
 *
 * Returns the current AI proxy configuration including:
 * - The active default model (KV override > env var > shared constant)
 * - Available models with provider info, tier, cost, and availability status
 * - Credential status for each provider
 */
adminAIProxyRoutes.get('/config', async (c) => {
  const kvConfig = await c.env.KV.get(AI_PROXY_DEFAULT_MODEL_KV_KEY);
  const parsed: AIProxyConfig | null = kvConfig ? JSON.parse(kvConfig) : null;

  const [hasAnthropic, hasOpenAI] = await Promise.all([
    hasPlatformCredential(c.env, 'claude-code'),
    hasPlatformCredential(c.env, 'codex'),
  ]);
  const hasUnifiedBilling = !!c.env.CF_AIG_TOKEN;

  // Effective default: KV override > env var > shared constant
  const effectiveDefault = parsed?.defaultModel
    ?? c.env.AI_PROXY_DEFAULT_MODEL
    ?? DEFAULT_AI_PROXY_MODEL;

  const models = PLATFORM_AI_MODELS.map((m) => ({
    ...m,
    available: isModelAvailable(m.provider, hasAnthropic, hasOpenAI, hasUnifiedBilling),
  }));

  return c.json({
    defaultModel: effectiveDefault,
    source: parsed ? 'admin' as const : (c.env.AI_PROXY_DEFAULT_MODEL ? 'env' as const : 'default' as const),
    updatedAt: parsed?.updatedAt ?? null,
    hasAnthropicCredential: hasAnthropic,
    hasOpenAICredential: hasOpenAI,
    hasUnifiedBilling,
    models,
  });
});

/**
 * PUT /api/admin/ai-proxy/config
 *
 * Update the default model. Validates that:
 * - The model ID is in the PLATFORM_AI_MODELS list
 * - If a paid provider model is selected, a credential or Unified Billing is configured
 */
adminAIProxyRoutes.put('/config', async (c) => {
  const body = await c.req.json<{ defaultModel: string }>();

  if (!body.defaultModel || typeof body.defaultModel !== 'string') {
    throw errors.badRequest('defaultModel is required');
  }

  const model = PLATFORM_AI_MODELS.find((m) => m.id === body.defaultModel);
  if (!model) {
    throw errors.badRequest(`Unknown model: ${body.defaultModel}. Available: ${PLATFORM_AI_MODELS.map((m) => m.id).join(', ')}`);
  }

  const hasUnifiedBilling = !!c.env.CF_AIG_TOKEN;

  // Anthropic models require a platform credential or Unified Billing
  if (model.provider === 'anthropic' && !hasUnifiedBilling) {
    const hasAnthropic = await hasPlatformCredential(c.env, 'claude-code');
    if (!hasAnthropic) {
      throw errors.badRequest(
        'Cannot select an Anthropic model without a Claude Code platform credential or Unified Billing. '
        + 'Add a credential on the Credentials tab first.',
      );
    }
  }

  // OpenAI models require a platform credential or Unified Billing
  if (model.provider === 'openai' && !hasUnifiedBilling) {
    const hasOpenAI = await hasPlatformCredential(c.env, 'codex');
    if (!hasOpenAI) {
      throw errors.badRequest(
        'Cannot select an OpenAI model without a Codex platform credential or Unified Billing. '
        + 'Add a credential on the Credentials tab first.',
      );
    }
  }

  const config: AIProxyConfig = {
    defaultModel: body.defaultModel,
    updatedAt: new Date().toISOString(),
  };

  await c.env.KV.put(AI_PROXY_DEFAULT_MODEL_KV_KEY, JSON.stringify(config));

  log.info('admin.ai_proxy.config_updated', {
    defaultModel: body.defaultModel,
    provider: model.provider,
    tier: model.tier,
  });

  return c.json({
    defaultModel: config.defaultModel,
    source: 'admin' as const,
    updatedAt: config.updatedAt,
  });
});

/**
 * DELETE /api/admin/ai-proxy/config
 *
 * Reset to platform default (removes KV override).
 */
adminAIProxyRoutes.delete('/config', async (c) => {
  await c.env.KV.delete(AI_PROXY_DEFAULT_MODEL_KV_KEY);

  log.info('admin.ai_proxy.config_reset', {});

  const effectiveDefault = c.env.AI_PROXY_DEFAULT_MODEL ?? DEFAULT_AI_PROXY_MODEL;
  return c.json({
    defaultModel: effectiveDefault,
    source: c.env.AI_PROXY_DEFAULT_MODEL ? 'env' as const : 'default' as const,
    updatedAt: null,
  });
});

export { adminAIProxyRoutes };
