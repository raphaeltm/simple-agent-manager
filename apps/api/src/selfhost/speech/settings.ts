/**
 * Admin settings for the self-host build's OpenAI-compatible speech endpoints: speech-to-text
 * (`<baseUrl>/audio/transcriptions`) and read-aloud (`<baseUrl>/audio/speech`), used where the
 * runtime has no Workers AI binding. Hosted OpenAI, Groq, or a server on the box such as speaches
 * or Kokoro-FastAPI.
 *
 * Only the self-host entry registers these (`installSpeechEndpoints`), so a Cloudflare admin
 * never sees them. Nothing changes until an admin sets a base URL and a model. Keys are stored
 * encrypted in `platform_credentials` like the LLM endpoint key.
 */
import { classifyHost } from '@simple-agent-manager/worker-core';

import {
  type AdminSettingDefinition,
  type AdminSettingName,
  integerDefinition,
} from '../../services/admin-setting-definitions';

export type SpeechEndpointKind = 'transcription' | 'synthesis';

const COMMON_KEYS = ['baseUrl', 'apiKey', 'model', 'allowPrivateNetwork'] as const;
type CommonKey = (typeof COMMON_KEYS)[number];

/** Default per-request budget for one speech endpoint call (`speech.endpointTimeoutMs`). */
export const DEFAULT_SPEECH_ENDPOINT_TIMEOUT_MS = 60_000;

/**
 * Default read-aloud requests per user per hour that reach the endpoint
 * (`speech.synthesis.maxRequestsPerHour`). Each one spends the admin's endpoint.
 */
export const DEFAULT_SPEECH_SYNTHESIS_REQUESTS_PER_HOUR = 120;

const MAX_URL_LENGTH = 2048;
const MAX_API_KEY_LENGTH = 4096;
const MIN_API_KEY_LENGTH = 8;
const MAX_ID_LENGTH = 200;

const ROUTE_SUFFIX: Readonly<Record<SpeechEndpointKind, RegExp>> = {
  transcription: /\/audio\/transcriptions\/?$/,
  synthesis: /\/audio\/speech\/?$/,
};

/** These names exist only in the self-host build, so they are not in the shared name union. */
export function speechSettingName(kind: SpeechEndpointKind | null, key: string): AdminSettingName {
  return (kind ? `speech.${kind}.${key}` : `speech.${key}`) as AdminSettingName;
}

/**
 * An OpenAI-compatible base URL such as `https://api.openai.com/v1`: HTTPS to any host but a
 * metadata or link-local one, plain HTTP only to a private-network host, so the API key never
 * crosses the internet unencrypted (the rule `llm.openAICompatible.baseUrl` uses). No
 * credentials, query or fragment: SAM appends the route itself.
 */
export function validSpeechBaseUrl(kind: SpeechEndpointKind, value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_URL_LENGTH) return false;
  try {
    const url = new URL(value.trim());
    const hostClass = classifyHost(url.hostname);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      hostClass !== 'forbidden' &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && hostClass === 'private')) &&
      !ROUTE_SUFFIX[kind].test(url.pathname)
    );
  } catch {
    return false;
  }
}

function validId(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_ID_LENGTH && !/\s/.test(trimmed);
}

const LABEL: Readonly<Record<SpeechEndpointKind, string>> = {
  transcription: 'speech-to-text (the chat microphone; POST <baseUrl>/audio/transcriptions)',
  synthesis: 'server read-aloud (POST <baseUrl>/audio/speech)',
};

function definition(kind: SpeechEndpointKind, key: CommonKey | 'voice'): AdminSettingDefinition {
  const base = {
    name: speechSettingName(kind, key),
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
        description: `OpenAI-compatible base URL for ${LABEL[kind]}, for example https://api.openai.com/v1. Needs a model too. Empty keeps the feature off.`,
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
          value.trim().length >= MIN_API_KEY_LENGTH &&
          value.length <= MAX_API_KEY_LENGTH,
      };
    case 'model':
      return {
        ...base,
        description:
          kind === 'transcription'
            ? 'Speech-to-text model id on the endpoint (for example gpt-4o-mini-transcribe, whisper-large-v3).'
            : 'Text-to-speech model id on the endpoint (for example tts-1, kokoro).',
        validate: validId,
      };
    case 'voice':
      return {
        ...base,
        description: 'Voice id on the text-to-speech endpoint (for example alloy). Optional.',
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
    speechSettingName(null, 'endpointTimeoutMs'),
    DEFAULT_SPEECH_ENDPOINT_TIMEOUT_MS,
    'AI models',
    'Milliseconds SAM waits for one speech endpoint request (a recording to transcribe, or one chunk of read-aloud audio) before giving up.',
    { min: 1_000, max: 600_000 }
  ),
  integerDefinition(
    speechSettingName('synthesis', 'maxRequestsPerHour'),
    DEFAULT_SPEECH_SYNTHESIS_REQUESTS_PER_HOUR,
    'AI models',
    'Read-aloud requests per user per hour on an installation using the text-to-speech endpoint. Every request counts, including ones answered from cached audio.',
    { min: 1, max: 100_000 }
  ),
];
