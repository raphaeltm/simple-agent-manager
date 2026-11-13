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
import {
  aiGatewayOnlyHeaders,
  hasCloudflareAccountApi,
  hasLocalAiCostMetering,
  isMonthlyCostCapAvailable,
  resolveAiGatewayId,
} from '@simple-agent-manager/ai-proxy';

import type { Env } from '../env';
import { errors } from '../middleware/error';
import { emailTransportKind } from './agent-email/provider';
import { hasInboundAgentEmail } from './agent-email/self-host-inbound';
import { isAnalyticsD1SinkEnabled } from './analytics-d1-sink';
import { resolveArtifactsBackend } from './hosted-git/backend';
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
  | 'inboundAgentEmail'
  | 'cloudflareDns'
  | 'appDeployments'
  | 'workersObservability'
  | 'r2Presign'
  | 'speechToText'
  | 'textToSpeech'
  | 'liveLogStream';

export type PlatformCapabilities = Readonly<Record<PlatformCapability, boolean>>;

type CapabilityEnv = Pick<
  Env,
  | 'AI'
  | 'AI_GATEWAY_ID'
  | 'CF_ACCOUNT_ID'
  | 'CF_API_TOKEN'
  | 'CF_ZONE_ID'
  | 'ANALYTICS'
  | 'ANALYTICS_SINK'
  | 'OBSERVABILITY_DATABASE'
  | 'ARTIFACTS'
  | 'ARTIFACTS_ENABLED'
  | 'HOSTED_GIT'
  | 'HOSTED_GIT_BACKEND'
  | 'CONTAINER_RUNTIME_AVAILABLE'
  | 'SANDBOX_CONTAINER_RUNTIME_AVAILABLE'
  | 'LOG_TAIL_AVAILABLE'
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
  | 'AGENT_EMAIL_INBOUND_SMTP'
  | 'REVERSE_TUNNEL_GATEWAY_SECRET'
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

// The AI Gateway helpers are pure functions of the environment and live in the AI proxy
// package, which needs them too. Re-exported so this module stays the one place to ask.
export {
  aiGatewayOnlyHeaders,
  hasCloudflareAccountApi,
  hasLocalAiCostMetering,
  isMonthlyCostCapAvailable,
  resolveAiGatewayId,
};

function present(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** The Workers AI binding, or null when this runtime has none (celld, or `[ai]` removed). */
export function getWorkersAiBindingOrNull(env: Pick<Env, 'AI'>): Ai | null {
  const ai: unknown = env.AI;
  if (!ai || typeof (ai as { run?: unknown }).run !== 'function') return null;
  return ai as Ai;
}

/**
 * Whether the container bindings, and in particular VM_AGENT_CONTAINER (Instant), are backed by
 * a container runtime. The SANDBOX binding has its own declaration that falls back to this one:
 * see `hasSandboxContainerRuntime`.
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
 * Whether the SANDBOX binding (the Sandbox SDK container that guided credential setup runs) is
 * backed by a container runtime. Declared per class because a runtime can back one container
 * class and not another: celld runs the sign-in sandbox but never Instant, whose vm-agent must
 * call back into the box (scripts/selfhost/celld-config.ts). Unset falls back to the shared
 * declaration, so Cloudflare deployments, which back every class, are unchanged.
 */
export function hasSandboxContainerRuntime(
  env: Pick<Env, 'CONTAINER_RUNTIME_AVAILABLE' | 'SANDBOX_CONTAINER_RUNTIME_AVAILABLE'>
): boolean {
  const declared = env.SANDBOX_CONTAINER_RUNTIME_AVAILABLE?.trim();
  if (declared) return declared.toLowerCase() !== 'false';
  return hasContainerRuntime(env);
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

/**
 * Whether Admin → Stream can receive anything. The stream is fed by the tail worker (a Cloudflare
 * `tail_consumers` attachment), which the Worker cannot see from inside, so the deployment
 * declares its absence: `LOG_TAIL_AVAILABLE="false"` (scripts/selfhost/celld-config.ts). Unset
 * means available, which keeps Cloudflare deployments unchanged.
 */
export function hasLiveLogStream(env: Pick<Env, 'LOG_TAIL_AVAILABLE'>): boolean {
  return env.LOG_TAIL_AVAILABLE?.trim().toLowerCase() !== 'false';
}

/** Guided credential setup runs the Sandbox SDK and two coordination Durable Objects. */
export function isGuidedCredentialSetupAvailable(
  env: Pick<
    Env,
    | 'CONTAINER_RUNTIME_AVAILABLE'
    | 'SANDBOX_CONTAINER_RUNTIME_AVAILABLE'
    | 'SANDBOX'
    | 'CREDENTIAL_SETUP_SESSION'
    | 'SETUP_SESSION_POOL'
  >
): boolean {
  return (
    hasSandboxContainerRuntime(env) &&
    !!env.SANDBOX &&
    !!env.CREDENTIAL_SETUP_SESSION &&
    !!env.SETUP_SESSION_POOL
  );
}

/**
 * SAM-native Git repositories: Cloudflare Artifacts, or on self-host the local Durable Object git
 * server (`services/hosted-git/backend.ts`, the one resolver for both).
 */
export function isArtifactsAvailable(
  env: Pick<
    Env,
    'ARTIFACTS' | 'ARTIFACTS_ENABLED' | 'HOSTED_GIT' | 'HOSTED_GIT_BACKEND' | 'BASE_DOMAIN'
  >
): boolean {
  return resolveArtifactsBackend(env) !== null;
}

/** Resolve every capability from bindings and settings. Pure and synchronous. */
export function resolvePlatformCapabilities(env: CapabilityEnv): PlatformCapabilities {
  const workersAi = getWorkersAiBindingOrNull(env) !== null;
  const cloudflareAccountApi = hasCloudflareAccountApi(env);
  const cloudflareDns = present(env.CF_API_TOKEN) && present(env.CF_ZONE_ID);
  return {
    workersAi,
    aiGateway: resolveAiGatewayId(env) !== null,
    monthlyCostCap: isMonthlyCostCapAvailable(env),
    cloudflareAccountApi,
    // Self-host: ANALYTICS_SINK="d1" records and reads analytics in D1 (analytics-d1-sink.ts).
    analyticsIngest: !!env.ANALYTICS || isAnalyticsD1SinkEnabled(env),
    analyticsQuery: cloudflareAccountApi || isAnalyticsD1SinkEnabled(env),
    artifacts: isArtifactsAvailable(env),
    containerRuntime: hasContainerRuntime(env),
    guidedCredentialSetup: isGuidedCredentialSetupAvailable(env),
    // SAM can send its own email (sign-in codes): Cloudflare Email Sending or SMTP.
    emailSending: emailTransportKind(env) !== null,
    // Agent email can arrive here: Cloudflare Email Routing (the binding; an admin still has to
    // run the setup) or the self-hosted sam-mx receiver (agent-email/self-host-inbound.ts).
    inboundAgentEmail: hasInboundAgentEmail(env),
    cloudflareDns,
    // Deployment nodes keep public-IP transport even on a reverse-tunnel box
    // (resolveManagedNodeTransport), so they need what that transport needs: a Cloudflare DNS
    // record per node, an Origin CA certificate and *.apps route records, all through the
    // Cloudflare API with CF_API_TOKEN and CF_ZONE_ID.
    appDeployments: cloudflareDns,
    workersObservability: cloudflareAccountApi,
    r2Presign: resolveR2PresignConfig(env) !== null,
    speechToText: workersAi,
    textToSpeech: workersAi && env.TTS_ENABLED !== 'false',
    liveLogStream: hasLiveLogStream(env),
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
  /** Admin → Logs search (Workers Observability). Off on self-host: logs are read on the box. */
  logSearch: boolean;
  /** Admin → Stream (tail worker). Off on self-host. */
  liveLogStream: boolean;
  /** Whether app deployments can run here (the Deployments page reads it). */
  appDeployments: boolean;
  /**
   * Whether agents can call Cloudflare-hosted models (`run_ai_model`, Workers AI). Profile, skill
   * and project settings hide their model-access field when false, instead of asking for a
   * catalog that answers FEATURE_UNAVAILABLE.
   */
  agentModelCalls: boolean;
}

/**
 * Which speech services an admin pointed at an OpenAI-compatible endpoint (`speech.*` settings,
 * read by `resolveSpeechEndpoint()` in speech-endpoints.ts). Only consulted without the Workers AI
 * binding, so a Cloudflare deployment never reads them.
 */
export interface SpeechEndpointAvailability {
  transcription: boolean;
  synthesis: boolean;
}

const NO_SPEECH_ENDPOINTS: SpeechEndpointAvailability = { transcription: false, synthesis: false };

export function publicPlatformCapabilities(
  env: CapabilityEnv,
  speechEndpoints: SpeechEndpointAvailability = NO_SPEECH_ENDPOINTS
): PublicPlatformCapabilities {
  const capabilities = resolvePlatformCapabilities(env);
  const ttsAllowed = env.TTS_ENABLED !== 'false';
  return {
    speechToText: capabilities.speechToText || speechEndpoints.transcription,
    textToSpeech: capabilities.textToSpeech || (ttsAllowed && speechEndpoints.synthesis),
    monthlyCostCap: capabilities.monthlyCostCap,
    logSearch: capabilities.workersObservability,
    liveLogStream: capabilities.liveLogStream,
    appDeployments: capabilities.appDeployments,
    agentModelCalls: capabilities.workersAi,
  };
}

export const APP_DEPLOYMENTS_UNAVAILABLE_MESSAGE =
  'App deployments are not available on this installation. Deployment nodes need Cloudflare DNS ' +
  '(CF_API_TOKEN and CF_ZONE_ID): each one gets a public DNS record, an Origin CA certificate and ' +
  '*.apps routes through the Cloudflare API, and this installation has none configured.';

/** Refuse before any deployment state is written when app deployments cannot work here. */
export function assertAppDeploymentsAvailable(env: CapabilityEnv): void {
  if (!resolvePlatformCapabilities(env).appDeployments) {
    throw errors.featureUnavailable('appDeployments', APP_DEPLOYMENTS_UNAVAILABLE_MESSAGE);
  }
}
