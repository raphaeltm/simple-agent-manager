import type { ResourceRequirements } from '@simple-agent-manager/shared';
import { normalizeResourceRequirements } from '@simple-agent-manager/shared';

import { expectJsonRecord } from '../../lib/runtime-validation';

export interface ResourceRequirementsFormState {
  minVcpu: string;
  minMemoryGb: string;
  minDiskGb: string;
  exclusiveNode: boolean | undefined;
  maxCoTenants: string;
  /** Set when stored JSON could not be parsed; prevents accidental overwrite on save. */
  storedJsonError?: string;
}

export const EMPTY_RESOURCE_STATE: ResourceRequirementsFormState = {
  minVcpu: '',
  minMemoryGb: '',
  minDiskGb: '',
  exclusiveNode: undefined,
  maxCoTenants: '',
};

export interface ResourceValidationErrors {
  minVcpu?: string;
  minMemoryGb?: string;
  minDiskGb?: string;
  maxCoTenants?: string;
  form?: string;
}

export function validateResourceState(state: ResourceRequirementsFormState): ResourceValidationErrors {
  const errors: ResourceValidationErrors = {};

  if (state.minVcpu !== '') {
    const n = Number(state.minVcpu);
    if (!Number.isFinite(n) || n <= 0) {
      errors.minVcpu = 'Must be a positive number';
    }
  }

  if (state.minMemoryGb !== '') {
    const n = Number(state.minMemoryGb);
    if (!Number.isFinite(n) || n <= 0) {
      errors.minMemoryGb = 'Must be a positive number';
    }
  }

  if (state.minDiskGb !== '') {
    const n = Number(state.minDiskGb);
    if (!Number.isFinite(n) || n < 0) {
      errors.minDiskGb = 'Must be zero or a positive number';
    }
  }

  if (state.maxCoTenants !== '') {
    const n = Number(state.maxCoTenants);
    if (!Number.isSafeInteger(n) || n <= 0) {
      errors.maxCoTenants = 'Must be a positive whole number';
    }
  }

  if (state.storedJsonError) {
    errors.form = state.storedJsonError;
  }

  return errors;
}

export function hasValidationErrors(errors: ResourceValidationErrors): boolean {
  return Object.keys(errors).length > 0;
}

export function deserializeResourceRequirements(
  json: string | null | undefined
): ResourceRequirementsFormState {
  if (!json) return { ...EMPTY_RESOURCE_STATE };
  try {
    const req = expectJsonRecord(JSON.parse(json) as unknown, 'resourceRequirements');
    return {
      minVcpu: typeof req.minVcpu === 'number' && Number.isFinite(req.minVcpu) ? String(req.minVcpu) : '',
      minMemoryGb: typeof req.minMemoryGb === 'number' && Number.isFinite(req.minMemoryGb) ? String(req.minMemoryGb) : '',
      minDiskGb: typeof req.minDiskGb === 'number' && Number.isFinite(req.minDiskGb) ? String(req.minDiskGb) : '',
      exclusiveNode: typeof req.exclusiveNode === 'boolean' ? req.exclusiveNode : undefined,
      maxCoTenants: typeof req.maxCoTenants === 'number' && Number.isFinite(req.maxCoTenants) ? String(req.maxCoTenants) : '',
    };
  } catch (err) {
    return {
      ...EMPTY_RESOURCE_STATE,
      storedJsonError: `Stored resource data is malformed: ${err instanceof Error ? err.message : 'invalid JSON'}`,
    };
  }
}

export function serializeResourceRequirements(
  state: ResourceRequirementsFormState
): string | null {
  const raw = buildRawRequirements(state);
  if (Object.keys(raw).length === 0) return null;
  const validated = normalizeResourceRequirements(raw);
  return Object.keys(validated).length > 0 ? JSON.stringify(validated) : null;
}

export function toResourceRequirements(
  state: ResourceRequirementsFormState
): ResourceRequirements | undefined {
  const raw = buildRawRequirements(state);
  if (Object.keys(raw).length === 0) return undefined;
  return normalizeResourceRequirements(raw);
}

function buildRawRequirements(state: ResourceRequirementsFormState): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  if (state.minVcpu !== '') raw.minVcpu = Number(state.minVcpu);
  if (state.minMemoryGb !== '') raw.minMemoryGb = Number(state.minMemoryGb);
  if (state.minDiskGb !== '') raw.minDiskGb = Number(state.minDiskGb);
  if (state.exclusiveNode !== undefined) raw.exclusiveNode = state.exclusiveNode;
  if (state.maxCoTenants !== '') raw.maxCoTenants = Number(state.maxCoTenants);
  return raw;
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
