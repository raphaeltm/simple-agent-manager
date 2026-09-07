import type { CCConfiguration, CCCredential } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import { hydrateMissingCloudProviderSecretProviders } from '../../src/services/composable-credentials/snapshot';

function cloudCredential(overrides: Partial<CCCredential> = {}): CCCredential {
  return {
    id: 'cred-cloud',
    ownerId: 'user-1',
    name: 'Hetzner migrated',
    kind: 'cloud-provider',
    secret: { kind: 'cloud-provider', provider: '', token: 'raw-hetzner-token' },
    isActive: true,
    ...overrides,
  };
}

function computeConfiguration(overrides: Partial<CCConfiguration> = {}): CCConfiguration {
  return {
    id: 'cfg-hetzner',
    ownerId: 'user-1',
    name: 'Hetzner compute',
    consumer: { kind: 'compute', provider: 'hetzner' },
    credentialId: 'cred-cloud',
    settings: {},
    isActive: true,
    ...overrides,
  };
}

describe('hydrateMissingCloudProviderSecretProviders', () => {
  it('hydrates a raw migrated cloud-provider credential from its compute configuration', () => {
    const [credential] = hydrateMissingCloudProviderSecretProviders(
      [cloudCredential()],
      [computeConfiguration()],
    );

    expect(credential.secret).toEqual({
      kind: 'cloud-provider',
      provider: 'hetzner',
      token: 'raw-hetzner-token',
    });
  });

  it('does not override an explicit provider from the decrypted secret', () => {
    const [credential] = hydrateMissingCloudProviderSecretProviders(
      [
        cloudCredential({
          secret: { kind: 'cloud-provider', provider: 'scaleway', token: 'scw-token' },
        }),
      ],
      [computeConfiguration()],
    );

    expect(credential.secret).toEqual({
      kind: 'cloud-provider',
      provider: 'scaleway',
      token: 'scw-token',
    });
  });

  it('leaves the provider empty when one credential is referenced by multiple compute providers', () => {
    const [credential] = hydrateMissingCloudProviderSecretProviders(
      [cloudCredential()],
      [
        computeConfiguration(),
        computeConfiguration({
          id: 'cfg-scaleway',
          consumer: { kind: 'compute', provider: 'scaleway' },
        }),
      ],
    );

    expect(credential.secret).toEqual({
      kind: 'cloud-provider',
      provider: '',
      token: 'raw-hetzner-token',
    });
  });
});
