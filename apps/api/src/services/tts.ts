/**
 * Text-to-Speech Service
 *
 * Reusable TTS pipeline using Cloudflare Workers AI:
 *   1. Clean markdown/code from text via LLM
 *   2. Generate speech audio via TTS model
 *   3. Cache audio in R2 with deterministic keys
 *
 * Architecture:
 *   Text (markdown) → LLM cleanup → plain text → TTS model → MP3 audio → R2 storage
 *
 * The service is designed to be reusable across different contexts
 * (message read-aloud, notification audio, etc.) by accepting a
 * storage key that callers can derive from their domain (e.g., messageId).
 */

import { Agent } from '@mastra/core/agent';
import { createWorkersAI } from 'workers-ai-provider';
import {
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_SPEAKER,
  DEFAULT_TTS_ENCODING,
  DEFAULT_TTS_CLEANUP_MODEL,
  DEFAULT_TTS_MAX_TEXT_LENGTH,
  DEFAULT_TTS_TIMEOUT_MS,
  DEFAULT_TTS_CLEANUP_TIMEOUT_MS,
  DEFAULT_TTS_R2_PREFIX,
} from '@simple-agent-manager/shared';
import { log } from '../lib/logger';

// ─── Configuration ───────────────────────────────────────────────────────────

export interface TTSConfig {
  model?: string;
  speaker?: string;
  encoding?: string;
  cleanupModel?: string;
  maxTextLength?: number;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  r2Prefix?: string;
  enabled?: boolean;
}

export interface TTSEnvVars {
  TTS_MODEL?: string;
  TTS_SPEAKER?: string;
  TTS_ENCODING?: string;
  TTS_CLEANUP_MODEL?: string;
  TTS_MAX_TEXT_LENGTH?: string;
  TTS_TIMEOUT_MS?: string;
  TTS_CLEANUP_TIMEOUT_MS?: string;
  TTS_R2_PREFIX?: string;
  TTS_ENABLED?: string;
}

export function getTTSConfig(env: TTSEnvVars): TTSConfig {
  return {
    model: env.TTS_MODEL || DEFAULT_TTS_MODEL,
    speaker: env.TTS_SPEAKER || DEFAULT_TTS_SPEAKER,
    encoding: env.TTS_ENCODING || DEFAULT_TTS_ENCODING,
    cleanupModel: env.TTS_CLEANUP_MODEL || DEFAULT_TTS_CLEANUP_MODEL,
    maxTextLength: parseInt(env.TTS_MAX_TEXT_LENGTH || String(DEFAULT_TTS_MAX_TEXT_LENGTH), 10),
    timeoutMs: parseInt(env.TTS_TIMEOUT_MS || String(DEFAULT_TTS_TIMEOUT_MS), 10),
    cleanupTimeoutMs: parseInt(env.TTS_CLEANUP_TIMEOUT_MS || String(DEFAULT_TTS_CLEANUP_TIMEOUT_MS), 10),
    r2Prefix: env.TTS_R2_PREFIX || DEFAULT_TTS_R2_PREFIX,
    enabled: env.TTS_ENABLED !== 'false',
  };
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

/**
 * Use an LLM to clean markdown/code from text, producing natural spoken text.
 * Falls back to basic regex stripping if the LLM call fails.
 */
export async function cleanTextForSpeech(
  text: string,
  ai: Ai,
  config: TTSConfig = {},
): Promise<string> {
  const cleanupModel = config.cleanupModel ?? DEFAULT_TTS_CLEANUP_MODEL;
  const cleanupTimeoutMs = config.cleanupTimeoutMs ?? DEFAULT_TTS_CLEANUP_TIMEOUT_MS;

  // If text has no markdown indicators, skip LLM cleanup
  if (!hasMarkdown(text)) {
    return text.trim();
  }

  try {
    const workersAi = createWorkersAI({ binding: ai });
    const model = workersAi(cleanupModel as Parameters<typeof workersAi>[0]);
    const agent = new Agent({
      id: 'tts-text-cleanup',
      name: 'TTS Text Cleanup',
      instructions: CLEANUP_INSTRUCTIONS,
      model,
    });

    const result = await agent.generate(text, {
      abortSignal: AbortSignal.timeout(cleanupTimeoutMs),
    });

    const cleaned = result.text?.trim();
    if (!cleaned) {
      log.warn('tts.cleanup_empty', { textLength: text.length, cleanupModel });
      return fallbackStripMarkdown(text);
    }

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

// ─── Audio Generation ────────────────────────────────────────────────────────

/**
 * Generate speech audio from plain text using Workers AI TTS.
 * Returns raw audio bytes as an ArrayBuffer.
 */
export async function generateSpeechAudio(
  text: string,
  ai: Ai,
  config: TTSConfig = {},
): Promise<ArrayBuffer> {
  const model = config.model ?? DEFAULT_TTS_MODEL;
  const speaker = config.speaker ?? DEFAULT_TTS_SPEAKER;
  const encoding = config.encoding ?? DEFAULT_TTS_ENCODING;

  const startTime = Date.now();

  // Use returnRawResponse to get streaming audio bytes
  const response = await ai.run(
    model as Parameters<typeof ai.run>[0],
    { text, speaker, encoding } as never,
    { returnRawResponse: true },
  );

  // The response is a standard Response object when returnRawResponse is true
  const rawResponse = response as unknown as Response;
  if (!rawResponse.ok) {
    const errorText = await rawResponse.text().catch(() => 'unknown');
    throw new Error(`TTS model returned ${rawResponse.status}: ${errorText}`);
  }

  const audioBuffer = await rawResponse.arrayBuffer();
  const durationMs = Date.now() - startTime;

  log.info('tts.audio_generated', {
    model,
    speaker,
    encoding,
    textLength: text.length,
    audioBytes: audioBuffer.byteLength,
    durationMs,
  });

  return audioBuffer;
}

// ─── R2 Storage ──────────────────────────────────────────────────────────────

/** Build the R2 object key for a TTS audio file. */
export function buildR2Key(storageId: string, config: TTSConfig = {}): string {
  const prefix = config.r2Prefix ?? DEFAULT_TTS_R2_PREFIX;
  const encoding = config.encoding ?? DEFAULT_TTS_ENCODING;
  return `${prefix}/${storageId}.${encoding}`;
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
  config: TTSConfig = {},
): Promise<R2ObjectBody | null> {
  const key = buildR2Key(storageId, config);
  return r2.get(key);
}

/** Store audio bytes in R2. */
export async function storeAudioInR2(
  r2: R2Bucket,
  storageId: string,
  audio: ArrayBuffer,
  config: TTSConfig = {},
): Promise<void> {
  const key = buildR2Key(storageId, config);
  const encoding = config.encoding ?? DEFAULT_TTS_ENCODING;
  await r2.put(key, audio, {
    httpMetadata: {
      contentType: audioContentType(encoding),
    },
  });
  log.info('tts.audio_stored', { key, bytes: audio.byteLength });
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export interface SynthesizeResult {
  audioBody: ReadableStream | ArrayBuffer;
  contentType: string;
  cached: boolean;
}

/**
 * Full TTS pipeline: check cache → clean text → generate audio → store → return.
 *
 * @param text - The raw text (possibly with markdown) to synthesize
 * @param storageId - Unique identifier for R2 caching (e.g., messageId)
 * @param ai - Workers AI binding
 * @param r2 - R2 bucket binding
 * @param config - Optional TTS configuration overrides
 */
export async function synthesizeSpeech(
  text: string,
  storageId: string,
  ai: Ai,
  r2: R2Bucket,
  config: TTSConfig = {},
): Promise<SynthesizeResult> {
  const encoding = config.encoding ?? DEFAULT_TTS_ENCODING;
  const maxTextLength = config.maxTextLength ?? DEFAULT_TTS_MAX_TEXT_LENGTH;
  const contentType = audioContentType(encoding);

  // 1. Check R2 cache
  const cached = await getAudioFromR2(r2, storageId, config);
  if (cached) {
    log.info('tts.cache_hit', { storageId });
    return {
      audioBody: cached.body,
      contentType,
      cached: true,
    };
  }

  // 2. Truncate if too long
  const inputText = text.length > maxTextLength ? text.slice(0, maxTextLength) : text;

  // 3. Clean markdown for natural speech
  const cleanedText = await cleanTextForSpeech(inputText, ai, config);

  if (!cleanedText) {
    throw new Error('Text cleanup produced empty result');
  }

  // 4. Generate audio
  const audioBuffer = await generateSpeechAudio(cleanedText, ai, config);

  if (audioBuffer.byteLength === 0) {
    throw new Error('TTS model returned empty audio');
  }

  // 5. Store in R2 (fire-and-forget is fine, but we await for reliability)
  await storeAudioInR2(r2, storageId, audioBuffer, config);

  return {
    audioBody: audioBuffer,
    contentType,
    cached: false,
  };
}
