/**
 * Which platform services this installation actually has.
 *
 * SAM runs on Cloudflare, where every binding below exists, and on Workers-compatible
 * runtimes such as celld, where Cloudflare-only services are absent. Every caller that
 * depends on one of these services asks this module rather than reading `env.X` directly,
 * so "is it there?" has exactly one answer per service (rules 24 and 74).
 *
 * Each capability is derived from the condition itself:
 * - a binding is present and has the method SAM calls, or
 * - every credential the service needs is configured.
 * A Cloudflare deployment with all bindings and settings present resolves every
 * capability to true, so its behaviour does not change.
 */
import type { Env } from '../env';
import { emailTransportKind } from './agent-email/provider';
import { resolveR2PresignConfig } from './r2-presign-config';

/** One platform service. The name is also the `feature` field of a FEATURE_UNAVAILABLE error. */
export type PlatformCapability =
  | 'workersAi'
  | 'aiGateway'
  | 'monthlyCostCap'
  | 'cloudflareAccountApi'
  | 'analyticsIngest'
  | 'analyticsQuery'
  | 'artifacts'
  | 'containerRuntime'
  | 'guidedCredentialSetup'
  | 'emailSending'
  | 'cloudflareDns'
  | 'workersObservability'
  | 'r2Presign'
  | 'speechToText'
  | 'textToSpeech';

export type PlatformCapabilities = Readonly<Record<PlatformCapability, boolean>>;

type CapabilityEnv = Pick<
  Env,
  | 'AI'
  | 'AI_GATEWAY_ID'
  | 'CF_ACCOUNT_ID'
  | 'CF_API_TOKEN'
  | 'CF_ZONE_ID'
  | 'ANALYTICS'
  | 'ARTIFACTS'
  | 'ARTIFACTS_ENABLED'
  | 'CONTAINER_RUNTIME_AVAILABLE'
  | 'SANDBOX'
  | 'CREDENTIAL_SETUP_SESSION'
  | 'SETUP_SESSION_POOL'
  | 'AGENT_EMAIL'
  | 'BASE_DOMAIN'
  | 'SMTP_HOST'
  | 'SMTP_PORT'
  | 'SMTP_TLS'
  | 'SMTP_USERNAME'
  | 'SMTP_PASSWORD'
  | 'SMTP_FROM'
  | 'TTS_ENABLED'
  | 'R2_ACCESS_KEY_ID'
  | 'R2_SECRET_ACCESS_KEY'
  | 'R2_BUCKET_NAME'
  | 'R2_S3_ENDPOINT'
  | 'R2_S3_BUCKET'
  | 'R2_S3_KEY_PREFIX'
  | 'R2_S3_REGION'
  | 'R2_S3_FORCE_PATH_STYLE'
>;

function present(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** The Workers AI binding, or null when this runtime has none (celld, or `[ai]` removed). */
export function getWorkersAiBindingOrNull(env: Pick<Env, 'AI'>): Ai | null {
  const ai: unknown = env.AI;
  if (!ai || typeof (ai as { run?: unknown }).run !== 'function') return null;
  return ai as Ai;
}

/** Account-scoped Cloudflare REST API (Workers AI REST, Analytics SQL, Observability). */
export function hasCloudflareAccountApi(env: Pick<Env, 'CF_ACCOUNT_ID' | 'CF_API_TOKEN'>): boolean {
  return present(env.CF_ACCOUNT_ID) && present(env.CF_API_TOKEN);
}

/**
 * The AI Gateway id to route through, or null when the gateway cannot be addressed.
 *
 * `AI_GATEWAY_ID` alone is not the condition: `wrangler.toml` ships a default id, so a
 * runtime with no Cloudflare account still has it set. Every gateway URL is
 * `gateway.ai.cloudflare.com/v1/<account>/<gateway>/...`, so it also needs the account id.
 */
export function resolveAiGatewayId(env: Pick<Env, 'AI_GATEWAY_ID' | 'CF_ACCOUNT_ID'>): string | null {
  const gatewayId = env.AI_GATEWAY_ID?.trim();
  if (!gatewayId || !present(env.CF_ACCOUNT_ID)) return null;
  return gatewayId;
}

/**
 * Whether a monthly AI dollar cap can be enforced here. The month's spend comes only from AI
 * Gateway logs, read by `runMonthlyCostAggregation` through the account API (gateway id, account
 * id and API token all required); SAM's own records carry no price for an operator's model on
 * their own endpoint. Without that, the cap is reported as unavailable everywhere (budget API,
 * settings UI, admin AI proxy page) rather than accepted and silently never enforced. Daily token
 * budgets apply either way.
 *
 * Calls served by an admin-configured OpenAI-compatible endpoint never reach gateway logs, so on
 * an installation with both, the cap counts only gateway-routed spend (documented in
 * reference/configuration.md). This predicate reads env only and cannot see that D1 setting.
 */
export function isMonthlyCostCapAvailable(
  env: Pick<Env, 'AI_GATEWAY_ID' | 'CF_ACCOUNT_ID' | 'CF_API_TOKEN'>
): boolean {
  return resolveAiGatewayId(env) !== null && hasCloudflareAccountApi(env);
}

/**
 * AI Gateway request headers (`cf-aig-metadata` attribution with user and workspace ids), or
 * nothing when the call goes straight to the provider. Only the gateway reads them, so a
 * direct call to OpenAI or Anthropic must not carry SAM's internal ids.
 */
export function aiGatewayOnlyHeaders(
  env: Pick<Env, 'AI_GATEWAY_ID' | 'CF_ACCOUNT_ID'>,
  headers: Record<string, string>
): Record<string, string> {
  return resolveAiGatewayId(env) ? headers : {};
}

/**
 * Whether the container bindings are backed by a container runtime.
 *
 * On Cloudflare the container Durable Object bindings always are. Other runtimes may bind the
 * same classes as plain Durable Objects with no container behind them, and a binding cannot
 * tell the two apart, so the deployment declares it: `CONTAINER_RUNTIME_AVAILABLE="false"`.
 * Unset means available, which keeps Cloudflare deployments unchanged.
 */
export function hasContainerRuntime(env: Pick<Env, 'CONTAINER_RUNTIME_AVAILABLE'>): boolean {
  return env.CONTAINER_RUNTIME_AVAILABLE?.trim().toLowerCase() !== 'false';
}

/**
 * Whether Instant (raw container) workspaces may run: the operator switch is on AND a container
 * runtime backs the bindings. The one gate for both advertising Instant and choosing it, so the
 * two cannot diverge on a runtime whose container classes are plain Durable Objects.
 */
export function isContainerWorkspaceRuntimeEnabled(
  env: Pick<Env, 'CF_CONTAINER_ENABLED' | 'SANDBOX_ENABLED' | 'CONTAINER_RUNTIME_AVAILABLE'>
): boolean {
  return (env.CF_CONTAINER_ENABLED ?? env.SANDBOX_ENABLED) === 'true' && hasContainerRuntime(env);
}

/** Guided credential setup runs the Sandbox SDK and two coordination Durable Objects. */
export function isGuidedCredentialSetupAvailable(
  env: Pick<
    Env,
    'CONTAINER_RUNTIME_AVAILABLE' | 'SANDBOX' | 'CREDENTIAL_SETUP_SESSION' | 'SETUP_SESSION_POOL'
  >
): boolean {
  return (
    hasContainerRuntime(env) &&
    !!env.SANDBOX &&
    !!env.CREDENTIAL_SETUP_SESSION &&
    !!env.SETUP_SESSION_POOL
  );
}

/** Cloudflare Artifacts (SAM-native Git repositories). */
export function isArtifactsAvailable(env: Pick<Env, 'ARTIFACTS' | 'ARTIFACTS_ENABLED'>): boolean {
  return env.ARTIFACTS_ENABLED === 'true' && !!env.ARTIFACTS;
}

/** Resolve every capability from bindings and settings. Pure and synchronous. */
export function resolvePlatformCapabilities(env: CapabilityEnv): PlatformCapabilities {
  const workersAi = getWorkersAiBindingOrNull(env) !== null;
  const cloudflareAccountApi = hasCloudflareAccountApi(env);
  return {
    workersAi,
    aiGateway: resolveAiGatewayId(env) !== null,
    monthlyCostCap: isMonthlyCostCapAvailable(env),
    cloudflareAccountApi,
    analyticsIngest: !!env.ANALYTICS,
    analyticsQuery: cloudflareAccountApi,
    artifacts: isArtifactsAvailable(env),
    containerRuntime: hasContainerRuntime(env),
    guidedCredentialSetup: isGuidedCredentialSetupAvailable(env),
    // SAM can send its own email (sign-in codes): Cloudflare Email Sending or SMTP. Agent email
    // (inbound mail, replies) still needs the Cloudflare binding (agent-email/setup-state.ts).
    emailSending: emailTransportKind(env) !== null,
    cloudflareDns: present(env.CF_API_TOKEN) && present(env.CF_ZONE_ID),
    workersObservability: cloudflareAccountApi,
    r2Presign: resolveR2PresignConfig(env) !== null,
    speechToText: workersAi,
    textToSpeech: workersAi && env.TTS_ENABLED !== 'false',
  };
}

/**
 * What the web client needs to hide entry points that cannot work here. Public: no secrets.
 * Only fields the UI reads: guided setup, Artifacts and email sign-in already have their own
 * config endpoints, and analytics and log search answer FEATURE_UNAVAILABLE themselves.
 */
export interface PublicPlatformCapabilities {
  speechToText: boolean;
  textToSpeech: boolean;
  /** Whether a monthly AI dollar cap can be set (onboarding's SAM-managed AI step reads it). */
  monthlyCostCap: boolean;
}

export function publicPlatformCapabilities(env: CapabilityEnv): PublicPlatformCapabilities {
  const capabilities = resolvePlatformCapabilities(env);
  return {
    speechToText: capabilities.speechToText,
    textToSpeech: capabilities.textToSpeech,
    monthlyCostCap: capabilities.monthlyCostCap,
  };
}
