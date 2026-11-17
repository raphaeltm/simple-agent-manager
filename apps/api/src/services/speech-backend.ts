/**
 * Speech seam: where speech-to-text and read-aloud go when this runtime has no Workers AI binding.
 *
 * On Cloudflare the binding is present, nothing is installed here, and the speech routes behave
 * exactly as before: no setting is read and no extra I/O happens per call. Only the self-host
 * build installs a backend (`apps/api/src/selfhost/speech/`, an OpenAI-compatible endpoint the
 * admin configures). The shared Worker entry never imports that module, so the Cloudflare bundle
 * does not contain it.
 */
import type { Env } from '../env';
import {
  getWorkersAiBindingOrNull,
  type PublicPlatformCapabilities,
  publicPlatformCapabilities,
} from './platform-capabilities';
import { getTTSConfig } from './tts-config';

/** Transcribes one recording. Throws on failure; the route turns that into a 503. */
export interface SpeechTranscriptionBackend {
  transcribe(audio: File): Promise<string>;
}

export interface SpeechSynthesisBackend {
  /**
   * Throws an AppError (for example a rate limit) when this user may not synthesize now. The
   * route calls it once per read-aloud request, before any audio is generated.
   */
  admit(env: Env, userId: string): Promise<void>;
  /** Synthesizes one chunk of plain text into audio in `encoding` (mp3, wav, ...). */
  synthesize(text: string, encoding: string): Promise<ArrayBuffer>;
}

export interface SpeechBackendExtension {
  /** The configured backend, or null when the installation has not set one up. */
  transcription(env: Env): Promise<SpeechTranscriptionBackend | null>;
  /** The configured backend, or null when the installation has not set one up. */
  synthesis(env: Env): Promise<SpeechSynthesisBackend | null>;
}

let extension: SpeechBackendExtension | undefined;

/** Called once by the self-host entry, before any request runs. */
export function installSpeechBackendExtension(value: SpeechBackendExtension): void {
  if (extension && extension !== value) {
    throw new Error('A speech backend extension is already installed');
  }
  extension = value;
}

/** Test seam: removes the installed extension. */
export function resetSpeechBackendExtensionForTests(): void {
  extension = undefined;
}

/** Null without reading anything when the Workers AI binding exists or nothing is installed. */
export async function resolveSpeechTranscriptionBackend(
  env: Env
): Promise<SpeechTranscriptionBackend | null> {
  if (getWorkersAiBindingOrNull(env) || !extension) return null;
  return extension.transcription(env);
}

/** Null without reading anything when the Workers AI binding exists or nothing is installed. */
export async function resolveSpeechSynthesisBackend(
  env: Env
): Promise<SpeechSynthesisBackend | null> {
  if (getWorkersAiBindingOrNull(env) || !extension) return null;
  return extension.synthesis(env);
}

/**
 * `publicPlatformCapabilities()` plus an installed speech backend. With the Workers AI binding,
 * or with nothing installed, this is the synchronous answer unchanged and reads nothing.
 */
export async function resolvePublicPlatformCapabilities(
  env: Env
): Promise<PublicPlatformCapabilities> {
  const base = publicPlatformCapabilities(env);
  if (getWorkersAiBindingOrNull(env) || !extension) return base;
  const backend = extension;
  const [transcription, synthesis] = await Promise.all([
    backend.transcription(env).catch(() => null),
    getTTSConfig(env).enabled === true
      ? backend.synthesis(env).catch(() => null)
      : Promise.resolve(null),
  ]);
  return {
    ...base,
    speechToText: base.speechToText || transcription !== null,
    textToSpeech: base.textToSpeech || synthesis !== null,
  };
}
