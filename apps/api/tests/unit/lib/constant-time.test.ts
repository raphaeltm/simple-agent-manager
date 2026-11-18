import { describe, expect, it } from 'vitest';

import { constantTimeEqual } from '../../../src/lib/constant-time';

describe('constantTimeEqual', () => {
  it.each(['', 'setup-token', 'é🔑', '\0', 'a\0b'])(
    'accepts identical UTF-8 strings %j',
    (value) => {
      expect(constantTimeEqual(value, value)).toBe(true);
    }
  );

  it.each([
    ['', '\0'],
    ['a', 'a\0'],
    ['token', 'tokenx'],
    ['token', 'xoken'],
    ['token', 'tokex'],
    ['é', 'e'],
    ['é', 'é'],
    ['🔑', '🔒'],
    ['a\0b', 'a\0c'],
  ])('rejects different contents or lengths %j / %j in both orders', (left, right) => {
    expect(constantTimeEqual(left, right)).toBe(false);
    expect(constantTimeEqual(right, left)).toBe(false);
  });
});
