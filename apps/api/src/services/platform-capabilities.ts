/**
 * Which platform services this installation actually has.
 *
 * SAM runs on Cloudflare, where every binding below exists, and on Workers-compatible runtimes
 * where some Cloudflare-only services are absent. A caller that depends on one of these services
 * asks this module rather than reading `env.X` directly, so "is it there?" has exactly one answer
 * per service (rules 24 and 74).
 *
 * Each capability is derived from the condition itself: the binding is present and has the
 * method SAM calls, or the operator switch for the service is not off. A Cloudflare deployment
 * with its bindings present resolves every capability to true, so its behaviour does not change.
 */
import type { Env } from '../env';
import { getTTSConfig } from './tts-config';

/** One platform service. The name is also the `feature` field of a FEATURE_UNAVAILABLE error. */
export type PlatformCapability = 'workersAi' | 'speechToText' | 'textToSpeech';

export type PlatformCapabilities = Readonly<Record<PlatformCapability, boolean>>;

type CapabilityEnv = Pick<Env, 'AI' | 'TTS_ENABLED'>;

/** The Workers AI binding, or null when this runtime has none (or it lacks `run`). */
export function getWorkersAiBindingOrNull(env: Pick<Env, 'AI'>): Ai | null {
  const ai: unknown = env.AI;
  if (!ai || typeof (ai as { run?: unknown }).run !== 'function') return null;
  return ai as Ai;
}

/** Resolve every capability from bindings and settings. Pure and synchronous: no I/O. */
export function resolvePlatformCapabilities(env: CapabilityEnv): PlatformCapabilities {
  const workersAi = getWorkersAiBindingOrNull(env) !== null;
  return {
    workersAi,
    // Whisper runs on Workers AI (routes/transcribe.ts).
    speechToText: workersAi,
    // Synthesis runs on Workers AI, and the operator can switch it off (routes/tts.ts).
    textToSpeech: workersAi && getTTSConfig(env).enabled === true,
  };
}

/**
 * What the web client needs to hide entry points that cannot work here. Public: booleans only,
 * no secrets. The web client (apps/web/src/lib/api/platform-capabilities.ts) treats any field it
 * does not receive as available, so fields can be added without breaking older clients.
 */
export interface PublicPlatformCapabilities {
  /** Voice input (mic) in the chat, comment and SAM composers. */
  speechToText: boolean;
  /** Server read-aloud on agent messages and task summaries. */
  textToSpeech: boolean;
  /**
   * Whether agents can call Cloudflare-hosted models (Workers AI). Profile, skill and project
   * settings hide their model-access field when false instead of asking for a catalog that
   * answers FEATURE_UNAVAILABLE.
   */
  agentModelCalls: boolean;
}

export function publicPlatformCapabilities(env: CapabilityEnv): PublicPlatformCapabilities {
  const capabilities = resolvePlatformCapabilities(env);
  return {
    speechToText: capabilities.speechToText,
    textToSpeech: capabilities.textToSpeech,
    agentModelCalls: capabilities.workersAi,
  };
}
