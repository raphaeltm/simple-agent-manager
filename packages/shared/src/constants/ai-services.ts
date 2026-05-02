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

/** Default model for AI proxy inference when no admin override is set.
 * Out-of-box default is a free Workers AI model — no API key required.
 * Admins can override via the AI Proxy admin page (stored in KV) or
 * the AI_PROXY_DEFAULT_MODEL env var. */
export const DEFAULT_AI_PROXY_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

/** Default model for Anthropic proxy fallback (Claude Code agent).
 * Override via AI_PROXY_DEFAULT_ANTHROPIC_MODEL env var. */
export const DEFAULT_AI_PROXY_ANTHROPIC_MODEL = 'claude-sonnet-4-6';

/** Default model for OpenAI proxy fallback (Codex agent).
 * Override via AI_PROXY_DEFAULT_OPENAI_MODEL env var. */
export const DEFAULT_AI_PROXY_OPENAI_MODEL = 'gpt-4.1';

/** Budget tier for platform AI models. */
export type PlatformAIModelTier = 'free' | 'standard' | 'premium';

/** Tool-call reliability tier for agent loop suitability. */
export type ToolCallSupport = 'excellent' | 'good' | 'limited' | 'none';

/** Intended role in the SAM agent hierarchy. */
export type ModelIntendedRole = 'workspace-agent' | 'sam-agent' | 'project-agent' | 'utility' | 'any';

/** Scopes where a model is allowed. */
export type ModelAllowedScope = 'workspace' | 'project' | 'top-level';

/** Platform AI model metadata for UI dropdowns, allowed-model derivation, and harness model selection. */
export interface PlatformAIModel {
  /** Model ID (Workers AI uses @cf/ prefix; Anthropic uses claude-* IDs; OpenAI uses gpt-* IDs) */
  id: string;
  /** Human-friendly display label */
  label: string;
  /** Whether this is the default model */
  isDefault?: boolean;
  /** Provider for the model (determines routing in AI proxy) */
  provider: 'workers-ai' | 'anthropic' | 'openai';
  /** Budget tier: free (Workers AI free tier), standard, or premium */
  tier: PlatformAIModelTier;
  /** Approximate cost per 1K input tokens (USD) for budget estimation. Actual costs from AI Gateway logs. */
  costPer1kInputTokens: number;
  /** Approximate cost per 1K output tokens (USD) for budget estimation. Actual costs from AI Gateway logs. */
  costPer1kOutputTokens: number;
  /** Context window size in tokens. */
  contextWindow: number;
  /** Tool-call reliability for agent loop suitability. */
  toolCallSupport: ToolCallSupport;
  /** Primary intended role in the SAM agent hierarchy. */
  intendedRole: ModelIntendedRole;
  /** Fallback group — models in the same group can substitute for each other. */
  fallbackGroup: string;
  /** Scopes where this model is allowed to be selected. */
  allowedScopes: ModelAllowedScope[];
  /**
   * Model identifier for the AI Gateway Unified API (`/compat/chat/completions`).
   * Format: `{provider}/{model-id}` (e.g., `anthropic/claude-sonnet-4-6`).
   * Workers AI models use the Workers AI path instead; this field is null for them.
   */
  unifiedApiModelId: string | null;
}

/** Models available through the SAM Platform AI proxy.
 * This is the single source of truth — the DEFAULT_AI_PROXY_ALLOWED_MODELS
 * string and the UI dropdown both derive from this list.
 * Includes Workers AI (free, Cloudflare-hosted), Anthropic, and OpenAI
 * models routed through Cloudflare AI Gateway with Unified Billing. */
export const PLATFORM_AI_MODELS: PlatformAIModel[] = [
  // --- Workers AI (free tier) ---
  {
    id: '@cf/meta/llama-4-scout-17b-16e-instruct',
    label: 'Llama 4 Scout 17B',
    isDefault: true,
    provider: 'workers-ai',
    tier: 'free',
    costPer1kInputTokens: 0,
    costPer1kOutputTokens: 0,
    contextWindow: 131072,
    toolCallSupport: 'limited',
    intendedRole: 'utility',
    fallbackGroup: 'free-general',
    allowedScopes: ['workspace'],
    unifiedApiModelId: null,
  },
  {
    id: '@cf/qwen/qwen3-30b-a3b-fp8',
    label: 'Qwen 3 30B',
    provider: 'workers-ai',
    tier: 'free',
    costPer1kInputTokens: 0,
    costPer1kOutputTokens: 0,
    contextWindow: 32768,
    toolCallSupport: 'good',
    intendedRole: 'workspace-agent',
    fallbackGroup: 'free-coding',
    allowedScopes: ['workspace'],
    unifiedApiModelId: null,
  },
  {
    id: '@cf/qwen/qwen2.5-coder-32b-instruct',
    label: 'Qwen 2.5 Coder 32B',
    provider: 'workers-ai',
    tier: 'free',
    costPer1kInputTokens: 0,
    costPer1kOutputTokens: 0,
    contextWindow: 32768,
    toolCallSupport: 'good',
    intendedRole: 'workspace-agent',
    fallbackGroup: 'free-coding',
    allowedScopes: ['workspace'],
    unifiedApiModelId: null,
  },
  {
    id: '@cf/google/gemma-3-12b-it',
    label: 'Gemma 3 12B',
    provider: 'workers-ai',
    tier: 'free',
    costPer1kInputTokens: 0,
    costPer1kOutputTokens: 0,
    contextWindow: 32768,
    toolCallSupport: 'none',
    intendedRole: 'utility',
    fallbackGroup: 'free-utility',
    allowedScopes: ['workspace'],
    unifiedApiModelId: null,
  },
  // --- Anthropic (via AI Gateway) ---
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    provider: 'anthropic',
    tier: 'standard',
    costPer1kInputTokens: 0.0008,
    costPer1kOutputTokens: 0.004,
    contextWindow: 200000,
    toolCallSupport: 'excellent',
    intendedRole: 'utility',
    fallbackGroup: 'anthropic-fast',
    allowedScopes: ['workspace', 'project', 'top-level'],
    unifiedApiModelId: 'anthropic/claude-haiku-4-5-20251001',
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    tier: 'standard',
    costPer1kInputTokens: 0.003,
    costPer1kOutputTokens: 0.015,
    contextWindow: 200000,
    toolCallSupport: 'excellent',
    intendedRole: 'any',
    fallbackGroup: 'anthropic-standard',
    allowedScopes: ['workspace', 'project', 'top-level'],
    unifiedApiModelId: 'anthropic/claude-sonnet-4-6',
  },
  {
    id: 'claude-opus-4-6',
    label: 'Claude Opus 4.6',
    provider: 'anthropic',
    tier: 'premium',
    costPer1kInputTokens: 0.015,
    costPer1kOutputTokens: 0.075,
    contextWindow: 200000,
    toolCallSupport: 'excellent',
    intendedRole: 'sam-agent',
    fallbackGroup: 'anthropic-premium',
    allowedScopes: ['workspace', 'project', 'top-level'],
    unifiedApiModelId: 'anthropic/claude-opus-4-6',
  },
  // --- OpenAI (via AI Gateway) ---
  {
    id: 'gpt-4.1-mini',
    label: 'GPT-4.1 Mini',
    provider: 'openai',
    tier: 'standard',
    costPer1kInputTokens: 0.0004,
    costPer1kOutputTokens: 0.0016,
    contextWindow: 1047576,
    toolCallSupport: 'excellent',
    intendedRole: 'utility',
    fallbackGroup: 'openai-fast',
    allowedScopes: ['workspace', 'project'],
    unifiedApiModelId: 'openai/gpt-4.1-mini',
  },
  {
    id: 'gpt-4.1',
    label: 'GPT-4.1',
    provider: 'openai',
    tier: 'standard',
    costPer1kInputTokens: 0.002,
    costPer1kOutputTokens: 0.008,
    contextWindow: 1047576,
    toolCallSupport: 'excellent',
    intendedRole: 'workspace-agent',
    fallbackGroup: 'openai-standard',
    allowedScopes: ['workspace', 'project'],
    unifiedApiModelId: 'openai/gpt-4.1',
  },
  {
    id: 'gpt-5.2',
    label: 'GPT-5.2',
    provider: 'openai',
    tier: 'premium',
    costPer1kInputTokens: 0.01,
    costPer1kOutputTokens: 0.04,
    contextWindow: 131072,
    toolCallSupport: 'excellent',
    intendedRole: 'workspace-agent',
    fallbackGroup: 'openai-premium',
    allowedScopes: ['workspace', 'project'],
    unifiedApiModelId: 'openai/gpt-5.2',
  },
];

/** KV key for the admin-configured default model. Stored by the admin AI proxy config endpoint. */
export const AI_PROXY_DEFAULT_MODEL_KV_KEY = 'platform:ai-proxy:default-model';

/** KV key for the admin-configured billing mode. */
export const AI_PROXY_BILLING_MODE_KV_KEY = 'platform:ai-proxy:billing-mode';

/** Billing mode for AI proxy upstream authentication.
 * - 'unified': Use Cloudflare Unified Billing (cf-aig-authorization header with CF_API_TOKEN)
 * - 'platform-key': Use stored platform API key (x-api-key header, current behavior)
 * - 'auto': Try unified billing first, fall back to platform key if CF_API_TOKEN is missing
 *
 * Override via AI_PROXY_BILLING_MODE env var. Default: 'auto'. */
export type BillingMode = 'unified' | 'platform-key' | 'auto';

/** All valid billing modes — single source of truth for validation. */
export const VALID_BILLING_MODES: readonly BillingMode[] = ['unified', 'platform-key', 'auto'] as const;

/** Default billing mode. Override via AI_PROXY_BILLING_MODE env var. */
export const DEFAULT_AI_PROXY_BILLING_MODE: BillingMode = 'auto';

/** Admin AI proxy configuration (stored in KV, managed via admin UI). */
export interface AIProxyConfig {
  /** Admin-selected default model ID */
  defaultModel: string;
  /** When the config was last updated (ISO string) */
  updatedAt: string;
}

/** Default allowed models (comma-separated). Override via AI_PROXY_ALLOWED_MODELS env var. */
export const DEFAULT_AI_PROXY_ALLOWED_MODELS = PLATFORM_AI_MODELS.map((m) => m.id).join(',');

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

// =============================================================================
// User Budget Settings
// =============================================================================

/** Default alert threshold percentage for budget warnings. Override via AI_USAGE_ALERT_THRESHOLD_PERCENT env var. */
export const DEFAULT_AI_USAGE_ALERT_THRESHOLD_PERCENT = 80;

/** KV key prefix for user budget settings. */
export const AI_BUDGET_SETTINGS_KV_PREFIX = 'ai-budget-settings';

/** Maximum allowed daily token limit a user can set. Override via AI_USAGE_MAX_DAILY_TOKEN_LIMIT env var. */
export const DEFAULT_AI_USAGE_MAX_DAILY_TOKEN_LIMIT = 10_000_000;

/** Minimum daily token limit a user can set. Override via AI_USAGE_MIN_DAILY_TOKEN_LIMIT env var. */
export const DEFAULT_AI_USAGE_MIN_DAILY_TOKEN_LIMIT = 1_000;

/** Maximum allowed monthly cost cap (USD) a user can set. Override via AI_USAGE_MAX_MONTHLY_COST_CAP_USD env var. */
export const DEFAULT_AI_USAGE_MAX_MONTHLY_COST_CAP_USD = 10_000;

/** Minimum monthly cost cap (USD) a user can set. Override via AI_USAGE_MIN_MONTHLY_COST_CAP_USD env var. */
export const DEFAULT_AI_USAGE_MIN_MONTHLY_COST_CAP_USD = 0.01;

/** Default KV TTL for daily budget entries — 24h + 1h timezone buffer. Override via AI_USAGE_BUDGET_TTL_SECONDS env var. */
export const DEFAULT_AI_USAGE_BUDGET_TTL_SECONDS = 86_400 + 3_600;
