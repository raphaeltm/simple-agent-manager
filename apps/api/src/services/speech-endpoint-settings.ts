/**
 * Admin settings for OpenAI-compatible speech endpoints: speech-to-text
 * (`<baseUrl>/audio/transcriptions`) and text-to-speech (`<baseUrl>/audio/speech`), for an
 * installation without the Workers AI binding (overnight B3 A4/A5). Hosted OpenAI, Groq, or a
 * server on the box such as speaches or Kokoro-FastAPI.
 *
 * Nothing changes until an admin sets a base URL and a model. Keys are stored encrypted in
 * `platform_credentials` like the LLM endpoint key. Only type imports and pure validators here, so
 * the settings registry imports no resolution code.
 */
import { isAcceptableOperatorEndpoint } from '../lib/network-hosts';
import {
  type AdminSettingDefinition,
  type AdminSettingName,
  integerDefinition,
  MIN_SECRET_SETTING_LENGTH,
} from './admin-setting-definitions';

export type SpeechEndpointKind = 'transcription' | 'synthesis';

const COMMON_KEYS = ['baseUrl', 'apiKey', 'model', 'allowPrivateNetwork'] as const;
type CommonKey = (typeof COMMON_KEYS)[number];

export type SpeechEndpointSettingName =
  | `speech.transcription.${CommonKey}`
  | `speech.synthesis.${CommonKey | 'voice'}`
  | 'speech.endpointTimeoutMs';

/** Default per-request budget for a speech endpoint call (`speech.endpointTimeoutMs`). */
export const DEFAULT_SPEECH_ENDPOINT_TIMEOUT_MS = 60_000;

const MAX_API_KEY_LENGTH = 4096;
const MAX_ID_LENGTH = 200;

const ROUTE_SUFFIX: Readonly<Record<SpeechEndpointKind, RegExp>> = {
  transcription: /\/audio\/transcriptions\/?$/,
  synthesis: /\/audio\/speech\/?$/,
};

/**
 * An OpenAI-compatible base URL such as `https://api.openai.com/v1`: HTTPS to any host but a
 * metadata or link-local one, plain HTTP only to a private-network host (`isAcceptableOperatorEndpoint`,
 * the same rule as `llm.openAICompatible.baseUrl`). SAM appends the route itself.
 */
export function validSpeechBaseUrl(kind: SpeechEndpointKind, value: unknown): boolean {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 2048) return false;
  try {
    const url = new URL(value.trim());
    return isAcceptableOperatorEndpoint(url) && !ROUTE_SUFFIX[kind].test(url.pathname);
  } catch {
    return false;
  }
}

function validId(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= MAX_ID_LENGTH &&
    !/\s/.test(value.trim())
  );
}

const LABEL: Readonly<Record<SpeechEndpointKind, string>> = {
  transcription: 'speech-to-text (the chat microphone; POST <baseUrl>/audio/transcriptions)',
  synthesis: 'server read-aloud (POST <baseUrl>/audio/speech)',
};

function definition(kind: SpeechEndpointKind, key: CommonKey | 'voice'): AdminSettingDefinition {
  const name = `speech.${kind}.${key}` as AdminSettingName;
  const base = {
    name,
    type: 'string' as const,
    defaultValue: null,
    category: 'AI models' as const,
    secret: false,
    risky: false,
  };
  switch (key) {
    case 'baseUrl':
      return {
        ...base,
        description: `OpenAI-compatible base URL for ${LABEL[kind]}, for example https://api.openai.com/v1. Used only where Cloudflare Workers AI is not available. Needs a model too. Empty keeps the feature off.`,
        // Sends users' audio or text to this endpoint.
        risky: true,
        validate: (value) => validSpeechBaseUrl(kind, value),
      };
    case 'apiKey':
      return {
        ...base,
        description: `API key sent as a Bearer token to the ${kind} endpoint. Optional.`,
        secret: true,
        risky: true,
        credential: { provider: `speech-${kind}`, kind: 'api-key' },
        validate: (value) =>
          typeof value === 'string' &&
          value.trim().length >= MIN_SECRET_SETTING_LENGTH &&
          value.length <= MAX_API_KEY_LENGTH,
      };
    case 'model':
      return {
        ...base,
        description:
          kind === 'transcription'
            ? 'Speech-to-text model id on the endpoint (for example gpt-4o-mini-transcribe, whisper-large-v3, Systran/faster-whisper-small).'
            : 'Text-to-speech model id on the endpoint (for example tts-1, kokoro).',
        validate: validId,
      };
    case 'voice':
      return {
        ...base,
        description:
          'Voice id on the text-to-speech endpoint (for example alloy, af_heart). Optional.',
        validate: validId,
      };
    case 'allowPrivateNetwork':
      return {
        ...base,
        type: 'boolean',
        defaultValue: false,
        risky: true,
        description: `Let SAM call a ${kind} endpoint on this machine or its private network (loopback, 10/8, 172.16/12, 192.168/16, a Docker service name). Off: such a base URL is refused when used. Cloud metadata addresses are refused either way.`,
        validate: (value) => typeof value === 'boolean',
      };
  }
}

export const SPEECH_ENDPOINT_SETTINGS: readonly AdminSettingDefinition[] = [
  ...COMMON_KEYS.map((key) => definition('transcription', key)),
  ...COMMON_KEYS.map((key) => definition('synthesis', key)),
  definition('synthesis', 'voice'),
  integerDefinition(
    'speech.endpointTimeoutMs',
    DEFAULT_SPEECH_ENDPOINT_TIMEOUT_MS,
    'AI models',
    'Milliseconds SAM waits for one speech endpoint request (a recording to transcribe, or one chunk of read-aloud audio) before giving up.',
    { min: 1_000, max: 600_000 }
  ),
];
