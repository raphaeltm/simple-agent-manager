/**
 * The admission steps shared by every native Anthropic proxy route (`ai-proxy-anthropic.ts`
 * `/messages`, `ai-proxy-anthropic-count-tokens.ts` `/messages/count_tokens`): callback-token
 * auth, the proxy switch, the per-user rate limit, body parsing, the model checks, the usage gate,
 * then the upstream: the test-only fake for an allowlisted user (`ai-test-upstream.ts`) or the
 * platform's upstream auth. One implementation, so the two routes cannot drift (rule 24).
 */
import {
  DEFAULT_AI_PROXY_RATE_LIMIT_RPM,
  DEFAULT_AI_PROXY_RATE_LIMIT_WINDOW_SECONDS,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import type { Context } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { readRequestJsonRecord } from '../lib/runtime-validation';
import {
  checkRateLimit,
  createRateLimitKey,
  getCurrentWindowStart,
} from '../middleware/rate-limit';
import { resolveUpstreamAuth, type UpstreamAuth } from '../services/ai-billing';
import type { AIProxyAuthResult } from '../services/ai-proxy-auth';
import { isAiProxyEnabled } from '../services/ai-proxy-availability';
import {
  AIProxyAuthError,
  extractCallbackToken,
  isAnthropicModel,
  verifyAIProxyAuth,
} from '../services/ai-proxy-shared';
import {
  type AiTestUpstream,
  resolveAiTestUpstream,
  testUpstreamAnthropicAuth,
} from '../services/ai-test-upstream';
import { checkAiUsageGate } from '../services/ai-token-budget';
import {
  anthropicBodyMaxBytes,
  anthropicBodyParseError,
  anthropicError,
  anthropicUsageGateError,
  enforceAnthropicModelTier,
  validateAnthropicAllowedModel,
} from './ai-proxy-anthropic-support';

export interface AnthropicProxyAdmission {
  auth: AIProxyAuthResult;
  body: Record<string, unknown>;
  modelId: string;
  /** The test-only fake for an allowlisted user, else null (the real upstream). */
  testUpstream: AiTestUpstream | null;
  upstreamAuth: UpstreamAuth;
}

export interface AnthropicProxyAdmissionOptions {
  /** Context name for body-parse diagnostics. */
  bodyContext: string;
  /** Refusal text for a model that is not `claude-*`. */
  unsupportedModelMessage: (modelId: string) => string;
  /** Log event when the platform's upstream auth cannot be resolved. */
  upstreamAuthFailureEvent: string;
}

/** Run every admission step; a Response means the request was refused. */
export async function admitAnthropicProxyRequest(
  c: Context<{ Bindings: Env }>,
  options: AnthropicProxyAdmissionOptions
): Promise<AnthropicProxyAdmission | Response> {
  // --- Auth: token from x-api-key or Authorization: Bearer ---
  const token = extractCallbackToken(c.req.header('Authorization'), c.req.header('x-api-key'));
  if (!token) {
    return anthropicError(
      'Missing authentication. Provide x-api-key or Authorization: Bearer header.',
      'authentication_error',
      401
    );
  }

  const db = drizzle(c.env.DATABASE, { schema });
  let auth: AIProxyAuthResult;
  try {
    auth = await verifyAIProxyAuth(token, c.env, db);
  } catch (err) {
    if (err instanceof AIProxyAuthError) {
      const errType = err.statusCode === 403 ? 'permission_error' : 'authentication_error';
      return anthropicError(err.message, errType, err.statusCode);
    }
    return anthropicError('Invalid or expired API key', 'authentication_error', 401);
  }
  if (!(await isAiProxyEnabled(c.env)))
    return anthropicError('AI proxy is disabled', 'api_error', 503);

  const { userId, workspaceId } = auth;

  // --- Rate limit: per-user RPM (shared key with the OpenAI-compatible proxy) ---
  const rpmLimit =
    parseInt(c.env.AI_PROXY_RATE_LIMIT_RPM || '', 10) || DEFAULT_AI_PROXY_RATE_LIMIT_RPM;
  const windowSeconds =
    parseInt(c.env.AI_PROXY_RATE_LIMIT_WINDOW_SECONDS || '', 10) ||
    DEFAULT_AI_PROXY_RATE_LIMIT_WINDOW_SECONDS;
  const windowStart = getCurrentWindowStart(windowSeconds);
  const rateLimitKey = createRateLimitKey('ai-proxy', userId, windowStart);

  const {
    allowed: rpmAllowed,
    remaining,
    resetAt,
  } = await checkRateLimit(c.env.KV, rateLimitKey, rpmLimit, windowSeconds);

  c.header('X-RateLimit-Limit', rpmLimit.toString());
  c.header('X-RateLimit-Remaining', remaining.toString());
  c.header('X-RateLimit-Reset', resetAt.toString());

  if (!rpmAllowed) {
    const retryAfter = resetAt - Math.floor(Date.now() / 1000);
    c.header('Retry-After', Math.max(1, retryAfter).toString());
    return anthropicError('Rate limit exceeded. Please try again later.', 'rate_limit_error', 429);
  }

  // --- Parse request body ---
  let body: Record<string, unknown>;
  try {
    body = await readRequestJsonRecord(c.req.raw, options.bodyContext, anthropicBodyMaxBytes(c));
  } catch (error) {
    return anthropicBodyParseError(error);
  }

  // --- Validate model (must be an Anthropic model) ---
  const modelId = typeof body.model === 'string' ? body.model : undefined;
  if (!modelId) {
    return anthropicError('model is required', 'invalid_request_error', 400);
  }
  if (!isAnthropicModel(modelId)) {
    return anthropicError(options.unsupportedModelMessage(modelId), 'invalid_request_error', 400);
  }

  const modelError = validateAnthropicAllowedModel(c, auth, modelId);
  if (modelError) return modelError;

  const tierError = await enforceAnthropicModelTier(c, auth, modelId);
  if (tierError) return tierError;

  const usageGate = await checkAiUsageGate(c.env.KV, userId, c.env);
  if (!usageGate.allowed) {
    return anthropicUsageGateError(
      usageGate.reason,
      usageGate.reason === 'monthly-cost-cap' ? usageGate.monthlyCap : undefined
    );
  }

  // Test-only fake upstream for allowlisted users: no key is resolved or sent, and the response
  // is metered exactly like a real one.
  const testUpstream = await resolveAiTestUpstream(c.env, userId);
  if (testUpstream) {
    return { auth, body, modelId, testUpstream, upstreamAuth: testUpstreamAnthropicAuth() };
  }

  // --- Resolve upstream auth (Unified Billing or platform key) ---
  try {
    const upstreamAuth = await resolveUpstreamAuth(c.env, db);
    return { auth, body, modelId, testUpstream: null, upstreamAuth };
  } catch (err) {
    log.error(options.upstreamAuthFailureEvent, {
      userId,
      workspaceId,
      reason: err instanceof Error ? err.message : String(err),
    });
    return anthropicError(
      'AI proxy is not configured. Contact an administrator.',
      'api_error',
      503
    );
  }
}
