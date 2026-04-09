import { describe, expect, it } from 'vitest';

import { cronToHumanReadable, cronToNextFire, validateCronExpression } from '../../../src/services/cron-utils';

// =============================================================================
// validateCronExpression
// =============================================================================

describe('validateCronExpression', () => {
  it('accepts a valid hourly expression', () => {
    const result = validateCronExpression('0 * * * *');
    expect(result.valid).toBe(true);
    expect(result.humanReadable).toBeDefined();
  });

  it('accepts "every day at 9 AM"', () => {
    const result = validateCronExpression('0 9 * * *');
    expect(result.valid).toBe(true);
    expect(result.humanReadable).toContain('9:00 AM');
  });

  it('accepts weekday-only schedule', () => {
    const result = validateCronExpression('0 9 * * 1-5');
    expect(result.valid).toBe(true);
    expect(result.humanReadable).toContain('weekdays');
  });

  it('accepts schedule with step', () => {
    const result = validateCronExpression('*/30 * * * *');
    expect(result.valid).toBe(true);
  });

  it('accepts named months', () => {
    const result = validateCronExpression('0 9 * jan,jun *');
    expect(result.valid).toBe(true);
    expect(result.humanReadable).toContain('Jan');
  });

  it('accepts named days of week', () => {
    const result = validateCronExpression('0 9 * * mon,wed,fri');
    expect(result.valid).toBe(true);
  });

  it('rejects too-frequent schedule (every minute)', () => {
    const result = validateCronExpression('* * * * *');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('too frequently');
  });

  it('rejects every 5 minutes (below 15-minute default minimum)', () => {
    const result = validateCronExpression('*/5 * * * *');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('too frequently');
  });

  it('accepts every 5 minutes with lower minimum override', () => {
    const result = validateCronExpression('*/5 * * * *', 5);
    expect(result.valid).toBe(true);
  });

  it('accepts every 15 minutes (exactly at default minimum)', () => {
    const result = validateCronExpression('*/15 * * * *');
    expect(result.valid).toBe(true);
  });

  it('rejects invalid field count (6 fields)', () => {
    const result = validateCronExpression('0 0 * * * *');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('5 fields');
  });

  it('rejects invalid field count (4 fields)', () => {
    const result = validateCronExpression('0 0 * *');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('5 fields');
  });

  it('rejects out-of-range minute', () => {
    const result = validateCronExpression('60 * * * *');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('minute');
  });

  it('rejects out-of-range hour', () => {
    const result = validateCronExpression('0 25 * * *');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('hour');
  });

  it('rejects out-of-range day of month', () => {
    const result = validateCronExpression('0 0 32 * *');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('dayOfMonth');
  });

  it('rejects out-of-range month', () => {
    const result = validateCronExpression('0 0 * 13 *');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('month');
  });

  it('rejects out-of-range day of week', () => {
    const result = validateCronExpression('0 0 * * 7');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('dayOfWeek');
  });

  it('rejects invalid range (start > end)', () => {
    const result = validateCronExpression('0 0 * * 5-2');
    expect(result.valid).toBe(false);
  });

  it('rejects empty expression', () => {
    const result = validateCronExpression('');
    expect(result.valid).toBe(false);
  });

  it('accepts list values', () => {
    const result = validateCronExpression('0,30 9,17 * * *');
    expect(result.valid).toBe(true);
  });

  it('accepts range with step', () => {
    const result = validateCronExpression('0 9-17/2 * * *');
    expect(result.valid).toBe(true);
  });
});

// =============================================================================
// cronToNextFire
// =============================================================================

describe('cronToNextFire', () => {
  it('computes next fire for daily 9 AM UTC', () => {
    // After 2026-04-09 08:00 UTC → should be 2026-04-09 09:00 UTC
    const after = new Date('2026-04-09T08:00:00Z');
    const next = cronToNextFire('0 9 * * *', 'UTC', after);
    expect(next).toBe(new Date('2026-04-09T09:00:00.000Z').toISOString());
  });

  it('rolls to next day when time has passed', () => {
    // After 2026-04-09 10:00 UTC → should be 2026-04-10 09:00 UTC
    const after = new Date('2026-04-09T10:00:00Z');
    const next = cronToNextFire('0 9 * * *', 'UTC', after);
    expect(next).toBe(new Date('2026-04-10T09:00:00.000Z').toISOString());
  });

  it('handles hourly schedule', () => {
    const after = new Date('2026-04-09T08:30:00Z');
    const next = cronToNextFire('0 * * * *', 'UTC', after);
    expect(next).toBe(new Date('2026-04-09T09:00:00.000Z').toISOString());
  });

  it('handles every-30-minutes schedule', () => {
    const after = new Date('2026-04-09T08:15:00Z');
    const next = cronToNextFire('*/30 * * * *', 'UTC', after);
    expect(next).toBe(new Date('2026-04-09T08:30:00.000Z').toISOString());
  });

  it('handles weekday-only schedule', () => {
    // 2026-04-11 is a Saturday
    const after = new Date('2026-04-10T23:00:00Z'); // Friday night
    const next = cronToNextFire('0 9 * * 1-5', 'UTC', after);
    const nextDate = new Date(next);
    // Should be Monday April 13
    expect(nextDate.getUTCDay()).toBe(1); // Monday
    expect(nextDate.getUTCHours()).toBe(9);
  });

  it('handles specific day of month', () => {
    const after = new Date('2026-04-02T00:00:00Z');
    const next = cronToNextFire('0 0 15 * *', 'UTC', after);
    expect(next).toContain('2026-04-15');
  });

  it('handles month restriction', () => {
    // Only in January
    const after = new Date('2026-04-09T00:00:00Z');
    const next = cronToNextFire('0 9 * 1 *', 'UTC', after);
    // Should be January next year
    expect(next).toContain('2027-01');
  });

  it('handles timezone — America/New_York', () => {
    // 9 AM ET on Apr 9 = 13:00 UTC (EDT is UTC-4)
    const after = new Date('2026-04-09T12:00:00Z'); // 8 AM ET
    const next = cronToNextFire('0 9 * * *', 'America/New_York', after);
    const nextDate = new Date(next);
    // Should be ~13:00 UTC (9 AM ET)
    expect(nextDate.getUTCHours()).toBe(13);
  });

  it('returns ISO string format', () => {
    const next = cronToNextFire('0 9 * * *', 'UTC');
    expect(next).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('always returns a time after the "after" parameter', () => {
    const after = new Date('2026-04-09T09:00:00Z');
    const next = cronToNextFire('0 9 * * *', 'UTC', after);
    expect(new Date(next).getTime()).toBeGreaterThan(after.getTime());
  });
});

// =============================================================================
// cronToHumanReadable
// =============================================================================

describe('cronToHumanReadable', () => {
  it('describes daily at 9 AM', () => {
    const desc = cronToHumanReadable('0 9 * * *');
    expect(desc).toContain('9:00 AM');
  });

  it('describes weekday schedule', () => {
    const desc = cronToHumanReadable('0 9 * * 1-5');
    expect(desc).toContain('weekdays');
  });

  it('describes hourly', () => {
    const desc = cronToHumanReadable('0 * * * *');
    expect(desc).toContain('hour');
  });

  it('describes every 30 minutes', () => {
    const desc = cronToHumanReadable('*/30 * * * *');
    expect(desc).toContain('30 minutes');
  });

  it('appends timezone when non-UTC', () => {
    const desc = cronToHumanReadable('0 9 * * *', 'America/New_York');
    expect(desc).toContain('America/New_York');
  });

  it('does not append UTC timezone label', () => {
    const desc = cronToHumanReadable('0 9 * * *', 'UTC');
    expect(desc).not.toContain('(UTC)');
  });

  it('handles weekend schedule', () => {
    const desc = cronToHumanReadable('0 10 * * 0,6');
    expect(desc).toContain('weekends');
  });

  it('handles month-specific schedule', () => {
    const desc = cronToHumanReadable('0 9 * 1,6 *');
    expect(desc).toContain('Jan');
    expect(desc).toContain('Jun');
  });

  it('returns raw expression for invalid input', () => {
    const desc = cronToHumanReadable('not a cron');
    expect(desc).toBe('not a cron');
  });
});
