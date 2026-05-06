import { describe, expect,it } from 'vitest';

import { buildProviderConfig,serializeCredentialToken } from '../../../src/services/provider-credentials';

describe('serializeCredentialToken', () => {
  it('should return raw token for hetzner', () => {
    const result = serializeCredentialToken('hetzner', { token: 'my-hetzner-token' });
    expect(result).toBe('my-hetzner-token');
  });

  it('should return empty string when token field is missing for hetzner', () => {
    const result = serializeCredentialToken('hetzner', { apiToken: 'my-api-token' });
    expect(result).toBe('');
  });

  it('should return JSON for scaleway with secretKey and projectId', () => {
    const result = serializeCredentialToken('scaleway', {
      secretKey: 'scw-secret-key',
      projectId: 'proj-uuid-1234',
    });
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({
      secretKey: 'scw-secret-key',
      projectId: 'proj-uuid-1234',
    });
  });
});

describe('buildProviderConfig', () => {
  it('should build HetznerProviderConfig from raw token string', () => {
    const config = buildProviderConfig('hetzner', 'my-hetzner-token');
    expect(config).toEqual({
      provider: 'hetzner',
      apiToken: 'my-hetzner-token',
    });
  });

  it('should build HetznerProviderConfig with retry and placement overrides from env', () => {
    const config = buildProviderConfig('hetzner', 'my-hetzner-token', {
      HETZNER_API_TIMEOUT_MS: '45000',
      HETZNER_API_RETRY_MAX_ATTEMPTS: '4',
      HETZNER_API_RETRY_BASE_DELAY_MS: '1500',
      HETZNER_API_RETRY_MAX_DELAY_MS: '12000',
      HETZNER_PLACEMENT_RETRY_DELAY_MS: '2500',
      HETZNER_PLACEMENT_RETRY_ATTEMPTS: '3',
      HETZNER_PLACEMENT_FALLBACK_ENABLED: 'false',
      HETZNER_PLACEMENT_FALLBACK_LOCATIONS: 'hel1,nbg1',
    });
    expect(config).toEqual({
      provider: 'hetzner',
      apiToken: 'my-hetzner-token',
      timeoutMs: 45000,
      apiRetryMaxAttempts: 4,
      apiRetryBaseDelayMs: 1500,
      apiRetryMaxDelayMs: 12000,
      placementRetryDelayMs: 2500,
      placementRetryAttempts: 3,
      placementFallbackEnabled: false,
      placementFallbackLocations: ['hel1', 'nbg1'],
    });
  });

  it('should build ScalewayProviderConfig from JSON string', () => {
    const token = JSON.stringify({
      secretKey: 'scw-secret',
      projectId: 'proj-uuid',
    });
    const config = buildProviderConfig('scaleway', token);
    expect(config).toEqual({
      provider: 'scaleway',
      secretKey: 'scw-secret',
      projectId: 'proj-uuid',
    });
  });

  it('should throw for unsupported provider', () => {
    expect(() => buildProviderConfig('unknown' as any, 'token')).toThrow('Unsupported provider');
  });

  it('should throw for malformed scaleway JSON', () => {
    expect(() => buildProviderConfig('scaleway', 'not-json')).toThrow();
  });

  it('should round-trip hetzner serialize -> build', () => {
    const serialized = serializeCredentialToken('hetzner', { token: 'test-token-123' });
    const config = buildProviderConfig('hetzner', serialized);
    expect(config).toEqual({ provider: 'hetzner', apiToken: 'test-token-123' });
  });

  it('should round-trip scaleway serialize -> build', () => {
    const fields = { secretKey: 'key-abc', projectId: 'proj-xyz' };
    const serialized = serializeCredentialToken('scaleway', fields);
    const config = buildProviderConfig('scaleway', serialized);
    expect(config).toEqual({
      provider: 'scaleway',
      secretKey: 'key-abc',
      projectId: 'proj-xyz',
    });
  });
});
