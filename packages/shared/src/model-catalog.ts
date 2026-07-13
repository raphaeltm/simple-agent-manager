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

function modelGroup(label: string, models: Array<Omit<ModelDefinition, 'group'>>): ModelGroup {
  return {
    label,
    models: models.map((model) => ({ ...model, group: label })),
  };
}

// ---------------------------------------------------------------------------
// Claude Code models
// ---------------------------------------------------------------------------

const CLAUDE_MODELS: ModelGroup[] = [
  modelGroup('Claude 5 (Frontier)', [
    { id: 'claude-fable-5', name: 'Claude Fable 5 (1M context)' },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 (1M context)' },
  ]),
  modelGroup('Claude 4 (1M context)', [
    { id: 'claude-opus-4-8[1m]', name: 'Claude Opus 4.8 (1M context)' },
    { id: 'claude-opus-4-7[1m]', name: 'Claude Opus 4.7 (1M context)' },
    { id: 'claude-opus-4-6[1m]', name: 'Claude Opus 4.6 (1M context)' },
    { id: 'claude-sonnet-4-6[1m]', name: 'Claude Sonnet 4.6 (1M context)' },
  ]),
  modelGroup('Claude 4 (Latest)', [
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
    { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
  ]),
  modelGroup('Claude 4 (Earlier)', [
    { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5' },
    {
      id: 'claude-opus-4-1-20250805',
      name: 'Claude Opus 4.1 (deprecated; retires Aug 5, 2026)',
    },
    { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
  ]),
];

// ---------------------------------------------------------------------------
// OpenAI Codex models
// ---------------------------------------------------------------------------

const CODEX_MODELS: ModelGroup[] = [
  modelGroup('GPT-5 (Latest)', [
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
    { id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro' },
    { id: 'gpt-5.5', name: 'GPT-5.5' },
    { id: 'gpt-5.4-pro', name: 'GPT-5.4 Pro' },
    { id: 'gpt-5.4', name: 'GPT-5.4' },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
    { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano' },
  ]),
  modelGroup('Codex Preview (ChatGPT)', [
    { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark (ChatGPT Pro preview)' },
  ]),
  modelGroup('Reasoning', [
    { id: 'o4-mini', name: 'O4 Mini' },
    { id: 'o3', name: 'O3' },
  ]),
  modelGroup('GPT-5 (Legacy)', [
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex (deprecated for ChatGPT sign-in)' },
    { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex (deprecated for ChatGPT sign-in)' },
    { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max' },
    { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini' },
    { id: 'gpt-5-mini', name: 'GPT-5 Mini' },
  ]),
  modelGroup('GPT-4.1 (Legacy)', [
    { id: 'gpt-4.1', name: 'GPT-4.1' },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
  ]),
];

// ---------------------------------------------------------------------------
// OpenCode models
// ---------------------------------------------------------------------------

const OPENCODE_MODELS: ModelGroup[] = [
  modelGroup('OpenCode Zen', [
    { id: 'opencode/big-pickle', name: 'Big Pickle' },
    { id: 'opencode/claude-fable-5', name: 'Claude Fable 5' },
    { id: 'opencode/claude-haiku-4-5', name: 'Claude Haiku 4.5' },
    { id: 'opencode/claude-opus-4-1', name: 'Claude Opus 4.1' },
    { id: 'opencode/claude-opus-4-5', name: 'Claude Opus 4.5' },
    { id: 'opencode/claude-opus-4-6', name: 'Claude Opus 4.6' },
    { id: 'opencode/claude-opus-4-7', name: 'Claude Opus 4.7' },
    { id: 'opencode/claude-opus-4-8', name: 'Claude Opus 4.8' },
    { id: 'opencode/claude-sonnet-4', name: 'Claude Sonnet 4' },
    { id: 'opencode/claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
    { id: 'opencode/claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    { id: 'opencode/claude-sonnet-5', name: 'Claude Sonnet 5' },
    { id: 'opencode/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'opencode/deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free' },
    { id: 'opencode/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    { id: 'opencode/gemini-3-flash', name: 'Gemini 3 Flash' },
    { id: 'opencode/gemini-3.1-pro', name: 'Gemini 3.1 Pro Preview' },
    { id: 'opencode/gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
    { id: 'opencode/glm-5', name: 'GLM-5' },
    { id: 'opencode/glm-5.1', name: 'GLM-5.1' },
    { id: 'opencode/glm-5.2', name: 'GLM-5.2' },
    { id: 'opencode/gpt-5', name: 'GPT-5' },
    { id: 'opencode/gpt-5-codex', name: 'GPT-5 Codex' },
    { id: 'opencode/gpt-5-nano', name: 'GPT-5 Nano' },
    { id: 'opencode/gpt-5.1', name: 'GPT-5.1' },
    { id: 'opencode/gpt-5.1-codex', name: 'GPT-5.1 Codex' },
    { id: 'opencode/gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max' },
    { id: 'opencode/gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini' },
    { id: 'opencode/gpt-5.2', name: 'GPT-5.2' },
    { id: 'opencode/gpt-5.2-codex', name: 'GPT-5.2 Codex' },
    { id: 'opencode/gpt-5.3-codex', name: 'GPT-5.3 Codex' },
    { id: 'opencode/gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark' },
    { id: 'opencode/gpt-5.4', name: 'GPT-5.4' },
    { id: 'opencode/gpt-5.4-mini', name: 'GPT-5.4 Mini' },
    { id: 'opencode/gpt-5.4-nano', name: 'GPT-5.4 Nano' },
    { id: 'opencode/gpt-5.4-pro', name: 'GPT-5.4 Pro' },
    { id: 'opencode/gpt-5.5', name: 'GPT-5.5' },
    { id: 'opencode/gpt-5.5-pro', name: 'GPT-5.5 Pro' },
    { id: 'opencode/gpt-5.6-luna', name: 'GPT-5.6 Luna' },
    { id: 'opencode/gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    { id: 'opencode/gpt-5.6-terra', name: 'GPT-5.6 Terra' },
    { id: 'opencode/grok-4.5', name: 'Grok 4.5' },
    { id: 'opencode/grok-build-0.1', name: 'Grok Build 0.1' },
    { id: 'opencode/hy3-free', name: 'Hy3 Free' },
    { id: 'opencode/kimi-k2.5', name: 'Kimi K2.5' },
    { id: 'opencode/kimi-k2.6', name: 'Kimi K2.6' },
    { id: 'opencode/kimi-k2.7-code', name: 'Kimi K2.7 Code' },
    { id: 'opencode/mimo-v2.5-free', name: 'MiMo V2.5 Free' },
    { id: 'opencode/minimax-m2.5', name: 'MiniMax-M2.5' },
    { id: 'opencode/minimax-m2.7', name: 'MiniMax-M2.7' },
    { id: 'opencode/minimax-m3', name: 'MiniMax-M3' },
    { id: 'opencode/nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free' },
    { id: 'opencode/north-mini-code-free', name: 'North Mini Code Free' },
    { id: 'opencode/qwen3.5-plus', name: 'Qwen3.5 Plus' },
    { id: 'opencode/qwen3.6-plus', name: 'Qwen3.6 Plus' },
  ]),
  modelGroup('OpenCode Go', [
    { id: 'opencode-go/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'opencode-go/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    { id: 'opencode-go/glm-5.1', name: 'GLM-5.1' },
    { id: 'opencode-go/glm-5.2', name: 'GLM-5.2' },
    { id: 'opencode-go/kimi-k2.6', name: 'Kimi K2.6' },
    { id: 'opencode-go/kimi-k2.7-code', name: 'Kimi K2.7 Code' },
    { id: 'opencode-go/mimo-v2.5', name: 'MiMo V2.5' },
    { id: 'opencode-go/mimo-v2.5-pro', name: 'MiMo V2.5 Pro' },
    { id: 'opencode-go/minimax-m2.7', name: 'MiniMax-M2.7' },
    { id: 'opencode-go/minimax-m3', name: 'MiniMax-M3' },
    { id: 'opencode-go/qwen3.6-plus', name: 'Qwen3.6 Plus' },
    { id: 'opencode-go/qwen3.7-max', name: 'Qwen3.7 Max' },
    { id: 'opencode-go/qwen3.7-plus', name: 'Qwen3.7 Plus' },
  ]),
];

// ---------------------------------------------------------------------------
// Mistral Vibe models
// ---------------------------------------------------------------------------

const MISTRAL_MODELS: ModelGroup[] = [
  modelGroup('Frontier (Latest)', [
    { id: 'mistral-medium-3-5-2604', name: 'Mistral Medium 3.5' },
    { id: 'mistral-small-2603', name: 'Mistral Small 4' },
    { id: 'mistral-large-2512', name: 'Mistral Large 3' },
  ]),
  modelGroup('Coding', [{ id: 'codestral-2508', name: 'Codestral' }]),
  modelGroup('Legacy / Deprecated', [
    { id: 'mistral-medium-2508', name: 'Mistral Medium 3.1 (legacy)' },
    { id: 'devstral-2512', name: 'Devstral 2 (deprecated)' },
    { id: 'magistral-medium-2509', name: 'Magistral Medium 1.2 (deprecated)' },
  ]),
  modelGroup('Edge / Efficient', [
    { id: 'ministral-14b-2512', name: 'Ministral 3 14B' },
    { id: 'ministral-8b-2512', name: 'Ministral 3 8B' },
    { id: 'ministral-3b-2512', name: 'Ministral 3 3B' },
  ]),
];

// ---------------------------------------------------------------------------
// Google Gemini models
// ---------------------------------------------------------------------------

const GEMINI_MODELS: ModelGroup[] = [
  modelGroup('Gemini 3 (Latest)', [
    { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview' },
    { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite' },
  ]),
  modelGroup('Gemini 2.5 (Retiring Oct 16, 2026)', [
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite' },
  ]),
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
