import { AGENT_MODEL_CATEGORIES, type AgentModelCategory } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { resolveAdminSetting } from '../admin-settings';
import { AGENT_MODEL_SETTING_DEFAULTS, type AgentModelSettingKey } from './settings-definition';

export interface AgentModelSettings {
  enabled: boolean;
  defaultCategories: AgentModelCategory[];
  defaultMonthlyBudgetMicroUsd: number;
  maxMonthlyBudgetMicroUsd: number;
  callTimeoutMs: number;
  schemaTimeoutMs: number;
  maxFileReferences: number;
  maxInputBytes: number;
  maxInlineOutputBytes: number;
  unpricedCallEstimateMicroUsd: number;
  reservationOutputTokens: number;
  catalogCacheSeconds: number;
}

export const MICRO_USD_PER_CENT = 10_000;
export const MICRO_USD_PER_USD = 1_000_000;

const CATEGORY_SET: ReadonlySet<string> = new Set(AGENT_MODEL_CATEGORIES);

// resolveAdminSetting serves the cached snapshot and degrades to the registry default on a
// store outage; these guards only narrow the union type.
async function integerSetting(env: Env, key: AgentModelSettingKey): Promise<number> {
  const fallback = AGENT_MODEL_SETTING_DEFAULTS[key];
  const value = await resolveAdminSetting(env, `aiModels.${key}`);
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  return typeof fallback === 'number' ? fallback : 0;
}

async function categoriesSetting(env: Env): Promise<AgentModelCategory[]> {
  const value = await resolveAdminSetting(env, 'aiModels.defaultCategories');
  const list = Array.isArray(value) ? value : AGENT_MODEL_SETTING_DEFAULTS.defaultCategories;
  return list.filter((entry): entry is AgentModelCategory => CATEGORY_SET.has(entry));
}

export async function getAgentModelSettings(env: Env): Promise<AgentModelSettings> {
  const [
    enabled,
    defaultCategories,
    defaultBudgetCents,
    maxBudgetCents,
    timeoutSeconds,
    schemaTimeoutSeconds,
    maxFileReferences,
    maxInputBytes,
    maxInlineOutputBytes,
    unpricedCallEstimateMicroUsd,
    reservationOutputTokens,
    catalogCacheSeconds,
  ] = await Promise.all([
    resolveAdminSetting(env, 'aiModels.enabled'),
    categoriesSetting(env),
    integerSetting(env, 'defaultMonthlyBudgetCents'),
    integerSetting(env, 'maxMonthlyBudgetCents'),
    integerSetting(env, 'callTimeoutSeconds'),
    integerSetting(env, 'schemaTimeoutSeconds'),
    integerSetting(env, 'maxFileReferences'),
    integerSetting(env, 'maxInputBytes'),
    integerSetting(env, 'maxInlineOutputBytes'),
    integerSetting(env, 'unpricedCallEstimateMicroUsd'),
    integerSetting(env, 'reservationOutputTokens'),
    integerSetting(env, 'catalogCacheSeconds'),
  ]);
  return {
    enabled: enabled === true,
    defaultCategories,
    defaultMonthlyBudgetMicroUsd: defaultBudgetCents * MICRO_USD_PER_CENT,
    maxMonthlyBudgetMicroUsd: maxBudgetCents * MICRO_USD_PER_CENT,
    callTimeoutMs: timeoutSeconds * 1000,
    schemaTimeoutMs: schemaTimeoutSeconds * 1000,
    maxFileReferences,
    maxInputBytes,
    maxInlineOutputBytes,
    unpricedCallEstimateMicroUsd,
    reservationOutputTokens,
    catalogCacheSeconds,
  };
}

/**
 * The monthly limit in force for a project: its own budget or the installation default, never
 * above the installation maximum (an administrator may lower the maximum after a project set
 * a higher budget).
 */
export function effectiveMonthlyBudgetMicroUsd(
  projectBudgetCents: number | null,
  settings: Pick<AgentModelSettings, 'defaultMonthlyBudgetMicroUsd' | 'maxMonthlyBudgetMicroUsd'>
): number {
  const own =
    projectBudgetCents === null
      ? settings.defaultMonthlyBudgetMicroUsd
      : projectBudgetCents * MICRO_USD_PER_CENT;
  return Math.min(own, settings.maxMonthlyBudgetMicroUsd);
}
