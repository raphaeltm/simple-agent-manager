import type { ResourceRequirements } from '@simple-agent-manager/shared';

import { expectJsonRecord } from '../../lib/runtime-validation';

export interface ResourceRequirementsFormState {
  minVcpu: string;
  minMemoryGb: string;
  minDiskGb: string;
  exclusiveNode: boolean | undefined;
  maxCoTenants: string;
}

export const EMPTY_RESOURCE_STATE: ResourceRequirementsFormState = {
  minVcpu: '',
  minMemoryGb: '',
  minDiskGb: '',
  exclusiveNode: undefined,
  maxCoTenants: '',
};

export function deserializeResourceRequirements(
  json: string | null | undefined
): ResourceRequirementsFormState {
  if (!json) return { ...EMPTY_RESOURCE_STATE };
  try {
    const req = expectJsonRecord(JSON.parse(json) as unknown, 'resourceRequirements');
    return {
      minVcpu: typeof req.minVcpu === 'number' ? String(req.minVcpu) : '',
      minMemoryGb: typeof req.minMemoryGb === 'number' ? String(req.minMemoryGb) : '',
      minDiskGb: typeof req.minDiskGb === 'number' ? String(req.minDiskGb) : '',
      exclusiveNode: typeof req.exclusiveNode === 'boolean' ? req.exclusiveNode : undefined,
      maxCoTenants: typeof req.maxCoTenants === 'number' ? String(req.maxCoTenants) : '',
    };
  } catch {
    return { ...EMPTY_RESOURCE_STATE };
  }
}

export function serializeResourceRequirements(
  state: ResourceRequirementsFormState
): string | null {
  const req: Record<string, unknown> = {};
  if (state.minVcpu) req.minVcpu = Number(state.minVcpu);
  if (state.minMemoryGb) req.minMemoryGb = Number(state.minMemoryGb);
  if (state.minDiskGb) req.minDiskGb = Number(state.minDiskGb);
  if (state.exclusiveNode !== undefined) req.exclusiveNode = state.exclusiveNode;
  if (state.maxCoTenants) req.maxCoTenants = Number(state.maxCoTenants);
  return Object.keys(req).length > 0 ? JSON.stringify(req) : null;
}

export function toResourceRequirements(
  state: ResourceRequirementsFormState
): ResourceRequirements | undefined {
  const req: ResourceRequirements = {};
  if (state.minVcpu) req.minVcpu = Number(state.minVcpu);
  if (state.minMemoryGb) req.minMemoryGb = Number(state.minMemoryGb);
  if (state.minDiskGb) req.minDiskGb = Number(state.minDiskGb);
  if (state.exclusiveNode !== undefined) req.exclusiveNode = state.exclusiveNode;
  if (state.maxCoTenants) req.maxCoTenants = Number(state.maxCoTenants);
  return Object.keys(req).length > 0 ? req : undefined;
}

export function hasAnyResourceValue(state: ResourceRequirementsFormState): boolean {
  return !!(
    state.minVcpu ||
    state.minMemoryGb ||
    state.minDiskGb ||
    state.exclusiveNode !== undefined ||
    state.maxCoTenants
  );
}

const LEGACY_SIZE_LABELS: Record<string, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
};

export function formatLegacyVmSize(vmSize: string | null | undefined): string | null {
  if (!vmSize) return null;
  return LEGACY_SIZE_LABELS[vmSize] ?? vmSize;
}

export function formatHardwareDisplay(opts: {
  providerInstanceType?: string | null;
  providerInstanceVcpuCount?: number | null;
  providerInstanceMemoryMb?: number | null;
  providerInstanceDiskGb?: number | null;
  vmSize?: string | null;
}): string {
  if (opts.providerInstanceType) {
    const parts = [opts.providerInstanceType];
    if (opts.providerInstanceVcpuCount) parts.push(`${opts.providerInstanceVcpuCount} vCPU`);
    if (opts.providerInstanceMemoryMb) {
      const gb = (opts.providerInstanceMemoryMb / 1024).toFixed(
        opts.providerInstanceMemoryMb % 1024 === 0 ? 0 : 1
      );
      parts.push(`${gb} GB`);
    }
    if (opts.providerInstanceDiskGb) parts.push(`${opts.providerInstanceDiskGb} GB disk`);
    return parts.join(' · ');
  }
  const label = formatLegacyVmSize(opts.vmSize);
  if (label) return `${label} (compatibility estimate)`;
  return 'Unknown';
}
