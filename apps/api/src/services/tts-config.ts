/**
 * TTS configuration (env → TTSConfig) and the retry helper shared by the TTS pipeline.
 * Split from tts.ts by size; consumers import through tts.ts.
 */
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
    retryBaseDelayMs: parsePositiveInt(
      env.TTS_RETRY_BASE_DELAY_MS,
      DEFAULT_TTS_RETRY_BASE_DELAY_MS
    ),
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
  label: string
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
