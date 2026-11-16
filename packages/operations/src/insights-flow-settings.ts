/**
 * Insights · Flow limits (listed under "Operations" in Admin → Settings). Runtime settings rather
 * than Worker vars (policy 9017df94, `.claude/rules/07`). The definitions carry no imports so the
 * admin settings registry can depend on them; `getInsightsFlowLimits` resolves them per request.
 */
import type { OperationContext } from './types';

export const INSIGHTS_FLOW_SETTINGS = [
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
] as const;

export type InsightsFlowSettingName = (typeof INSIGHTS_FLOW_SETTINGS)[number]['name'];

export interface InsightsFlowLimits {
  ideaSampleCap: number;
  waitingIdeasLimit: number;
  flakyChecksLimit: number;
  reworkWindowDays: number;
}

const KEYS: Record<InsightsFlowSettingName, keyof InsightsFlowLimits> = {
  'insights.flowIdeaSampleCap': 'ideaSampleCap',
  'insights.flowWaitingIdeasLimit': 'waitingIdeasLimit',
  'insights.flowFlakyChecksLimit': 'flakyChecksLimit',
  'insights.flowReworkWindowDays': 'reworkWindowDays',
};

/** Each value falls back to its code default when settings storage cannot be read. */
export async function getInsightsFlowLimits(
  ctx: Pick<OperationContext, 'ports'>
): Promise<InsightsFlowLimits> {
  let values: unknown[];
  try {
    values = (
      await ctx.ports.settings.resolveDetailsMany(INSIGHTS_FLOW_SETTINGS.map((s) => s.name))
    ).map((row) => row.value);
  } catch {
    values = INSIGHTS_FLOW_SETTINGS.map((s) => s.defaultValue);
  }
  const limits = {} as InsightsFlowLimits;
  INSIGHTS_FLOW_SETTINGS.forEach((setting, index) => {
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
