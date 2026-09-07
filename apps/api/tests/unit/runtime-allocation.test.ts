import { ProviderError, type VMConfig, type VMInstance } from '@simple-agent-manager/providers';
import { describe, expect, it } from 'vitest';

import {
  applyNativePlanToVmConfig,
  assertNativePlanConcrete,
  nativePlanFromRow,
  observedHardwareDbValues,
} from '../../src/services/runtime-allocation';

describe('runtime allocation native plan reader', () => {
  it('builds a provider-native VM payload without legacy vmSize or top-level instance type authority', () => {
    const legacyConfig: VMConfig = {
      name: 'sam-node',
      size: 'medium',
      instanceType: 'legacy-medium-alias',
      location: 'nbg1',
      userData: '#cloud-config',
      image: 'legacy-image',
    };

    const config = applyNativePlanToVmConfig(legacyConfig, {
      providerInstanceType: 'arbitrary-provider-sku-without-alias',
      providerInstanceBootDiskSizeGb: 80,
      providerInstanceImage: 'ubuntu-24.04',
      providerInstanceArchitecture: 'arm64',
      providerInstanceVcpuCount: 6,
      providerInstanceMemoryMb: 12288,
      providerInstanceDiskGb: 160,
    });

    expect(config).toMatchObject({
      name: 'sam-node',
      location: 'nbg1',
      userData: '#cloud-config',
      native: {
        instanceType: 'arbitrary-provider-sku-without-alias',
        bootDiskSizeGb: 80,
        image: 'ubuntu-24.04',
        architecture: 'arm64',
        resources: {
          vcpuCount: 6,
          memoryMb: 12288,
          diskGb: 160,
        },
      },
    });
    expect(config.size).toBeUndefined();
    expect(config.instanceType).toBeUndefined();
    expect(config.image).toBeUndefined();
  });

  it('does not claim resources from incomplete candidate estimates', () => {
    expect(
      nativePlanFromRow({
        providerInstanceType: 'cx42',
        providerInstanceVcpuCount: 8,
        providerInstanceMemoryMb: null,
        providerInstanceDiskGb: 80,
      })
    ).toEqual({ instanceType: 'cx42' });
  });

  it('rejects invalid concrete native plan fields before paid provider calls', () => {
    expect(() =>
      assertNativePlanConcrete('hetzner', {
        providerInstanceType: 'cx42',
        providerInstanceBootDiskSizeGb: 0,
        providerInstanceVcpuCount: 2.5,
        providerInstanceMemoryMb: -1,
        providerInstanceDiskGb: -1,
        providerInstanceArchitecture: 'riscv64',
      })
    ).toThrow(ProviderError);
  });
});

describe('runtime allocation observed hardware persistence', () => {
  it('persists provider-observed hardware separately from planned/catalog values', () => {
    const vm: VMInstance = {
      id: 'provider-vm-1',
      name: 'sam-node',
      ip: '203.0.113.10',
      status: 'running',
      serverType: 'catalog-estimate-ignored',
      createdAt: '2026-09-07T00:00:00.000Z',
      labels: {},
      observedHardware: {
        serverType: { source: 'observed', value: 'provider-returned-sku' },
        resources: {
          source: 'observed',
          value: { vcpuCount: 12, memoryMb: 49152, diskGb: 240 },
        },
      },
    };

    expect(observedHardwareDbValues(vm)).toEqual({
      observedProviderInstanceType: 'provider-returned-sku',
      observedProviderInstanceVcpuCount: 12,
      observedProviderInstanceMemoryMb: 49152,
      observedProviderInstanceDiskGb: 240,
      observedHardwareJson: JSON.stringify(vm.observedHardware),
      observedHardwareSource: 'observed',
    });
  });

  it('grandfathers unknown provider metadata without inventing observed capacity', () => {
    const vm: VMInstance = {
      id: 'provider-vm-2',
      name: 'legacy-node',
      ip: '203.0.113.11',
      status: 'running',
      serverType: 'legacy-vm-size-only',
      createdAt: '2026-09-07T00:00:00.000Z',
      labels: {},
      observedHardware: {
        serverType: { source: 'unknown', value: null, reason: 'legacy-provider-response' },
        resources: { source: 'unknown', value: null, reason: 'legacy-provider-response' },
      },
    };

    expect(observedHardwareDbValues(vm)).toEqual({
      observedProviderInstanceType: null,
      observedProviderInstanceVcpuCount: null,
      observedProviderInstanceMemoryMb: null,
      observedProviderInstanceDiskGb: null,
      observedHardwareJson: JSON.stringify(vm.observedHardware),
      observedHardwareSource: 'unknown',
    });
  });
});
