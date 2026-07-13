import type { AgentType } from './agents';

// =============================================================================
// Model Catalog — known model IDs per agent type
// =============================================================================

/** A single model definition for the catalog */
export interface ModelDefinition {
  /** The exact model ID string passed to the agent */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Grouping label for UI optgroups */
  group: string;
}

/** Model group with its entries */
export interface ModelGroup {
  label: string;
  models: ModelDefinition[];
}

export type ModelCatalogSource = 'dynamic' | 'cache' | 'static';

export interface ModelCatalogResponse {
  agentType: string;
  groups: ModelGroup[];
  source: ModelCatalogSource;
  updatedAt: string | null;
}

export const OPENCODE_MODELS_DEV_PROVIDER_IDS = ['opencode', 'opencode-go'] as const;
export type OpenCodeModelsDevProviderId = (typeof OPENCODE_MODELS_DEV_PROVIDER_IDS)[number];

/** Codex selectors available through ChatGPT sign-in, not SAM's raw platform AI proxy. */
export const CODEX_CHATGPT_ONLY_MODEL_IDS = ['gpt-5.3-codex-spark'] as const;

function modelGroup(label: string, models: Readonly<Record<string, string>>): ModelGroup {
  return {
    label,
    models: Object.entries(models).map(([id, name]) => ({ id, name, group: label })),
  };
}

// ---------------------------------------------------------------------------
// Claude Code models
// ---------------------------------------------------------------------------

const CLAUDE_MODELS: ModelGroup[] = [
  modelGroup('Claude 5 (Frontier)', {
    'claude-fable-5': 'Claude Fable 5 (1M context)',
    'claude-sonnet-5': 'Claude Sonnet 5 (1M context)',
  }),
  modelGroup('Claude 4 (1M context)', {
    'claude-opus-4-8[1m]': 'Claude Opus 4.8 (1M context)',
    'claude-opus-4-7[1m]': 'Claude Opus 4.7 (1M context)',
    'claude-opus-4-6[1m]': 'Claude Opus 4.6 (1M context)',
    'claude-sonnet-4-6[1m]': 'Claude Sonnet 4.6 (1M context)',
  }),
  modelGroup('Claude 4 (Latest)', {
    'claude-opus-4-8': 'Claude Opus 4.8',
    'claude-opus-4-7': 'Claude Opus 4.7',
    'claude-opus-4-6': 'Claude Opus 4.6',
    'claude-sonnet-4-6': 'Claude Sonnet 4.6',
    'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
  }),
  modelGroup('Claude 4 (Earlier)', {
    'claude-opus-4-5-20251101': 'Claude Opus 4.5',
    'claude-opus-4-1-20250805': 'Claude Opus 4.1 (deprecated; retires Aug 5, 2026)',
    'claude-sonnet-4-5-20250929': 'Claude Sonnet 4.5',
  }),
];

// ---------------------------------------------------------------------------
// OpenAI Codex models
// ---------------------------------------------------------------------------

const CODEX_MODELS: ModelGroup[] = [
  modelGroup('GPT-5 (Latest)', {
    'gpt-5.6-sol': 'GPT-5.6 Sol',
    'gpt-5.6-terra': 'GPT-5.6 Terra',
    'gpt-5.6-luna': 'GPT-5.6 Luna',
    'gpt-5.5-pro': 'GPT-5.5 Pro',
    'gpt-5.5': 'GPT-5.5',
    'gpt-5.4-pro': 'GPT-5.4 Pro',
    'gpt-5.4': 'GPT-5.4',
    'gpt-5.4-mini': 'GPT-5.4 Mini',
    'gpt-5.4-nano': 'GPT-5.4 Nano',
  }),
  modelGroup('Codex Preview (ChatGPT)', {
    'gpt-5.3-codex-spark': 'GPT-5.3 Codex Spark (ChatGPT Pro preview)',
  }),
  modelGroup('Reasoning', {
    'o4-mini': 'O4 Mini',
    o3: 'O3',
  }),
  modelGroup('GPT-5 (Legacy)', {
    'gpt-5.3-codex': 'GPT-5.3 Codex (deprecated for ChatGPT sign-in)',
    'gpt-5.2-codex': 'GPT-5.2 Codex (deprecated for ChatGPT sign-in)',
    'gpt-5.1-codex-max': 'GPT-5.1 Codex Max',
    'gpt-5.1-codex-mini': 'GPT-5.1 Codex Mini',
    'gpt-5-mini': 'GPT-5 Mini',
  }),
  modelGroup('GPT-4.1 (Legacy)', {
    'gpt-4.1': 'GPT-4.1',
    'gpt-4.1-mini': 'GPT-4.1 Mini',
  }),
];

// ---------------------------------------------------------------------------
// OpenCode models
// ---------------------------------------------------------------------------

const OPENCODE_MODELS: ModelGroup[] = [
  modelGroup('OpenCode Zen', {
    'opencode/big-pickle': 'Big Pickle',
    'opencode/claude-fable-5': 'Claude Fable 5',
    'opencode/claude-haiku-4-5': 'Claude Haiku 4.5',
    'opencode/claude-opus-4-1': 'Claude Opus 4.1',
    'opencode/claude-opus-4-5': 'Claude Opus 4.5',
    'opencode/claude-opus-4-6': 'Claude Opus 4.6',
    'opencode/claude-opus-4-7': 'Claude Opus 4.7',
    'opencode/claude-opus-4-8': 'Claude Opus 4.8',
    'opencode/claude-sonnet-4': 'Claude Sonnet 4',
    'opencode/claude-sonnet-4-5': 'Claude Sonnet 4.5',
    'opencode/claude-sonnet-4-6': 'Claude Sonnet 4.6',
    'opencode/claude-sonnet-5': 'Claude Sonnet 5',
    'opencode/deepseek-v4-flash': 'DeepSeek V4 Flash',
    'opencode/deepseek-v4-flash-free': 'DeepSeek V4 Flash Free',
    'opencode/deepseek-v4-pro': 'DeepSeek V4 Pro',
    'opencode/gemini-3-flash': 'Gemini 3 Flash',
    'opencode/gemini-3.1-pro': 'Gemini 3.1 Pro Preview',
    'opencode/gemini-3.5-flash': 'Gemini 3.5 Flash',
    'opencode/glm-5': 'GLM-5',
    'opencode/glm-5.1': 'GLM-5.1',
    'opencode/glm-5.2': 'GLM-5.2',
    'opencode/gpt-5': 'GPT-5',
    'opencode/gpt-5-codex': 'GPT-5 Codex',
    'opencode/gpt-5-nano': 'GPT-5 Nano',
    'opencode/gpt-5.1': 'GPT-5.1',
    'opencode/gpt-5.1-codex': 'GPT-5.1 Codex',
    'opencode/gpt-5.1-codex-max': 'GPT-5.1 Codex Max',
    'opencode/gpt-5.1-codex-mini': 'GPT-5.1 Codex Mini',
    'opencode/gpt-5.2': 'GPT-5.2',
    'opencode/gpt-5.2-codex': 'GPT-5.2 Codex',
    'opencode/gpt-5.3-codex': 'GPT-5.3 Codex',
    'opencode/gpt-5.3-codex-spark': 'GPT-5.3 Codex Spark',
    'opencode/gpt-5.4': 'GPT-5.4',
    'opencode/gpt-5.4-mini': 'GPT-5.4 Mini',
    'opencode/gpt-5.4-nano': 'GPT-5.4 Nano',
    'opencode/gpt-5.4-pro': 'GPT-5.4 Pro',
    'opencode/gpt-5.5': 'GPT-5.5',
    'opencode/gpt-5.5-pro': 'GPT-5.5 Pro',
    'opencode/gpt-5.6-luna': 'GPT-5.6 Luna',
    'opencode/gpt-5.6-sol': 'GPT-5.6 Sol',
    'opencode/gpt-5.6-terra': 'GPT-5.6 Terra',
    'opencode/grok-4.5': 'Grok 4.5',
    'opencode/grok-build-0.1': 'Grok Build 0.1',
    'opencode/hy3-free': 'Hy3 Free',
    'opencode/kimi-k2.5': 'Kimi K2.5',
    'opencode/kimi-k2.6': 'Kimi K2.6',
    'opencode/kimi-k2.7-code': 'Kimi K2.7 Code',
    'opencode/mimo-v2.5-free': 'MiMo V2.5 Free',
    'opencode/minimax-m2.5': 'MiniMax-M2.5',
    'opencode/minimax-m2.7': 'MiniMax-M2.7',
    'opencode/minimax-m3': 'MiniMax-M3',
    'opencode/nemotron-3-ultra-free': 'Nemotron 3 Ultra Free',
    'opencode/north-mini-code-free': 'North Mini Code Free',
    'opencode/qwen3.5-plus': 'Qwen3.5 Plus',
    'opencode/qwen3.6-plus': 'Qwen3.6 Plus',
  }),
  modelGroup('OpenCode Go', {
    'opencode-go/deepseek-v4-flash': 'DeepSeek V4 Flash',
    'opencode-go/deepseek-v4-pro': 'DeepSeek V4 Pro',
    'opencode-go/glm-5.1': 'GLM-5.1',
    'opencode-go/glm-5.2': 'GLM-5.2',
    'opencode-go/kimi-k2.6': 'Kimi K2.6',
    'opencode-go/kimi-k2.7-code': 'Kimi K2.7 Code',
    'opencode-go/mimo-v2.5': 'MiMo V2.5',
    'opencode-go/mimo-v2.5-pro': 'MiMo V2.5 Pro',
    'opencode-go/minimax-m2.7': 'MiniMax-M2.7',
    'opencode-go/minimax-m3': 'MiniMax-M3',
    'opencode-go/qwen3.6-plus': 'Qwen3.6 Plus',
    'opencode-go/qwen3.7-max': 'Qwen3.7 Max',
    'opencode-go/qwen3.7-plus': 'Qwen3.7 Plus',
  }),
];

// ---------------------------------------------------------------------------
// Mistral Vibe models
// ---------------------------------------------------------------------------

const MISTRAL_MODELS: ModelGroup[] = [
  modelGroup('Frontier (Latest)', {
    'mistral-medium-3-5-2604': 'Mistral Medium 3.5',
    'mistral-small-2603': 'Mistral Small 4',
    'mistral-large-2512': 'Mistral Large 3',
  }),
  modelGroup('Coding', { 'codestral-2508': 'Codestral' }),
  modelGroup('Legacy / Deprecated', {
    'mistral-medium-2508': 'Mistral Medium 3.1 (legacy)',
    'devstral-2512': 'Devstral 2 (deprecated)',
    'magistral-medium-2509': 'Magistral Medium 1.2 (deprecated)',
  }),
  modelGroup('Edge / Efficient', {
    'ministral-14b-2512': 'Ministral 3 14B',
    'ministral-8b-2512': 'Ministral 3 8B',
    'ministral-3b-2512': 'Ministral 3 3B',
  }),
];

// ---------------------------------------------------------------------------
// Google Gemini models
// ---------------------------------------------------------------------------

const GEMINI_MODELS: ModelGroup[] = [
  modelGroup('Gemini 3 (Latest)', {
    'gemini-3.5-flash': 'Gemini 3.5 Flash',
    'gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview',
    'gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite',
  }),
  modelGroup('Gemini 2.5 (Retiring Oct 16, 2026)', {
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
    'gemini-2.5-flash': 'Gemini 2.5 Flash',
    'gemini-2.5-flash-lite': 'Gemini 2.5 Flash-Lite',
  }),
];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Model catalog keyed by agent type. Agents not listed here have no known models. */
const MODEL_CATALOG: Partial<Record<AgentType, ModelGroup[]>> = {
  'claude-code': CLAUDE_MODELS,
  'openai-codex': CODEX_MODELS,
  'mistral-vibe': MISTRAL_MODELS,
  'google-gemini': GEMINI_MODELS,
  opencode: OPENCODE_MODELS,
};

/** Get the model groups for a given agent type. Returns empty array if none defined. */
export function getModelGroupsForAgent(agentType: string): ModelGroup[] {
  return MODEL_CATALOG[agentType as AgentType] ?? [];
}

/** Get a flat list of all model definitions for a given agent type. */
export function getModelsForAgent(agentType: string): ModelDefinition[] {
  return getModelGroupsForAgent(agentType).flatMap((g) => g.models);
}

/** Check if a model ID is in the catalog for a given agent type. */
export function isKnownModel(agentType: string, modelId: string): boolean {
  return getModelsForAgent(agentType).some((m) => m.id === modelId);
}
