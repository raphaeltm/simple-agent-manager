import { describe, expect, it } from 'vitest';

import {
  deserializeResourceRequirements,
  EMPTY_RESOURCE_STATE,
  formatHardwareDisplay,
  formatLegacyVmSize,
  hasAnyResourceValue,
  serializeResourceRequirements,
  toResourceRequirements,
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

  it('returns empty state for invalid JSON', () => {
    expect(deserializeResourceRequirements('not json')).toEqual(EMPTY_RESOURCE_STATE);
  });

  it('returns empty state for JSON array', () => {
    expect(deserializeResourceRequirements('[1,2,3]')).toEqual(EMPTY_RESOURCE_STATE);
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

describe('invalid number handling', () => {
  it('rejects NaN values from serialization', () => {
    const result = serializeResourceRequirements({
      ...EMPTY_RESOURCE_STATE,
      minVcpu: 'abc',
      minMemoryGb: '8',
    });
    const parsed = JSON.parse(result!);
    expect(parsed.minVcpu).toBeUndefined();
    expect(parsed.minMemoryGb).toBe(8);
  });

  it('rejects negative values from serialization', () => {
    const result = serializeResourceRequirements({
      ...EMPTY_RESOURCE_STATE,
      minVcpu: '-4',
    });
    expect(result).toBeNull();
  });

  it('rejects Infinity from serialization', () => {
    const result = serializeResourceRequirements({
      ...EMPTY_RESOURCE_STATE,
      minVcpu: 'Infinity',
    });
    expect(result).toBeNull();
  });

  it('rejects NaN values from toResourceRequirements', () => {
    const result = toResourceRequirements({
      ...EMPTY_RESOURCE_STATE,
      minVcpu: 'abc',
      minMemoryGb: '8',
    });
    expect(result).toEqual({ minMemoryGb: 8 });
  });

  it('accepts zero disk value', () => {
    const result = serializeResourceRequirements({
      ...EMPTY_RESOURCE_STATE,
      minDiskGb: '0',
    });
    const parsed = JSON.parse(result!);
    expect(parsed.minDiskGb).toBe(0);
  });

  it('deserializes NaN/Infinity stored values as empty', () => {
    const withNaN = deserializeResourceRequirements(JSON.stringify({ minVcpu: NaN }));
    expect(withNaN.minVcpu).toBe('');

    const withInf = deserializeResourceRequirements(JSON.stringify({ minMemoryGb: Infinity }));
    expect(withInf.minMemoryGb).toBe('');
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

describe('legacy no-op edit safety', () => {
  it('opening a profile with only vmSizeOverride shows legacy label and preserves it', () => {
    const existing = deserializeResourceRequirements(null);
    expect(hasAnyResourceValue(existing)).toBe(false);
    const serialized = serializeResourceRequirements(existing);
    expect(serialized).toBeNull();
  });

  it('setting modern fields clears legacy serialization intent', () => {
    const withModern = { ...EMPTY_RESOURCE_STATE, minVcpu: '4' };
    expect(hasAnyResourceValue(withModern)).toBe(true);
    const serialized = serializeResourceRequirements(withModern);
    expect(serialized).not.toBeNull();
    const parsed = JSON.parse(serialized!);
    expect(parsed.minVcpu).toBe(4);
  });

  it('inherit clears all modern values back to empty', () => {
    const cleared = { ...EMPTY_RESOURCE_STATE };
    expect(hasAnyResourceValue(cleared)).toBe(false);
    expect(serializeResourceRequirements(cleared)).toBeNull();
  });
});
