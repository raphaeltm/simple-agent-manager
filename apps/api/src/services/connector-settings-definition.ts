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
