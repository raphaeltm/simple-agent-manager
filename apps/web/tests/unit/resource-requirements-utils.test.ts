import { describe, expect, it } from 'vitest';

import {
  deserializeResourceRequirements,
  EMPTY_RESOURCE_STATE,
  formatHardwareDisplay,
  formatLegacyVmSize,
  hasAnyResourceValue,
  hasValidationErrors,
  serializeResourceRequirements,
  toResourceRequirements,
  validateResourceState,
} from '../../src/components/resource-requirements';

describe('deserializeResourceRequirements', () => {
  it('returns empty state for null input', () => {
    expect(deserializeResourceRequirements(null)).toEqual(EMPTY_RESOURCE_STATE);
  });

  it('returns empty state for undefined input', () => {
    expect(deserializeResourceRequirements(undefined)).toEqual(EMPTY_RESOURCE_STATE);
  });

  it('returns empty state for empty string', () => {
    expect(deserializeResourceRequirements('')).toEqual(EMPTY_RESOURCE_STATE);
  });

  it('sets storedJsonError for invalid JSON instead of silently returning empty', () => {
    const result = deserializeResourceRequirements('not json');
    expect(result.storedJsonError).toBeTruthy();
    expect(result.minVcpu).toBe('');
  });

  it('sets storedJsonError for JSON array', () => {
    const result = deserializeResourceRequirements('[1,2,3]');
    expect(result.storedJsonError).toBeTruthy();
  });

  it('deserializes all fields', () => {
    const json = JSON.stringify({
      minVcpu: 4,
      minMemoryGb: 8,
      minDiskGb: 40,
      exclusiveNode: true,
      maxCoTenants: 2,
    });
    const result = deserializeResourceRequirements(json);
    expect(result).toEqual({
      minVcpu: '4',
      minMemoryGb: '8',
      minDiskGb: '40',
      exclusiveNode: true,
      maxCoTenants: '2',
    });
    expect(result.storedJsonError).toBeUndefined();
  });

  it('handles partial fields', () => {
    const json = JSON.stringify({ minVcpu: 2 });
    const result = deserializeResourceRequirements(json);
    expect(result.minVcpu).toBe('2');
    expect(result.minMemoryGb).toBe('');
    expect(result.minDiskGb).toBe('');
    expect(result.exclusiveNode).toBeUndefined();
    expect(result.maxCoTenants).toBe('');
  });

  it('preserves exclusiveNode false vs undefined', () => {
    const withFalse = deserializeResourceRequirements(
      JSON.stringify({ exclusiveNode: false })
    );
    expect(withFalse.exclusiveNode).toBe(false);

    const withoutField = deserializeResourceRequirements(JSON.stringify({ minVcpu: 2 }));
    expect(withoutField.exclusiveNode).toBeUndefined();
  });

  it('deserializes NaN/Infinity stored values as empty', () => {
    const withNaN = deserializeResourceRequirements(JSON.stringify({ minVcpu: NaN }));
    expect(withNaN.minVcpu).toBe('');

    const withInf = deserializeResourceRequirements(JSON.stringify({ minMemoryGb: Infinity }));
    expect(withInf.minMemoryGb).toBe('');
  });
});

describe('serializeResourceRequirements', () => {
  it('returns null for empty state', () => {
    expect(serializeResourceRequirements(EMPTY_RESOURCE_STATE)).toBeNull();
  });

  it('serializes numeric fields', () => {
    const result = serializeResourceRequirements({
      ...EMPTY_RESOURCE_STATE,
      minVcpu: '4',
      minMemoryGb: '8',
    });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.minVcpu).toBe(4);
    expect(parsed.minMemoryGb).toBe(8);
  });

  it('preserves maxCoTenants alongside exclusiveNode=true', () => {
    const result = serializeResourceRequirements({
      ...EMPTY_RESOURCE_STATE,
      exclusiveNode: true,
      maxCoTenants: '4',
    });
    const parsed = JSON.parse(result!);
    expect(parsed.exclusiveNode).toBe(true);
    expect(parsed.maxCoTenants).toBe(4);
  });

  it('includes exclusiveNode false', () => {
    const result = serializeResourceRequirements({
      ...EMPTY_RESOURCE_STATE,
      exclusiveNode: false,
    });
    const parsed = JSON.parse(result!);
    expect(parsed.exclusiveNode).toBe(false);
  });

  it('round-trips through deserialize', () => {
    const original = {
      minVcpu: '4',
      minMemoryGb: '8',
      minDiskGb: '40',
      exclusiveNode: true,
      maxCoTenants: '2',
    };
    const serialized = serializeResourceRequirements(original);
    const deserialized = deserializeResourceRequirements(serialized);
    expect(deserialized.minVcpu).toBe('4');
    expect(deserialized.minMemoryGb).toBe('8');
    expect(deserialized.minDiskGb).toBe('40');
    expect(deserialized.exclusiveNode).toBe(true);
    expect(deserialized.maxCoTenants).toBe('2');
  });

  it('throws on NaN input (validation should run first)', () => {
    expect(() =>
      serializeResourceRequirements({
        ...EMPTY_RESOURCE_STATE,
        minVcpu: 'abc',
        minMemoryGb: '8',
      })
    ).toThrow();
  });

  it('throws on negative CPU (validation should run first)', () => {
    expect(() =>
      serializeResourceRequirements({
        ...EMPTY_RESOURCE_STATE,
        minVcpu: '-4',
      })
    ).toThrow();
  });

  it('throws on Infinity (validation should run first)', () => {
    expect(() =>
      serializeResourceRequirements({
        ...EMPTY_RESOURCE_STATE,
        minVcpu: 'Infinity',
      })
    ).toThrow();
  });

  it('accepts zero disk value', () => {
    const result = serializeResourceRequirements({
      ...EMPTY_RESOURCE_STATE,
      minDiskGb: '0',
    });
    const parsed = JSON.parse(result!);
    expect(parsed.minDiskGb).toBe(0);
  });

  it('accepts fractional CPU and memory', () => {
    const result = serializeResourceRequirements({
      ...EMPTY_RESOURCE_STATE,
      minVcpu: '0.5',
      minMemoryGb: '1.5',
    });
    const parsed = JSON.parse(result!);
    expect(parsed.minVcpu).toBe(0.5);
    expect(parsed.minMemoryGb).toBe(1.5);
  });
});

describe('toResourceRequirements', () => {
  it('returns undefined for empty state', () => {
    expect(toResourceRequirements(EMPTY_RESOURCE_STATE)).toBeUndefined();
  });

  it('returns ResourceRequirements object with values', () => {
    const result = toResourceRequirements({
      ...EMPTY_RESOURCE_STATE,
      minVcpu: '2',
      minMemoryGb: '4',
    });
    expect(result).toEqual({ minVcpu: 2, minMemoryGb: 4 });
  });

  it('throws on NaN (validation should run first)', () => {
    expect(() =>
      toResourceRequirements({
        ...EMPTY_RESOURCE_STATE,
        minVcpu: 'abc',
        minMemoryGb: '8',
      })
    ).toThrow();
  });
});

describe('hasAnyResourceValue', () => {
  it('returns false for empty state', () => {
    expect(hasAnyResourceValue(EMPTY_RESOURCE_STATE)).toBe(false);
  });

  it('returns true for any numeric field', () => {
    expect(hasAnyResourceValue({ ...EMPTY_RESOURCE_STATE, minVcpu: '2' })).toBe(true);
    expect(hasAnyResourceValue({ ...EMPTY_RESOURCE_STATE, minMemoryGb: '4' })).toBe(true);
    expect(hasAnyResourceValue({ ...EMPTY_RESOURCE_STATE, minDiskGb: '40' })).toBe(true);
    expect(hasAnyResourceValue({ ...EMPTY_RESOURCE_STATE, maxCoTenants: '4' })).toBe(true);
  });

  it('returns true for exclusiveNode boolean', () => {
    expect(hasAnyResourceValue({ ...EMPTY_RESOURCE_STATE, exclusiveNode: false })).toBe(true);
    expect(hasAnyResourceValue({ ...EMPTY_RESOURCE_STATE, exclusiveNode: true })).toBe(true);
  });
});

describe('formatLegacyVmSize', () => {
  it('returns null for null/undefined input', () => {
    expect(formatLegacyVmSize(null)).toBeNull();
    expect(formatLegacyVmSize(undefined)).toBeNull();
  });

  it('maps known sizes', () => {
    expect(formatLegacyVmSize('small')).toBe('Small');
    expect(formatLegacyVmSize('medium')).toBe('Medium');
    expect(formatLegacyVmSize('large')).toBe('Large');
  });

  it('passes through unknown sizes', () => {
    expect(formatLegacyVmSize('xlarge')).toBe('xlarge');
  });
});

describe('formatHardwareDisplay', () => {
  it('uses native instance type when available', () => {
    const result = formatHardwareDisplay({
      providerInstanceType: 'cpx21',
      providerInstanceVcpuCount: 3,
      providerInstanceMemoryMb: 4096,
      providerInstanceDiskGb: 80,
    });
    expect(result).toBe('cpx21 · 3 vCPU · 4 GB · 80 GB disk');
  });

  it('falls back to legacy label with estimate marker', () => {
    const result = formatHardwareDisplay({ vmSize: 'medium' });
    expect(result).toBe('Medium (compatibility estimate)');
  });

  it('returns Unknown when nothing available', () => {
    expect(formatHardwareDisplay({})).toBe('Unknown');
  });

  it('handles fractional memory correctly', () => {
    const result = formatHardwareDisplay({
      providerInstanceType: 'test',
      providerInstanceMemoryMb: 3584,
    });
    expect(result).toContain('3.5 GB');
  });
});

describe('validateResourceState', () => {
  it('returns no errors for empty state', () => {
    const errors = validateResourceState(EMPTY_RESOURCE_STATE);
    expect(hasValidationErrors(errors)).toBe(false);
  });

  it('returns no errors for valid values', () => {
    const errors = validateResourceState({
      ...EMPTY_RESOURCE_STATE,
      minVcpu: '4',
      minMemoryGb: '8',
      minDiskGb: '0',
    });
    expect(hasValidationErrors(errors)).toBe(false);
  });

  it('rejects zero CPU', () => {
    const errors = validateResourceState({ ...EMPTY_RESOURCE_STATE, minVcpu: '0' });
    expect(errors.minVcpu).toBeTruthy();
  });

  it('rejects zero memory', () => {
    const errors = validateResourceState({ ...EMPTY_RESOURCE_STATE, minMemoryGb: '0' });
    expect(errors.minMemoryGb).toBeTruthy();
  });

  it('accepts zero disk', () => {
    const errors = validateResourceState({ ...EMPTY_RESOURCE_STATE, minDiskGb: '0' });
    expect(errors.minDiskGb).toBeUndefined();
  });

  it('accepts exclusiveNode false', () => {
    const errors = validateResourceState({ ...EMPTY_RESOURCE_STATE, exclusiveNode: false });
    expect(hasValidationErrors(errors)).toBe(false);
  });

  it('rejects negative CPU', () => {
    const errors = validateResourceState({ ...EMPTY_RESOURCE_STATE, minVcpu: '-1' });
    expect(errors.minVcpu).toBeTruthy();
  });

  it('rejects NaN values', () => {
    const errors = validateResourceState({ ...EMPTY_RESOURCE_STATE, minVcpu: 'abc' });
    expect(errors.minVcpu).toBeTruthy();
  });

  it('rejects Infinity', () => {
    const errors = validateResourceState({ ...EMPTY_RESOURCE_STATE, minMemoryGb: 'Infinity' });
    expect(errors.minMemoryGb).toBeTruthy();
  });

  it('rejects fractional maxCoTenants', () => {
    const errors = validateResourceState({ ...EMPTY_RESOURCE_STATE, maxCoTenants: '2.5' });
    expect(errors.maxCoTenants).toBeTruthy();
  });

  it('rejects zero maxCoTenants', () => {
    const errors = validateResourceState({ ...EMPTY_RESOURCE_STATE, maxCoTenants: '0' });
    expect(errors.maxCoTenants).toBeTruthy();
  });

  it('accepts valid positive integer maxCoTenants', () => {
    const errors = validateResourceState({ ...EMPTY_RESOURCE_STATE, maxCoTenants: '3' });
    expect(errors.maxCoTenants).toBeUndefined();
  });

  it('reports storedJsonError as form error', () => {
    const state = { ...EMPTY_RESOURCE_STATE, storedJsonError: 'bad data' };
    const errors = validateResourceState(state);
    expect(errors.form).toBe('bad data');
    expect(hasValidationErrors(errors)).toBe(true);
  });

  it('accepts fractional CPU and memory', () => {
    const errors = validateResourceState({
      ...EMPTY_RESOURCE_STATE,
      minVcpu: '0.5',
      minMemoryGb: '1.5',
    });
    expect(hasValidationErrors(errors)).toBe(false);
  });
});

describe('exclusiveNode + maxCoTenants round-trip', () => {
  it('preserves both fields through round-trip', () => {
    const json = JSON.stringify({ exclusiveNode: true, maxCoTenants: 3 });
    const deserialized = deserializeResourceRequirements(json);
    expect(deserialized.exclusiveNode).toBe(true);
    expect(deserialized.maxCoTenants).toBe('3');

    const serialized = serializeResourceRequirements(deserialized);
    const parsed = JSON.parse(serialized!);
    expect(parsed.exclusiveNode).toBe(true);
    expect(parsed.maxCoTenants).toBe(3);
  });

  it('preserves exclusiveNode=false with maxCoTenants', () => {
    const json = JSON.stringify({ exclusiveNode: false, maxCoTenants: 5 });
    const deserialized = deserializeResourceRequirements(json);
    const serialized = serializeResourceRequirements(deserialized);
    const parsed = JSON.parse(serialized!);
    expect(parsed.exclusiveNode).toBe(false);
    expect(parsed.maxCoTenants).toBe(5);
  });
});

describe('upgrade-safe save semantics', () => {
  it('no-op save of legacy-only data produces null JSON (legacy preserved separately)', () => {
    const existing = deserializeResourceRequirements(null);
    expect(hasAnyResourceValue(existing)).toBe(false);
    const serialized = serializeResourceRequirements(existing);
    expect(serialized).toBeNull();
  });

  it('no-op save of mixed data preserves modern fields', () => {
    const json = JSON.stringify({ minVcpu: 2 });
    const existing = deserializeResourceRequirements(json);
    expect(existing.minVcpu).toBe('2');
    const serialized = serializeResourceRequirements(existing);
    expect(serialized).not.toBeNull();
    const parsed = JSON.parse(serialized!);
    expect(parsed.minVcpu).toBe(2);
  });

  it('editing one modern field does not affect other fields', () => {
    const json = JSON.stringify({ minVcpu: 2 });
    const existing = deserializeResourceRequirements(json);
    const edited = { ...existing, minMemoryGb: '4' };
    const serialized = serializeResourceRequirements(edited);
    const parsed = JSON.parse(serialized!);
    expect(parsed.minVcpu).toBe(2);
    expect(parsed.minMemoryGb).toBe(4);
  });

  it('inherit clears all modern values back to null', () => {
    const cleared = { ...EMPTY_RESOURCE_STATE };
    expect(hasAnyResourceValue(cleared)).toBe(false);
    expect(serializeResourceRequirements(cleared)).toBeNull();
  });

  it('malformed stored JSON does not silently produce empty state that would overwrite', () => {
    const result = deserializeResourceRequirements('{bad json}');
    expect(result.storedJsonError).toBeTruthy();
    const errors = validateResourceState(result);
    expect(hasValidationErrors(errors)).toBe(true);
  });

  it('disk 0 and exclusive false round-trip correctly', () => {
    const state = { ...EMPTY_RESOURCE_STATE, minDiskGb: '0', exclusiveNode: false as boolean | undefined };
    const serialized = serializeResourceRequirements(state);
    expect(serialized).not.toBeNull();
    const parsed = JSON.parse(serialized!);
    expect(parsed.minDiskGb).toBe(0);
    expect(parsed.exclusiveNode).toBe(false);
  });
});

describe('per-task chat payload carries overrides', () => {
  it('toResourceRequirements produces correct object for submit', () => {
    const state = { ...EMPTY_RESOURCE_STATE, minVcpu: '2', minMemoryGb: '4' };
    const req = toResourceRequirements(state);
    expect(req).toEqual({ minVcpu: 2, minMemoryGb: 4 });
  });

  it('empty override returns undefined (inherits)', () => {
    const req = toResourceRequirements(EMPTY_RESOURCE_STATE);
    expect(req).toBeUndefined();
  });

  it('exclusive false is included in the override', () => {
    const state = { ...EMPTY_RESOURCE_STATE, exclusiveNode: false as boolean | undefined };
    const req = toResourceRequirements(state);
    expect(req).toEqual({ exclusiveNode: false });
  });
});

describe('malformed-type stored JSON (canonical validation on deserialize)', () => {
  it('wrong-typed minMemoryGb with valid minVcpu flags storedJsonError and projects raw value', () => {
    const json = JSON.stringify({ minMemoryGb: 'oops', minVcpu: 2 });
    const result = deserializeResourceRequirements(json);
    expect(result.storedJsonError).toBeTruthy();
    expect(result.minVcpu).toBe('2');
    expect(result.minMemoryGb).toBe('oops');
  });

  it('exclusiveNode string "false" flags storedJsonError instead of silently becoming undefined', () => {
    const json = JSON.stringify({ exclusiveNode: 'false' });
    const result = deserializeResourceRequirements(json);
    expect(result.storedJsonError).toBeTruthy();
    expect(result.exclusiveNode).toBeUndefined();
  });

  it('malformed-type state blocks save through validateResourceState', () => {
    const json = JSON.stringify({ minMemoryGb: 'oops', minVcpu: 2 });
    const result = deserializeResourceRequirements(json);
    const errors = validateResourceState(result);
    expect(hasValidationErrors(errors)).toBe(true);
    expect(errors.form).toBeTruthy();
  });

  it('wrong-typed field is not silently omitted on re-serialize', () => {
    const json = JSON.stringify({ minMemoryGb: 'oops', minVcpu: 2 });
    const result = deserializeResourceRequirements(json);
    expect(() => serializeResourceRequirements(result)).toThrow();
  });
});

describe('canonical unit bounds in validateResourceState', () => {
  it('rejects minVcpu 1e100 that exceeds safe reservation units', () => {
    const errors = validateResourceState({ ...EMPTY_RESOURCE_STATE, minVcpu: '1e100' });
    expect(errors.minVcpu).toBeTruthy();
    expect(errors.minVcpu).toContain('unsafe');
  });

  it('rejects minMemoryGb 1e100 that exceeds safe reservation units', () => {
    const errors = validateResourceState({ ...EMPTY_RESOURCE_STATE, minMemoryGb: '1e100' });
    expect(errors.minMemoryGb).toBeTruthy();
  });

  it('rejects minDiskGb 1e100 that exceeds safe reservation units', () => {
    const errors = validateResourceState({ ...EMPTY_RESOURCE_STATE, minDiskGb: '1e100' });
    expect(errors.minDiskGb).toBeTruthy();
  });

  it('accepts values within canonical bounds', () => {
    const errors = validateResourceState({
      ...EMPTY_RESOURCE_STATE,
      minVcpu: '128',
      minMemoryGb: '512',
      minDiskGb: '2000',
    });
    expect(hasValidationErrors(errors)).toBe(false);
  });
});

describe('storedJsonError clear affordance', () => {
  it('storedJsonError with blank state still shows hasAnything true for clear button', () => {
    const state = { ...EMPTY_RESOURCE_STATE, storedJsonError: 'bad data' };
    const hasValues = !!(state.minVcpu || state.minMemoryGb || state.minDiskGb ||
      state.exclusiveNode !== undefined || state.maxCoTenants);
    const hasAnything = hasValues || !!state.storedJsonError;
    expect(hasValues).toBe(false);
    expect(hasAnything).toBe(true);
  });

  it('clearing storedJsonError state produces clean EMPTY_RESOURCE_STATE', () => {
    const cleared = { ...EMPTY_RESOURCE_STATE };
    expect(cleared.storedJsonError).toBeUndefined();
    const errors = validateResourceState(cleared);
    expect(hasValidationErrors(errors)).toBe(false);
    expect(serializeResourceRequirements(cleared)).toBeNull();
  });
});
