/**
 * SAM Agent constants — configurable via env vars with defaults.
 * See specs/sam-agent/plan.md for architecture details.
 */

/** Default LLM model for SAM agent loop. */
export const DEFAULT_SAM_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

/** Max output tokens per LLM turn. */
export const DEFAULT_SAM_MAX_TOKENS = 4096;

/** Max tool-use loop iterations per message (prevent runaway loops). */
export const DEFAULT_SAM_MAX_TURNS = 20;

/** Max messages per minute per user. */
export const DEFAULT_SAM_RATE_LIMIT_RPM = 30;

/** Rate limit window in seconds. */
export const DEFAULT_SAM_RATE_LIMIT_WINDOW_SECONDS = 60;

/** Max stored conversations per user. */
export const DEFAULT_SAM_MAX_CONVERSATIONS = 100;

/** Max messages per conversation. */
export const DEFAULT_SAM_MAX_MESSAGES_PER_CONVERSATION = 500;

/** Messages sent to LLM per turn (context window). */
export const DEFAULT_SAM_CONVERSATION_CONTEXT_WINDOW = 50;

/** Source tag in cf-aig-metadata for AI Gateway filtering. */
export const DEFAULT_SAM_AIG_SOURCE = 'sam';

/** Anthropic API version header. */
export const SAM_ANTHROPIC_VERSION = '2023-06-01';

/** Resolve SAM config from env with defaults. */
export interface SamConfig {
  model: string;
  maxTokens: number;
  maxTurns: number;
  rateLimitRpm: number;
  rateLimitWindowSeconds: number;
  maxConversations: number;
  maxMessagesPerConversation: number;
  contextWindow: number;
  aigSource: string;
  systemPromptAppend: string;
}

export function resolveSamConfig(env: Record<string, string | undefined>): SamConfig {
  return {
    model: env.SAM_MODEL || DEFAULT_SAM_MODEL,
    maxTokens: parseInt(env.SAM_MAX_TOKENS || '', 10) || DEFAULT_SAM_MAX_TOKENS,
    maxTurns: parseInt(env.SAM_MAX_TURNS || '', 10) || DEFAULT_SAM_MAX_TURNS,
    rateLimitRpm: parseInt(env.SAM_RATE_LIMIT_RPM || '', 10) || DEFAULT_SAM_RATE_LIMIT_RPM,
    rateLimitWindowSeconds: parseInt(env.SAM_RATE_LIMIT_WINDOW_SECONDS || '', 10) || DEFAULT_SAM_RATE_LIMIT_WINDOW_SECONDS,
    maxConversations: parseInt(env.SAM_MAX_CONVERSATIONS || '', 10) || DEFAULT_SAM_MAX_CONVERSATIONS,
    maxMessagesPerConversation: parseInt(env.SAM_MAX_MESSAGES_PER_CONVERSATION || '', 10) || DEFAULT_SAM_MAX_MESSAGES_PER_CONVERSATION,
    contextWindow: parseInt(env.SAM_CONVERSATION_CONTEXT_WINDOW || '', 10) || DEFAULT_SAM_CONVERSATION_CONTEXT_WINDOW,
    aigSource: env.SAM_AIG_SOURCE || DEFAULT_SAM_AIG_SOURCE,
    systemPromptAppend: env.SAM_SYSTEM_PROMPT_APPEND || '',
  };
}
