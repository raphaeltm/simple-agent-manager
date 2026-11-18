import * as v from 'valibot';

import type { Env } from '../env';
import { parseWithSchema } from '../lib/runtime-validation';
import { errors } from '../middleware/error';

export type { ConnectorSettingKey, ConnectorSettings } from './connector-settings-definition';
export { CONNECTOR_DEFAULTS, validateConnectorSetting } from './connector-settings-definition';
import {
  resolveAdminSetting,
  resolveAdminSettingDetailsMany,
  updateAdminSettings,
} from './admin-settings';
import {
  CONNECTOR_DEFAULTS,
  type ConnectorSettingKey,
  type ConnectorSettings,
  validateConnectorSetting,
} from './connector-settings-definition';
export async function getConnectorSettingsConfig(env: Env) {
  const keys = Object.keys(CONNECTOR_DEFAULTS) as ConnectorSettingKey[];
  const settings = await resolveAdminSettingDetailsMany(
    env,
    keys.map((key) => `connector.${key}` as const),
    { fresh: true }
  );
  return Object.fromEntries(
    keys.map((key, index) => {
      const setting = settings[index];
      if (!setting) throw new Error('Connector setting metadata missing');
      return [
        key,
        {
          value: setting.value as ConnectorSettings[ConnectorSettingKey],
          source: setting.source === 'database' ? 'runtime' : setting.source,
          updatedAt: setting.updatedAt,
          updatedBy: setting.updatedBy,
        },
      ];
    })
  ) as Record<
    ConnectorSettingKey,
    {
      value: ConnectorSettings[ConnectorSettingKey];
      source: string;
      updatedAt: string | null;
      updatedBy: string | null;
    }
  >;
}
const connectorSettingsSchema = v.custom<ConnectorSettings>((input) => {
  if (typeof input !== 'object' || input === null) return false;
  return (Object.keys(CONNECTOR_DEFAULTS) as ConnectorSettingKey[]).every((key) =>
    validateConnectorSetting(key, Reflect.get(input, key))
  );
});
export async function getConnectorSettings(env: Env): Promise<ConnectorSettings> {
  const keys = Object.keys(CONNECTOR_DEFAULTS) as ConnectorSettingKey[];
  const values = Object.fromEntries(
    await Promise.all(
      keys.map(async (key) => [key, await resolveAdminSetting(env, `connector.${key}`)])
    )
  );
  return parseWithSchema(connectorSettingsSchema, values, 'connector.settings');
}
export async function updateConnectorSettings(
  env: Env,
  input: Record<string, unknown>,
  userId: string
) {
  const entries = Object.entries(input);
  if (
    !entries.length ||
    entries.some(
      ([key, value]) =>
        !Object.hasOwn(CONNECTOR_DEFAULTS, key) ||
        (value !== null && !validateConnectorSetting(key as ConnectorSettingKey, value))
    )
  )
    throw errors.badRequest('Invalid Connector setting');
  await updateAdminSettings(env, {
    changes: entries.map(([key, value]) => ({
      name: `connector.${key}` as `connector.${ConnectorSettingKey}`,
      value: value as ConnectorSettings[ConnectorSettingKey] | null,
    })),
    actorUserId: userId,
  });
  return getConnectorSettingsConfig(env);
}
export function connectorUrl(env: Env): string {
  return `https://api.${env.BASE_DOMAIN}/connect/mcp`;
}
