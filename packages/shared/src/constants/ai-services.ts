// =============================================================================
// AI Task Title Generation
// =============================================================================

/** Default Workers AI model for task title generation. Override via TASK_TITLE_MODEL env var. */
export const DEFAULT_TASK_TITLE_MODEL = '@cf/google/gemma-3-12b-it';

/** Default max generated title length. Override via TASK_TITLE_MAX_LENGTH env var. */
export const DEFAULT_TASK_TITLE_MAX_LENGTH = 100;

/** Default timeout (ms) for AI title generation. Override via TASK_TITLE_TIMEOUT_MS env var. */
export const DEFAULT_TASK_TITLE_TIMEOUT_MS = 5000;

/** Default short-message threshold for AI title generation (messages at or below this length are used as-is).
 * Override via TASK_TITLE_SHORT_MESSAGE_THRESHOLD env var. */
export const DEFAULT_TASK_TITLE_SHORT_MESSAGE_THRESHOLD = 100;

/** Default max retry attempts for AI title generation. Override via TASK_TITLE_MAX_RETRIES env var. */
export const DEFAULT_TASK_TITLE_MAX_RETRIES = 2;

/** Default base delay (ms) between retry attempts (exponential backoff). Override via TASK_TITLE_RETRY_DELAY_MS env var. */
export const DEFAULT_TASK_TITLE_RETRY_DELAY_MS = 1000;

/** Default max delay (ms) cap for retry backoff. Override via TASK_TITLE_RETRY_MAX_DELAY_MS env var. */
export const DEFAULT_TASK_TITLE_RETRY_MAX_DELAY_MS = 4000;

// =============================================================================
// Context Summarization (Conversation Forking)
// =============================================================================

/** Default Workers AI model for session summarization. Override via CONTEXT_SUMMARY_MODEL env var. */
export const DEFAULT_CONTEXT_SUMMARY_MODEL = '@cf/google/gemma-3-12b-it';

/** Default max summary output length in characters. Override via CONTEXT_SUMMARY_MAX_LENGTH env var. */
export const DEFAULT_CONTEXT_SUMMARY_MAX_LENGTH = 4000;

/** Default timeout (ms) for AI summarization. Override via CONTEXT_SUMMARY_TIMEOUT_MS env var. */
export const DEFAULT_CONTEXT_SUMMARY_TIMEOUT_MS = 10000;

/** Default max messages to include in summarization input. Override via CONTEXT_SUMMARY_MAX_MESSAGES env var. */
export const DEFAULT_CONTEXT_SUMMARY_MAX_MESSAGES = 50;

/** Default number of most-recent messages to always include. Override via CONTEXT_SUMMARY_RECENT_MESSAGES env var. */
export const DEFAULT_CONTEXT_SUMMARY_RECENT_MESSAGES = 20;

/** Sessions with filtered message count at or below this threshold skip AI and include messages verbatim.
 * Override via CONTEXT_SUMMARY_SHORT_THRESHOLD env var. */
export const DEFAULT_CONTEXT_SUMMARY_SHORT_THRESHOLD = 5;

/** Default number of leading messages always included in summarization chunking.
 * Override via CONTEXT_SUMMARY_HEAD_MESSAGES env var. */
export const DEFAULT_CONTEXT_SUMMARY_HEAD_MESSAGES = 5;

/** Default number of recent messages included in heuristic fallback summary.
 * Override via CONTEXT_SUMMARY_HEURISTIC_RECENT_MESSAGES env var. */
export const DEFAULT_CONTEXT_SUMMARY_HEURISTIC_RECENT_MESSAGES = 10;

/** Maximum size of contextSummary in bytes (64KB — schema constraint). */
export const MAX_CONTEXT_SUMMARY_BYTES = 65536;

// =============================================================================
// Text-to-Speech (Cloudflare Workers AI)
// =============================================================================

/** Default Workers AI model for text-to-speech. Override via TTS_MODEL env var. */
export const DEFAULT_TTS_MODEL = '@cf/deepgram/aura-2-en';

/** Default TTS voice/speaker. Override via TTS_SPEAKER env var. */
export const DEFAULT_TTS_SPEAKER = 'luna';

/** Default TTS audio encoding. Override via TTS_ENCODING env var. */
export const DEFAULT_TTS_ENCODING = 'mp3';

/** Default Workers AI model for cleaning markdown before TTS. Override via TTS_CLEANUP_MODEL env var. */
export const DEFAULT_TTS_CLEANUP_MODEL = '@cf/google/gemma-3-12b-it';

/** Default max text length (characters) for TTS input. Override via TTS_MAX_TEXT_LENGTH env var.
 * With chunking enabled, this is a soft limit — text beyond this is summarized rather than read verbatim. */
export const DEFAULT_TTS_MAX_TEXT_LENGTH = 100000;

/** Default max output tokens for the markdown cleanup LLM. Override via TTS_CLEANUP_MAX_TOKENS env var. */
export const DEFAULT_TTS_CLEANUP_MAX_TOKENS = 4096;

/** Default timeout (ms) for TTS audio generation per chunk. Override via TTS_TIMEOUT_MS env var. */
export const DEFAULT_TTS_TIMEOUT_MS = 60000;

/** Default timeout (ms) for markdown cleanup LLM call. Override via TTS_CLEANUP_TIMEOUT_MS env var. */
export const DEFAULT_TTS_CLEANUP_TIMEOUT_MS = 15000;

/** Default R2 key prefix for TTS audio files. Override via TTS_R2_PREFIX env var. */
export const DEFAULT_TTS_R2_PREFIX = 'tts';

/** Default max characters per TTS chunk. Text is split at sentence boundaries.
 * Deepgram Aura 2 enforces a hard 2000-character limit; 1800 provides a safe margin.
 * Override via TTS_CHUNK_SIZE env var. */
export const DEFAULT_TTS_CHUNK_SIZE = 1800;

/** Default max number of TTS chunks per request. Prevents CPU time exhaustion
 * on Workers runtime. Override via TTS_MAX_CHUNKS env var. */
export const DEFAULT_TTS_MAX_CHUNKS = 8;

/** Default character threshold above which text is summarized instead of read verbatim.
 * Aligned to DEFAULT_TTS_MAX_CHUNKS × DEFAULT_TTS_CHUNK_SIZE (8 × 1800 = 14400) to ensure
 * summary mode engages before the chunk cap fires. Override via TTS_SUMMARY_THRESHOLD env var. */
export const DEFAULT_TTS_SUMMARY_THRESHOLD = 14400;

/** Default number of retry attempts per TTS chunk generation. Override via TTS_RETRY_ATTEMPTS env var. */
export const DEFAULT_TTS_RETRY_ATTEMPTS = 3;

/** Default base delay (ms) for exponential backoff between TTS retries. Override via TTS_RETRY_BASE_DELAY_MS env var. */
export const DEFAULT_TTS_RETRY_BASE_DELAY_MS = 500;

// =============================================================================
// AI Inference Proxy (OpenAI-compatible Workers AI gateway)
// =============================================================================

/** Default model for AI proxy inference via AI Gateway unified API.
 * Format: {provider}/{model} — e.g. workers-ai/@cf/qwen/qwen2.5-coder-32b-instruct.
 * Override via AI_PROXY_DEFAULT_MODEL env var. */
export const DEFAULT_AI_PROXY_MODEL = 'workers-ai/@cf/qwen/qwen2.5-coder-32b-instruct';

/** Default allowed models (comma-separated). Override via AI_PROXY_ALLOWED_MODELS env var.
 * Format: {provider}/{model} for AI Gateway unified API. */
export const DEFAULT_AI_PROXY_ALLOWED_MODELS = [
  'workers-ai/@cf/qwen/qwen2.5-coder-32b-instruct',
  'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
  'workers-ai/@cf/qwen/qwen3-30b-a3b-fp8',
].join(',');

/** Default AI Gateway ID. Override via AI_GATEWAY_ID env var. */
export const DEFAULT_AI_GATEWAY_ID = 'default';

/** Default daily input token limit per user. Override via AI_PROXY_DAILY_INPUT_TOKEN_LIMIT env var. */
export const DEFAULT_AI_PROXY_DAILY_INPUT_TOKEN_LIMIT = 500_000;

/** Default daily output token limit per user. Override via AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT env var. */
export const DEFAULT_AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT = 200_000;

/** Default max input tokens per request. Override via AI_PROXY_MAX_INPUT_TOKENS_PER_REQUEST env var. */
export const DEFAULT_AI_PROXY_MAX_INPUT_TOKENS_PER_REQUEST = 32_000;

/** Default rate limit in requests per minute per user. Override via AI_PROXY_RATE_LIMIT_RPM env var. */
export const DEFAULT_AI_PROXY_RATE_LIMIT_RPM = 30;

/** Default streaming timeout in ms. Override via AI_PROXY_STREAM_TIMEOUT_MS env var. */
export const DEFAULT_AI_PROXY_STREAM_TIMEOUT_MS = 120_000;

/** Default rate limit window in seconds. Override via AI_PROXY_RATE_LIMIT_WINDOW_SECONDS env var. */
export const DEFAULT_AI_PROXY_RATE_LIMIT_WINDOW_SECONDS = 60;
