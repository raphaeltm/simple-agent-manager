import { describe, expect,it } from 'vitest';

import {
  buildProviderConfig,
  parseGcpCredential,
  serializeCredentialToken,
  serializeGcpCredential,
} from '../../../src/services/provider-credentials';

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


describe('versioned GCP credential parsing', () => {
  const legacy = {
    gcpProjectId: 'legacy-project',
    gcpProjectNumber: '123456789',
    serviceAccountEmail: 'sam@legacy-project.iam.gserviceaccount.com',
    wifPoolId: 'sam-pool',
    wifProviderId: 'sam-oidc',
    defaultZone: 'us-central1-a',
  };

  it('normalizes an existing unversioned WIF blob without migration', () => {
    expect(parseGcpCredential(JSON.stringify(legacy))).toEqual({
      version: 1,
      provider: 'gcp',
      authType: 'workload-identity',
      ...legacy,
    });
  });

  it('serializes new WIF metadata with a version and discriminator', () => {
    const serialized = serializeCredentialToken('gcp', legacy);
    expect(JSON.parse(serialized)).toMatchObject({
      version: 1,
      provider: 'gcp',
      authType: 'workload-identity',
      ...legacy,
    });
  });

  it('round-trips a service-account-key credential', () => {
    const credential = {
      version: 1 as const,
      provider: 'gcp' as const,
      authType: 'service-account-key' as const,
      gcpProjectId: 'service-project',
      serviceAccountEmail: 'sam@service-project.iam.gserviceaccount.com',
      privateKeyId: 'key-123',
      privateKey: 'private-key-value',
      defaultZone: 'europe-west1-b',
    };
    expect(parseGcpCredential(serializeGcpCredential(credential))).toEqual(credential);
  });

  it('rejects provider mismatches before provider construction', () => {
    expect(() => parseGcpCredential(JSON.stringify({
      ...legacy,
      version: 1,
      provider: 'scaleway',
      authType: 'workload-identity',
    }))).toThrow('provider is scaleway');
  });

  it('rejects unsupported versions and auth modes', () => {
    expect(() => parseGcpCredential(JSON.stringify({ ...legacy, version: 2, authType: 'workload-identity' })))
      .toThrow('unsupported version');
    expect(() => parseGcpCredential(JSON.stringify({ ...legacy, version: 1, authType: 'other' })))
      .toThrow('unsupported authType');
  });
});
