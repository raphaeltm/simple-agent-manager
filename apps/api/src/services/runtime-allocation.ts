import type {
  NativeVMConfig,
  VMArchitecture,
  VMConfig,
  VMHardwareResources,
  VMInstance,
  VMObservedHardware,
} from '@simple-agent-manager/providers';
import { ProviderError } from '@simple-agent-manager/providers';

type NativePlanRow = {
  providerInstanceType?: string | null;
  providerInstanceVcpuCount?: number | null;
  providerInstanceMemoryMb?: number | null;
  providerInstanceDiskGb?: number | null;
  providerInstanceBootDiskSizeGb?: number | null;
  providerInstanceImage?: string | null;
  providerInstanceArchitecture?: string | null;
};

export type ObservedHardwareDbValues = {
  observedProviderInstanceType: string | null;
  observedProviderInstanceVcpuCount: number | null;
  observedProviderInstanceMemoryMb: number | null;
  observedProviderInstanceDiskGb: number | null;
  observedHardwareJson: string;
  observedHardwareSource: string;
};

export function nativePlanFromRow(row: NativePlanRow): NativeVMConfig | undefined {
  const instanceType = row.providerInstanceType?.trim();
  if (!instanceType) return undefined;

  const resources = nativeResourcesFromRow(row);
  return {
    instanceType,
    ...(positiveInteger(row.providerInstanceBootDiskSizeGb) !== null
      ? { bootDiskSizeGb: positiveInteger(row.providerInstanceBootDiskSizeGb) ?? undefined }
      : {}),
    ...(row.providerInstanceImage?.trim() ? { image: row.providerInstanceImage.trim() } : {}),
    ...(toVmArchitecture(row.providerInstanceArchitecture)
      ? { architecture: toVmArchitecture(row.providerInstanceArchitecture) }
      : {}),
    ...(resources ? { resources } : {}),
  };
}

export function applyNativePlanToVmConfig<T extends VMConfig>(config: T, row: NativePlanRow): T {
  const native = nativePlanFromRow(row);
  if (!native) return config;
  const nativeWithDefaults =
    config.image && !native.image ? { ...native, image: config.image } : native;
  return {
    ...config,
    native: nativeWithDefaults,
    instanceType: undefined,
    size: undefined,
    image: undefined,
  };
}

export function assertNativePlanConcrete(providerName: string, row: NativePlanRow): void {
  const instanceType = row.providerInstanceType?.trim();
  if (!instanceType) return;

  const invalidFields = [
    positiveInteger(row.providerInstanceBootDiskSizeGb) === null &&
    row.providerInstanceBootDiskSizeGb !== null &&
    row.providerInstanceBootDiskSizeGb !== undefined
      ? 'providerInstanceBootDiskSizeGb'
      : null,
    positiveInteger(row.providerInstanceVcpuCount) === null &&
    row.providerInstanceVcpuCount !== null &&
    row.providerInstanceVcpuCount !== undefined
      ? 'providerInstanceVcpuCount'
      : null,
    positiveInteger(row.providerInstanceMemoryMb) === null &&
    row.providerInstanceMemoryMb !== null &&
    row.providerInstanceMemoryMb !== undefined
      ? 'providerInstanceMemoryMb'
      : null,
    nonNegativeInteger(row.providerInstanceDiskGb) === null &&
    row.providerInstanceDiskGb !== null &&
    row.providerInstanceDiskGb !== undefined
      ? 'providerInstanceDiskGb'
      : null,
  ].filter(Boolean);

  if (invalidFields.length > 0) {
    throw new ProviderError(
      providerName,
      400,
      `Invalid native allocation plan fields: ${invalidFields.join(', ')}`,
      { category: 'invalid_config' }
    );
  }

  const architecture = row.providerInstanceArchitecture?.trim();
  if (architecture && !toVmArchitecture(architecture)) {
    throw new ProviderError(
      providerName,
      400,
      `Invalid native allocation architecture: ${architecture}`,
      { category: 'invalid_config' }
    );
  }
}

export function observedHardwareDbValues(vm: VMInstance): ObservedHardwareDbValues {
  const observedType =
    vm.observedHardware.serverType.source === 'observed'
      ? vm.observedHardware.serverType.value
      : null;
  const observedResources =
    vm.observedHardware.resources.source === 'observed'
      ? vm.observedHardware.resources.value
      : null;

  return {
    observedProviderInstanceType: observedType,
    observedProviderInstanceVcpuCount: observedResources?.vcpuCount ?? null,
    observedProviderInstanceMemoryMb: observedResources?.memoryMb ?? null,
    observedProviderInstanceDiskGb: observedResources?.diskGb ?? null,
    observedHardwareJson: JSON.stringify(vm.observedHardware),
    observedHardwareSource: summarizeObservedHardwareSource(vm.observedHardware),
  };
}

function nativeResourcesFromRow(row: NativePlanRow): VMHardwareResources | undefined {
  const vcpuCount = positiveInteger(row.providerInstanceVcpuCount);
  const memoryMb = positiveInteger(row.providerInstanceMemoryMb);
  if (vcpuCount === null || memoryMb === null) return undefined;

  const diskGb = nonNegativeInteger(row.providerInstanceDiskGb);
  return {
    vcpuCount,
    memoryMb,
    ...(diskGb !== null ? { diskGb } : {}),
  };
}

function positiveInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function toVmArchitecture(value: string | null | undefined): VMArchitecture | undefined {
  if (value === 'x86_64' || value === 'arm64') return value;
  return undefined;
}

function summarizeObservedHardwareSource(hardware: VMObservedHardware): string {
  if (hardware.serverType.source === 'observed' && hardware.resources.source === 'observed') {
    return 'observed';
  }
  if (hardware.serverType.source === 'unknown' && hardware.resources.source === 'unknown') {
    return 'unknown';
  }
  return `${hardware.serverType.source}/${hardware.resources.source}`;
}
