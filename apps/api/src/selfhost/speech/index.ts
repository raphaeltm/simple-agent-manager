/**
 * The self-host build's speech backend: speech-to-text and read-aloud through admin-configured
 * OpenAI-compatible endpoints, on a runtime without Workers AI. Imported only by the self-host
 * entry, which calls `installSpeechEndpoints()` once before any request; the shared Worker entry
 * (`src/index.ts`) never imports this directory, so the Cloudflare bundle does not contain it.
 */
import type { Env } from '../../env';
import {
  checkRateLimit,
  createRateLimitKey,
  DEFAULT_WINDOW_SECONDS,
  getCurrentWindowStart,
  RateLimitError,
} from '../../middleware/rate-limit';
import { installAdminSettingDefinitions } from '../../services/admin-settings-registry';
import { resolveAdminSettingDetails } from '../../services/admin-settings-resolution';
import {
  installSpeechBackendExtension,
  type SpeechBackendExtension,
  type SpeechSynthesisBackend,
  type SpeechTranscriptionBackend,
} from '../../services/speech-backend';
import {
  resolveSpeechEndpoint,
  type SpeechEndpoint,
  synthesizeWithEndpoint,
  transcribeWithEndpoint,
} from './endpoints';
import {
  DEFAULT_SPEECH_SYNTHESIS_REQUESTS_PER_HOUR,
  SPEECH_ENDPOINT_SETTINGS,
  speechSettingName,
} from './settings';

/** Read-aloud requests per user per hour (`speech.synthesis.maxRequestsPerHour`). */
async function synthesisRequestsPerHour(env: Env): Promise<number> {
  try {
    const { value } = await resolveAdminSettingDetails(
      env,
      speechSettingName('synthesis', 'maxRequestsPerHour')
    );
    return typeof value === 'number' && Number.isInteger(value) && value > 0
      ? value
      : DEFAULT_SPEECH_SYNTHESIS_REQUESTS_PER_HOUR;
  } catch {
    return DEFAULT_SPEECH_SYNTHESIS_REQUESTS_PER_HOUR;
  }
}

function transcriptionBackend(endpoint: SpeechEndpoint): SpeechTranscriptionBackend {
  return { transcribe: (audio) => transcribeWithEndpoint(endpoint, audio) };
}

function synthesisBackend(endpoint: SpeechEndpoint): SpeechSynthesisBackend {
  return {
    // Every request spends the admin's endpoint: bound it per user (KV, per hour).
    admit: async (env, userId) => {
      const window = getCurrentWindowStart(DEFAULT_WINDOW_SECONDS);
      const result = await checkRateLimit(
        env.KV,
        createRateLimitKey('speech-synthesis', userId, window),
        await synthesisRequestsPerHour(env),
        DEFAULT_WINDOW_SECONDS
      );
      if (!result.allowed) {
        throw new RateLimitError(Math.max(1, result.resetAt - Math.floor(Date.now() / 1000)));
      }
    },
    synthesize: (text, encoding) => synthesizeWithEndpoint(endpoint, text, encoding),
  };
}

export const speechEndpointBackend: SpeechBackendExtension = {
  transcription: async (env) => {
    const endpoint = await resolveSpeechEndpoint(env, 'transcription');
    return endpoint ? transcriptionBackend(endpoint) : null;
  },
  synthesis: async (env) => {
    const endpoint = await resolveSpeechEndpoint(env, 'synthesis');
    return endpoint ? synthesisBackend(endpoint) : null;
  },
};

/** Registers the speech settings and backend. Idempotent; call before any request. */
export function installSpeechEndpoints(): void {
  installAdminSettingDefinitions(SPEECH_ENDPOINT_SETTINGS);
  installSpeechBackendExtension(speechEndpointBackend);
}
