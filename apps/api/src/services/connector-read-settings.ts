/**
 * The effective Connector read bounds for one request (`connector-read-settings-definition.ts`).
 */
import type { Env } from '../env';
import { resolveAdminSettingDetailsMany } from './admin-settings';
import {
  CONNECTOR_READ_SETTINGS,
  type ConnectorReadSettingName,
} from './connector-read-settings-definition';

type LimitKey<N extends string> = N extends `connector.${infer K}` ? K : never;
export type ConnectorReadLimits = Record<LimitKey<ConnectorReadSettingName>, number>;

/** The effective limits, with each value falling back to its code default if unreadable. */
export async function getConnectorReadLimits(env: Env): Promise<ConnectorReadLimits> {
  const names = CONNECTOR_READ_SETTINGS.map((setting) => setting.name);
  let values: unknown[];
  try {
    values = (await resolveAdminSettingDetailsMany(env, [...names])).map((row) => row.value);
  } catch {
    // Settings storage unavailable: reads stay bounded by their code defaults.
    values = CONNECTOR_READ_SETTINGS.map((setting) => setting.defaultValue);
  }
  return Object.fromEntries(
    CONNECTOR_READ_SETTINGS.map((setting, index) => {
      const value = values[index];
      const key = setting.name.slice('connector.'.length);
      return [
        key,
        typeof value === 'number' && Number.isInteger(value) ? value : setting.defaultValue,
      ];
    })
  ) as ConnectorReadLimits;
}
