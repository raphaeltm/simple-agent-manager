// =============================================================================
// AI Task Title Generation
// =============================================================================

/** Default Workers AI model for task title generation. Override via TASK_TITLE_MODEL env var. */
export const DEFAULT_TASK_TITLE_MODEL = '@cf/zai-org/glm-5.2';

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

/** Maximum safe provider-error diagnostic length. Override via TASK_TITLE_ERROR_DIAGNOSTIC_MAX_LENGTH. */
export const DEFAULT_TASK_TITLE_ERROR_DIAGNOSTIC_MAX_LENGTH = 512;
export const MIN_TASK_TITLE_ERROR_DIAGNOSTIC_MAX_LENGTH = 64;
export const MAX_TASK_TITLE_ERROR_DIAGNOSTIC_MAX_LENGTH = 2048;

// =============================================================================
// Context Summarization (Conversation Forking)
// =============================================================================

/** Default Workers AI model for session summarization. Override via CONTEXT_SUMMARY_MODEL env var. */
export const DEFAULT_CONTEXT_SUMMARY_MODEL = '@cf/google/gemma-4-26b-a4b-it';

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
export const DEFAULT_TTS_CLEANUP_MODEL = '@cf/google/gemma-4-26b-a4b-it';

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
 * Out-of-box default is a Cloudflare-billed Workers AI model — no separate provider API key required.
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
export type PlatformAIModelTier = 'low-cost' | 'standard' | 'premium';

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
  /** Budget tier: Cloudflare-billed low-cost, standard, or premium */
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
   * Model identifier for the AI Gateway Unified API.
   * Format: `{provider}/{model-id}` (e.g., `anthropic/claude-sonnet-4-6`).
   *
   * Routing:
   * - Non-null: use Unified API at `.../compat/chat/completions` with `cf-aig-authorization` header
   * - Null (Workers AI): use `.../workers-ai/v1/chat/completions` with `Authorization` header
   */
  unifiedApiModelId: string | null;
}

const ALL_AGENT_SCOPES: ModelAllowedScope[] = ['workspace', 'project', 'top-level'];
const WORKSPACE_PROJECT_SCOPES: ModelAllowedScope[] = ['workspace', 'project'];
const WORKSPACE_ONLY_SCOPES: ModelAllowedScope[] = ['workspace'];

type ModelDefinition = Omit<PlatformAIModel, 'provider' | 'allowedScopes' | 'unifiedApiModelId'> & {
  allowedScopes?: ModelAllowedScope[];
};

function workersAIModel(input: ModelDefinition): PlatformAIModel {
  return {
    ...input,
    provider: 'workers-ai',
    allowedScopes: input.allowedScopes ?? WORKSPACE_ONLY_SCOPES,
    unifiedApiModelId: null,
  };
}

function anthropicModel(input: ModelDefinition): PlatformAIModel {
  return {
    ...input,
    provider: 'anthropic',
    allowedScopes: input.allowedScopes ?? ALL_AGENT_SCOPES,
    unifiedApiModelId: 'anthropic/' + input.id,
  };
}

function openAIModel(input: ModelDefinition): PlatformAIModel {
  return {
    ...input,
    provider: 'openai',
    allowedScopes: input.allowedScopes ?? WORKSPACE_PROJECT_SCOPES,
    unifiedApiModelId: 'openai/' + input.id,
  };
}

const OPENAI_CODEX_PREMIUM_PROFILE = {
  tier: 'premium',
  costPer1kInputTokens: 0.00175,
  costPer1kOutputTokens: 0.014,
  contextWindow: 400000,
  toolCallSupport: 'excellent',
  intendedRole: 'workspace-agent',
  fallbackGroup: 'openai-premium',
} satisfies Pick<
  ModelDefinition,
  | 'tier'
  | 'costPer1kInputTokens'
  | 'costPer1kOutputTokens'
  | 'contextWindow'
  | 'toolCallSupport'
  | 'intendedRole'
  | 'fallbackGroup'
>;

const OPENAI_GPT56_PREVIEW_PROFILE = {
  contextWindow: 1000000,
  toolCallSupport: 'excellent',
  intendedRole: 'workspace-agent',
} satisfies Pick<ModelDefinition, 'contextWindow' | 'toolCallSupport' | 'intendedRole'>;

const OPENAI_GPT56_PREVIEW_MODELS = [
  ['gpt-5.6-sol', 'GPT-5.6 Sol', 'premium', 0.005, 0.03, 'openai-premium'],
  ['gpt-5.6-terra', 'GPT-5.6 Terra', 'premium', 0.0025, 0.015, 'openai-premium'],
  ['gpt-5.6-luna', 'GPT-5.6 Luna', 'standard', 0.001, 0.006, 'openai-standard'],
] as const satisfies readonly [
  string,
  string,
  PlatformAIModelTier,
  number,
  number,
  string,
][];

/** Models available through the SAM Platform AI proxy.
 * This is the single source of truth — the DEFAULT_AI_PROXY_ALLOWED_MODELS
 * string and the UI dropdown both derive from this list.
 * Includes Workers AI (Cloudflare-billed), Anthropic, and OpenAI
 * models routed through Cloudflare AI Gateway with Unified Billing. */
export const PLATFORM_AI_MODELS: PlatformAIModel[] = [
  // --- Workers AI (Cloudflare-billed low-cost tier) ---
  workersAIModel({
    id: '@cf/meta/llama-4-scout-17b-16e-instruct',
    label: 'Llama 4 Scout 17B',
    isDefault: true,
    tier: 'low-cost',
    costPer1kInputTokens: 0.00027,
    costPer1kOutputTokens: 0.00085,
    contextWindow: 131072,
    toolCallSupport: 'limited',
    intendedRole: 'utility',
    fallbackGroup: 'workers-general',
  }),
  workersAIModel({
    id: '@cf/qwen/qwen3-30b-a3b-fp8',
    label: 'Qwen 3 30B',
    tier: 'low-cost',
    costPer1kInputTokens: 0.000051,
    costPer1kOutputTokens: 0.000335,
    contextWindow: 32768,
    toolCallSupport: 'good',
    intendedRole: 'workspace-agent',
    fallbackGroup: 'workers-coding',
  }),
  workersAIModel({
    id: '@cf/qwen/qwen2.5-coder-32b-instruct',
    label: 'Qwen 2.5 Coder 32B',
    tier: 'low-cost',
    costPer1kInputTokens: 0.00066,
    costPer1kOutputTokens: 0.001,
    contextWindow: 32768,
    toolCallSupport: 'good',
    intendedRole: 'workspace-agent',
    fallbackGroup: 'workers-coding',
  }),
  workersAIModel({
    id: '@cf/google/gemma-4-26b-a4b-it',
    label: 'Gemma 4 26B',
    tier: 'low-cost',
    costPer1kInputTokens: 0.0001,
    costPer1kOutputTokens: 0.0003,
    contextWindow: 32768,
    toolCallSupport: 'good',
    intendedRole: 'workspace-agent',
    fallbackGroup: 'workers-coding',
  }),
  workersAIModel({
    id: '@cf/zai-org/glm-5.2',
    label: 'GLM 5.2',
    tier: 'standard',
    costPer1kInputTokens: 0.0014,
    costPer1kOutputTokens: 0.0044,
    contextWindow: 262144,
    toolCallSupport: 'good',
    intendedRole: 'utility',
    fallbackGroup: 'workers-general',
  }),
  // --- Anthropic (via AI Gateway) ---
  anthropicModel({
    id: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    tier: 'standard',
    costPer1kInputTokens: 0.001,
    costPer1kOutputTokens: 0.005,
    contextWindow: 200000,
    toolCallSupport: 'excellent',
    intendedRole: 'utility',
    fallbackGroup: 'anthropic-fast',
  }),
  anthropicModel({
    id: 'claude-sonnet-4-20250514',
    label: 'Claude Sonnet 4',
    tier: 'standard',
    costPer1kInputTokens: 0.003,
    costPer1kOutputTokens: 0.015,
    contextWindow: 200000,
    toolCallSupport: 'excellent',
    intendedRole: 'workspace-agent',
    fallbackGroup: 'anthropic-standard',
  }),
  anthropicModel({
    id: 'claude-sonnet-4-5-20250929',
    label: 'Claude Sonnet 4.5',
    tier: 'standard',
    costPer1kInputTokens: 0.003,
    costPer1kOutputTokens: 0.015,
    contextWindow: 200000,
    toolCallSupport: 'excellent',
    intendedRole: 'workspace-agent',
    fallbackGroup: 'anthropic-standard',
  }),
  anthropicModel({
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    tier: 'standard',
    costPer1kInputTokens: 0.003,
    costPer1kOutputTokens: 0.015,
    contextWindow: 1000000,
    toolCallSupport: 'excellent',
    intendedRole: 'any',
    fallbackGroup: 'anthropic-standard',
  }),
  anthropicModel({
    id: 'claude-opus-4-6',
    label: 'Claude Opus 4.6',
    tier: 'premium',
    costPer1kInputTokens: 0.005,
    costPer1kOutputTokens: 0.025,
    contextWindow: 1000000,
    toolCallSupport: 'excellent',
    intendedRole: 'sam-agent',
    fallbackGroup: 'anthropic-premium',
  }),
  anthropicModel({
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    tier: 'standard',
    costPer1kInputTokens: 0.003,
    costPer1kOutputTokens: 0.015,
    contextWindow: 1000000,
    toolCallSupport: 'excellent',
    intendedRole: 'any',
    fallbackGroup: 'anthropic-standard',
  }),
  anthropicModel({
    id: 'claude-fable-5',
    label: 'Claude Fable 5',
    tier: 'premium',
    costPer1kInputTokens: 0.01,
    costPer1kOutputTokens: 0.05,
    contextWindow: 1000000,
    toolCallSupport: 'excellent',
    intendedRole: 'workspace-agent',
    fallbackGroup: 'anthropic-premium',
  }),
  anthropicModel({
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    tier: 'premium',
    costPer1kInputTokens: 0.005,
    costPer1kOutputTokens: 0.025,
    contextWindow: 1000000,
    toolCallSupport: 'excellent',
    intendedRole: 'sam-agent',
    fallbackGroup: 'anthropic-premium',
  }),
  anthropicModel({
    id: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    tier: 'premium',
    costPer1kInputTokens: 0.005,
    costPer1kOutputTokens: 0.025,
    contextWindow: 1000000,
    toolCallSupport: 'excellent',
    intendedRole: 'sam-agent',
    fallbackGroup: 'anthropic-premium',
  }),
  anthropicModel({
    id: 'claude-opus-4-5-20251101',
    label: 'Claude Opus 4.5',
    tier: 'premium',
    costPer1kInputTokens: 0.005,
    costPer1kOutputTokens: 0.025,
    contextWindow: 200000,
    toolCallSupport: 'excellent',
    intendedRole: 'workspace-agent',
    fallbackGroup: 'anthropic-premium',
  }),
  anthropicModel({
    id: 'claude-opus-4-1-20250805',
    label: 'Claude Opus 4.1',
    tier: 'premium',
    costPer1kInputTokens: 0.015,
    costPer1kOutputTokens: 0.075,
    contextWindow: 200000,
    toolCallSupport: 'excellent',
    intendedRole: 'workspace-agent',
    fallbackGroup: 'anthropic-premium',
  }),
  // --- OpenAI (via AI Gateway) ---
  // GPT-5.6 preview series
  ...OPENAI_GPT56_PREVIEW_MODELS.map(
    ([id, label, tier, costPer1kInputTokens, costPer1kOutputTokens, fallbackGroup]) =>
      openAIModel({
        id,
        label,
        tier,
        costPer1kInputTokens,
        costPer1kOutputTokens,
        ...OPENAI_GPT56_PREVIEW_PROFILE,
        fallbackGroup,
      })
  ),
  // GPT-5.5 series (current flagship)
  openAIModel({
    id: 'gpt-5.5-pro',
    label: 'GPT-5.5 Pro',
    tier: 'premium',
    costPer1kInputTokens: 0.03,
    costPer1kOutputTokens: 0.18,
    contextWindow: 1000000,
    toolCallSupport: 'excellent',
    intendedRole: 'workspace-agent',
    fallbackGroup: 'openai-premium',
  }),
  openAIModel({
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    tier: 'premium',
    costPer1kInputTokens: 0.005,
    costPer1kOutputTokens: 0.03,
    contextWindow: 1000000,
    toolCallSupport: 'excellent',
    intendedRole: 'workspace-agent',
    fallbackGroup: 'openai-premium',
  }),
  // GPT-5.4 series (current)
  openAIModel({
    id: 'gpt-5.4-pro',
    label: 'GPT-5.4 Pro',
    tier: 'premium',
    costPer1kInputTokens: 0.03,
    costPer1kOutputTokens: 0.18,
    contextWindow: 1000000,
    toolCallSupport: 'excellent',
    intendedRole: 'workspace-agent',
    fallbackGroup: 'openai-premium',
  }),
  openAIModel({
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    tier: 'premium',
    costPer1kInputTokens: 0.0025,
    costPer1kOutputTokens: 0.015,
    contextWindow: 1000000,
    toolCallSupport: 'excellent',
    intendedRole: 'workspace-agent',
    fallbackGroup: 'openai-premium',
  }),
  openAIModel({
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    tier: 'standard',
    costPer1kInputTokens: 0.00075,
    costPer1kOutputTokens: 0.0045,
    contextWindow: 400000,
    toolCallSupport: 'excellent',
    intendedRole: 'workspace-agent',
    fallbackGroup: 'openai-standard',
  }),
  openAIModel({
    id: 'gpt-5.4-nano',
    label: 'GPT-5.4 Nano',
    tier: 'standard',
    costPer1kInputTokens: 0.0002,
    costPer1kOutputTokens: 0.00125,
    contextWindow: 400000,
    toolCallSupport: 'excellent',
    intendedRole: 'utility',
    fallbackGroup: 'openai-fast',
  }),
  // GPT-5.3 Codex (current coding model)
  openAIModel({
    id: 'gpt-5.3-codex',
    label: 'GPT-5.3 Codex',
    ...OPENAI_CODEX_PREMIUM_PROFILE,
  }),
  // GPT-5.2 Codex (deprecating Aug 10, 2026)
  openAIModel({
    id: 'gpt-5.2-codex',
    label: 'GPT-5.2 Codex',
    ...OPENAI_CODEX_PREMIUM_PROFILE,
  }),
  // GPT-5.1 Codex series (deprecating Jul 23, 2026)
  openAIModel({
    id: 'gpt-5.1-codex-max',
    label: 'GPT-5.1 Codex Max',
    ...OPENAI_CODEX_PREMIUM_PROFILE,
  }),
  openAIModel({
    id: 'gpt-5.1-codex-mini',
    label: 'GPT-5.1 Codex Mini',
    tier: 'standard',
    costPer1kInputTokens: 0.00075,
    costPer1kOutputTokens: 0.0045,
    contextWindow: 400000,
    toolCallSupport: 'excellent',
    intendedRole: 'workspace-agent',
    fallbackGroup: 'openai-standard',
  }),
  // GPT-5 Mini (deprecating Aug 10, 2026)
  openAIModel({
    id: 'gpt-5-mini',
    label: 'GPT-5 Mini',
    tier: 'standard',
    costPer1kInputTokens: 0.00025,
    costPer1kOutputTokens: 0.002,
    contextWindow: 400000,
    toolCallSupport: 'excellent',
    intendedRole: 'workspace-agent',
    fallbackGroup: 'openai-standard',
  }),
  // Reasoning models (deprecating Oct 23, 2026)
  openAIModel({
    id: 'o4-mini',
    label: 'O4 Mini',
    tier: 'standard',
    costPer1kInputTokens: 0.00055,
    costPer1kOutputTokens: 0.0022,
    contextWindow: 200000,
    toolCallSupport: 'excellent',
    intendedRole: 'workspace-agent',
    fallbackGroup: 'openai-standard',
  }),
  openAIModel({
    id: 'o3',
    label: 'O3',
    tier: 'premium',
    costPer1kInputTokens: 0.002,
    costPer1kOutputTokens: 0.008,
    contextWindow: 200000,
    toolCallSupport: 'excellent',
    intendedRole: 'workspace-agent',
    fallbackGroup: 'openai-premium',
  }),
  // GPT-4.1 (legacy, still available)
  openAIModel({
    id: 'gpt-4.1',
    label: 'GPT-4.1',
    tier: 'standard',
    costPer1kInputTokens: 0.002,
    costPer1kOutputTokens: 0.008,
    contextWindow: 1047576,
    toolCallSupport: 'excellent',
    intendedRole: 'workspace-agent',
    fallbackGroup: 'openai-standard',
  }),
  openAIModel({
    id: 'gpt-4.1-mini',
    label: 'GPT-4.1 Mini',
    tier: 'standard',
    costPer1kInputTokens: 0.0004,
    costPer1kOutputTokens: 0.0016,
    contextWindow: 1047576,
    toolCallSupport: 'excellent',
    intendedRole: 'utility',
    fallbackGroup: 'openai-fast',
  }),
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

/** KV key prefix for cached monthly AI cost per user. Written by cron, read by proxy. */
export const AI_MONTHLY_COST_CACHE_KV_PREFIX = 'ai-monthly-cost';

/** KV key prefix for admin-managed per-user AI allowance ceilings. */
export const AI_ADMIN_ALLOWANCE_KV_PREFIX = 'ai-admin-allowance';

/** Default TTL for cached monthly cost entries — 2 hours (cron runs hourly). Override via AI_MONTHLY_COST_CACHE_TTL_SECONDS env var. */
export const DEFAULT_AI_MONTHLY_COST_CACHE_TTL_SECONDS = 7_200;

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

// =============================================================================
// Sandbox Agent Configuration
// =============================================================================

/** Default model for sandbox-based agent loops. Override via SANDBOX_DEFAULT_MODEL env var. */
export const DEFAULT_SANDBOX_MODEL = '@cf/google/gemma-4-26b-a4b-it';

/** Default max turns for sandbox agent loop. Override via SANDBOX_AGENT_MAX_TURNS env var. */
export const DEFAULT_SANDBOX_AGENT_MAX_TURNS = 20;

/** Minimum tool-call support level required for agent loop participation. */
export const AGENT_LOOP_MIN_TOOL_CALL_SUPPORT: ToolCallSupport = 'good';

/**
 * Filter models suitable for agent loop execution.
 *
 * Returns models with tool-call reliability greater than or equal to `minSupport`
 * and optionally filters by allowed execution scope.
 */
export function filterModelsForAgentLoop(
  models: PlatformAIModel[],
  options?: { scope?: ModelAllowedScope; minSupport?: ToolCallSupport }
): PlatformAIModel[] {
  const minSupport = options?.minSupport ?? AGENT_LOOP_MIN_TOOL_CALL_SUPPORT;
  const supportLevels: ToolCallSupport[] = ['excellent', 'good', 'limited', 'none'];
  const minIndex = supportLevels.indexOf(minSupport);

  return models.filter((model) => {
    const modelIndex = supportLevels.indexOf(model.toolCallSupport);
    if (modelIndex > minIndex) return false;
    if (options?.scope && !model.allowedScopes.includes(options.scope)) return false;
    return true;
  });
}
