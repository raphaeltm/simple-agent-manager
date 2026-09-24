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
      {
        id: 'claude-fable-5-1',
        name: 'Claude Fable 5.1 (1M context)',
        group: 'Claude 5 (Frontier)',
      },
      { id: 'claude-fable-5', name: 'Claude Fable 5 (1M context)', group: 'Claude 5 (Frontier)' },
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 (1M context)', group: 'Claude 5 (Frontier)' },
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
  modelGroup('Claude 4 (Previous)', [
    { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5' },
    { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
  ]),
];

// ---------------------------------------------------------------------------
// OpenAI Codex models
// ---------------------------------------------------------------------------

const CODEX_MODELS: ModelGroup[] = [
  modelGroup('GPT-6 (Latest)', [
    { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
    { id: 'gpt-6-sol', name: 'GPT-6 Sol' },
    { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
  ]),
  modelGroup('GPT-5.6 (Previous)', [
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
  ]),
  modelGroup('GPT-5.5 / 5.2 (Previous)', [
    { id: 'gpt-5.5', name: 'GPT-5.5' },
    { id: 'gpt-5.2', name: 'GPT-5.2' },
  ]),
  modelGroup('GPT-5.4 (Legacy, hidden upstream)', [
    { id: 'gpt-5.4', name: 'GPT-5.4 (Legacy)' },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini (Legacy)' },
  ]),
];

// ---------------------------------------------------------------------------
// OpenCode models
// ---------------------------------------------------------------------------

const OPENCODE_MODELS: ModelGroup[] = [
  modelGroup('OpenCode Zen', [
    { id: 'opencode/ling-3.0-flash-fin-free', name: 'Ling 3.0 Flash Fin Free' },
    { id: 'opencode/gpt-5.4', name: 'GPT-5.4' },
    { id: 'opencode/claude-haiku-4-5', name: 'Claude Haiku 4.5' },
    { id: 'opencode/gpt-5.4-pro', name: 'GPT-5.4 Pro' },
    { id: 'opencode/muse-spark-1.2-contributor-free', name: 'Muse Spark 1.2 Free' },
    { id: 'opencode/muse-spark-1.3', name: 'Muse Spark 1.3' },
    { id: 'opencode/gpt-5.5-pro', name: 'GPT-5.5 Pro' },
    { id: 'opencode/grok-4.7', name: 'Grok 4.7 (30% Off)' },
    { id: 'opencode/gpt-5.4-nano', name: 'GPT-5.4 Nano' },
    { id: 'opencode/gpt-5.2-codex', name: 'GPT-5.2 Codex' },
    { id: 'opencode/gpt-5.1-codex', name: 'GPT-5.1 Codex' },
    { id: 'opencode/glm-5.3-flash', name: 'GLM-5.3-Flash' },
    { id: 'opencode/kimi-k3', name: 'Kimi K3' },
    { id: 'opencode/gpt-5-codex', name: 'GPT-5 Codex' },
    { id: 'opencode/qwen3.5-plus', name: 'Qwen3.5 Plus' },
    { id: 'opencode/claude-opus-4-5', name: 'Claude Opus 4.5' },
    { id: 'opencode/glm-5', name: 'GLM-5' },
    { id: 'opencode/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
    { id: 'opencode/gpt-5.3-codex', name: 'GPT-5.3 Codex' },
    { id: 'opencode/minimax-m2.5', name: 'MiniMax-M2.5' },
    { id: 'opencode/gpt-5-nano', name: 'GPT-5 Nano' },
    { id: 'opencode/deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp' },
    { id: 'opencode/kimi-k2.6', name: 'Kimi K2.6' },
    { id: 'opencode/claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
    { id: 'opencode/claude-opus-5-5', name: 'Claude Opus 5.5' },
    { id: 'opencode/claude-fable-5-1', name: 'Claude Fable 5.1' },
    { id: 'opencode/gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
    { id: 'opencode/gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark' },
    { id: 'opencode/gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite' },
    { id: 'opencode/gpt-6-astra', name: 'GPT-6 Astra' },
    { id: 'opencode/grok-4.5', name: 'Grok 4.5' },
    { id: 'opencode/kimi-k2.5', name: 'Kimi K2.5' },
    { id: 'opencode/gpt-5.1', name: 'GPT-5.1' },
    { id: 'opencode/claude-opus-5', name: 'Claude Opus 5' },
    { id: 'opencode/gemini-3-flash', name: 'Gemini 3 Flash' },
    { id: 'opencode/minimax-m2.7', name: 'MiniMax-M2.7' },
    { id: 'opencode/gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
    { id: 'opencode/space-bunny-free', name: 'Space Bunny Free' },
    { id: 'opencode/claude-fable-5', name: 'Claude Fable 5' },
    { id: 'opencode/mimo-v2.6-flash-free', name: 'MiMo-V2.6-Flash Free' },
    { id: 'opencode/nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free' },
    { id: 'opencode/claude-sonnet-4', name: 'Claude Sonnet 4' },
    { id: 'opencode/muse-spark-1.2', name: 'Muse Spark 1.2' },
    { id: 'opencode/gpt-5.4-mini', name: 'GPT-5.4 Mini' },
    { id: 'opencode/minimax-m3', name: 'MiniMax-M3' },
    { id: 'opencode/gpt-5.6-luna', name: 'GPT-5.6 Luna' },
    { id: 'opencode/qwen3.8-flash', name: 'Qwen3.8 Flash' },
    { id: 'opencode/gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max' },
    { id: 'opencode/gpt-5.2', name: 'GPT-5.2' },
    { id: 'opencode/claude-opus-4-8', name: 'Claude Opus 4.8' },
    { id: 'opencode/gpt-5.5', name: 'GPT-5.5' },
    { id: 'opencode/claude-sonnet-5', name: 'Claude Sonnet 5' },
    { id: 'opencode/nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning Free' },
    { id: 'opencode/claude-opus-4-6', name: 'Claude Opus 4.6' },
    { id: 'opencode/gemini-3.7-flash', name: 'Gemini 3.7 Flash' },
    { id: 'opencode/glm-5.2', name: 'GLM-5.2' },
    { id: 'opencode/glm-5.1', name: 'GLM-5.1' },
    { id: 'opencode/grok-build-0.1', name: 'Grok Build 0.1' },
    { id: 'opencode/gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    { id: 'opencode/gpt-6-luna', name: 'GPT-6 Luna' },
    { id: 'opencode/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    { id: 'opencode/claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    { id: 'opencode/big-pickle', name: 'Big Pickle' },
    { id: 'opencode/qwen3.6-plus', name: 'Qwen3.6 Plus' },
    { id: 'opencode/gpt-5.6-terra', name: 'GPT-5.6 Terra' },
    { id: 'opencode/gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini' },
    { id: 'opencode/glm-5.3', name: 'GLM-5.3' },
    { id: 'opencode/claude-opus-4-7', name: 'Claude Opus 4.7' },
    { id: 'opencode/kimi-k2.7-code', name: 'Kimi K2.7 Code' },
    { id: 'opencode/gpt-5', name: 'GPT-5' },
    { id: 'opencode/grok-4.6', name: 'Grok 4.6' },
    { id: 'opencode/gemini-3.1-pro', name: 'Gemini 3.1 Pro Preview' },
    { id: 'opencode/gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    { id: 'opencode/muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3 Free' },
    { id: 'opencode/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'opencode/gpt-6-sol', name: 'GPT-6 Sol' },
  ]),
  modelGroup('OpenCode Go', [
    { id: 'opencode-go/mimo-v2.6-pro', name: 'MiMo-V2.6-Pro' },
    { id: 'opencode-go/qwen3.7-max', name: 'Qwen3.7 Max' },
    { id: 'opencode-go/mimo-v2.5', name: 'MiMo V2.5' },
    { id: 'opencode-go/grok-4.7', name: 'Grok 4.7' },
    { id: 'opencode-go/glm-5.3-flash', name: 'GLM-5.3-Flash' },
    { id: 'opencode-go/qwen3.8-max', name: 'Qwen3.8 Max' },
    { id: 'opencode-go/kimi-k3', name: 'Kimi K3' },
    { id: 'opencode-go/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
    { id: 'opencode-go/deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp' },
    { id: 'opencode-go/kimi-k2.6', name: 'Kimi K2.6' },
    { id: 'opencode-go/longcat-2.0', name: 'LongCat-2.0' },
    { id: 'opencode-go/minimax-m2.7', name: 'MiniMax-M2.7' },
    { id: 'opencode-go/space-bunny-free', name: 'Space Bunny Free' },
    { id: 'opencode-go/mimo-v2.5-pro', name: 'MiMo V2.5 Pro' },
    { id: 'opencode-go/mimo-v2.6-flash', name: 'MiMo-V2.6-Flash' },
    { id: 'opencode-go/minimax-m3', name: 'MiniMax-M3' },
    { id: 'opencode-go/gpt-5.6-luna', name: 'GPT-5.6 Luna' },
    { id: 'opencode-go/qwen3.8-flash', name: 'Qwen3.8 Flash' },
    { id: 'opencode-go/glm-5.2', name: 'GLM-5.2' },
    { id: 'opencode-go/hy3', name: 'Hy3' },
    { id: 'opencode-go/glm-5.1', name: 'GLM-5.1' },
    { id: 'opencode-go/muse-spark-1.2-contributor', name: 'Muse Spark 1.2 Contributor' },
    { id: 'opencode-go/gpt-6-luna', name: 'GPT-6 Luna' },
    { id: 'opencode-go/deepseek-v4-pro', name: 'DeepSeek V4 Pro (New)' },
    { id: 'opencode-go/qwen3.6-plus', name: 'Qwen3.6 Plus' },
    { id: 'opencode-go/hy4-preview', name: 'Hy4 preview' },
    { id: 'opencode-go/muse-spark-1.3-contributor', name: 'Muse Spark 1.3 Contributor' },
    { id: 'opencode-go/glm-5.3', name: 'GLM-5.3' },
    { id: 'opencode-go/kimi-k2.7-code', name: 'Kimi K2.7 Code' },
    { id: 'opencode-go/grok-4.6', name: 'Grok 4.6' },
    { id: 'opencode-go/qwen3.7-plus', name: 'Qwen3.7 Plus' },
    { id: 'opencode-go/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  ]),
];

// ---------------------------------------------------------------------------
// Mistral Vibe models
// ---------------------------------------------------------------------------

const MISTRAL_MODELS: ModelGroup[] = [
  {
    label: 'Frontier (Latest)',
    models: [
      { id: 'mistral-medium-latest', name: 'Mistral Medium 3.5', group: 'Frontier (Latest)' },
      { id: 'zai-glm-5-3', name: 'Z.ai GLM 5.3', group: 'Frontier (Latest)' },
      { id: 'zai-glm-5-2', name: 'Z.ai GLM 5.2', group: 'Frontier (Latest)' },
      { id: 'mistral-large-latest', name: 'Mistral Large 3', group: 'Frontier (Latest)' },
      { id: 'mistral-small-latest', name: 'Mistral Small 4', group: 'Frontier (Latest)' },
    ],
  },
  {
    label: 'Coding (Recommended)',
    models: [{ id: 'codestral-latest', name: 'Codestral', group: 'Coding (Recommended)' }],
  },
  {
    label: 'Edge / Efficient',
    models: [
      { id: 'ministral-14b-latest', name: 'Ministral 3 14B', group: 'Edge / Efficient' },
      { id: 'ministral-8b-latest', name: 'Ministral 3 8B', group: 'Edge / Efficient' },
      { id: 'ministral-3b-latest', name: 'Ministral 3 3B', group: 'Edge / Efficient' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Google Gemini models
// ---------------------------------------------------------------------------

const GEMINI_MODELS: ModelGroup[] = [
  modelGroupFromTuples('Gemini 3 (Latest)', [
    ['gemini-3.8-flash', 'Gemini 3.8 Flash'],
    ['gemini-3.7-flash', 'Gemini 3.7 Flash'],
    ['gemini-3.6-flash', 'Gemini 3.6 Flash'],
    ['gemini-3.5-flash', 'Gemini 3.5 Flash'],
    ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite'],
    ['gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview'],
    ['gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite'],
  ]),
  modelGroupFromTuples('Gemini 2.5 (Current)', [
    ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
    ['gemini-2.5-flash', 'Gemini 2.5 Flash'],
    ['gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite'],
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
