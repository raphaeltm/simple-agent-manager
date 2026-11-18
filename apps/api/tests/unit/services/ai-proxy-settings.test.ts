import { describe, expect, it } from 'vitest';

import {
  AI_PROXY_PER_USER_MONTHLY_COST_CEILING_SETTING,
  AI_PROXY_SETTINGS,
} from '../../../src/services/ai-proxy-settings';

const ceiling = AI_PROXY_SETTINGS.find(
  (setting) => setting.name === AI_PROXY_PER_USER_MONTHLY_COST_CEILING_SETTING
)!;

describe('installation ceiling numeric representation', () => {
  it('allows an operator to configure a ceiling above one million USD', () => {
    expect(ceiling.validate(2_000_000)).toBe(true);
  });

  it('accepts zero (disabled) and the largest exactly representable integer', () => {
    expect(ceiling.validate(0)).toBe(true);
    expect(ceiling.validate(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(ceiling.range).toEqual({ min: 0, max: Number.MAX_SAFE_INTEGER });
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects non-whole, negative, or inexact values (%s)',
    (value) => {
      expect(ceiling.validate(value)).toBe(false);
    }
  );
});
