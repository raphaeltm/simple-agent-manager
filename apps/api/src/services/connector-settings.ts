import type { Env } from '../env';
import { errors } from '../middleware/error';

export const CONNECTOR_DEFAULTS = {
  enabled: true,
  writeEnabled: true,
  clientRegistration: 'open' as 'open' | 'allowlist',
  allowedRedirectHosts: ['claude.ai', 'chatgpt.com', 'loopback'],
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 2592000,
  readRateLimitPerMinute: 120,
  writeRateLimitPerMinute: 30,
  maxStartsPerUserPerHour: 10,
  maxStartsPerUserPerDay: 50,
};
export type ConnectorSettings = typeof CONNECTOR_DEFAULTS;
export type ConnectorSettingKey = keyof ConnectorSettings;
const ENV_KEYS: Record<ConnectorSettingKey, string> = {
  enabled: 'CONNECTOR_ENABLED',
  writeEnabled: 'CONNECTOR_WRITE_ENABLED',
  clientRegistration: 'CONNECTOR_CLIENT_REGISTRATION',
  allowedRedirectHosts: 'CONNECTOR_ALLOWED_REDIRECT_HOSTS',
  accessTokenTtlSeconds: 'CONNECTOR_ACCESS_TOKEN_TTL_SECONDS',
  refreshTokenTtlSeconds: 'CONNECTOR_REFRESH_TOKEN_TTL_SECONDS',
  readRateLimitPerMinute: 'CONNECTOR_READ_RATE_LIMIT_PER_MINUTE',
  writeRateLimitPerMinute: 'CONNECTOR_WRITE_RATE_LIMIT_PER_MINUTE',
  maxStartsPerUserPerHour: 'CONNECTOR_MAX_STARTS_PER_USER_PER_HOUR',
  maxStartsPerUserPerDay: 'CONNECTOR_MAX_STARTS_PER_USER_PER_DAY',
};
export function validateConnectorSetting(key: ConnectorSettingKey, value: unknown): boolean {
  if (key === 'clientRegistration') return value === 'open' || value === 'allowlist';
  if (key === 'allowedRedirectHosts')
    return (
      Array.isArray(value) &&
      value.length <= 100 &&
      value.every(
        (host) =>
          typeof host === 'string' && /^(?:loopback|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/.test(host)
      )
    );
  if (typeof CONNECTOR_DEFAULTS[key] === 'boolean') return typeof value === 'boolean';
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= (key.endsWith('TtlSeconds') ? 60 : 1) &&
    value <= 2147483647
  );
}
export async function getConnectorSettingsConfig(env: Env) {
  const rows = await env.DATABASE.prepare(
    "SELECT key, value, updated_at, updated_by FROM platform_settings WHERE key LIKE 'connector.%'"
  ).all<{ key: string; value: string; updated_at: string; updated_by: string | null }>();
  const result = {} as Record<
    ConnectorSettingKey,
    {
      value: ConnectorSettings[ConnectorSettingKey];
      source: 'runtime' | 'environment' | 'default';
      updatedAt: string | null;
      updatedBy: string | null;
    }
  >;
  for (const key of Object.keys(CONNECTOR_DEFAULTS) as ConnectorSettingKey[]) {
    const row = rows.results.find((item) => item.key === `connector.${key}`);
    const parse = (raw: unknown): unknown => {
      if (typeof raw !== 'string') return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        return key === 'allowedRedirectHosts' ? raw.split(',').map((host) => host.trim()) : raw;
      }
    };
    const stored = parse(row?.value);
    const valid = validateConnectorSetting(key, stored);
    const fallback = parse((env as unknown as Record<string, unknown>)[ENV_KEYS[key]]);
    const value = valid
      ? stored
      : validateConnectorSetting(key, fallback)
        ? fallback
        : CONNECTOR_DEFAULTS[key];
    result[key] = {
      value: value as ConnectorSettings[ConnectorSettingKey],
      source:
        row && valid
          ? 'runtime'
          : validateConnectorSetting(key, fallback)
            ? 'environment'
            : 'default',
      updatedAt: row && valid ? row.updated_at : null,
      updatedBy: row && valid ? row.updated_by : null,
    };
  }
  return result;
}
export async function getConnectorSettings(env: Env): Promise<ConnectorSettings> {
  const config = await getConnectorSettingsConfig(env);
  return Object.fromEntries(
    Object.entries(config).map(([key, setting]) => [key, setting.value])
  ) as ConnectorSettings;
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
  await env.DATABASE.batch(
    entries.map(([key, value]) =>
      value === null
        ? env.DATABASE.prepare('DELETE FROM platform_settings WHERE key=?').bind(`connector.${key}`)
        : env.DATABASE.prepare(
            'INSERT INTO platform_settings (key,value,updated_at,updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by'
          ).bind(`connector.${key}`, JSON.stringify(value), new Date().toISOString(), userId)
    )
  );
  return getConnectorSettingsConfig(env);
}
export function connectorUrl(env: Env): string {
  return `https://api.${env.BASE_DOMAIN}/connect/mcp`;
}
