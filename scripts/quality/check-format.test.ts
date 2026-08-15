import { describe, expect, it } from 'vitest';

import { compareFormatCounts } from './check-format';

describe('format debt ratchet', () => {
  it('allows an unchanged baseline', () => {
    expect(compareFormatCounts(2390, 2390)).toEqual({
      ok: true,
      currentCount: 2390,
      baselineCount: 2390,
      increase: 0,
    });
  });

  it('allows debt reduction', () => {
    expect(compareFormatCounts(2300, 2390).ok).toBe(true);
  });

  it('blocks net-new formatting debt', () => {
    expect(compareFormatCounts(2391, 2390)).toEqual({
      ok: false,
      currentCount: 2391,
      baselineCount: 2390,
      increase: 1,
    });
  });
});
