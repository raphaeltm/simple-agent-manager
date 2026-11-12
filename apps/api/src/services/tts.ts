/**
 * Text-to-Speech Service
 *
 * Reusable TTS pipeline using Cloudflare Workers AI:
 *   1. Clean markdown/code from text via LLM (with retry)
 *   2. Split long text into chunks at sentence boundaries
 *   3. Generate speech audio per chunk via TTS model (with retry + per-chunk R2 caching)
 *   4. Concatenate chunks and cache final audio in R2
 *
 * Architecture:
 *   Text (markdown) → LLM cleanup → plain text → chunk → TTS model × N → concat → R2 storage
 *
 * For very long texts (above summary threshold), the service summarizes
 * the content via LLM before converting to speech.
 *
 * The service is designed to be reusable across different contexts
 * (message read-aloud, notification audio, etc.) by accepting a
 * storage key that callers can derive from their domain (e.g., messageId).
 */

import {
  DEFAULT_TTS_CHUNK_SIZE,
  DEFAULT_TTS_ENCODING,
  DEFAULT_TTS_MAX_CHUNKS,
  DEFAULT_TTS_MAX_TEXT_LENGTH,
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_R2_PREFIX,
  DEFAULT_TTS_RETRY_ATTEMPTS,
  DEFAULT_TTS_RETRY_BASE_DELAY_MS,
  DEFAULT_TTS_SPEAKER,
  DEFAULT_TTS_SUMMARY_THRESHOLD,
  DEFAULT_TTS_TIMEOUT_MS,
} from '@simple-agent-manager/shared';

import { log } from '../lib/logger';
import { type SpeechEndpoint, synthesizeWithEndpoint } from './speech-endpoints';
import { retryWithBackoff, type TTSConfig } from './tts-config';
import {
  cleanTextForSpeech,
  fallbackStripMarkdown,
  splitTextIntoChunks,
  summarizeTextForSpeech,
} from './tts-text';

export { getTTSConfig, retryWithBackoff, type TTSConfig, type TTSEnvVars } from './tts-config';
export {
  cleanTextForSpeech,
  fallbackStripMarkdown,
  splitTextIntoChunks,
  summarizeTextForSpeech,
} from './tts-text';

/**
 * Where audio comes from: the Workers AI binding, or an admin-configured OpenAI-compatible speech
 * endpoint (`speech.synthesis.*`) on an installation without it (overnight B3 A5).
 */
export type SpeechAudioSource = Ai | SpeechEndpoint;

function isSpeechEndpoint(source: SpeechAudioSource): source is SpeechEndpoint {
  return (source as SpeechEndpoint).kind === 'synthesis';
}

// ─── Audio Generation ────────────────────────────────────────────────────────

/**
 * Generate speech audio for a single chunk of plain text using Workers AI TTS.
 * Retries with exponential backoff on failure.
 * Returns raw audio bytes as an ArrayBuffer.
 */
export async function generateSpeechAudioChunk(
  text: string,
  ai: SpeechAudioSource,
  config: TTSConfig = {}
): Promise<ArrayBuffer> {
  if (isSpeechEndpoint(ai)) {
    const encoding = config.encoding ?? DEFAULT_TTS_ENCODING;
    return retryWithBackoff(
      () => synthesizeWithEndpoint(ai, text, encoding),
      config.retryAttempts ?? DEFAULT_TTS_RETRY_ATTEMPTS,
      config.retryBaseDelayMs ?? DEFAULT_TTS_RETRY_BASE_DELAY_MS,
      'tts_endpoint_chunk'
    );
  }
  const model = config.model ?? DEFAULT_TTS_MODEL;
  const speaker = config.speaker ?? DEFAULT_TTS_SPEAKER;
  const encoding = config.encoding ?? DEFAULT_TTS_ENCODING;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;
  const retryAttempts = config.retryAttempts ?? DEFAULT_TTS_RETRY_ATTEMPTS;
  const retryBaseDelayMs = config.retryBaseDelayMs ?? DEFAULT_TTS_RETRY_BASE_DELAY_MS;

  const startTime = Date.now();

  const audioBuffer = await retryWithBackoff(
    async () => {
      // Use returnRawResponse to get streaming audio bytes
      // Save timeout handle so we can clear it on the winning path to avoid timer leaks
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`TTS generation timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      });

      const response = await Promise.race([
        ai.run(model as Parameters<typeof ai.run>[0], { text, speaker, encoding } as never, {
          returnRawResponse: true,
        }),
        timeoutPromise,
      ]);
      clearTimeout(timeoutHandle);

      // The response is a standard Response object when returnRawResponse is true
      const rawResponse = response as unknown as Response;
      if (typeof rawResponse.ok !== 'boolean') {
        throw new Error(`TTS model did not return a Response (got ${typeof response})`);
      }
      if (!rawResponse.ok) {
        const errorText = await rawResponse.text().catch(() => 'unknown');
        throw new Error(`TTS model returned ${rawResponse.status}: ${errorText}`);
      }

      const buffer = await rawResponse.arrayBuffer();
      if (buffer.byteLength === 0) {
        throw new Error('TTS model returned empty audio buffer');
      }
      return buffer;
    },
    retryAttempts,
    retryBaseDelayMs,
    'tts_chunk'
  );

  const durationMs = Date.now() - startTime;

  log.info('tts.chunk_generated', {
    model,
    speaker,
    encoding,
    textLength: text.length,
    audioBytes: audioBuffer.byteLength,
    durationMs,
  });

  return audioBuffer;
}

/**
 * Generate speech audio from plain text, splitting into chunks if needed.
 * Uses per-chunk R2 caching when an R2 bucket is provided — cached chunks
 * are skipped, and only missing chunks are generated.
 * Concatenates chunk audio buffers into a single ArrayBuffer.
 */
export async function generateSpeechAudio(
  text: string,
  ai: SpeechAudioSource,
  config: TTSConfig = {},
  r2?: R2Bucket,
  storageId?: string,
  userId?: string
): Promise<ArrayBuffer> {
  const chunkSize = config.chunkSize ?? DEFAULT_TTS_CHUNK_SIZE;
  const maxChunks = config.maxChunks ?? DEFAULT_TTS_MAX_CHUNKS;
  const chunks = splitTextIntoChunks(text, chunkSize);

  if (chunks.length === 1) {
    const [chunk] = chunks;
    if (chunk === undefined) {
      throw new Error('Internal error: expected exactly one text chunk');
    }
    return generateSpeechAudioChunk(chunk, ai, config);
  }

  // Guard against CPU time exhaustion on Workers runtime
  if (chunks.length > maxChunks) {
    log.warn('tts.chunk_limit_exceeded', {
      chunkCount: chunks.length,
      maxChunks,
      textLength: text.length,
    });
    throw new Error(
      `Text produces ${chunks.length} chunks, exceeding limit of ${maxChunks}. ` +
        `Use summary mode or reduce text length.`
    );
  }

  log.info('tts.chunked_generation_start', {
    totalLength: text.length,
    chunkCount: chunks.length,
    chunkSize,
  });

  // Generate audio for each chunk sequentially to avoid rate limiting
  const audioBuffers: ArrayBuffer[] = [];
  for (const [i, chunkText] of chunks.entries()) {
    // Try per-chunk R2 cache first
    if (r2 && storageId && userId) {
      const chunkKey = buildChunkR2Key(storageId, userId, i, chunkText, config);
      const cachedChunk = await r2.get(chunkKey);
      if (cachedChunk) {
        const cachedBuffer = await cachedChunk.arrayBuffer();
        audioBuffers.push(cachedBuffer);
        log.info('tts.chunk_cache_hit', {
          chunkIndex: i + 1,
          totalChunks: chunks.length,
          chunkKey,
          audioBytes: cachedBuffer.byteLength,
        });
        continue;
      }
    }

    const buffer = await generateSpeechAudioChunk(chunkText, ai, config);
    audioBuffers.push(buffer);

    // Store individual chunk in R2 for future partial recovery
    if (r2 && storageId && userId) {
      const chunkKey = buildChunkR2Key(storageId, userId, i, chunkText, config);
      const encoding = config.encoding ?? DEFAULT_TTS_ENCODING;
      await r2
        .put(chunkKey, buffer, {
          httpMetadata: { contentType: audioContentType(encoding) },
        })
        .catch((err) => {
          // Non-fatal: chunk caching failure shouldn't abort generation
          log.warn('tts.chunk_cache_store_failed', {
            chunkKey,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    log.info('tts.chunk_progress', {
      chunkIndex: i + 1,
      totalChunks: chunks.length,
      chunkTextLength: chunkText.length,
      chunkAudioBytes: buffer.byteLength,
    });
  }

  // Concatenate all audio buffers
  const concatenated = concatenateArrayBuffers(audioBuffers);

  // Best-effort cleanup of per-chunk R2 objects now that final audio will be stored.
  // Chunks are only needed for retry recovery during generation; the final concatenated
  // audio is what getAudioFromR2 serves.
  if (r2 && storageId && userId) {
    const chunkKeys = chunks.map((chunkText, i) =>
      buildChunkR2Key(storageId, userId, i, chunkText, config)
    );
    await Promise.allSettled(chunkKeys.map((key) => r2.delete(key))).catch(() => {
      // Non-fatal: cleanup failure doesn't affect the result
    });
  }

  log.info('tts.chunked_generation_complete', {
    totalLength: text.length,
    chunkCount: chunks.length,
    totalAudioBytes: concatenated.byteLength,
  });

  return concatenated;
}

/**
 * Concatenate multiple ArrayBuffers into a single ArrayBuffer.
 *
 * For MP3: Each MP3 frame is self-contained with its own sync header.
 * Most decoders (including browser <audio>) handle concatenated MP3 frames
 * correctly, treating each frame independently. Duration reporting may be
 * approximate since it's typically estimated from file size and first frame's
 * bitrate. This is acceptable for TTS audio where exact seek precision is
 * not critical.
 */
export function concatenateArrayBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
  const totalLength = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of buffers) {
    result.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  return result.buffer;
}

// ─── R2 Storage ──────────────────────────────────────────────────────────────

/** Build the R2 object key for a TTS audio file, scoped by userId. */
export function buildR2Key(storageId: string, userId: string, config: TTSConfig = {}): string {
  const prefix = config.r2Prefix ?? DEFAULT_TTS_R2_PREFIX;
  const encoding = config.encoding ?? DEFAULT_TTS_ENCODING;
  return `${prefix}/${userId}/${storageId}.${encoding}`;
}

/** Build the R2 object key for an individual TTS chunk, keyed by text hash. */
export function buildChunkR2Key(
  storageId: string,
  userId: string,
  chunkIndex: number,
  chunkText: string,
  config: TTSConfig = {}
): string {
  const prefix = config.r2Prefix ?? DEFAULT_TTS_R2_PREFIX;
  const encoding = config.encoding ?? DEFAULT_TTS_ENCODING;
  const hash = simpleHash(chunkText);
  return `${prefix}/${userId}/${storageId}_chunk_${chunkIndex}_${hash}.${encoding}`;
}

/**
 * Simple non-cryptographic hash for chunk cache keys.
 * Uses djb2 algorithm — fast and sufficient for cache key uniqueness.
 */
export function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** Content-Type mapping for audio encodings. */
function audioContentType(encoding: string): string {
  const types: Record<string, string> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    aac: 'audio/aac',
    opus: 'audio/opus',
  };
  return types[encoding] ?? 'audio/mpeg';
}

/** Check if audio already exists in R2. */
export async function getAudioFromR2(
  r2: R2Bucket,
  storageId: string,
  userId: string,
  config: TTSConfig = {}
): Promise<R2ObjectBody | null> {
  const key = buildR2Key(storageId, userId, config);
  return r2.get(key);
}

/** Store audio bytes in R2. */
export async function storeAudioInR2(
  r2: R2Bucket,
  storageId: string,
  userId: string,
  audio: ArrayBuffer,
  config: TTSConfig = {}
): Promise<void> {
  const key = buildR2Key(storageId, userId, config);
  const encoding = config.encoding ?? DEFAULT_TTS_ENCODING;
  await r2.put(key, audio, {
    httpMetadata: {
      contentType: audioContentType(encoding),
    },
  });
  log.info('tts.audio_stored', { key, bytes: audio.byteLength });
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export type TTSMode = 'full' | 'summary';

export interface SynthesizeResult {
  audioBody: ReadableStream | ArrayBuffer;
  contentType: string;
  cached: boolean;
  summarized: boolean;
}

/**
 * Full TTS pipeline: check cache → decide mode → clean/summarize text → chunk → generate audio → store → return.
 *
 * @param text - The raw text (possibly with markdown) to synthesize
 * @param storageId - Unique identifier for R2 caching (e.g., messageId)
 * @param ai - Workers AI binding
 * @param r2 - R2 bucket binding
 * @param config - Optional TTS configuration overrides
 * @param userId - User ID for R2 key scoping
 * @param mode - "full" to read verbatim (with chunking), "summary" to summarize first, or undefined for auto-detect
 */
export async function synthesizeSpeech(
  text: string,
  storageId: string,
  ai: SpeechAudioSource,
  r2: R2Bucket,
  config: TTSConfig = {},
  userId: string = 'anonymous',
  mode?: TTSMode
): Promise<SynthesizeResult> {
  const encoding = config.encoding ?? DEFAULT_TTS_ENCODING;
  const maxTextLength = config.maxTextLength ?? DEFAULT_TTS_MAX_TEXT_LENGTH;
  const summaryThreshold = config.summaryThreshold ?? DEFAULT_TTS_SUMMARY_THRESHOLD;
  const contentType = audioContentType(encoding);

  // 1. Check R2 cache
  const cached = await getAudioFromR2(r2, storageId, userId, config);
  if (cached) {
    log.info('tts.cache_hit', { storageId, userId });
    return {
      audioBody: cached.body,
      contentType,
      cached: true,
      summarized: false,
    };
  }

  // 2. Enforce max text length
  let inputText = text;
  if (inputText.length > maxTextLength) {
    log.info('tts.text_truncated', {
      originalLength: inputText.length,
      maxTextLength,
      storageId,
    });
    inputText = inputText.slice(0, maxTextLength);
  }

  // 3. Decide mode: auto-detect if not explicitly set
  const effectiveMode: TTSMode = mode ?? (inputText.length > summaryThreshold ? 'summary' : 'full');
  const summarized = effectiveMode === 'summary';

  let processedText: string;

  if (isSpeechEndpoint(ai)) {
    // No Workers AI model to clean up or summarize with: strip markdown with the regex fallback
    // and keep the text within the chunk limit instead of summarizing.
    const chunkSize = config.chunkSize ?? DEFAULT_TTS_CHUNK_SIZE;
    const maxChunks = config.maxChunks ?? DEFAULT_TTS_MAX_CHUNKS;
    processedText = fallbackStripMarkdown(inputText).slice(
      0,
      chunkSize * Math.max(1, maxChunks - 1)
    );
    const audio = await generateSpeechAudio(processedText, ai, config, r2, storageId, userId);
    if (audio.byteLength === 0) throw new Error('TTS model returned empty audio');
    await storeAudioInR2(r2, storageId, userId, audio, config);
    return { audioBody: audio, contentType, cached: false, summarized: false };
  }

  if (summarized) {
    // Summarize long text via LLM
    log.info('tts.summary_mode', {
      textLength: inputText.length,
      summaryThreshold,
      storageId,
    });
    processedText = await summarizeTextForSpeech(inputText, ai, config);
  } else {
    // Clean markdown for natural speech
    processedText = await cleanTextForSpeech(inputText, ai, config);
  }

  if (!processedText) {
    throw new Error('Text processing produced empty result');
  }

  // 4. Generate audio (with automatic chunking and per-chunk R2 caching)
  const audioBuffer = await generateSpeechAudio(processedText, ai, config, r2, storageId, userId);

  if (audioBuffer.byteLength === 0) {
    throw new Error('TTS model returned empty audio');
  }

  // 5. Store final concatenated audio in R2
  await storeAudioInR2(r2, storageId, userId, audioBuffer, config);

  return {
    audioBody: audioBuffer,
    contentType,
    cached: false,
    summarized,
  };
}
