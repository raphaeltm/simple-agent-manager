import { describe, expect, it } from 'vitest';

import type { SizeConfig, VMConfig } from '../../src';
import {
  legacySizeToNativeVMConfig,
  ProviderError,
  resolveVMConfigWithLegacySizeAdapter,
} from '../../src';

const legacySizes: Readonly<Record<string, SizeConfig>> = {
  small: { type: 'legacy-small', price: '$1/mo', vcpu: 1, ramGb: 2, storageGb: 20 },
  medium: { type: 'legacy-medium', price: '$2/mo', vcpu: 2, ramGb: 4, storageGb: 40 },
  large: { type: 'legacy-large', price: '$3/mo', vcpu: 4, ramGb: 8, storageGb: 80 },
};

const baseConfig = {
  name: 'node',
  location: 'region-1',
  userData: '#cloud-config',
} satisfies Omit<VMConfig, 'size'>;

describe('native VM config resolver', () => {
  it('adapts legacy-only callers through the named compatibility adapter', () => {
    expect(legacySizeToNativeVMConfig('medium', { providerName: 'test', legacySizes })).toEqual({
      instanceType: 'legacy-medium',
      bootDiskSizeGb: 40,
      resources: { vcpuCount: 2, memoryMb: 4096, diskGb: 40 },
    });
  });

  it('can let a provider default boot disk override legacy-size storage for compatibility callers', () => {
    const resolved = resolveVMConfigWithLegacySizeAdapter(
      { ...baseConfig, size: 'small' },
      {
        providerName: 'gcp',
        defaultLocation: 'region-default',
        legacySizes,
        defaultBootDiskSizeGb: 200,
        legacyBootDiskSizeAuthority: 'provider-default',
      }
    );

    expect(resolved.bootDiskSizeGb).toBe(200);
    expect(resolved.resources).toEqual({ vcpuCount: 1, memoryMb: 2048, diskGb: 20 });
  });

  it('lets exact native configuration work without a legacy size', () => {
    const resolved = resolveVMConfigWithLegacySizeAdapter(
      {
        ...baseConfig,
        native: {
          instanceType: 'provider-exact-42',
          bootDiskSizeGb: 123,
          image: 'ubuntu-24-04-arm64',
          architecture: 'arm64',
          resources: { vcpuCount: 6, memoryMb: 12_288, diskGb: 123 },
        },
      },
      { providerName: 'test', defaultLocation: 'region-default', legacySizes }
    );

    expect(resolved).toMatchObject({
      instanceType: 'provider-exact-42',
      bootDiskSizeGb: 123,
      image: 'ubuntu-24-04-arm64',
      architecture: 'arm64',
      resources: { vcpuCount: 6, memoryMb: 12_288, diskGb: 123 },
    });
  });

  it('ignores absent or contradictory legacy hints once native instanceType is present', () => {
    const resolved = resolveVMConfigWithLegacySizeAdapter(
      {
        ...baseConfig,
        size: 'not-a-legacy-size',
        native: { instanceType: 'provider-exact-42', bootDiskSizeGb: 64 },
      } as VMConfig,
      { providerName: 'test', defaultLocation: 'region-default', legacySizes }
    );

    expect(resolved.instanceType).toBe('provider-exact-42');
    expect(resolved.bootDiskSizeGb).toBe(64);
  });

  it('preserves diskless native resource metadata while rejecting invalid resource units', () => {
    const diskless = resolveVMConfigWithLegacySizeAdapter(
      {
        ...baseConfig,
        native: {
          instanceType: 'diskless-supported-sku',
          resources: { vcpuCount: 2, memoryMb: 4096, diskGb: 0 },
        },
      },
      { providerName: 'test', defaultLocation: 'region-default', legacySizes }
    );

    expect(diskless.resources).toEqual({ vcpuCount: 2, memoryMb: 4096, diskGb: 0 });

    expect(() =>
      resolveVMConfigWithLegacySizeAdapter(
        {
          ...baseConfig,
          native: {
            instanceType: 'bad-sku',
            resources: { vcpuCount: 2, memoryMb: 4096, diskGb: -1 },
          },
        },
        { providerName: 'test', defaultLocation: 'region-default', legacySizes }
      )
    ).toThrow('native.resources.diskGb must be a non-negative integer');
  });

  it('rejects invalid native resources and incompatible image architecture before provider calls', () => {
    expect(() =>
      resolveVMConfigWithLegacySizeAdapter(
        {
          ...baseConfig,
          native: {
            instanceType: 'provider-exact-42',
            architecture: 'arm64',
            image: 'ubuntu-24-04-amd64',
          },
        },
        { providerName: 'test', defaultLocation: 'region-default', legacySizes }
      )
    ).toThrow(ProviderError);

    expect(() =>
      resolveVMConfigWithLegacySizeAdapter(
        {
          ...baseConfig,
          native: { instanceType: 'provider-exact-42', resources: { vcpuCount: 0, memoryMb: 1 } },
        },
        { providerName: 'test', defaultLocation: 'region-default', legacySizes }
      )
    ).toThrow('native.resources.vcpuCount');
  });
});
