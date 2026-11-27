/**
 * Gateway routing for the test-only fake AI upstream (`ai-test-upstream.ts`).
 *
 * On a self-hosted Cloudflare install spend is priced from AI Gateway logs, so a faked call must
 * go through the real gateway. The proxy builds the same gateway URL it always builds
 * (`.../<gateway>/anthropic/v1/messages`); this fetch swaps the provider segment for the staging
 * fake's custom provider (`custom-<prefix>-test-upstream`) and sends the request there instead.
 * The gateway logs it, the fake Worker (`packages/ai-proxy/src/ai-test-upstream-worker.ts`) answers
 * it with canned usage, and the proxy's normal accounting runs on the answer.
 *
 * What is sent: the gateway's own auth (`cf-aig-authorization`, the same token real gateway calls
 * use, which the gateway consumes), the usage metadata, the requested cost, and a per-token custom
 * cost so the gateway logs a price for a provider it has no price table for. Provider keys are
 * never sent: every other header is dropped. The gating header is not sent from here; the custom
 * provider's config adds it (`scripts/deploy/fake-ai-upstream.ts`).
 */
import {
  AI_TEST_UPSTREAM_COST_HEADER,
  findPricedModel,
  resolveUnifiedBillingToken,
} from '@simple-agent-manager/ai-proxy';

import type { Env } from '../env';
import { log } from '../lib/logger';
import type { AiUpstreamFetch } from './ai-test-upstream';

const GATEWAY_HOST = 'gateway.ai.cloudflare.com';
/** Only the custom-provider form, so a misconfigured var can never name a real provider. */
const GATEWAY_PROVIDER = /^custom-[a-z0-9][a-z0-9-]{0,62}$/u;
/** Gateway provider segments a faked call may replace. Workers AI is never faked. */
const REPLACEABLE_PROVIDERS: ReadonlySet<string> = new Set(['anthropic', 'openai']);
/** Request headers carried over to the fake. Everything else, credentials included, is dropped. */
const FORWARDED_HEADERS = [
  'content-type',
  'accept',
  'anthropic-version',
  'anthropic-beta',
  'cf-aig-metadata',
] as const;

/** The configured custom provider segment, or null when absent or not a custom provider. */
export function resolveTestUpstreamGatewayProvider(
  env: Pick<Env, 'AI_TEST_UPSTREAM_GATEWAY_PROVIDER'>
): string | null {
  const provider = env.AI_TEST_UPSTREAM_GATEWAY_PROVIDER?.trim();
  return provider && GATEWAY_PROVIDER.test(provider) ? provider : null;
}

/**
 * `url` with its gateway provider segment replaced by `provider`, or null when `url` is not an AI
 * Gateway provider URL this may rewrite. Gateway URLs are `/v1/<account>/<gateway>/<provider>/...`.
 */
export function testUpstreamGatewayUrl(url: string, provider: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.host !== GATEWAY_HOST) return null;
  const parts = parsed.pathname.split('/');
  if (parts.length < 6 || parts[1] !== 'v1' || !REPLACEABLE_PROVIDERS.has(parts[4] ?? '')) {
    return null;
  }
  parts[4] = provider;
  parsed.pathname = parts.join('/');
  return parsed.toString();
}

/** AI Gateway custom cost for `modelId` at catalog list price, or null for an unpriced model. */
export function testUpstreamCustomCost(modelId: string): string | null {
  const model = findPricedModel(modelId);
  if (!model) return null;
  return JSON.stringify({
    per_token_in: model.costPer1kInputTokens / 1000,
    per_token_out: model.costPer1kOutputTokens / 1000,
  });
}

function requestModel(body: RequestInit['body']): string | null {
  if (typeof body !== 'string') return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const model = (parsed as Record<string, unknown>).model;
      return typeof model === 'string' ? model : null;
    }
  } catch {
    return null;
  }
  return null;
}

function refused(reason: string): Response {
  return new Response(
    JSON.stringify({ error: { type: 'invalid_request_error', message: reason } }),
    { status: 400, headers: { 'Content-Type': 'application/json' } }
  );
}

/**
 * The fetch a faked call uses on a gateway install. Never reaches a real provider: a URL it cannot
 * rewrite is refused with a 400 instead of being sent anywhere.
 */
export function gatewayTestUpstreamFetch(
  env: Env,
  provider: string,
  costPerCallUsd: number,
  realFetch: AiUpstreamFetch
): AiUpstreamFetch {
  return async (url, init) => {
    const target = testUpstreamGatewayUrl(url, provider);
    if (!target) {
      log.warn('ai_proxy.test_upstream_gateway_url_refused', { provider });
      return refused('This route cannot be served by the SAM test upstream');
    }
    const source = new Headers(init.headers);
    const headers = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = source.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set(AI_TEST_UPSTREAM_COST_HEADER, String(costPerCallUsd));
    const model = requestModel(init.body);
    const customCost = model ? testUpstreamCustomCost(model) : null;
    if (customCost) headers.set('cf-aig-custom-cost', customCost);
    const gatewayToken = resolveUnifiedBillingToken(env);
    if (gatewayToken) headers.set('cf-aig-authorization', `Bearer ${gatewayToken}`);
    return realFetch(target, { ...init, headers });
  };
}
