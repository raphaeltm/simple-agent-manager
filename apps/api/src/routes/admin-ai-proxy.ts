/**
 * Admin AI Proxy configuration routes.
 *
 * GET    /api/admin/ai-proxy/config — read current config (default model, billing mode, available models)
 * PUT    /api/admin/ai-proxy/config — update default model selection
 * PATCH  /api/admin/ai-proxy/config — update billing mode
 * DELETE /api/admin/ai-proxy/config — reset to platform default
 *
 * Config is stored in KV so admins can change settings without redeploying.
 */
import {
  AI_PROXY_BILLING_MODE_KV_KEY,
  AI_PROXY_DEFAULT_MODEL_KV_KEY,
  type AIProxyConfig,
  type BillingMode,
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
import { resolveBillingMode } from '../services/ai-billing';
import { getPlatformAgentCredential } from '../services/platform-credentials';

const adminAIProxyRoutes = new Hono<{ Bindings: Env }>();

adminAIProxyRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

/**
 * Check whether an Anthropic platform credential exists and is enabled.
 * Anthropic models require this to be present before they can be selected.
 */
async function hasAnthropicCredential(env: Env): Promise<boolean> {
  try {
    const db = drizzle(env.DATABASE, { schema });
    const encryptionKey = getCredentialEncryptionKey(env);
    const cred = await getPlatformAgentCredential(db, 'claude-code', encryptionKey);
    return !!cred?.credential;
  } catch {
    return false;
  }
}

const VALID_BILLING_MODES: BillingMode[] = ['unified', 'platform-key', 'auto'];

/**
 * GET /api/admin/ai-proxy/config
 *
 * Returns the current AI proxy configuration including:
 * - The active default model (KV override > env var > shared constant)
 * - The active billing mode (KV override > env var > default)
 * - Available models with provider info and availability status
 * - Whether an Anthropic credential is configured
 * - Whether CF_API_TOKEN is configured (boolean only, never expose the value)
 */
adminAIProxyRoutes.get('/config', async (c) => {
  const kvConfig = await c.env.KV.get(AI_PROXY_DEFAULT_MODEL_KV_KEY);
  const parsed: AIProxyConfig | null = kvConfig ? JSON.parse(kvConfig) : null;

  const hasAnthropic = await hasAnthropicCredential(c.env);
  const hasCfApiToken = !!c.env.CF_API_TOKEN;
  const billingMode = await resolveBillingMode(c.env);

  // Effective default: KV override > env var > shared constant
  const effectiveDefault = parsed?.defaultModel
    ?? c.env.AI_PROXY_DEFAULT_MODEL
    ?? DEFAULT_AI_PROXY_MODEL;

  // With unified billing, Anthropic models are available if either CF_API_TOKEN
  // or a platform credential is configured
  const anthropicAvailable = hasCfApiToken || hasAnthropic;

  const models = PLATFORM_AI_MODELS.map((m) => ({
    ...m,
    available: m.provider === 'workers-ai' || anthropicAvailable,
  }));

  return c.json({
    defaultModel: effectiveDefault,
    source: parsed ? 'admin' as const : (c.env.AI_PROXY_DEFAULT_MODEL ? 'env' as const : 'default' as const),
    updatedAt: parsed?.updatedAt ?? null,
    hasAnthropicCredential: hasAnthropic,
    hasCfApiToken,
    billingMode,
    models,
  });
});

/**
 * PUT /api/admin/ai-proxy/config
 *
 * Update the default model. Validates that:
 * - The model ID is in the PLATFORM_AI_MODELS list
 * - If an Anthropic model is selected, either a platform credential or CF_API_TOKEN exists
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

  // Anthropic models require either unified billing (CF_API_TOKEN) or platform credential
  if (model.provider === 'anthropic') {
    const hasAnthropic = await hasAnthropicCredential(c.env);
    const hasCfApiToken = !!c.env.CF_API_TOKEN;
    if (!hasAnthropic && !hasCfApiToken) {
      throw errors.badRequest(
        'Cannot select an Anthropic model without either a CF API token (Unified Billing) or a Claude Code platform credential. '
        + 'Configure Unified Billing or add a credential on the Credentials tab first.',
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
  });

  return c.json({
    defaultModel: config.defaultModel,
    source: 'admin' as const,
    updatedAt: config.updatedAt,
  });
});

/**
 * PATCH /api/admin/ai-proxy/config
 *
 * Update the billing mode. Stored in KV for persistence across deploys.
 */
adminAIProxyRoutes.patch('/config', async (c) => {
  const body = await c.req.json<{ billingMode: string }>();

  if (!body.billingMode || typeof body.billingMode !== 'string') {
    throw errors.badRequest('billingMode is required');
  }

  if (!VALID_BILLING_MODES.includes(body.billingMode as BillingMode)) {
    throw errors.badRequest(`Invalid billing mode: ${body.billingMode}. Valid values: ${VALID_BILLING_MODES.join(', ')}`);
  }

  // Validate that unified billing can work with available credentials
  if (body.billingMode === 'unified' && !c.env.CF_API_TOKEN) {
    throw errors.badRequest(
      'Cannot set billing mode to "unified" without CF_API_TOKEN configured. '
      + 'Set CF_API_TOKEN as a Worker secret first, or use "auto" mode.',
    );
  }

  await c.env.KV.put(AI_PROXY_BILLING_MODE_KV_KEY, body.billingMode);

  log.info('admin.ai_proxy.billing_mode_updated', {
    billingMode: body.billingMode,
  });

  return c.json({
    billingMode: body.billingMode as BillingMode,
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
