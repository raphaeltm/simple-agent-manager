import { describe, expect, it } from 'vitest';

import { isSessionAccessDurationMinutes, SESSION_ACCESS_DURATION_MINUTES } from '../src';

/**
 * The one list of how long shared access can last, read by the API route's validator, the
 * ProjectData check and the share dialog. The product requires exactly these choices: no
 * default and no unlimited option (Raphaël, 2026-10-19).
 */
describe('session access durations', () => {
  it('offers exactly 5, 10, 30 and 60 minutes', () => {
    expect(SESSION_ACCESS_DURATION_MINUTES).toEqual([5, 10, 30, 60]);
  });

  it.each([5, 10, 30, 60])('accepts %i minutes', (minutes) => {
    expect(isSessionAccessDurationMinutes(minutes)).toBe(true);
  });

  it.each([undefined, null, 0, -5, 1, 15, 61, 1440, 30.5, '30', Number.POSITIVE_INFINITY, NaN])(
    'refuses %s',
    (value) => {
      expect(isSessionAccessDurationMinutes(value)).toBe(false);
    }
  );
});
