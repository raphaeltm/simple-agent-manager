import type {
  NativeVMConfig,
  SizeConfig,
  VMArchitecture,
  VMConfig,
  VMHardwareResources,
  VMObservedHardware,
  VMObservedValue,
} from './types';
import { ProviderError } from './types';

const IMAGE_ARCHITECTURE_MARKERS: Readonly<Record<VMArchitecture, readonly RegExp[]>> = {
  x86_64: [/\bx86[_-]?64\b/i, /\bamd64\b/i, /\bx64\b/i],
  arm64: [/\barm64\b/i, /\baarch64\b/i],
};

export interface ResolvedNativeVMConfig {
  name: string;
  location: string;
  userData: string;
  labels: Record<string, string>;
  instanceType: string;
  image?: string;
  architecture?: VMArchitecture;
  bootDiskSizeGb?: number;
  resources?: VMHardwareResources;
}

export interface NativeVMResolveOptions {
  providerName: string;
  defaultLocation: string;
  legacySizes: Readonly<Record<string, SizeConfig>>;
  defaultImage?: string;
  defaultBootDiskSizeGb?: number;
  minBootDiskSizeGb?: number;
  maxBootDiskSizeGb?: number;
}

export function resolveVMConfigWithLegacySizeAdapter(
  config: VMConfig,
  options: NativeVMResolveOptions
): ResolvedNativeVMConfig {
  const native = normalizeNativeVMConfig(config, options);
  validateImageArchitecture(
    native.image ?? options.defaultImage,
    native.architecture,
    options.providerName
  );

  return {
    name: config.name,
    location: config.location || options.defaultLocation,
    userData: config.userData,
    labels: config.labels || {},
    ...native,
  };
}

export function legacySizeToNativeVMConfig(
  size: string | undefined,
  options: Pick<NativeVMResolveOptions, 'providerName' | 'legacySizes'>
): NativeVMConfig {
  if (!size) {
    throw new ProviderError(
      options.providerName,
      undefined,
      'Native VM provisioning requires native.instanceType or a legacy size adapter input',
      { category: 'invalid_config' }
    );
  }

  const sizeConfig = options.legacySizes[size];
  if (!sizeConfig) {
    throw new ProviderError(options.providerName, undefined, `Unknown VM size: ${size}`, {
      category: 'invalid_config',
    });
  }

  return {
    instanceType: sizeConfig.type,
    bootDiskSizeGb: sizeConfig.storageGb,
    resources: {
      vcpuCount: sizeConfig.vcpu,
      memoryMb: sizeConfig.ramGb * 1024,
      diskGb: sizeConfig.storageGb,
    },
  };
}

export function assertBootDiskSizeGb(
  providerName: string,
  value: number | undefined,
  limits: { min?: number; max?: number } = {}
): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0) {
    throw new ProviderError(providerName, 400, 'bootDiskSizeGb must be a positive integer GB value', {
      category: 'invalid_config',
    });
  }
  if (limits.min !== undefined && value < limits.min) {
    throw new ProviderError(
      providerName,
      400,
      `bootDiskSizeGb must be at least ${limits.min}GB for ${providerName}`,
      { category: 'invalid_config' }
    );
  }
  if (limits.max !== undefined && value > limits.max) {
    throw new ProviderError(
      providerName,
      400,
      `bootDiskSizeGb must be at most ${limits.max}GB for ${providerName}`,
      { category: 'invalid_config' }
    );
  }
}

export function observedValue<T>(value: T): VMObservedValue<T> {
  return { value, source: 'observed' };
}

export function unknownValue<T>(reason: string): VMObservedValue<T> {
  return { value: null, source: 'unknown', reason };
}

export function observedHardware(input: {
  serverType?: string | null;
  resources?: VMHardwareResources | null;
  unknownResourcesReason?: string;
}): VMObservedHardware {
  return {
    serverType:
      input.serverType && input.serverType.length > 0
        ? observedValue(input.serverType)
        : unknownValue('Provider response did not include a server type'),
    resources: input.resources
      ? observedValue(input.resources)
      : unknownValue(input.unknownResourcesReason ?? 'Provider response did not include resources'),
  };
}

function normalizeNativeVMConfig(
  config: VMConfig,
  options: NativeVMResolveOptions
): NativeVMConfig {
  const explicitNative = config.native;
  const candidate: NativeVMConfig =
    explicitNative ??
    (config.instanceType
      ? {
          instanceType: config.instanceType,
          image: config.image,
        }
      : legacySizeToNativeVMConfig(config.size, options));

  if (!candidate.instanceType || candidate.instanceType.trim().length === 0) {
    throw new ProviderError(options.providerName, 400, 'native.instanceType is required', {
      category: 'invalid_config',
    });
  }

  const bootDiskSizeGb = candidate.bootDiskSizeGb ?? options.defaultBootDiskSizeGb;
  assertBootDiskSizeGb(options.providerName, bootDiskSizeGb, {
    min: options.minBootDiskSizeGb,
    max: options.maxBootDiskSizeGb,
  });

  const resources = candidate.resources;
  if (resources) validateResources(resources, options.providerName);

  return {
    instanceType: candidate.instanceType,
    ...(candidate.image ?? config.image ? { image: candidate.image ?? config.image } : {}),
    ...(candidate.architecture ? { architecture: candidate.architecture } : {}),
    ...(bootDiskSizeGb !== undefined ? { bootDiskSizeGb } : {}),
    ...(resources ? { resources } : {}),
  };
}

function validateResources(resources: VMHardwareResources, providerName: string): void {
  if (!Number.isInteger(resources.vcpuCount) || resources.vcpuCount <= 0) {
    throw new ProviderError(providerName, 400, 'native.resources.vcpuCount must be a positive integer', {
      category: 'invalid_config',
    });
  }
  if (!Number.isInteger(resources.memoryMb) || resources.memoryMb <= 0) {
    throw new ProviderError(providerName, 400, 'native.resources.memoryMb must be a positive integer', {
      category: 'invalid_config',
    });
  }
  if (
    resources.diskGb !== undefined &&
    (!Number.isInteger(resources.diskGb) || resources.diskGb <= 0)
  ) {
    throw new ProviderError(providerName, 400, 'native.resources.diskGb must be a positive integer', {
      category: 'invalid_config',
    });
  }
}

function validateImageArchitecture(
  image: string | undefined,
  architecture: VMArchitecture | undefined,
  providerName: string
): void {
  if (!image || !architecture) return;
  const incompatibleArchitecture = architecture === 'arm64' ? 'x86_64' : 'arm64';
  const markers = IMAGE_ARCHITECTURE_MARKERS[incompatibleArchitecture];
  if (!markers.some((marker) => marker.test(image))) return;

  throw new ProviderError(
    providerName,
    400,
    `Image "${image}" is incompatible with requested ${architecture} architecture`,
    { category: 'invalid_config' }
  );
}
