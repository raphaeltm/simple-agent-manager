/**
 * OpenAI-compatible speech endpoints for the self-host build (no Workers AI binding). Settings:
 * `./settings.ts`; the Worker reaches this only through services/speech-backend.ts.
 *
 * Every call goes through `guardedFetch`: the host and each redirect hop are checked, cloud
 * metadata is refused, a private-network host needs the admin's `allowPrivateNetwork` opt-in, and
 * the Bearer key is dropped on any cross-origin hop. Response bodies are never logged: a provider
 * error body can echo the user's audio transcript or text.
 */
import { classifyHost, guardedFetch, maybeJsonRecord } from '@simple-agent-manager/worker-core';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { resolveAdminSettingDetailsMany } from '../../services/admin-settings-resolution';
import { outboundMaxRedirectsValue } from '../../services/outbound-fetch-settings';
import { audioContentType } from '../../services/tts';
import {
  DEFAULT_SPEECH_ENDPOINT_TIMEOUT_MS,
  DEFAULT_SPEECH_SYNTHESIS_MAX_AUDIO_BYTES,
  DEFAULT_SPEECH_TRANSCRIPTION_MAX_RESPONSE_BYTES,
  type SpeechEndpointKind,
  speechSettingName,
  validSpeechBaseUrl,
} from './settings';

export interface SpeechEndpoint {
  kind: SpeechEndpointKind;
  /** Base URL without a trailing slash. */
  baseUrl: string;
  apiKey: string | null;
  model: string;
  /** Synthesis only. */
  voice: string | null;
  allowPrivateNetwork: boolean;
  maxRedirects: number;
  /** Per-request budget (`speech.endpointTimeoutMs`). */
  timeoutMs: number;
  maxAudioBytes: number;
  maxTranscriptionResponseBytes: number;
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

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The configured endpoint, or null without a base URL, model (or synthesis voice), when the
 * settings cannot be read, or when its host is private and the admin has not opted in. Null keeps
 * the feature off, as on an installation that never set it up.
 */
export async function resolveSpeechEndpoint(
  env: Env,
  kind: SpeechEndpointKind
): Promise<SpeechEndpoint | null> {
  let values: unknown[];
  try {
    const details = await resolveAdminSettingDetailsMany(env, [
      speechSettingName(kind, 'baseUrl'),
      speechSettingName(kind, 'apiKey'),
      speechSettingName(kind, 'model'),
      speechSettingName(kind, 'allowPrivateNetwork'),
      speechSettingName('synthesis', 'voice'),
      speechSettingName(null, 'endpointTimeoutMs'),
      'outbound.maxRedirects',
      speechSettingName('synthesis', 'maxAudioBytes'),
      speechSettingName('transcription', 'maxResponseBytes'),
    ]);
    values = details.map((detail) => detail.value);
  } catch (err) {
    log.warn('speech_endpoint.settings_unreadable', {
      kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const [
    baseUrl,
    apiKey,
    model,
    allowPrivate,
    voice,
    timeout,
    maxRedirects,
    maxAudioBytes,
    maxTranscriptionResponseBytes,
  ] = values;
  const modelId = stringValue(model);
  if (!validSpeechBaseUrl(kind, baseUrl) || !modelId) return null;
  if (kind === 'synthesis' && !stringValue(voice)) return null;
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
    voice: kind === 'synthesis' ? stringValue(voice) : null,
    allowPrivateNetwork,
    maxRedirects: outboundMaxRedirectsValue(maxRedirects),
    maxAudioBytes:
      typeof maxAudioBytes === 'number' && Number.isInteger(maxAudioBytes) && maxAudioBytes > 0
        ? maxAudioBytes
        : DEFAULT_SPEECH_SYNTHESIS_MAX_AUDIO_BYTES,
    maxTranscriptionResponseBytes:
      typeof maxTranscriptionResponseBytes === 'number' &&
      Number.isInteger(maxTranscriptionResponseBytes) &&
      maxTranscriptionResponseBytes > 0
        ? maxTranscriptionResponseBytes
        : DEFAULT_SPEECH_TRANSCRIPTION_MAX_RESPONSE_BYTES,
    timeoutMs:
      typeof timeout === 'number' && Number.isInteger(timeout) && timeout > 0
        ? timeout
        : DEFAULT_SPEECH_ENDPOINT_TIMEOUT_MS,
  };
}

async function send(endpoint: SpeechEndpoint, path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (endpoint.apiKey) headers.set('Authorization', `Bearer ${endpoint.apiKey}`);
  const response = await guardedFetch(
    `${endpoint.baseUrl}${path}`,
    { ...init, headers, signal: AbortSignal.timeout(endpoint.timeoutMs) },
    { allowPrivateNetwork: endpoint.allowPrivateNetwork, maxRedirects: endpoint.maxRedirects }
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
  const response = await send(endpoint, '/audio/transcriptions', { method: 'POST', body: form });
  const bytes = await readSpeechResponse(response, endpoint.maxTranscriptionResponseBytes);
  // Parse only the bounded buffer; invalid provider JSON must not leak its contents in errors.
  const payload = maybeJsonRecord(await new Response(bytes).json().catch(() => null));
  if (typeof payload?.text !== 'string') {
    throw new SpeechEndpointError(
      'transcription',
      response.status,
      'The transcription endpoint returned no text'
    );
  }
  return payload.text;
}

/** Synthesize one chunk: JSON POST `<baseUrl>/audio/speech`, returns the audio bytes. */
export async function synthesizeWithEndpoint(
  endpoint: SpeechEndpoint,
  text: string,
  format: string,
  maxBytes = endpoint.maxAudioBytes
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
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  const aliases: Readonly<Record<string, string>> = {
    'audio/mp3': 'audio/mpeg',
    'audio/x-wav': 'audio/wav',
    'audio/x-flac': 'audio/flac',
  };
  const declared = contentType ? (aliases[contentType] ?? contentType) : null;
  if (
    declared &&
    declared !== 'application/octet-stream' &&
    declared !== audioContentType(format)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new SpeechEndpointError(
      'synthesis',
      response.status,
      'The synthesis endpoint returned an unexpected audio content type'
    );
  }
  return readSpeechResponse(response, maxBytes);
}

/** Bound actual streamed bytes even when Content-Length is absent or untruthful. */
async function readSpeechResponse(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const reader = response.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get('content-length')) > maxBytes) {
      throw new Error('Speech response exceeds configured byte limit');
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Speech response exceeds configured byte limit');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes.buffer;
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  } finally {
    reader.releaseLock();
  }
}
