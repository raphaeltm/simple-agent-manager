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

function modelGroup(label: string, models: Array<Omit<ModelDefinition, 'group'>>): ModelGroup {
  return {
    label,
    models: models.map((model) => ({ ...model, group: label })),
  };
}

function modelGroupFromTuples(
  label: string,
  entries: Array<readonly [id: string, name: string]>
): ModelGroup {
  return modelGroup(
    label,
    entries.map(([id, name]) => ({ id, name }))
  );
}

// ---------------------------------------------------------------------------
// Claude Code models
// ---------------------------------------------------------------------------

const CLAUDE_MODELS: ModelGroup[] = [
  {
    label: 'Claude 5 (Frontier)',
    models: [
      { id: 'claude-fable-5', name: 'Claude Fable 5 (1M context)', group: 'Claude 5 (Frontier)' },
      { id: 'claude-opus-5', name: 'Claude Opus 5 (1M context)', group: 'Claude 5 (Frontier)' },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 (1M context)', group: 'Claude 5 (Frontier)' },
    ],
  },
  {
    label: 'Claude 4 (1M context)',
    models: [
      {
        id: 'claude-opus-4-8[1m]',
        name: 'Claude Opus 4.8 (1M context)',
        group: 'Claude 4 (1M context)',
      },
      {
        id: 'claude-opus-4-7[1m]',
        name: 'Claude Opus 4.7 (1M context)',
        group: 'Claude 4 (1M context)',
      },
      {
        id: 'claude-opus-4-6[1m]',
        name: 'Claude Opus 4.6 (1M context)',
        group: 'Claude 4 (1M context)',
      },
      {
        id: 'claude-sonnet-4-6[1m]',
        name: 'Claude Sonnet 4.6 (1M context)',
        group: 'Claude 4 (1M context)',
      },
    ],
  },
  {
    label: 'Claude 4 (Latest)',
    models: [
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', group: 'Claude 4 (Latest)' },
      { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', group: 'Claude 4 (Latest)' },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', group: 'Claude 4 (Latest)' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', group: 'Claude 4 (Latest)' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', group: 'Claude 4 (Latest)' },
    ],
  },
  modelGroup('Claude 4 (Legacy)', [
    { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5' },
    { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
  ]),
];

// ---------------------------------------------------------------------------
// OpenAI Codex models
// ---------------------------------------------------------------------------

const CODEX_MODELS: ModelGroup[] = [
  modelGroup('GPT-5 (Latest)', [
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol (Preview)' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra (Preview)' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna (Preview)' },
    { id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro' },
    { id: 'gpt-5.5', name: 'GPT-5.5' },
    { id: 'gpt-5.4-pro', name: 'GPT-5.4 Pro' },
    { id: 'gpt-5.4', name: 'GPT-5.4' },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
    { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano' },
  ]),
  modelGroup('Codex (Current)', [{ id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' }]),
  {
    label: 'Reasoning',
    models: [{ id: 'o3', name: 'O3', group: 'Reasoning' }],
  },
  {
    label: 'Deprecated',
    models: [
      { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex (Deprecated)', group: 'Deprecated' },
      {
        id: 'gpt-5.1-codex-max',
        name: 'GPT-5.1 Codex Max (Deprecated)',
        group: 'Deprecated',
      },
      {
        id: 'gpt-5.1-codex-mini',
        name: 'GPT-5.1 Codex Mini (Deprecated)',
        group: 'Deprecated',
      },
      { id: 'o4-mini', name: 'O4 Mini (Deprecated)', group: 'Deprecated' },
    ],
  },
  modelGroup('GPT-5 (Previous)', [{ id: 'gpt-5-mini', name: 'GPT-5 Mini' }]),
  {
    label: 'GPT-4.1 (Legacy)',
    models: [
      { id: 'gpt-4.1', name: 'GPT-4.1', group: 'GPT-4.1 (Legacy)' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', group: 'GPT-4.1 (Legacy)' },
    ],
  },
];

// ---------------------------------------------------------------------------
// OpenCode models
// ---------------------------------------------------------------------------

const OPENCODE_MODELS: ModelGroup[] = [
  modelGroup('OpenCode Zen', [
    { id: 'opencode/big-pickle', name: 'Big Pickle' },
    { id: 'opencode/claude-fable-5', name: 'Claude Fable 5' },
    { id: 'opencode/claude-haiku-4-5', name: 'Claude Haiku 4.5' },
    { id: 'opencode/claude-opus-4-5', name: 'Claude Opus 4.5' },
    { id: 'opencode/claude-opus-4-6', name: 'Claude Opus 4.6' },
    { id: 'opencode/claude-opus-4-7', name: 'Claude Opus 4.7' },
    { id: 'opencode/claude-opus-4-8', name: 'Claude Opus 4.8' },
    { id: 'opencode/claude-opus-5', name: 'Claude Opus 5' },
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
    { id: 'opencode/gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite' },
    { id: 'opencode/gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
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
    { id: 'opencode/kimi-k2.5', name: 'Kimi K2.5' },
    { id: 'opencode/kimi-k2.6', name: 'Kimi K2.6' },
    { id: 'opencode/kimi-k2.7-code', name: 'Kimi K2.7 Code' },
    { id: 'opencode/kimi-k3', name: 'Kimi K3' },
    { id: 'opencode/laguna-s-2.1-free', name: 'Laguna S 2.1 Free' },
    { id: 'opencode/ling-3.0-tiny-free', name: 'Ling-3.0-tiny Free' },
    { id: 'opencode/longcat-2.0-free', name: 'LongCat-2.0 Free' },
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
    { id: 'opencode-go/deepseek-v4-flash', name: 'DeepSeek V4 Flash (2x usage)' },
    { id: 'opencode-go/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    { id: 'opencode-go/glm-5.1', name: 'GLM-5.1' },
    { id: 'opencode-go/glm-5.2', name: 'GLM-5.2' },
    { id: 'opencode-go/gpt-5.6-luna', name: 'GPT-5.6 Luna (2x usage)' },
    { id: 'opencode-go/grok-4.5', name: 'Grok 4.5' },
    { id: 'opencode-go/hy3', name: 'Hy3' },
    { id: 'opencode-go/kimi-k2.6', name: 'Kimi K2.6' },
    { id: 'opencode-go/kimi-k2.7-code', name: 'Kimi K2.7 Code' },
    { id: 'opencode-go/kimi-k3', name: 'Kimi K3' },
    { id: 'opencode-go/mimo-v2.5', name: 'MiMo V2.5' },
    { id: 'opencode-go/mimo-v2.5-pro', name: 'MiMo V2.5 Pro' },
    { id: 'opencode-go/minimax-m2.7', name: 'MiniMax-M2.7' },
    { id: 'opencode-go/minimax-m3', name: 'MiniMax-M3' },
    { id: 'opencode-go/qwen3.6-plus', name: 'Qwen3.6 Plus' },
    { id: 'opencode-go/qwen3.7-max', name: 'Qwen3.7 Max' },
    { id: 'opencode-go/qwen3.7-plus', name: 'Qwen3.7 Plus' },
    { id: 'opencode-go/qwen3.8-max', name: 'Qwen3.8 Max' },
  ]),
];

// ---------------------------------------------------------------------------
// Mistral Vibe models
// ---------------------------------------------------------------------------

const MISTRAL_MODELS: ModelGroup[] = [
  {
    label: 'Frontier (Latest)',
    models: [
      { id: 'mistral-medium-3-5', name: 'Mistral Medium 3.5', group: 'Frontier (Latest)' },
      { id: 'mistral-small-2603', name: 'Mistral Small 4', group: 'Frontier (Latest)' },
      { id: 'mistral-large-2512', name: 'Mistral Large 3', group: 'Frontier (Latest)' },
    ],
  },
  {
    label: 'Coding (Recommended)',
    models: [{ id: 'codestral-2508', name: 'Codestral', group: 'Coding (Recommended)' }],
  },
  {
    label: 'Edge / Efficient',
    models: [
      { id: 'ministral-14b-2512', name: 'Ministral 3 14B', group: 'Edge / Efficient' },
      { id: 'ministral-8b-2512', name: 'Ministral 3 8B', group: 'Edge / Efficient' },
      { id: 'ministral-3b-2512', name: 'Ministral 3 3B', group: 'Edge / Efficient' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Google Gemini models
// ---------------------------------------------------------------------------

const GEMINI_MODELS: ModelGroup[] = [
  modelGroupFromTuples('Gemini 3 (Latest)', [
    ['gemini-3.6-flash', 'Gemini 3.6 Flash'],
    ['gemini-3.5-flash', 'Gemini 3.5 Flash'],
    ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite'],
    ['gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview'],
    ['gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite'],
  ]),
  {
    label: 'Gemini 2.5 (Retires Oct 16)',
    models: [
      {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro (retires Oct 16)',
        group: 'Gemini 2.5 (Retires Oct 16)',
      },
      {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash (retires Oct 16)',
        group: 'Gemini 2.5 (Retires Oct 16)',
      },
    ],
  },
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
