import { describe, expect, it } from 'vitest';

import {
  normalizeResourceRequirements,
  resourceRequirementToReservationUnit,
} from '../../src/resource-requirements';

describe('normalizeResourceRequirements', () => {
  it('accepts empty and partial objects for inheritance', () => {
    expect(normalizeResourceRequirements({})).toEqual({});
    expect(normalizeResourceRequirements({ minVcpu: 2 })).toEqual({ minVcpu: 2 });
  });

  it('copies only supported own fields', () => {
    const value = Object.create({
      minVcpu: 99,
      maxCoTenants: 99,
    }) as Record<string, unknown>;
    value.minMemoryGb = 8;
    value.minDiskGb = 0;
    value.exclusiveNode = false;
    value.extra = 'ignored';

    expect(normalizeResourceRequirements(value)).toEqual({
      minMemoryGb: 8,
      minDiskGb: 0,
      exclusiveNode: false,
    });
  });

  it('preserves explicit false, disk zero, and positive safe tenant counts', () => {
    expect(
      normalizeResourceRequirements({
        minVcpu: 0.001,
        minMemoryGb: 0.001,
        minDiskGb: 0,
        exclusiveNode: false,
        maxCoTenants: 1,
      })
    ).toEqual({
      minVcpu: 0.001,
      minMemoryGb: 0.001,
      minDiskGb: 0,
      exclusiveNode: false,
      maxCoTenants: 1,
    });
  });

  it('requires every supported field when requireAllFields is true', () => {
    expect(() =>
      normalizeResourceRequirements({ minVcpu: 2 }, { requireAllFields: true })
    ).toThrow('resourceRequirements.minMemoryGb is required');
    expect(
      normalizeResourceRequirements(
        {
          minVcpu: 2,
          minMemoryGb: 4,
          minDiskGb: 40,
          exclusiveNode: false,
          maxCoTenants: 4,
        },
        { requireAllFields: true }
      )
    ).toEqual({
      minVcpu: 2,
      minMemoryGb: 4,
      minDiskGb: 40,
      exclusiveNode: false,
      maxCoTenants: 4,
    });
  });

  it('rejects non-object inputs', () => {
    for (const value of [null, undefined, 'resources', 1, true, []]) {
      expect(() => normalizeResourceRequirements(value)).toThrow(
        'resourceRequirements must be a JSON object'
      );
    }
  });

  it('rejects invalid field values', () => {
    expect(() => normalizeResourceRequirements({ minVcpu: 0 })).toThrow(
      'resourceRequirements.minVcpu must be a finite positive number'
    );
    expect(() => normalizeResourceRequirements({ minMemoryGb: 0 })).toThrow(
      'resourceRequirements.minMemoryGb must be a finite positive number'
    );
    expect(() => normalizeResourceRequirements({ minDiskGb: -1 })).toThrow(
      'resourceRequirements.minDiskGb must be a finite non-negative number'
    );
    expect(() => normalizeResourceRequirements({ minDiskGb: Number.POSITIVE_INFINITY })).toThrow(
      'resourceRequirements.minDiskGb must be a finite number'
    );
    expect(() => normalizeResourceRequirements({ maxCoTenants: 0 })).toThrow(
      'resourceRequirements.maxCoTenants must be a positive safe integer'
    );
    expect(() => normalizeResourceRequirements({ maxCoTenants: 1.5 })).toThrow(
      'resourceRequirements.maxCoTenants must be a positive safe integer'
    );
    expect(() => normalizeResourceRequirements({ exclusiveNode: 'false' })).toThrow(
      'resourceRequirements.exclusiveNode must be a boolean'
    );
  });

  it('rejects values whose rounded reservation units are unsafe', () => {
    expect(() => normalizeResourceRequirements({ minVcpu: Number.MAX_SAFE_INTEGER })).toThrow(
      'resourceRequirements.minVcpu converts to unsafe reservation units'
    );
    expect(() => normalizeResourceRequirements({ minMemoryGb: Number.MAX_SAFE_INTEGER })).toThrow(
      'resourceRequirements.minMemoryGb converts to unsafe reservation units'
    );
    expect(() => normalizeResourceRequirements({ minDiskGb: Number.MAX_SAFE_INTEGER })).toThrow(
      'resourceRequirements.minDiskGb converts to unsafe reservation units'
    );
  });
});

describe('resourceRequirementToReservationUnit', () => {
  it('uses conservative integer-unit rounding', () => {
    expect(resourceRequirementToReservationUnit('minVcpu', 0.0001)).toBe(1);
    expect(resourceRequirementToReservationUnit('minMemoryGb', 0.1)).toBe(103);
    expect(resourceRequirementToReservationUnit('minDiskGb', 0)).toBe(0);
  });
});
