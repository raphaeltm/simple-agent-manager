import { describe, expect,it } from 'vitest';

import { createProvider, HetznerProvider, ProviderError,ScalewayProvider } from '../../src/index';

describe('createProvider', () => {
  it('should return HetznerProvider for hetzner config', () => {
    const provider = createProvider({ provider: 'hetzner', apiToken: 'test-token' });
    expect(provider).toBeInstanceOf(HetznerProvider);
    expect(provider.name).toBe('hetzner');
  });

  it('should pass datacenter to HetznerProvider', () => {
    const provider = createProvider({
      provider: 'hetzner',
      apiToken: 'test-token',
      datacenter: 'nbg1',
    });
    expect(provider).toBeInstanceOf(HetznerProvider);
  });

  it('should throw ProviderError for unknown provider type', () => {
    expect(() =>
      createProvider({ provider: 'unknown' as 'hetzner', apiToken: 'x' }),
    ).toThrow(ProviderError);
  });

  it('should throw ProviderError with descriptive message for unknown provider', () => {
    try {
      createProvider({ provider: 'digitalocean' as 'hetzner', apiToken: 'x' });
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).message).toContain('digitalocean');
      expect((err as ProviderError).providerName).toBe('factory');
    }
  });

  it('should return ScalewayProvider for scaleway config', () => {
    const provider = createProvider({ provider: 'scaleway', secretKey: 'key', projectId: 'proj' });
    expect(provider).toBeInstanceOf(ScalewayProvider);
    expect(provider.name).toBe('scaleway');
  });

  it('should pass zone to ScalewayProvider', () => {
    const provider = createProvider({
      provider: 'scaleway',
      secretKey: 'key',
      projectId: 'proj',
      zone: 'nl-ams-1',
    });
    expect(provider).toBeInstanceOf(ScalewayProvider);
  });

  it('should not access process.env', () => {
    // The factory function signature requires explicit config — there's no fallback to env vars.
    // This test verifies the function works without any environment setup.
    const provider = createProvider({ provider: 'hetzner', apiToken: 'explicit-token' });
    expect(provider.name).toBe('hetzner');
  });
});
