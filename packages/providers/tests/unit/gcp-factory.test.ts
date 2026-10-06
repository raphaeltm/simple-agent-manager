import { describe, expect,it } from 'vitest';

import {
  createProvider,
  DEFAULT_GCP_AGENT_PORTS,
  DEFAULT_GCP_APP_ROUTE_PORTS,
  DEFAULT_GCP_APP_ROUTE_SOURCE_RANGES,
  DEFAULT_GCP_FIREWALL_SOURCE_RANGES,
  GcpProvider,
} from '../../src/index';
import { testCidr } from './test-helpers';

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

  it('should accept explicit firewall config in ProviderConfig', () => {
    const provider = createProvider({
      provider: 'gcp',
      projectId: 'test-project',
      tokenProvider: async () => 'test-token',
      firewallSourceRanges: [testCidr(10, 0, 0, 0, 8)],
      agentPorts: ['9443'],
      appRouteSourceRanges: [testCidr(0, 0, 0, 0, 0)],
      appRoutePorts: ['80', '443'],
    });

    expect(provider).toBeInstanceOf(GcpProvider);
  });

  it('should export documented GCP firewall defaults', () => {
    expect(DEFAULT_GCP_FIREWALL_SOURCE_RANGES).toContain(testCidr(173, 245, 48, 0, 20));
    expect(DEFAULT_GCP_FIREWALL_SOURCE_RANGES).not.toContain(testCidr(0, 0, 0, 0, 0));
    expect(DEFAULT_GCP_AGENT_PORTS).toEqual(['8080', '8443']);
    expect(DEFAULT_GCP_APP_ROUTE_SOURCE_RANGES).toEqual([testCidr(0, 0, 0, 0, 0)]);
    expect(DEFAULT_GCP_APP_ROUTE_PORTS).toEqual(['80', '443']);
  });
});
