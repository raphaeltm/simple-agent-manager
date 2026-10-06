import { describe, expect, it } from 'vitest';

import { isJsonRecord } from '../src/runtime-validation';

describe('isJsonRecord', () => {
  it('returns true for plain objects', () => {
    expect(isJsonRecord({})).toBe(true);
    expect(isJsonRecord({ a: 1 })).toBe(true);
    expect(isJsonRecord({ nested: { b: 2 } })).toBe(true);
  });

  it('returns false for arrays', () => {
    expect(isJsonRecord([])).toBe(false);
    expect(isJsonRecord([1, 2, 3])).toBe(false);
    expect(isJsonRecord([{}])).toBe(false);
  });

  it('returns false for null', () => {
    expect(isJsonRecord(null)).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isJsonRecord(undefined)).toBe(false);
    expect(isJsonRecord('string')).toBe(false);
    expect(isJsonRecord(42)).toBe(false);
    expect(isJsonRecord(true)).toBe(false);
    expect(isJsonRecord(false)).toBe(false);
  });

  it('returns true for class instances (still typeof object, non-array)', () => {
    expect(isJsonRecord(new Date())).toBe(true);
  });

  it('narrows the type for TypeScript when used as a guard', () => {
    const value: unknown = { key: 'value' };
    if (isJsonRecord(value)) {
      // Compiles because isJsonRecord narrows `value` to Record<string, unknown>.
      expect(value.key).toBe('value');
    } else {
      throw new Error('expected isJsonRecord to narrow this value');
    }
  });
});
