/**
 * Request admission for the platform AI proxy (`routes/ai-proxy.ts`): authentication, request-size
 * limits, and every gate a request must pass before it may spend platform credentials.
 *
 * Split out of ai-proxy.ts per .claude/rules/18-file-size-limits.md.
 */
import {
  DEFAULT_AI_PROXY_MAX_INPUT_TOKENS_PER_REQUEST,
  DEFAULT_AI_PROXY_RATE_LIMIT_RPM,
  DEFAULT_AI_PROXY_RATE_LIMIT_WINDOW_SECONDS,
  DEFAULT_AI_PROXY_REQUEST_BODY_MAX_BYTES,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import type { Context } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { RequestBodyTooLargeError } from '../lib/runtime-validation';
import {
  checkRateLimit,
  createRateLimitKey,
  getCurrentWindowStart,
} from '../middleware/rate-limit';
import {
  AIProxyAuthError,
  extractCallbackToken,
  verifyAIProxyAuth,
} from '../services/ai-proxy-shared';
import { checkAiUsageGate } from '../services/ai-token-budget';
import { getAllowedModels } from './ai-proxy-model-resolution';

export type AIProxyContext = Context<{ Bindings: Env }>;
export type AIProxyDb = Parameters<typeof verifyAIProxyAuth>[2];
export type AIProxyRequestContext = Awaited<ReturnType<typeof verifyAIProxyAuth>> & {
  db: AIProxyDb;
};
type ProxyErrorStatus = 400 | 401 | 403 | 404 | 413 | 429 | 502 | 503;

export function proxyJsonError(
  c: AIProxyContext,
  message: string,
  type: string,
  status: ProxyErrorStatus,
  extra?: Record<string, unknown>
): Response {
  return c.json({ error: { message, type, ...(extra ?? {}) } }, status);
}

export function aiProxyRequestBodyMaxBytes(c: AIProxyContext): number {
  return parsePositiveInt(
    c.env.AI_PROXY_REQUEST_BODY_MAX_BYTES,
    DEFAULT_AI_PROXY_REQUEST_BODY_MAX_BYTES
  );
}

export function aiProxyBodyParseError(c: AIProxyContext, error: unknown): Response {
  if (error instanceof RequestBodyTooLargeError) {
    return proxyJsonError(
      c,
      `Request body exceeds ${error.maxBytes} bytes`,
      'invalid_request_error',
      413
    );
  }
  return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400);
}

export async function prepareAIProxyRequest(
  c: AIProxyContext
): Promise<Response | AIProxyRequestContext> {
  if (c.env.AI_PROXY_ENABLED === 'false') {
    return proxyJsonError(c, 'AI proxy is disabled', 'service_unavailable', 503);
  }

  const token = extractCallbackToken(c.req.header('Authorization'), undefined);
  if (!token) {
    return proxyJsonError(
      c,
      'Missing or invalid Authorization header',
      'invalid_request_error',
      401
    );
  }

  const db = drizzle(c.env.DATABASE, { schema });
  try {
    const auth = await verifyAIProxyAuth(token, c.env, db);
    return { ...auth, db };
  } catch (err) {
    if (err instanceof AIProxyAuthError) {
      return proxyJsonError(
        c,
        err.message,
        'invalid_request_error',
        err.statusCode as 401 | 403 | 404
      );
    }
    return proxyJsonError(c, 'Invalid or expired token', 'invalid_request_error', 401);
  }
}

export async function enforceRateLimit(
  c: AIProxyContext,
  userId: string
): Promise<Response | null> {
  const rpmLimit =
    parseInt(c.env.AI_PROXY_RATE_LIMIT_RPM || '', 10) || DEFAULT_AI_PROXY_RATE_LIMIT_RPM;
  const windowSeconds =
    parseInt(c.env.AI_PROXY_RATE_LIMIT_WINDOW_SECONDS || '', 10) ||
    DEFAULT_AI_PROXY_RATE_LIMIT_WINDOW_SECONDS;
  const windowStart = getCurrentWindowStart(windowSeconds);
  const rateLimitKey = createRateLimitKey('ai-proxy', userId, windowStart);
  const { allowed, remaining, resetAt } = await checkRateLimit(
    c.env.KV,
    rateLimitKey,
    rpmLimit,
    windowSeconds
  );

  c.header('X-RateLimit-Limit', rpmLimit.toString());
  c.header('X-RateLimit-Remaining', remaining.toString());
  c.header('X-RateLimit-Reset', resetAt.toString());

  if (allowed) return null;

  const retryAfter = resetAt - Math.floor(Date.now() / 1000);
  c.header('Retry-After', Math.max(1, retryAfter).toString());
  return proxyJsonError(c, 'Rate limit exceeded. Please try again later.', 'rate_limit_error', 429);
}

export async function enforceUsageGate(
  c: AIProxyContext,
  userId: string
): Promise<Response | null> {
  const usageGate = await checkAiUsageGate(c.env.KV, userId, c.env);
  if (usageGate.allowed) return null;

  if (usageGate.reason === 'daily-token-budget') {
    const { budget } = usageGate;
    return proxyJsonError(
      c,
      'Daily token budget exceeded. Resets at midnight UTC.',
      'rate_limit_error',
      429,
      {
        budget: {
          inputTokens: { used: budget.usage.inputTokens, limit: budget.inputLimit },
          outputTokens: { used: budget.usage.outputTokens, limit: budget.outputLimit },
        },
      }
    );
  }

  return proxyJsonError(
    c,
    'Monthly cost cap exceeded. Adjust your cap in Settings > Usage.',
    'rate_limit_error',
    429,
    {
      monthlyCost: {
        used: usageGate.monthlyCap.costUsd,
        cap: usageGate.monthlyCap.capUsd,
      },
    }
  );
}

export function validateAllowedModel(c: AIProxyContext, modelId: string): Response | null {
  const allowedModels = getAllowedModels(c.env);
  if (allowedModels.has(modelId)) return null;

  return proxyJsonError(
    c,
    `Model '${modelId}' is not available. Allowed models: ${Array.from(allowedModels).join(', ')}`,
    'invalid_request_error',
    400
  );
}

export function enforceInputLimit(
  c: AIProxyContext,
  estimatedInputTokens: number
): Response | null {
  const maxInputPerRequest =
    parseInt(c.env.AI_PROXY_MAX_INPUT_TOKENS_PER_REQUEST || '', 10) ||
    DEFAULT_AI_PROXY_MAX_INPUT_TOKENS_PER_REQUEST;
  if (estimatedInputTokens <= maxInputPerRequest) return null;

  return proxyJsonError(
    c,
    `Request too large: estimated ${estimatedInputTokens} input tokens exceeds limit of ${maxInputPerRequest}`,
    'invalid_request_error',
    400
  );
}
