/**
 * Test-only fake AI upstream for SAM-managed ("sam" provider mode) model calls.
 *
 * Lets an operator prove platform-funded metering and spending limits end to end with no AI key.
 * The proxy routes run every gate they always run (auth, model allowlist, tier, daily token
 * budget, monthly cost cap); only the upstream call is replaced, and the fake's response then
 * goes through the same accounting as a real one (`attachTokenUsageAccounting`), so it is priced,
 * recorded and capped like a real call.
 *
 * Three locks, all fail closed:
 * 1. Deploy-time `AI_TEST_UPSTREAM_ENABLED === 'true'`, absent by default.
 * 2. Only where `ENVIRONMENT` names a test or self-host installation (`TEST_UPSTREAM_ENVIRONMENTS`).
 *    An allow-list, not a deny-list: a fork whose production stack has an unmapped name gets that
 *    raw name (`scripts/deploy/config.ts:getEnvironmentFromStack`) and must still be refused.
 *    Cloudflare deploys set staging/production; the self-host box sets `selfhost`
 *    (`scripts/selfhost/celld-config.ts`).
 * 3. Superadmin setting `aiProxy.testUpstreamUserIds`: only the listed users' calls are faked.
 *    Empty (the default) means off; every other user on the installation keeps the real model.
 *
 * 4. Only where SAM meters spend itself (no AI Gateway, `hasLocalAiCostMetering`).
 *
 * The fake is answered in-process (`fakeUpstreamFetch`): nothing leaves the Worker, no platform key
 * or Cloudflare token is sent, and no provider is billed. Passthrough routes
 * (`/ai/proxy/:wstoken/*`) and Workers AI models are not faked.
 */
import { hasLocalAiCostMetering } from '@simple-agent-manager/ai-proxy';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { resolveAdminSetting } from './admin-settings-resolution';
import type { UpstreamAuth } from './ai-billing';
import {
  AI_TEST_UPSTREAM_COST_PER_CALL_CENTS_SETTING,
  AI_TEST_UPSTREAM_USER_IDS_SETTING,
  DEFAULT_AI_TEST_UPSTREAM_COST_PER_CALL_CENTS,
} from './ai-proxy-settings';
import { buildFakeUpstreamResponse } from './ai-test-upstream-responses';

/** The only value of `AI_TEST_UPSTREAM_ENABLED` that opens the deploy-time lock. */
const AI_TEST_UPSTREAM_ENABLED_VALUE = 'true';
/** `ENVIRONMENT` values where the fake may answer. Anything else, including unset, is refused. */
const TEST_UPSTREAM_ENVIRONMENTS: ReadonlySet<string> = new Set([
  'staging',
  'staging2',
  'selfhost',
  'development',
  'test',
]);

/** A fetch the proxy routes call instead of the global one when the fake answers. */
export type AiUpstreamFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The real network fetch, the default for every proxy upstream call. */
export const globalUpstreamFetch: AiUpstreamFetch = (url, init) =>
  // eslint-disable-next-line sam/no-unguarded-outbound-fetch -- the proxy routes build every URL from fixed provider and AI Gateway bases (ai-proxy-shared.ts, ai-proxy-upstream.ts)
  fetch(url, init);

/**
 * Usage attribution for a faked call. Recorded on agent-run usage in place of a platform
 * credential reference, so test usage is never attributed to a real key.
 */
export const AI_TEST_UPSTREAM_ATTRIBUTION = {
  credentialReference: 'sam-test-upstream',
  credentialSource: 'platform',
} as const;

/** Anthropic upstream auth for a faked call: no headers, so nothing secret is sent anywhere. */
export function testUpstreamAnthropicAuth(): UpstreamAuth {
  return {
    headers: {},
    billingMode: 'platform-key',
    credentialProvider: 'anthropic',
    providerMode: 'platform-key',
    ...AI_TEST_UPSTREAM_ATTRIBUTION,
  };
}

export interface AiTestUpstream {
  /** Answers the upstream call. Never forwards the request anywhere. */
  readonly fetch: AiUpstreamFetch;
  readonly costPerCallUsd: number;
}

/**
 * Deploy-time locks 1 and 2. Pure and cheap: production pays nothing beyond two string compares,
 * and never reads the admin settings below.
 */
export function isAiTestUpstreamDeployable(
  env: Pick<Env, 'AI_TEST_UPSTREAM_ENABLED' | 'ENVIRONMENT'>
): boolean {
  if (env.AI_TEST_UPSTREAM_ENABLED !== AI_TEST_UPSTREAM_ENABLED_VALUE) return false;
  const environment = env.ENVIRONMENT?.trim().toLowerCase();
  return environment !== undefined && TEST_UPSTREAM_ENVIRONMENTS.has(environment);
}

function costPerCallUsd(raw: unknown): number {
  const cents =
    typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0
      ? raw
      : DEFAULT_AI_TEST_UPSTREAM_COST_PER_CALL_CENTS;
  return cents / 100;
}

/** The configured list-price cost of one fake call, in USD (`aiProxy.testUpstreamCostPerCallCents`). */
export async function resolveAiTestUpstreamCostPerCallUsd(env: Env): Promise<number> {
  return costPerCallUsd(
    await resolveAdminSetting(env, AI_TEST_UPSTREAM_COST_PER_CALL_CENTS_SETTING)
  );
}

/**
 * The fake upstream for this caller, or null when the real upstream must be used. A failed
 * settings read resolves to the default (an empty list), so it falls back to the real upstream.
 */
export async function resolveAiTestUpstream(
  env: Env,
  userId: string
): Promise<AiTestUpstream | null> {
  if (!isAiTestUpstreamDeployable(env)) return null;
  // Where an AI Gateway exists, spend is read from the gateway's logs, so an in-process answer
  // would be metered nowhere and prove nothing. The fake only answers where SAM meters itself.
  if (!hasLocalAiCostMetering(env)) return null;
  const userIds = await resolveAdminSetting(env, AI_TEST_UPSTREAM_USER_IDS_SETTING);
  if (!Array.isArray(userIds) || !userIds.some((id) => id.trim() === userId)) {
    // Only reachable on a test installation: says why a tester's call took the real upstream.
    log.info('ai_proxy.test_upstream_not_selected', { userId, reason: 'user_not_listed' });
    return null;
  }
  const cost = await resolveAiTestUpstreamCostPerCallUsd(env);
  log.info('ai_proxy.test_upstream_selected', {
    userId,
    environment: env.ENVIRONMENT,
    costPerCallUsd: cost,
  });
  return {
    costPerCallUsd: cost,
    fetch: (url, init) => fakeUpstreamFetch(url, init, cost),
  };
}

/** Answer an upstream call in-process from the request the proxy would have sent. */
export async function fakeUpstreamFetch(
  url: string,
  init: RequestInit,
  costUsd: number
): Promise<Response> {
  let body: unknown = null;
  try {
    body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
  } catch {
    body = null;
  }
  return buildFakeUpstreamResponse(new URL(url).pathname, body, costUsd);
}
