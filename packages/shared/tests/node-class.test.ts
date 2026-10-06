import { describe, expect, it } from 'vitest';

import { isNodeClass, isUserOwnedNodeClass, type NodeClass } from '../src/types';

const VALID: NodeClass[] = ['managed', 'user-owned'];

describe('isNodeClass', () => {
  it.each(VALID)('returns true for valid node class: %s', (value) => {
    expect(isNodeClass(value)).toBe(true);
  });

  it('returns false for unknown/legacy strings', () => {
    expect(isNodeClass('byo')).toBe(false);
    expect(isNodeClass('MANAGED')).toBe(false);
    expect(isNodeClass('')).toBe(false);
  });

  it('returns false for non-string values', () => {
    expect(isNodeClass(null)).toBe(false);
    expect(isNodeClass(undefined)).toBe(false);
    expect(isNodeClass(1)).toBe(false);
    expect(isNodeClass({})).toBe(false);
  });
});

describe('isUserOwnedNodeClass', () => {
  it('is true ONLY for the exact "user-owned" value', () => {
    expect(isUserOwnedNodeClass('user-owned')).toBe(true);
  });

  it('treats managed, unknown, and absent values as NOT user-owned (safe default)', () => {
    // The whole point: any value that is not exactly 'user-owned' must never be treated as BYO,
    // so lifecycle guards fail safe (a managed node is never wrongly protected from teardown).
    expect(isUserOwnedNodeClass('managed')).toBe(false);
    expect(isUserOwnedNodeClass('User-Owned')).toBe(false);
    expect(isUserOwnedNodeClass('userowned')).toBe(false);
    expect(isUserOwnedNodeClass(null)).toBe(false);
    expect(isUserOwnedNodeClass(undefined)).toBe(false);
    expect(isUserOwnedNodeClass(0)).toBe(false);
  });
});
