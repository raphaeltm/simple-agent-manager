/**
 * Where the staging-only fake AI upstream may exist, and what it is called there.
 *
 * Shared by the deploy step that creates the fake Worker and its AI Gateway custom provider
 * (`fake-ai-upstream.ts`) and by the Worker config sync that tells the API Worker which provider to
 * route allowlisted test calls to (`sync-wrangler-config.ts`). One function decides both, so the
 * pipeline can never create the fake for a stack the API would not use it on, or the reverse.
 *
 * An allow-list, not a deny-list: a stack is accepted only when it is a known staging stack, the
 * GitHub Environment supplying credentials is `staging`, and no name involved looks like
 * production. Anything else, including a fork's unmapped production stack, is refused.
 */
import { DEPLOYMENT_CONFIG } from './config.js';
import { SECONDARY_INSTALLATIONS } from './staging-installations.mjs';

/** Pulumi stacks of staging installations (`staging-installations.mjs`). */
export const FAKE_AI_UPSTREAM_STACKS: ReadonlySet<string> = new Set(['staging', 'staging2']);
/** The only GitHub Environment whose deploys may create the fake. */
export const FAKE_AI_UPSTREAM_CREDENTIAL_ENVIRONMENT = 'staging';

export interface FakeAiUpstreamPlan {
  /** Worker script name, served only at `<workerName>.<account subdomain>.workers.dev`. */
  workerName: string;
  /** AI Gateway custom provider slug (account-wide, so prefixed per installation). */
  providerSlug: string;
  /** The gateway path segment that addresses the provider: `custom-<slug>`. */
  gatewayProvider: string;
}

export class FakeAiUpstreamRefusedError extends Error {}

const NAME = /^[a-z][a-z0-9-]{0,40}$/u;

function looksLikeProduction(value: string): boolean {
  return /prod/iu.test(value);
}

/**
 * The fake's names for this deploy, or a `FakeAiUpstreamRefusedError` when it must not exist here.
 * `credentialEnvironment` is the GitHub Environment the deploy job runs in; `stack` and `prefix`
 * are the installation's resolved Pulumi stack and resource prefix.
 */
export function planFakeAiUpstream(input: {
  credentialEnvironment: string;
  stack: string;
  prefix: string;
}): FakeAiUpstreamPlan {
  const credentialEnvironment = input.credentialEnvironment.trim();
  const stack = input.stack.trim();
  const prefix = input.prefix.trim();
  const refuse = (reason: string): never => {
    throw new FakeAiUpstreamRefusedError(
      `Refusing the fake AI upstream for environment '${credentialEnvironment}', stack '${stack}': ${reason}`
    );
  };
  if ([credentialEnvironment, stack, prefix].some(looksLikeProduction)) {
    refuse('it never exists on production');
  }
  if (credentialEnvironment !== FAKE_AI_UPSTREAM_CREDENTIAL_ENVIRONMENT) {
    refuse(`only the '${FAKE_AI_UPSTREAM_CREDENTIAL_ENVIRONMENT}' environment may create it`);
  }
  if (!FAKE_AI_UPSTREAM_STACKS.has(stack)) {
    refuse(`only staging stacks (${[...FAKE_AI_UPSTREAM_STACKS].join(', ')}) may have it`);
  }
  if (!NAME.test(prefix)) refuse('the resource prefix is not a plain lowercase name');
  const providerSlug = `${prefix}-test-upstream`;
  return {
    workerName: `${prefix}-fake-ai-${stack}`,
    providerSlug,
    gatewayProvider: `custom-${providerSlug}`,
  };
}

/** The plan when the fake may exist here, else null (for callers that just skip). */
export function fakeAiUpstreamPlanOrNull(input: {
  credentialEnvironment: string;
  stack: string;
  prefix: string;
}): FakeAiUpstreamPlan | null {
  try {
    return planFakeAiUpstream(input);
  } catch (error) {
    if (error instanceof FakeAiUpstreamRefusedError) return null;
    throw error;
  }
}

/**
 * The GitHub Environment whose credentials deploy `stack`: the stack's own name for a primary
 * installation, the registry's `credentialEnvironment` for a secondary one.
 */
export function credentialEnvironmentForStack(stack: string): string {
  const secondary = Object.values(SECONDARY_INSTALLATIONS).find((entry) => entry.stack === stack);
  return secondary
    ? secondary.credentialEnvironment
    : DEPLOYMENT_CONFIG.getEnvironmentFromStack(stack);
}

/**
 * API Worker vars that open the test upstream's deploy-time lock and name its gateway provider.
 * Empty for every stack the plan refuses, production included.
 */
export function fakeAiUpstreamWorkerVars(stack: string, prefix: string): Record<string, string> {
  const plan = fakeAiUpstreamPlanOrNull({
    credentialEnvironment: credentialEnvironmentForStack(stack),
    stack,
    prefix,
  });
  return plan
    ? { AI_TEST_UPSTREAM_ENABLED: 'true', AI_TEST_UPSTREAM_GATEWAY_PROVIDER: plan.gatewayProvider }
    : {};
}
