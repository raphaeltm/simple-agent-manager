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
 * 2. Never where `ENVIRONMENT` is `production` or unset (every Cloudflare deploy sets it; the
 *    self-host box sets `selfhost`).
 * 3. Superadmin setting `aiProxy.testUpstreamUserIds`: only the listed users' calls are faked.
 *    Empty (the default) means off; every other user on the installation keeps the real model.
 *
 * Without an AI Gateway the fake is answered in-process (`fakeUpstreamFetch`): nothing leaves the
 * Worker, no platform key or Cloudflare token is resolved or sent, and no provider is billed.
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
/** `ENVIRONMENT` values that can never use the fake, whatever else is set. */
const FAKE_FORBIDDEN_ENVIRONMENTS: ReadonlySet<string> = new Set(['production', 'prod']);

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
  if (!environment) return false;
  return !FAKE_FORBIDDEN_ENVIRONMENTS.has(environment);
}

function costPerCallUsd(raw: unknown): number {
  const cents =
    typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0
      ? raw
      : DEFAULT_AI_TEST_UPSTREAM_COST_PER_CALL_CENTS;
  return cents / 100;
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
  if (!Array.isArray(userIds) || !userIds.some((id) => id.trim() === userId)) return null;
  const cost = costPerCallUsd(
    await resolveAdminSetting(env, AI_TEST_UPSTREAM_COST_PER_CALL_CENTS_SETTING)
  );
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
