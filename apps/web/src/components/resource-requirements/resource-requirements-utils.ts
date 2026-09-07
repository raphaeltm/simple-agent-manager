import type { ResourceRequirements } from '@simple-agent-manager/shared';
import { normalizeResourceRequirements } from '@simple-agent-manager/shared';

import { expectJsonRecord } from '../../lib/runtime-validation';

export interface ResourceRequirementsFormState {
  minVcpu: string;
  minMemoryGb: string;
  minDiskGb: string;
  exclusiveNode: boolean | undefined;
  maxCoTenants: string;
  /** Set when stored JSON could not be parsed or validated; prevents accidental overwrite on save. */
  storedJsonError?: string;
  /** Per-field stored errors — only cleared when that specific field is edited. */
  storedFieldErrors?: Partial<Record<string, string>>;
  /** Raw stored fields with wrong types, preserved until the user explicitly clears. */
  _rawInvalidFields?: Record<string, unknown>;
  /** Unknown stored fields preserved for round-trip fidelity. */
  _opaqueFields?: Record<string, unknown>;
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

const NUMERIC_FIELDS = ['minVcpu', 'minMemoryGb', 'minDiskGb', 'maxCoTenants'] as const;

function cleanFieldError(msg: string): string {
  return msg.replace(/^resourceRequirements\./, '');
}

/**
 * Validate form state through the canonical normalizeResourceRequirements
 * contract, one field at a time so all errors are reported together.
 */
export function validateResourceState(state: ResourceRequirementsFormState): ResourceValidationErrors {
  const errors: ResourceValidationErrors = {};

  if (state.storedJsonError) {
    errors.form = state.storedJsonError;
  }

  if (state.storedFieldErrors) {
    for (const [field, msg] of Object.entries(state.storedFieldErrors)) {
      if (msg && field in errors === false) {
        (errors as Record<string, string>)[field] = msg;
      }
    }
  }

  if (state._rawInvalidFields && Object.keys(state._rawInvalidFields).length > 0) {
    errors.form = errors.form ?? 'Some stored fields have invalid types. Clear or fix them before saving.';
  }

  for (const field of NUMERIC_FIELDS) {
    const val = state[field];
    if (val === '') continue;
    try {
      normalizeResourceRequirements({ [field]: Number(val) });
    } catch (err) {
      errors[field] = cleanFieldError(err instanceof Error ? err.message : 'Invalid value');
    }
  }

  if (state.exclusiveNode !== undefined) {
    try {
      normalizeResourceRequirements({ exclusiveNode: state.exclusiveNode });
    } catch (err) {
      errors.form = cleanFieldError(err instanceof Error ? err.message : 'Invalid exclusiveNode');
    }
  }

  return errors;
}

export function hasValidationErrors(errors: ResourceValidationErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** Clear the per-field stored error and raw invalid entry for a single edited field. */
export function clearStoredFieldError(
  state: ResourceRequirementsFormState,
  field: string
): Partial<ResourceRequirementsFormState> {
  const patch: Partial<ResourceRequirementsFormState> = {};
  if (state.storedFieldErrors && Object.hasOwn(state.storedFieldErrors, field)) {
    const next = { ...state.storedFieldErrors };
    delete next[field];
    patch.storedFieldErrors = Object.keys(next).length > 0 ? next : undefined;
  }
  if (state._rawInvalidFields && Object.hasOwn(state._rawInvalidFields, field)) {
    const next = { ...state._rawInvalidFields };
    delete next[field];
    patch._rawInvalidFields = Object.keys(next).length > 0 ? next : undefined;
  }
  return patch;
}


const KNOWN_FIELDS = new Set(['minVcpu', 'minMemoryGb', 'minDiskGb', 'exclusiveNode', 'maxCoTenants']);

export function deserializeResourceRequirements(
  json: string | null | undefined
): ResourceRequirementsFormState {
  if (!json) return { ...EMPTY_RESOURCE_STATE };
  let req: Record<string, unknown>;
  try {
    req = expectJsonRecord(JSON.parse(json) as unknown, 'resourceRequirements');
  } catch (err) {
    return {
      ...EMPTY_RESOURCE_STATE,
      storedJsonError: `Stored resource data is malformed: ${err instanceof Error ? err.message : 'invalid JSON'}`,
    };
  }

  const opaqueFields: Record<string, unknown> = {};
  for (const key of Object.keys(req)) {
    if (!KNOWN_FIELDS.has(key)) opaqueFields[key] = req[key];
  }

  const rawInvalidFields: Record<string, unknown> = {};
  const storedFieldErrors: Record<string, string> = {};

  const state: ResourceRequirementsFormState = {
    minVcpu: '',
    minMemoryGb: '',
    minDiskGb: '',
    exclusiveNode: undefined,
    maxCoTenants: '',
  };

  for (const field of NUMERIC_FIELDS) {
    const v = req[field];
    if (v === undefined) continue;
    if (typeof v === 'number' && Number.isFinite(v)) {
      state[field] = String(v);
      try {
        normalizeResourceRequirements({ [field]: v });
      } catch (err) {
        storedFieldErrors[field] = cleanFieldError(err instanceof Error ? err.message : 'Invalid value');
      }
    } else {
      rawInvalidFields[field] = v;
      storedFieldErrors[field] = `Invalid type for ${field}: expected number, got ${typeof v}`;
    }
  }

  if (req.exclusiveNode !== undefined) {
    if (typeof req.exclusiveNode === 'boolean') {
      state.exclusiveNode = req.exclusiveNode;
    } else {
      rawInvalidFields.exclusiveNode = req.exclusiveNode;
      storedFieldErrors.exclusiveNode = `Invalid type for exclusiveNode: expected boolean, got ${typeof req.exclusiveNode}`;
    }
  }

  if (Object.keys(opaqueFields).length > 0) state._opaqueFields = opaqueFields;
  if (Object.keys(rawInvalidFields).length > 0) state._rawInvalidFields = rawInvalidFields;
  if (Object.keys(storedFieldErrors).length > 0) state.storedFieldErrors = storedFieldErrors;

  return state;
}

export function serializeResourceRequirements(
  state: ResourceRequirementsFormState
): string | null {
  if (state._rawInvalidFields && Object.keys(state._rawInvalidFields).length > 0) {
    throw new Error('Cannot save: some stored fields have invalid types. Clear the resource requirements first.');
  }
  const raw = buildRawRequirements(state);
  const opaque = state._opaqueFields ?? {};
  const merged = { ...opaque, ...raw };
  if (Object.keys(merged).length === 0) return null;
  const validated = normalizeResourceRequirements(raw);
  const result = { ...opaque, ...validated };
  return Object.keys(result).length > 0 ? JSON.stringify(result) : null;
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
    state.maxCoTenants ||
    (state._opaqueFields && Object.keys(state._opaqueFields).length > 0) ||
    (state._rawInvalidFields && Object.keys(state._rawInvalidFields).length > 0)
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
