import { describe, expect, it } from 'vitest';

import { InfomaniakProvider } from '../../src/infomaniak';
import type { Provider } from '../../src/types';
import { runProviderCancellationContractTests } from './provider-contract.test';

describe('InfomaniakProvider contract surface', () => {
  it('implements every VM and volume lifecycle operation', () => {
    const provider: Provider = new InfomaniakProvider('id', 'secret');
    expect(provider.name).toBe('infomaniak');
    expect(provider.volumeCapabilities).toMatchObject({
      supported: true,
      growOnlyResize: true,
      requiresSameLocation: true,
    });
    for (const method of [
      'createVM',
      'deleteVM',
      'getVM',
      'listVMs',
      'powerOff',
      'powerOn',
      'validateToken',
      'listInstanceOfferings',
      'createVolume',
      'attachVolume',
      'detachVolume',
      'resizeVolume',
      'deleteVolume',
      'getVolume',
      'listVolumes',
    ] as const) {
      expect(provider[method]).toBeTypeOf('function');
    }
  });

  it('exposes static provider-native offerings for every configured location', async () => {
    const provider = new InfomaniakProvider('id', 'secret');

    const offerings = await provider.listInstanceOfferings({ preferApi: false });

    expect(offerings.length).toBeGreaterThan(provider.locations.length);
    expect(offerings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'infomaniak',
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
  () => new InfomaniakProvider('contract-credential-id', 'contract-credential-secret'),
  { name: 'InfomaniakProvider Contract' }
);
