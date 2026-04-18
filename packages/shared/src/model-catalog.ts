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

// ---------------------------------------------------------------------------
// Claude Code models
// ---------------------------------------------------------------------------

const CLAUDE_MODELS: ModelGroup[] = [
  {
    label: 'Claude 4 (Latest)',
    models: [
      { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', group: 'Claude 4 (Latest)' },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', group: 'Claude 4 (Latest)' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', group: 'Claude 4 (Latest)' },
      { id: 'claude-sonnet-4-5-20250514', name: 'Claude Sonnet 4.5', group: 'Claude 4 (Latest)' },
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', group: 'Claude 4 (Latest)' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', group: 'Claude 4 (Latest)' },
    ],
  },
  {
    label: 'Claude 3.5 (Legacy)',
    models: [
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', group: 'Claude 3.5 (Legacy)' },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', group: 'Claude 3.5 (Legacy)' },
    ],
  },
  {
    label: 'Claude 3 (Legacy)',
    models: [
      { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', group: 'Claude 3 (Legacy)' },
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
      { id: 'gpt-5.4', name: 'GPT-5.4', group: 'GPT-5 (Latest)' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', group: 'GPT-5 (Latest)' },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', group: 'GPT-5 (Latest)' },
      { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', group: 'GPT-5 (Latest)' },
      { id: 'gpt-5.2', name: 'GPT-5.2', group: 'GPT-5 (Latest)' },
      { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', group: 'GPT-5 (Latest)' },
      { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', group: 'GPT-5 (Latest)' },
    ],
  },
  {
    label: 'Legacy',
    models: [
      { id: 'o4-mini', name: 'O4 Mini', group: 'Legacy' },
      { id: 'o3', name: 'O3', group: 'Legacy' },
      { id: 'gpt-4.1', name: 'GPT-4.1', group: 'Legacy' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', group: 'Legacy' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Mistral Vibe models
// ---------------------------------------------------------------------------

const MISTRAL_MODELS: ModelGroup[] = [
  {
    label: 'Coding (Recommended)',
    models: [
      { id: 'devstral-2512', name: 'Devstral 2 (123B)', group: 'Coding (Recommended)' },
      { id: 'devstral-small-2505', name: 'Devstral Small 2 (24B)', group: 'Coding (Recommended)' },
      { id: 'codestral-2508', name: 'Codestral 25.08', group: 'Coding (Recommended)' },
      { id: 'codestral-latest', name: 'Codestral Latest', group: 'Coding (Recommended)' },
    ],
  },
  {
    label: 'General Purpose',
    models: [
      { id: 'mistral-large-2512', name: 'Mistral Large 3', group: 'General Purpose' },
      { id: 'mistral-large-latest', name: 'Mistral Large Latest', group: 'General Purpose' },
      { id: 'mistral-medium-2508', name: 'Mistral Medium 3.1', group: 'General Purpose' },
      { id: 'mistral-small-2603', name: 'Mistral Small 4', group: 'General Purpose' },
      { id: 'mistral-small-latest', name: 'Mistral Small Latest', group: 'General Purpose' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Google Gemini models
// ---------------------------------------------------------------------------

const GEMINI_MODELS: ModelGroup[] = [
  {
    label: 'Gemini 2.5',
    models: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', group: 'Gemini 2.5' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', group: 'Gemini 2.5' },
    ],
  },
  {
    label: 'Gemini 2.0',
    models: [
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', group: 'Gemini 2.0' },
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
