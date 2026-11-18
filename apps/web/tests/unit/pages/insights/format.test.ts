import { describe, expect, it } from 'vitest';

import {
  bucketLabel,
  countDelta,
  daysSince,
  durationDelta,
  formatDuration,
  formatDurationShort,
  formatPercent,
  rateDelta,
} from '../../../../src/pages/insights/format';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('insights format', () => {
  it('formats durations and says nothing for a missing value', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(22 * MIN)).toBe('22 min');
    expect(formatDuration(3.4 * HOUR)).toBe('3.4 h');
    expect(formatDuration(1.6 * DAY)).toBe('1.6 days');
    expect(formatDuration(DAY)).toBe('1 day');
    expect(formatDuration(12 * DAY)).toBe('12 days');
    expect(formatDurationShort(1.6 * DAY)).toBe('1.6d');
    expect(formatDurationShort(30 * MIN)).toBe('30m');
  });

  it('formats a rate, and null as missing rather than zero', () => {
    expect(formatPercent(0.64)).toBe('64%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(null)).toBe('—');
  });

  it('words a duration change for the reader, with the right tone', () => {
    expect(durationDelta(1.6 * DAY, 2 * DAY)).toEqual({ text: '▼ 9.6 h', tone: 'better' });
    expect(durationDelta(2 * DAY, 1.6 * DAY)).toEqual({ text: '▲ 9.6 h', tone: 'worse' });
    expect(durationDelta(DAY, DAY)).toEqual({ text: 'Same as before', tone: 'flat' });
    expect(durationDelta(null, DAY)).toBeNull();
    expect(durationDelta(DAY, null)).toBeNull();
  });

  it('words a rate change in points; lower can be better (rework)', () => {
    expect(rateDelta(0.64, 0.58)).toEqual({ text: '▲ 6 points', tone: 'better' });
    expect(rateDelta(0.11, 0.14, false)).toEqual({ text: '▼ 3 points', tone: 'better' });
    expect(rateDelta(0.5, 0.49)).toEqual({ text: '▲ 1 point', tone: 'better' });
    expect(rateDelta(null, 0.5)).toBeNull();
    expect(countDelta(28, 23)).toEqual({ text: '▲ 5', tone: 'better' });
  });

  it('labels buckets as ISO weeks or UTC days', () => {
    expect(bucketLabel('2026-11-16', 'week')).toBe('W47');
    expect(bucketLabel('2026-01-01', 'week')).toBe('W1');
    expect(bucketLabel('2026-11-16', 'day')).toBe('Mon 16');
    expect(daysSince('2026-11-07T12:00:00.000Z', Date.parse('2026-11-16T12:00:00.000Z'))).toBe(9);
  });
});
