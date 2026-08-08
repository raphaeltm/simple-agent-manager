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
});

runProviderCancellationContractTests(
  () => new InfomaniakProvider('contract-credential-id', 'contract-credential-secret'),
  { name: 'InfomaniakProvider Contract' }
);
