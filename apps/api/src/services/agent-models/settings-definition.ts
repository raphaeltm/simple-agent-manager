/**
 * Admin-editable tunables for agent model calls (`aiModels.*`). Typed code defaults live here
 * and the admin settings registry renders and stores overrides (policy 9017df94).
 */
import {
  AGENT_MODEL_CATEGORIES,
  DEFAULT_AGENT_MODEL_DEFAULT_CATEGORIES,
} from '@simple-agent-manager/shared';

import type { AdminSettingDefinition, AdminSettingName } from '../admin-settings-registry';

export const AGENT_MODEL_SETTING_DEFAULTS = Object.freeze({
  enabled: true,
  defaultCategories: Object.freeze([
    ...DEFAULT_AGENT_MODEL_DEFAULT_CATEGORIES,
  ]) as readonly string[],
  defaultMonthlyBudgetCents: 500,
  maxMonthlyBudgetCents: 5_000,
  // Below the 60 s default MCP tool timeout of common agent harnesses (Codex), so the agent
  // sees SAM's timeout message rather than its harness giving up while the call still runs.
  callTimeoutSeconds: 55,
  schemaTimeoutSeconds: 10,
  maxFileReferences: 16,
  maxInputBytes: 10 * 1024 * 1024,
  maxInlineOutputBytes: 32 * 1024,
  unpricedCallEstimateMicroUsd: 10_000,
  reservationOutputTokens: 4_096,
  catalogCacheSeconds: 6 * 60 * 60,
});

export type AgentModelSettingKey = keyof typeof AGENT_MODEL_SETTING_DEFAULTS;
type IntegerKey = Exclude<AgentModelSettingKey, 'enabled' | 'defaultCategories'>;

const RANGES: Readonly<Record<IntegerKey, { min: number; max: number }>> = {
  defaultMonthlyBudgetCents: { min: 0, max: 10_000_000 },
  maxMonthlyBudgetCents: { min: 0, max: 100_000_000 },
  callTimeoutSeconds: { min: 5, max: 900 },
  schemaTimeoutSeconds: { min: 1, max: 60 },
  maxFileReferences: { min: 0, max: 100 },
  maxInputBytes: { min: 1_024, max: 50 * 1024 * 1024 },
  maxInlineOutputBytes: { min: 1_024, max: 1024 * 1024 },
  unpricedCallEstimateMicroUsd: { min: 0, max: 10_000_000 },
  reservationOutputTokens: { min: 1, max: 1_000_000 },
  catalogCacheSeconds: { min: 60, max: 7 * 24 * 60 * 60 },
};

const DESCRIPTIONS: Readonly<Record<AgentModelSettingKey, string>> = {
  enabled:
    'Let agents call Cloudflare-hosted models with the run_ai_model tool. Off refuses every call.',
  defaultCategories:
    'Model groups switched on for projects that have not chosen their own models (e.g. decision, extraction, classification).',
  defaultMonthlyBudgetCents:
    'Monthly spending limit per project for agent model calls, in US cents, when the project has not set one.',
  maxMonthlyBudgetCents:
    'Highest monthly spending limit, in US cents, that a project owner or admin can set.',
  callTimeoutSeconds: 'Seconds one model call may run before it is stopped.',
  schemaTimeoutSeconds:
    "Seconds to wait for Cloudflare when list_ai_models fetches a model's input schema.",
  maxFileReferences:
    'Workspace files ({"$file": path}) one model call may include. 0 turns file inputs off.',
  maxInputBytes: 'Largest request one model call may send to Cloudflare, in bytes.',
  maxInlineOutputBytes:
    'Largest model output returned inline to the agent; bigger or binary outputs are saved as workspace files.',
  unpricedCallEstimateMicroUsd:
    'Amount charged to the budget per call, in millionths of a US dollar, for models without a published price.',
  reservationOutputTokens:
    'Output tokens held from the budget before a text call that does not set max_tokens; the real usage is charged after.',
  catalogCacheSeconds: 'Seconds the Cloudflare model catalog is cached between refreshes.',
};

/** Spend-affecting settings ask for confirmation in the admin UI. */
const RISKY: ReadonlySet<AgentModelSettingKey> = new Set([
  'enabled',
  'defaultCategories',
  'defaultMonthlyBudgetCents',
  'maxMonthlyBudgetCents',
  'unpricedCallEstimateMicroUsd',
]);

function isCategoryList(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > AGENT_MODEL_CATEGORIES.length) return false;
  const known = new Set<string>(AGENT_MODEL_CATEGORIES);
  return (
    value.every((entry) => typeof entry === 'string' && known.has(entry)) &&
    new Set(value).size === value.length
  );
}

function definition(key: AgentModelSettingKey): AdminSettingDefinition {
  const name: AdminSettingName = `aiModels.${key}`;
  const base = {
    name,
    category: 'AI models' as const,
    description: DESCRIPTIONS[key],
    secret: false,
    risky: RISKY.has(key),
  };
  if (key === 'enabled') {
    return {
      ...base,
      type: 'boolean',
      defaultValue: AGENT_MODEL_SETTING_DEFAULTS.enabled,
      validate: (value) => typeof value === 'boolean',
    };
  }
  if (key === 'defaultCategories') {
    return {
      ...base,
      type: 'string-list',
      defaultValue: AGENT_MODEL_SETTING_DEFAULTS.defaultCategories,
      validate: isCategoryList,
    };
  }
  const range = RANGES[key];
  return {
    ...base,
    type: 'integer',
    defaultValue: AGENT_MODEL_SETTING_DEFAULTS[key],
    range,
    validate: (value) =>
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= range.min &&
      value <= range.max,
  };
}

export function agentModelSettingDefinitions(): AdminSettingDefinition[] {
  return (Object.keys(AGENT_MODEL_SETTING_DEFAULTS) as AgentModelSettingKey[]).map(definition);
}
