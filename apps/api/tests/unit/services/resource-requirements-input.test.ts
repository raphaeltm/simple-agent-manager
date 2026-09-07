import { describe, expect, it } from 'vitest';

import {
  normalizeResourceRequirementsInput,
  parseStoredResourceRequirementsJson,
  serializeResourceRequirementsInput,
} from '../../../src/services/resource-requirements-input';

describe('resource requirements input validation', () => {
  it('preserves supported modern fields, explicit false, and disk zero', () => {
    const result = normalizeResourceRequirementsInput({
      minVcpu: 4,
      minMemoryGb: 16,
      minDiskGb: 0,
      exclusiveNode: false,
      maxCoTenants: 1,
      legacyNote: 'ignored',
    });

    expect(result).toEqual({
      minVcpu: 4,
      minMemoryGb: 16,
      minDiskGb: 0,
      exclusiveNode: false,
      maxCoTenants: 1,
    });
  });

  it('ignores inherited and unknown fields before serializing', () => {
    const inherited = Object.create({ minVcpu: 64 });
    inherited.minMemoryGb = 16;
    inherited.extra = 'ignored';

    expect(normalizeResourceRequirementsInput(inherited)).toEqual({ minMemoryGb: 16 });
    expect(serializeResourceRequirementsInput(inherited)).toBe('{"minMemoryGb":16}');
  });

  it('normalizes JSON strings for persisted compatibility fields', () => {
    expect(
      serializeResourceRequirementsInput(
        '{"minVcpu":2,"exclusiveNode":false}',
        'resourceRequirementsJson'
      )
    ).toBe('{"minVcpu":2,"exclusiveNode":false}');
  });

  it('rejects malformed known fields', () => {
    for (const value of [
      { minVcpu: -1 },
      { minVcpu: 0 },
      { minMemoryGb: Number.NaN },
      { minDiskGb: Number.POSITIVE_INFINITY },
      { exclusiveNode: 'false' },
      { maxCoTenants: 0 },
      { maxCoTenants: 1.5 },
      [],
    ]) {
      expect(() => normalizeResourceRequirementsInput(value)).toThrow();
    }
  });

  it('keeps null and omitted semantics in API adapters', () => {
    expect(serializeResourceRequirementsInput(null)).toBeNull();
    expect(serializeResourceRequirementsInput('')).toBeNull();
    expect(parseStoredResourceRequirementsJson(null)).toBeUndefined();
    expect(parseStoredResourceRequirementsJson(undefined)).toBeUndefined();
  });

  it('rejects malformed stored resource JSON instead of wiping intent', () => {
    expect(() => parseStoredResourceRequirementsJson('{"minVcpu":0}')).toThrow(
      /resourceRequirementsJson is malformed/
    );
    expect(() => parseStoredResourceRequirementsJson('not-json')).toThrow(
      /resourceRequirementsJson is malformed/
    );
  });
});
