/** The effective inbox limits for one request (`inbox-settings-definition.ts`). */
import { INBOX_SETTINGS, type InboxSettingName } from './inbox-settings-definition';
import type { OperationContext } from './types';

type LimitKey<N extends string> = N extends `inbox.${infer K}` ? K : never;
export type InboxLimits = Record<LimitKey<InboxSettingName>, number>;

export function defaultInboxLimits(): InboxLimits {
  return Object.fromEntries(
    INBOX_SETTINGS.map((setting) => [setting.name.slice('inbox.'.length), setting.defaultValue])
  ) as InboxLimits;
}

/** Each value falls back to its code default when settings storage cannot be read. */
export async function getInboxLimits(ctx: Pick<OperationContext, 'ports'>): Promise<InboxLimits> {
  let values: unknown[];
  try {
    values = (
      await ctx.ports.settings.resolveDetailsMany(INBOX_SETTINGS.map((setting) => setting.name))
    ).map((row) => row.value);
  } catch {
    values = INBOX_SETTINGS.map((setting) => setting.defaultValue);
  }
  return Object.fromEntries(
    INBOX_SETTINGS.map((setting, index) => {
      const value = values[index];
      return [
        setting.name.slice('inbox.'.length),
        typeof value === 'number' && Number.isInteger(value) ? value : setting.defaultValue,
      ];
    })
  ) as InboxLimits;
}
