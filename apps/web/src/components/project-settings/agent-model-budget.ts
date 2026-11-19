import type { ProjectAgentModelSettingsResponse } from '@simple-agent-manager/shared';

/** Fraction of the effective budget at which the bar turns cautionary, before it is fully used. */
const NEARLY_USED_FRACTION = 0.9;

export interface AgentModelBudgetUsage {
  /** Spent plus reserved, in USD. */
  spent: number;
  usedFraction: number;
  isFullyUsed: boolean;
  isNearlyUsed: boolean;
  barClass: string;
  progressPercent: number;
}

/** How much of this month's limit is spent or reserved, and how the usage bar shows it. */
export function getAgentModelBudgetUsage(
  settings: ProjectAgentModelSettingsResponse
): AgentModelBudgetUsage {
  const spent = settings.usage.spentUsd + settings.usage.reservedUsd;
  const limit = settings.effectiveMonthlyBudgetUsd;
  let usedFraction = 0;
  if (limit > 0) usedFraction = spent / limit;
  else if (spent > 0) usedFraction = 1;
  const isFullyUsed = usedFraction >= 1;
  const isNearlyUsed = !isFullyUsed && usedFraction >= NEARLY_USED_FRACTION;
  let barClass = 'bg-accent';
  if (isFullyUsed) barClass = 'bg-danger';
  else if (isNearlyUsed) barClass = 'bg-warning';
  return {
    spent,
    usedFraction,
    isFullyUsed,
    isNearlyUsed,
    barClass,
    progressPercent: Math.round(Math.min(100, Math.max(0, usedFraction * 100))),
  };
}

export interface AgentModelBudgetInput {
  parsed: number;
  hasError: boolean;
  exceedsMax: boolean;
  unchanged: boolean;
}

/** Check a typed monthly limit against the administrator's maximum and the current limit. */
export function getAgentModelBudgetInput(
  input: string,
  currentUsd: number,
  maxUsd: number
): AgentModelBudgetInput {
  const parsed = Number(input);
  const invalid = input.trim() === '' || !Number.isFinite(parsed) || parsed < 0;
  const exceedsMax = !invalid && parsed > maxUsd;
  return {
    parsed,
    hasError: invalid || exceedsMax,
    exceedsMax,
    unchanged: !invalid && parsed === currentUsd,
  };
}
