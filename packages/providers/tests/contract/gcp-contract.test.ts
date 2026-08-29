import { describe, expect, it } from 'vitest';

import { GcpProvider } from '../../src/gcp';
import { runProviderCancellationContractTests } from './provider-contract.test';

describe('GcpProvider provider-native offerings contract', () => {
  it('exposes static provider-native offerings for every configured zone', async () => {
    const provider = new GcpProvider('contract-project', async () => 'contract-access-token');

    const offerings = await provider.listInstanceOfferings({ preferApi: false });

    expect(offerings.length).toBeGreaterThan(provider.locations.length);
    expect(offerings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'gcp',
          location: provider.defaultLocation,
          providerInstanceType: provider.sizes.small.type,
          providerInstanceSku: null,
          vcpu: provider.sizes.small.vcpu,
          memoryMb: provider.sizes.small.ramGb * 1024,
          diskGb: provider.sizes.small.storageGb,
          catalogSource: 'static',
          catalogLastSeenAt: null,
        }),
      ])
    );
  });
});

runProviderCancellationContractTests(
  () => new GcpProvider('contract-project', async () => 'contract-access-token'),
  { name: 'GcpProvider Contract' }
);
