/** The effective run receipt limits for one request (`insights-receipt-settings-definition.ts`). */
import {
  INSIGHTS_RECEIPT_SETTINGS,
  type InsightsReceiptSettingName,
} from './insights-receipt-settings-definition';
import type { OperationContext } from './types';

type LimitKey<N extends string> = N extends `insights.${infer K}` ? K : never;
export type InsightsReceiptLimits = Record<LimitKey<InsightsReceiptSettingName>, number>;

export function defaultInsightsReceiptLimits(): InsightsReceiptLimits {
  return Object.fromEntries(
    INSIGHTS_RECEIPT_SETTINGS.map((setting) => [
      setting.name.slice('insights.'.length),
      setting.defaultValue,
    ])
  ) as InsightsReceiptLimits;
}

/** Each value falls back to its code default when settings storage cannot be read. */
export async function getInsightsReceiptLimits(
  ctx: Pick<OperationContext, 'ports'>
): Promise<InsightsReceiptLimits> {
  let values: unknown[];
  try {
    values = (
      await ctx.ports.settings.resolveDetailsMany(
        INSIGHTS_RECEIPT_SETTINGS.map((setting) => setting.name)
      )
    ).map((row) => row.value);
  } catch {
    values = INSIGHTS_RECEIPT_SETTINGS.map((setting) => setting.defaultValue);
  }
  return Object.fromEntries(
    INSIGHTS_RECEIPT_SETTINGS.map((setting, index) => {
      const value = values[index];
      return [
        setting.name.slice('insights.'.length),
        typeof value === 'number' && Number.isInteger(value) ? value : setting.defaultValue,
      ];
    })
  ) as InsightsReceiptLimits;
}
