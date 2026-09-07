import { describe, expect, it } from 'vitest';

import {
  normalizeResourceRequirementsInput,
  serializeResourceRequirementsInput,
} from '../../../src/services/resource-requirements-input';

describe('resource requirements input validation', () => {
  it('preserves modern fields, explicit false, and compatibility metadata', () => {
    const result = normalizeResourceRequirementsInput({
      minVcpu: 4,
      minMemoryGb: 16,
      minDiskGb: 80,
      exclusiveNode: false,
      maxCoTenants: 0,
      legacyNote: 'kept',
    });

    expect(result).toEqual({
      minVcpu: 4,
      minMemoryGb: 16,
      minDiskGb: 80,
      exclusiveNode: false,
      maxCoTenants: 0,
      legacyNote: 'kept',
    });
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
      { minMemoryGb: Number.NaN },
      { minDiskGb: Number.POSITIVE_INFINITY },
      { exclusiveNode: 'false' },
      [],
    ]) {
      expect(() => normalizeResourceRequirementsInput(value)).toThrow();
    }
  });
});
