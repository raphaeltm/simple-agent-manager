/**
 * OpenAI-compatible speech endpoints for installations without the Workers AI binding
 * (overnight B3 A4/A5). Settings: `speech-endpoint-settings.ts`.
 *
 * Every call goes through `guardedFetch`: the host and each redirect hop are checked, cloud
 * metadata is refused, and a private-network host needs the admin's `allowPrivateNetwork` opt-in
 * (the same policy as the LLM endpoint, `llm-chat-target.ts`). Response bodies are never logged.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { classifyHost, guardedFetch } from '../lib/network-hosts';
import { resolveAdminSettingDetailsMany } from './admin-settings-resolution';
import { outboundMaxRedirectsValue } from './outbound-fetch-settings';
import {
  getWorkersAiBindingOrNull,
  type PublicPlatformCapabilities,
  publicPlatformCapabilities,
} from './platform-capabilities';
import {
  DEFAULT_SPEECH_ENDPOINT_TIMEOUT_MS,
  type SpeechEndpointKind,
  type SpeechEndpointSettingName,
  validSpeechBaseUrl,
} from './speech-endpoint-settings';

export interface SpeechEndpoint {
  kind: SpeechEndpointKind;
  /** Base URL without a trailing slash. */
  baseUrl: string;
  apiKey: string | null;
  model: string;
  /** Synthesis only. */
  voice: string | null;
  allowPrivateNetwork: boolean;
  maxRedirects?: number;
  /** Per-request budget (`speech.endpointTimeoutMs`). */
  timeoutMs: number;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function names(kind: SpeechEndpointKind): SpeechEndpointSettingName[] {
  const prefix = `speech.${kind}` as const;
  return [
    `${prefix}.baseUrl`,
    `${prefix}.apiKey`,
    `${prefix}.model`,
    `${prefix}.allowPrivateNetwork`,
    ...(kind === 'synthesis' ? (['speech.synthesis.voice'] as const) : []),
  ] as SpeechEndpointSettingName[];
}

/**
 * The configured endpoint, or null when it is not configured (no base URL or no model), when the
 * settings cannot be read, or when its host is private and the admin has not opted in. A null
 * answer keeps the feature off, as on an installation that never set it up.
 */
export async function resolveSpeechEndpoint(
  env: Env,
  kind: SpeechEndpointKind
): Promise<SpeechEndpoint | null> {
  let values: unknown[];
  try {
    const details = await resolveAdminSettingDetailsMany(env, [
      ...names(kind),
      'outbound.maxRedirects',
      'speech.endpointTimeoutMs',
    ]);
    values = details.map((detail) => detail.value);
  } catch (err) {
    log.warn('speech_endpoint.settings_unreadable', {
      kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const [baseUrl, apiKey, model, allowPrivate, ...rest] = values;
  const voice = kind === 'synthesis' ? rest[0] : null;
  const [maxRedirects, timeout] = kind === 'synthesis' ? rest.slice(1) : rest;
  const modelId = stringValue(model);
  if (!validSpeechBaseUrl(kind, baseUrl) || !modelId) return null;
  const normalized = String(baseUrl).trim().replace(/\/+$/, '');
  const allowPrivateNetwork = allowPrivate === true;
  if (!allowPrivateNetwork && classifyHost(new URL(normalized).hostname) === 'private') {
    log.warn('speech_endpoint.private_network_not_allowed', { kind });
    return null;
  }
  return {
    kind,
    baseUrl: normalized,
    apiKey: stringValue(apiKey),
    model: modelId,
    voice: stringValue(voice),
    allowPrivateNetwork,
    maxRedirects: outboundMaxRedirectsValue(maxRedirects),
    timeoutMs:
      typeof timeout === 'number' && Number.isInteger(timeout) && timeout > 0
        ? timeout
        : DEFAULT_SPEECH_ENDPOINT_TIMEOUT_MS,
  };
}

export async function isSpeechEndpointConfigured(
  env: Env,
  kind: SpeechEndpointKind
): Promise<boolean> {
  return (await resolveSpeechEndpoint(env, kind)) !== null;
}

export class SpeechEndpointError extends Error {
  constructor(
    readonly kind: SpeechEndpointKind,
    readonly status: number | null,
    message: string
  ) {
    super(message);
    this.name = 'SpeechEndpointError';
  }
}

async function send(endpoint: SpeechEndpoint, path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (endpoint.apiKey) headers.set('Authorization', `Bearer ${endpoint.apiKey}`);
  const response = await guardedFetch(
    `${endpoint.baseUrl}${path}`,
    { ...init, headers },
    {
      allowPrivateNetwork: endpoint.allowPrivateNetwork,
      maxRedirects: endpoint.maxRedirects,
      deadlineMs: endpoint.timeoutMs,
    }
  );
  if (!response.ok) {
    // Status only: a provider error body can echo the request (audio text, prompt).
    await response.body?.cancel().catch(() => undefined);
    log.warn('speech_endpoint.upstream_error', { kind: endpoint.kind, status: response.status });
    throw new SpeechEndpointError(
      endpoint.kind,
      response.status,
      `The ${endpoint.kind} endpoint answered HTTP ${response.status}`
    );
  }
  return response;
}

/** Transcribe one recording: multipart POST `<baseUrl>/audio/transcriptions`, returns its text. */
export async function transcribeWithEndpoint(
  endpoint: SpeechEndpoint,
  audio: File
): Promise<string> {
  const form = new FormData();
  form.set('file', audio, audio.name || 'audio.webm');
  form.set('model', endpoint.model);
  form.set('response_format', 'json');
  const response = await send(endpoint, '/audio/transcriptions', {
    method: 'POST',
    body: form,
  });
  const payload: unknown = await response.json().catch(() => null);
  const text =
    payload &&
    typeof payload === 'object' &&
    typeof (payload as { text?: unknown }).text === 'string'
      ? (payload as { text: string }).text
      : null;
  if (text === null) {
    throw new SpeechEndpointError(
      'transcription',
      response.status,
      'The transcription endpoint returned no text'
    );
  }
  return text;
}

/** Synthesize one chunk: JSON POST `<baseUrl>/audio/speech`, returns the audio bytes. */
export async function synthesizeWithEndpoint(
  endpoint: SpeechEndpoint,
  text: string,
  format: string
): Promise<ArrayBuffer> {
  const response = await send(endpoint, '/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: endpoint.model,
      input: text,
      response_format: format,
      ...(endpoint.voice ? { voice: endpoint.voice } : {}),
    }),
  });
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw new SpeechEndpointError(
      'synthesis',
      response.status,
      'The speech endpoint returned no audio'
    );
  }
  return buffer;
}

/**
 * The public capabilities with speech endpoints applied (`publicPlatformCapabilities()`). With the
 * Workers AI binding no speech setting is read, so Cloudflare answers exactly as before.
 */
export async function resolvePublicPlatformCapabilities(
  env: Env
): Promise<PublicPlatformCapabilities> {
  if (getWorkersAiBindingOrNull(env)) return publicPlatformCapabilities(env);
  const [transcription, synthesis] = await Promise.all([
    isSpeechEndpointConfigured(env, 'transcription'),
    isSpeechEndpointConfigured(env, 'synthesis'),
  ]);
  return publicPlatformCapabilities(env, { transcription, synthesis });
}
