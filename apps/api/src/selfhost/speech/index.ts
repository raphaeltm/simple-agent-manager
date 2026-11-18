/**
 * The self-host build's speech backend: speech-to-text and read-aloud through admin-configured
 * OpenAI-compatible endpoints, on a runtime without Workers AI. Imported only by the self-host
 * entry, which calls `installSpeechEndpoints()` once before any request; the shared Worker entry
 * (`src/index.ts`) never imports this directory, so the Cloudflare bundle does not contain it.
 */
import type { Env } from '../../env';
import { errors } from '../../middleware/error';
import {
  checkAiSpendRateLimit,
  DEFAULT_WINDOW_SECONDS,
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
  // A fresh backend is resolved per request. Bound combined payload bytes across chunks;
  // concatenation retains those buffers plus one final copy (up to twice this payload cap).
  let audioBytes = 0;
  return {
    // Paid endpoint admission must retain every concurrent increment (D1, per hour).
    admit: async (env, userId) => {
      const limit = await synthesisRequestsPerHour(env);
      const result = await checkAiSpendRateLimit(
        env.DATABASE, 'speech-synthesis', userId, limit, DEFAULT_WINDOW_SECONDS
      ).catch(() => {
        throw errors.serviceUnavailable('Speech rate limit unavailable. Try again shortly.');
      });
      if (!result.allowed) {
        throw new RateLimitError(Math.max(1, result.resetAt - Math.floor(Date.now() / 1000)));
      }
    },
    synthesize: async (text, encoding) => {
      const remaining = endpoint.maxAudioBytes - audioBytes;
      if (remaining <= 0) throw new Error('Speech response exceeds configured byte limit');
      const audio = await synthesizeWithEndpoint(endpoint, text, encoding, remaining);
      audioBytes += audio.byteLength;
      return audio;
    },
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
