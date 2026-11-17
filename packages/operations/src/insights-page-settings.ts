/**
 * Insights page limits, Flow, Agent setups and Accounts tabs (listed under "Operations" in Admin → Settings). Runtime settings rather
 * than Worker vars (policy 9017df94, `.claude/rules/07`). The definitions carry no imports so the
 * admin settings registry can depend on them; `getInsightsPageLimits` resolves them per request.
 */
import type { OperationContext } from './types';

export const INSIGHTS_PAGE_SETTINGS = [
  {
    name: 'insights.flowIdeaSampleCap',
    defaultValue: 100,
    description:
      'Ideas, newest-updated first, examined for "idea to merged" on Insights. The page says when the cap cut the list short.',
    range: { min: 10, max: 500 },
  },
  {
    name: 'insights.flowWaitingIdeasLimit',
    defaultValue: 5,
    description: 'Ideas shown under "Ideas waiting longest" on Insights.',
    range: { min: 1, max: 20 },
  },
  {
    name: 'insights.flowFlakyChecksLimit',
    defaultValue: 5,
    description: 'Checks shown under "Flaky checks" on Insights.',
    range: { min: 1, max: 20 },
  },
  {
    name: 'insights.flowReworkWindowDays',
    defaultValue: 7,
    description:
      'Days after a merge in which another pull request on the same branch or idea counts as rework.',
    range: { min: 1, max: 30 },
  },
  {
    name: 'insights.accountsStallScanCap',
    defaultValue: 500,
    description:
      'Usage-limit waits and rejected limit windows, newest first, examined for "Stalled on a limit" on Insights · Accounts. The page says when the cap cut the list short.',
    range: { min: 50, max: 5000 },
  },
  {
    name: 'insights.accountsEpisodesListed',
    defaultValue: 10,
    description: 'Limit stalls listed under "Stalled on a limit" on Insights · Accounts.',
    range: { min: 1, max: 50 },
  },
  {
    name: 'insights.accountsUsageRowCap',
    defaultValue: 500,
    description:
      'Measured token usage rows (one per account and model), largest first, read for tokens and spend on Insights · Accounts. The page says when the cap cut the smallest off.',
    range: { min: 50, max: 5000 },
  },
  {
    name: 'insights.setupsRunScanCap',
    defaultValue: 2000,
    description:
      'Runs, newest first, examined on Insights · Agent setups. The page says when the cap cut the range short.',
    range: { min: 100, max: 10000 },
  },
  {
    name: 'insights.setupsSuggestionMinRuns',
    defaultValue: 10,
    description:
      'Finished runs each compared setup needs before Insights · Agent setups suggests a default profile or a memory request for a skill.',
    range: { min: 3, max: 200 },
  },
  {
    name: 'insights.setupsSuggestionMinGapPercent',
    defaultValue: 20,
    description:
      'Points by which a profile must beat the one it is compared with on "merged without rework" before it is suggested as a skill default.',
    range: { min: 5, max: 80 },
  },
  {
    name: 'insights.setupsMemoryHeadroomPercent',
    defaultValue: 25,
    description:
      'Headroom added to the 90th-percentile peak memory when suggesting a memory request for a skill.',
    range: { min: 0, max: 200 },
  },
] as const;

export type InsightsPageSettingName = (typeof INSIGHTS_PAGE_SETTINGS)[number]['name'];

export interface InsightsPageLimits {
  ideaSampleCap: number;
  waitingIdeasLimit: number;
  flakyChecksLimit: number;
  reworkWindowDays: number;
  accountsStallScanCap: number;
  accountsEpisodesListed: number;
  accountsUsageRowCap: number;
  setupsRunScanCap: number;
  setupsSuggestionMinRuns: number;
  setupsSuggestionMinGapPercent: number;
  setupsMemoryHeadroomPercent: number;
}

const KEYS: Record<InsightsPageSettingName, keyof InsightsPageLimits> = {
  'insights.flowIdeaSampleCap': 'ideaSampleCap',
  'insights.flowWaitingIdeasLimit': 'waitingIdeasLimit',
  'insights.flowFlakyChecksLimit': 'flakyChecksLimit',
  'insights.flowReworkWindowDays': 'reworkWindowDays',
  'insights.accountsStallScanCap': 'accountsStallScanCap',
  'insights.accountsEpisodesListed': 'accountsEpisodesListed',
  'insights.accountsUsageRowCap': 'accountsUsageRowCap',
  'insights.setupsRunScanCap': 'setupsRunScanCap',
  'insights.setupsSuggestionMinRuns': 'setupsSuggestionMinRuns',
  'insights.setupsSuggestionMinGapPercent': 'setupsSuggestionMinGapPercent',
  'insights.setupsMemoryHeadroomPercent': 'setupsMemoryHeadroomPercent',
};

/** Each value falls back to its code default when settings storage cannot be read. */
export async function getInsightsPageLimits(
  ctx: Pick<OperationContext, 'ports'>
): Promise<InsightsPageLimits> {
  let values: unknown[];
  try {
    values = (
      await ctx.ports.settings.resolveDetailsMany(INSIGHTS_PAGE_SETTINGS.map((s) => s.name))
    ).map((row) => row.value);
  } catch {
    values = INSIGHTS_PAGE_SETTINGS.map((s) => s.defaultValue);
  }
  const limits = {} as InsightsPageLimits;
  INSIGHTS_PAGE_SETTINGS.forEach((setting, index) => {
    const value = values[index];
    limits[KEYS[setting.name]] =
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= setting.range.min &&
      value <= setting.range.max
        ? value
        : setting.defaultValue;
  });
  return limits;
}
