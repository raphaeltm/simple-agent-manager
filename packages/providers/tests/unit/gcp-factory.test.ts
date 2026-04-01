import { describe, expect,it } from 'vitest';

import { createProvider, GcpProvider } from '../../src/index';

describe('createProvider with GCP', () => {
  it('should return GcpProvider for gcp config', () => {
    const provider = createProvider({
      provider: 'gcp',
      projectId: 'test-project',
      tokenProvider: async () => 'test-token',
    });
    expect(provider).toBeInstanceOf(GcpProvider);
    expect(provider.name).toBe('gcp');
  });

  it('should pass defaultZone to GcpProvider', () => {
    const provider = createProvider({
      provider: 'gcp',
      projectId: 'test-project',
      tokenProvider: async () => 'test-token',
      defaultZone: 'europe-west3-a',
    });
    expect(provider).toBeInstanceOf(GcpProvider);
    expect(provider.defaultLocation).toBe('europe-west3-a');
  });
});
