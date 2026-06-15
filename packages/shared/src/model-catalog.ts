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
  {
    label: 'Claude 5 (Frontier)',
    models: [{ id: 'claude-fable-5', name: 'Claude Fable 5', group: 'Claude 5 (Frontier)' }],
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
  {
    label: 'Claude 4 (Legacy)',
    models: [
      { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', group: 'Claude 4 (Legacy)' },
      { id: 'claude-opus-4-1-20250805', name: 'Claude Opus 4.1', group: 'Claude 4 (Legacy)' },
      { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', group: 'Claude 4 (Legacy)' },
      {
        id: 'claude-sonnet-4-20250514',
        name: 'Claude Sonnet 4 (retiring Jun 15)',
        group: 'Claude 4 (Legacy)',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// OpenAI Codex models
// ---------------------------------------------------------------------------

const CODEX_MODELS: ModelGroup[] = [
  {
    label: 'GPT-5 (Latest)',
    models: [
      { id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro', group: 'GPT-5 (Latest)' },
      { id: 'gpt-5.5', name: 'GPT-5.5', group: 'GPT-5 (Latest)' },
      { id: 'gpt-5.4-pro', name: 'GPT-5.4 Pro', group: 'GPT-5 (Latest)' },
      { id: 'gpt-5.4', name: 'GPT-5.4', group: 'GPT-5 (Latest)' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', group: 'GPT-5 (Latest)' },
      { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', group: 'GPT-5 (Latest)' },
    ],
  },
  {
    label: 'Reasoning',
    models: [
      { id: 'o4-mini', name: 'O4 Mini', group: 'Reasoning' },
      { id: 'o3', name: 'O3', group: 'Reasoning' },
    ],
  },
  {
    label: 'GPT-5 (Legacy)',
    models: [
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex (sunset)', group: 'GPT-5 (Legacy)' },
      { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex (sunset)', group: 'GPT-5 (Legacy)' },
      { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', group: 'GPT-5 (Legacy)' },
      { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', group: 'GPT-5 (Legacy)' },
      { id: 'gpt-5-mini', name: 'GPT-5 Mini', group: 'GPT-5 (Legacy)' },
    ],
  },
  {
    label: 'GPT-4.1 (Legacy)',
    models: [
      { id: 'gpt-4.1', name: 'GPT-4.1', group: 'GPT-4.1 (Legacy)' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', group: 'GPT-4.1 (Legacy)' },
    ],
  },
];

// ---------------------------------------------------------------------------
// OpenAI-compatible alternative provider models
// ---------------------------------------------------------------------------

const OPENAI_COMPATIBLE_ALTERNATIVE_MODELS: ModelGroup[] = [
  modelGroup('Mistral AI (OpenAI-compatible)', [
    { id: 'mistral-medium-3-5-2604', name: 'Mistral Medium 3.5' },
    { id: 'mistral-small-2603', name: 'Mistral Small 4' },
    { id: 'mistral-large-2512', name: 'Mistral Large 3' },
    { id: 'devstral-2512', name: 'Devstral 2' },
    { id: 'codestral-2508', name: 'Codestral' },
  ]),
  modelGroup('Cohere North (OpenAI-compatible)', [
    { id: 'north-mini-code-1-0', name: 'North Mini Code' },
    { id: 'command-a-plus-05-2026', name: 'Command A+' },
    { id: 'command-a-03-2025', name: 'Command A' },
    { id: 'command-a-reasoning-08-2025', name: 'Command A Reasoning' },
  ]),
  modelGroup('Scaleway Generative APIs (OpenAI-compatible)', [
    { id: 'qwen3-coder-30b-a3b-instruct', name: 'Qwen3 Coder 30B A3B Instruct' },
    { id: 'qwen3.6-35b-a3b', name: 'Qwen3.6 35B A3B' },
    { id: 'gemma-4-26b-a4b-it', name: 'Gemma 4 26B A4B IT' },
    { id: 'gpt-oss-120b', name: 'GPT OSS 120B' },
  ]),
];

// ---------------------------------------------------------------------------
// Mistral Vibe models
// ---------------------------------------------------------------------------

const MISTRAL_MODELS: ModelGroup[] = [
  {
    label: 'Frontier (Latest)',
    models: [
      { id: 'mistral-medium-3-5-2604', name: 'Mistral Medium 3.5', group: 'Frontier (Latest)' },
      { id: 'mistral-small-2603', name: 'Mistral Small 4', group: 'Frontier (Latest)' },
      { id: 'mistral-large-2512', name: 'Mistral Large 3', group: 'Frontier (Latest)' },
      { id: 'mistral-medium-2508', name: 'Mistral Medium 3.1', group: 'Frontier (Latest)' },
    ],
  },
  {
    label: 'Coding (Recommended)',
    models: [
      { id: 'devstral-2-2512', name: 'Devstral 2', group: 'Coding (Recommended)' },
      { id: 'codestral-2508', name: 'Codestral', group: 'Coding (Recommended)' },
    ],
  },
  {
    label: 'Reasoning',
    models: [{ id: 'magistral-medium-1-2-2509', name: 'Magistral Medium 1.2', group: 'Reasoning' }],
  },
  {
    label: 'Edge / Efficient',
    models: [
      { id: 'ministral-3-14b-2512', name: 'Ministral 3 14B', group: 'Edge / Efficient' },
      { id: 'ministral-3-8b-2512', name: 'Ministral 3 8B', group: 'Edge / Efficient' },
      { id: 'ministral-3-3b-2512', name: 'Ministral 3 3B', group: 'Edge / Efficient' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Google Gemini models
// ---------------------------------------------------------------------------

const GEMINI_MODELS: ModelGroup[] = [
  {
    label: 'Gemini 3 (Latest)',
    models: [
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', group: 'Gemini 3 (Latest)' },
      { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', group: 'Gemini 3 (Latest)' },
    ],
  },
  {
    label: 'Gemini 2.5',
    models: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', group: 'Gemini 2.5' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', group: 'Gemini 2.5' },
    ],
  },
  {
    label: 'Gemini 2.0 (Legacy)',
    models: [{ id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', group: 'Gemini 2.0 (Legacy)' }],
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
  opencode: OPENAI_COMPATIBLE_ALTERNATIVE_MODELS,
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
