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

import { Agent } from '@mastra/core/agent';
import {
  DEFAULT_TTS_CHUNK_SIZE,
  DEFAULT_TTS_CLEANUP_MAX_TOKENS,
  DEFAULT_TTS_CLEANUP_MODEL,
  DEFAULT_TTS_CLEANUP_TIMEOUT_MS,
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
import { createWorkersAI } from 'workers-ai-provider';

import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';

// ─── Configuration ───────────────────────────────────────────────────────────

export interface TTSConfig {
  model?: string;
  speaker?: string;
  encoding?: string;
  cleanupModel?: string;
  cleanupMaxTokens?: number;
  maxTextLength?: number;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  r2Prefix?: string;
  enabled?: boolean;
  chunkSize?: number;
  maxChunks?: number;
  summaryThreshold?: number;
  retryAttempts?: number;
  retryBaseDelayMs?: number;
}

export interface TTSEnvVars {
  TTS_MODEL?: string;
  TTS_SPEAKER?: string;
  TTS_ENCODING?: string;
  TTS_CLEANUP_MODEL?: string;
  TTS_CLEANUP_MAX_TOKENS?: string;
  TTS_MAX_TEXT_LENGTH?: string;
  TTS_TIMEOUT_MS?: string;
  TTS_CLEANUP_TIMEOUT_MS?: string;
  TTS_R2_PREFIX?: string;
  TTS_ENABLED?: string;
  TTS_CHUNK_SIZE?: string;
  TTS_MAX_CHUNKS?: string;
  TTS_SUMMARY_THRESHOLD?: string;
  TTS_RETRY_ATTEMPTS?: string;
  TTS_RETRY_BASE_DELAY_MS?: string;
}

export function getTTSConfig(env: TTSEnvVars): TTSConfig {
  return {
    model: env.TTS_MODEL || DEFAULT_TTS_MODEL,
    speaker: env.TTS_SPEAKER || DEFAULT_TTS_SPEAKER,
    encoding: env.TTS_ENCODING || DEFAULT_TTS_ENCODING,
    cleanupModel: env.TTS_CLEANUP_MODEL || DEFAULT_TTS_CLEANUP_MODEL,
    cleanupMaxTokens: parsePositiveInt(env.TTS_CLEANUP_MAX_TOKENS, DEFAULT_TTS_CLEANUP_MAX_TOKENS),
    maxTextLength: parsePositiveInt(env.TTS_MAX_TEXT_LENGTH, DEFAULT_TTS_MAX_TEXT_LENGTH),
    timeoutMs: parsePositiveInt(env.TTS_TIMEOUT_MS, DEFAULT_TTS_TIMEOUT_MS),
    cleanupTimeoutMs: parsePositiveInt(env.TTS_CLEANUP_TIMEOUT_MS, DEFAULT_TTS_CLEANUP_TIMEOUT_MS),
    r2Prefix: env.TTS_R2_PREFIX || DEFAULT_TTS_R2_PREFIX,
    enabled: env.TTS_ENABLED !== 'false',
    chunkSize: parsePositiveInt(env.TTS_CHUNK_SIZE, DEFAULT_TTS_CHUNK_SIZE),
    maxChunks: parsePositiveInt(env.TTS_MAX_CHUNKS, DEFAULT_TTS_MAX_CHUNKS),
    summaryThreshold: parsePositiveInt(env.TTS_SUMMARY_THRESHOLD, DEFAULT_TTS_SUMMARY_THRESHOLD),
    retryAttempts: parsePositiveInt(env.TTS_RETRY_ATTEMPTS, DEFAULT_TTS_RETRY_ATTEMPTS),
    retryBaseDelayMs: parsePositiveInt(env.TTS_RETRY_BASE_DELAY_MS, DEFAULT_TTS_RETRY_BASE_DELAY_MS),
  };
}

// ─── Retry Utility ──────────────────────────────────────────────────────────

/**
 * Retry an async function with exponential backoff and jitter.
 * Throws the last error if all attempts fail.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  baseDelayMs: number,
  label: string,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === maxAttempts) {
        log.warn('tts.retry_exhausted', {
          label,
          attempts: maxAttempts,
          error: lastError.message,
        });
        throw lastError;
      }

      // Exponential backoff: baseDelay * 2^(attempt-1) with ±25% jitter
      const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
      const jitter = exponentialDelay * 0.25 * (2 * Math.random() - 1);
      const delay = Math.max(0, Math.round(exponentialDelay + jitter));

      log.warn('tts.retry_attempt', {
        label,
        attempt,
        maxAttempts,
        error: lastError.message,
        delayMs: delay,
      });

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Should never reach here, but TypeScript needs this
  throw lastError ?? new Error('retryWithBackoff: no attempts made');
}

// ─── Markdown Cleanup ────────────────────────────────────────────────────────

const CLEANUP_INSTRUCTIONS = `You are a text preparation assistant for text-to-speech systems. Your job is to convert markdown-formatted text into natural spoken text.

Rules:
- Output ONLY the cleaned text, nothing else
- Remove all markdown formatting (headers, bold, italic, code blocks, links, images, lists markers)
- Convert bullet points and numbered lists into natural flowing sentences
- Remove code blocks entirely — do not try to read code aloud
- Convert URLs and links into just the link text
- Expand common abbreviations if they would sound odd spoken (e.g., "e.g." → "for example")
- Keep the meaning and tone of the original text
- Do not add any commentary, explanation, or meta-text
- Output plain text only — no markdown, no HTML, no special formatting`;

const SUMMARY_INSTRUCTIONS = `You are a text summarization assistant for text-to-speech systems. Your job is to create a concise spoken summary of long content.

Rules:
- Output ONLY the summary text, nothing else
- Summarize the key points, findings, and conclusions
- Use natural spoken language — no markdown, no HTML, no special formatting
- Remove all code blocks, URLs, and technical formatting
- Keep the summary proportional: aim for roughly 10-20% of the original length
- Preserve the most important information and main arguments
- Use transitional phrases for natural flow when spoken aloud
- Do not add any commentary like "Here is a summary" — just provide the summary directly
- Do not add any meta-text or preamble`;

/**
 * Use an LLM to clean markdown/code from text, producing natural spoken text.
 * Retries on failure before falling back to basic regex stripping.
 */
export async function cleanTextForSpeech(
  text: string,
  ai: Ai,
  config: TTSConfig = {},
): Promise<string> {
  const cleanupModel = config.cleanupModel ?? DEFAULT_TTS_CLEANUP_MODEL;
  const cleanupTimeoutMs = config.cleanupTimeoutMs ?? DEFAULT_TTS_CLEANUP_TIMEOUT_MS;
  const cleanupMaxTokens = config.cleanupMaxTokens ?? DEFAULT_TTS_CLEANUP_MAX_TOKENS;
  const retryAttempts = config.retryAttempts ?? DEFAULT_TTS_RETRY_ATTEMPTS;
  const retryBaseDelayMs = config.retryBaseDelayMs ?? DEFAULT_TTS_RETRY_BASE_DELAY_MS;

  // If text has no markdown indicators, skip LLM cleanup
  if (!hasMarkdown(text)) {
    return text.trim();
  }

  try {
    // Construct the agent once outside the retry loop to avoid
    // re-instantiating the Workers AI binding wrapper on each attempt
    const workersAi = createWorkersAI({ binding: ai });
    const model = workersAi(cleanupModel as Parameters<typeof workersAi>[0]);
    const agent = new Agent({
      id: 'tts-text-cleanup',
      name: 'TTS Text Cleanup',
      instructions: CLEANUP_INSTRUCTIONS,
      model,
    });

    const cleaned = await retryWithBackoff(
      async () => {
        const result = await agent.generate(text, {
          abortSignal: AbortSignal.timeout(cleanupTimeoutMs),
          modelSettings: {
            maxOutputTokens: cleanupMaxTokens,
          },
        });

        const resultText = result.text?.trim();
        if (!resultText) {
          throw new Error('LLM returned empty cleanup result');
        }
        return resultText;
      },
      retryAttempts,
      retryBaseDelayMs,
      'cleanup',
    );

    log.info('tts.cleanup_complete', {
      inputLength: text.length,
      outputLength: cleaned.length,
      ratio: Math.round((cleaned.length / text.length) * 100),
      cleanupModel,
      cleanupMaxTokens,
    });

    return cleaned;
  } catch (err) {
    log.warn('tts.cleanup_failed', {
      error: err instanceof Error ? err.message : String(err),
      textLength: text.length,
      cleanupModel,
    });
    return fallbackStripMarkdown(text);
  }
}

/**
 * Use an LLM to summarize long text for TTS.
 * Retries on failure before falling back to truncation + regex stripping.
 */
export async function summarizeTextForSpeech(
  text: string,
  ai: Ai,
  config: TTSConfig = {},
): Promise<string> {
  const cleanupModel = config.cleanupModel ?? DEFAULT_TTS_CLEANUP_MODEL;
  const cleanupTimeoutMs = config.cleanupTimeoutMs ?? DEFAULT_TTS_CLEANUP_TIMEOUT_MS;
  const cleanupMaxTokens = config.cleanupMaxTokens ?? DEFAULT_TTS_CLEANUP_MAX_TOKENS;
  const retryAttempts = config.retryAttempts ?? DEFAULT_TTS_RETRY_ATTEMPTS;
  const retryBaseDelayMs = config.retryBaseDelayMs ?? DEFAULT_TTS_RETRY_BASE_DELAY_MS;

  try {
    // Construct the agent once outside the retry loop to avoid
    // re-instantiating the Workers AI binding wrapper on each attempt
    const workersAi = createWorkersAI({ binding: ai });
    const model = workersAi(cleanupModel as Parameters<typeof workersAi>[0]);
    const agent = new Agent({
      id: 'tts-text-summarize',
      name: 'TTS Text Summarize',
      instructions: SUMMARY_INSTRUCTIONS,
      model,
    });

    const summary = await retryWithBackoff(
      async () => {
        const result = await agent.generate(text, {
          abortSignal: AbortSignal.timeout(cleanupTimeoutMs),
          modelSettings: {
            maxOutputTokens: cleanupMaxTokens,
          },
        });

        const resultText = result.text?.trim();
        if (!resultText) {
          throw new Error('LLM returned empty summary result');
        }
        return resultText;
      },
      retryAttempts,
      retryBaseDelayMs,
      'summary',
    );

    log.info('tts.summary_complete', {
      inputLength: text.length,
      outputLength: summary.length,
      ratio: Math.round((summary.length / text.length) * 100),
      cleanupModel,
    });

    return summary;
  } catch (err) {
    log.warn('tts.summary_failed', {
      error: err instanceof Error ? err.message : String(err),
      textLength: text.length,
      cleanupModel,
    });
    const effectiveChunkSize = config.chunkSize ?? DEFAULT_TTS_CHUNK_SIZE;
    return fallbackStripMarkdown(text.slice(0, effectiveChunkSize));
  }
}

/** Quick check for common markdown patterns. */
function hasMarkdown(text: string): boolean {
  return /```|`[^`]+`|#{1,6}\s|[*_]{1,2}\S|\[.*\]\(.*\)|^\s*[-*+]\s|^\s*\d+\.\s/m.test(text);
}

/** Regex-based markdown stripping fallback (less natural than LLM but works offline). */
export function fallbackStripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '')           // fenced code blocks
    .replace(/`([^`]+)`/g, '$1')              // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')     // images
    .replace(/\[[^\]]*\]\(([^)]*)\)/g, '$1')  // links → URL text
    .replace(/#{1,6}\s+/g, '')                // headings
    .replace(/\*\*([^*]+)\*\*/g, '$1')        // bold
    .replace(/__([^_]+)__/g, '$1')            // bold
    .replace(/\*([^*]+)\*/g, '$1')            // italic
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1') // italic
    .replace(/(^|\n)>\s?/g, '$1')             // blockquotes
    .replace(/(^|\n)\s*[-*+]\s/g, '$1')       // unordered list markers
    .replace(/(^|\n)\s*\d+\.\s/g, '$1')       // ordered list markers
    .replace(/(^|\n)(---+|\*\*\*+|___+)\s*($|\n)/g, '$1') // horizontal rules
    .replace(/\n{3,}/g, '\n\n')               // collapse excess newlines
    .trim();
}

// ─── Text Chunking ──────────────────────────────────────────────────────────

/**
 * Split text into chunks at sentence boundaries, respecting a max chunk size.
 * Never splits mid-word. Falls back to word boundaries if no sentence boundary
 * is found within the chunk limit.
 */
export function splitTextIntoChunks(text: string, maxChunkSize: number): string[] {
  if (!text) {
    return [];
  }

  if (text.length <= maxChunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChunkSize) {
      chunks.push(remaining);
      break;
    }

    // Look for the last sentence boundary within the chunk limit
    const window = remaining.slice(0, maxChunkSize);
    let splitIndex = -1;

    // Try sentence boundaries: ". ", "! ", "? ", ".\n", "!\n", "?\n"
    for (const sep of ['. ', '! ', '? ', '.\n', '!\n', '?\n']) {
      const idx = window.lastIndexOf(sep);
      if (idx > splitIndex) {
        // Include the punctuation but not the space/newline after it
        splitIndex = idx + 1;
      }
    }

    // Also try double newline (paragraph boundary)
    const paraIdx = window.lastIndexOf('\n\n');
    if (paraIdx > splitIndex) {
      splitIndex = paraIdx;
    }

    // Fallback: split at last space (word boundary)
    if (splitIndex <= 0) {
      const spaceIdx = window.lastIndexOf(' ');
      if (spaceIdx > 0) {
        splitIndex = spaceIdx;
      } else {
        // No space found — force split at max chunk size
        splitIndex = maxChunkSize;
      }
    }

    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  return chunks.filter(c => c.length > 0);
}

// ─── Audio Generation ────────────────────────────────────────────────────────

/**
 * Generate speech audio for a single chunk of plain text using Workers AI TTS.
 * Retries with exponential backoff on failure.
 * Returns raw audio bytes as an ArrayBuffer.
 */
export async function generateSpeechAudioChunk(
  text: string,
  ai: Ai,
  config: TTSConfig = {},
): Promise<ArrayBuffer> {
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
          timeoutMs,
        );
      });

      const response = await Promise.race([
        ai.run(
          model as Parameters<typeof ai.run>[0],
          { text, speaker, encoding } as never,
          { returnRawResponse: true },
        ),
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
    'tts_chunk',
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
  ai: Ai,
  config: TTSConfig = {},
  r2?: R2Bucket,
  storageId?: string,
  userId?: string,
): Promise<ArrayBuffer> {
  const chunkSize = config.chunkSize ?? DEFAULT_TTS_CHUNK_SIZE;
  const maxChunks = config.maxChunks ?? DEFAULT_TTS_MAX_CHUNKS;
  const chunks = splitTextIntoChunks(text, chunkSize);

  if (chunks.length === 1) {
    return generateSpeechAudioChunk(chunks[0]!, ai, config);
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
      `Use summary mode or reduce text length.`,
    );
  }

  log.info('tts.chunked_generation_start', {
    totalLength: text.length,
    chunkCount: chunks.length,
    chunkSize,
  });

  // Generate audio for each chunk sequentially to avoid rate limiting
  const audioBuffers: ArrayBuffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunkText = chunks[i]!;

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
      await r2.put(chunkKey, buffer, {
        httpMetadata: { contentType: audioContentType(encoding) },
      }).catch((err) => {
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
      buildChunkR2Key(storageId, userId, i, chunkText, config),
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
  config: TTSConfig = {},
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
  config: TTSConfig = {},
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
  config: TTSConfig = {},
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
  ai: Ai,
  r2: R2Bucket,
  config: TTSConfig = {},
  userId: string = 'anonymous',
  mode?: TTSMode,
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
