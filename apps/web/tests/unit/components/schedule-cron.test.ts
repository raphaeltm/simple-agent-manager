import { describe, expect, it } from 'vitest';

import {
  buildCron,
  describeCron,
  parseCronToMode,
} from '../../../src/components/triggers/schedule-cron';

/**
 * These pure helpers previously lived inside `SchedulePicker` with ZERO test
 * coverage, which is how the "editing a trigger shows the wrong schedule" bug
 * shipped. The round-trip below is the property that matters: whatever a stored
 * cron means, the picker must read it back and rebuild the identical string.
 */
describe('schedule-cron', () => {
  describe('parse → build round-trip', () => {
    const CRONS = [
      '0 9 * * *', // daily 09:00
      '30 2 * * *', // daily 02:30 — the schedule from the reported bug
      '0 0 * * *', // midnight
      '15 23 * * *', // late evening
      '0 */4 * * *', // every 4 hours
      '5 */2 * * *', // every 2 hours at :05
      '0 7 * * 3', // weekly Wednesday
      '45 18 * * 1,4', // weekly Mon+Thu
      '0 6 * * 1,2,3,4,5', // weekdays
      '0 10 * * 0,6', // weekends
      '0 3 15 * *', // monthly on the 15th
    ];

    for (const cron of CRONS) {
      it(`preserves "${cron}"`, () => {
        const p = parseCronToMode(cron);
        const rebuilt = buildCron(
          p.mode,
          p.hour,
          p.minute,
          p.everyNHours,
          p.dailyVariant,
          p.weeklyDays,
          p.monthDay,
          cron
        );
        expect(rebuilt).toBe(cron);
      });
    }
  });

  describe('parseCronToMode', () => {
    it('reads the real hour and minute rather than falling back to the 9am default', () => {
      // The regression: a 02:30 trigger must not read back as 09:00.
      expect(parseCronToMode('30 2 * * *')).toMatchObject({
        mode: 'daily',
        hour: 2,
        minute: 30,
        dailyVariant: 'every',
      });
    });

    it('classifies weekday and weekend sets as daily variants', () => {
      expect(parseCronToMode('0 6 * * 1,2,3,4,5').dailyVariant).toBe('weekday');
      expect(parseCronToMode('0 6 * * 0,6').dailyVariant).toBe('weekend');
    });

    it('falls back to advanced for expressions it cannot model', () => {
      expect(parseCronToMode('0 9 1 1 1').mode).toBe('advanced');
      expect(parseCronToMode('not a cron').mode).toBe('advanced');
    });

    it('treats an empty expression as the hourly starting point', () => {
      expect(parseCronToMode('').mode).toBe('hourly');
    });
  });

  describe('buildCron', () => {
    it('does not mutate the caller’s weeklyDays array', () => {
      // `Array.sort` mutates in place, and this array is React state — sorting
      // it defeats referential-equality checks elsewhere.
      const days = [5, 1, 3];
      const snapshot = [...days];
      buildCron('weekly', 9, 0, 1, 'every', days, 1, '');
      expect(days).toEqual(snapshot);
    });

    it('emits weekly days in ascending order regardless of click order', () => {
      expect(buildCron('weekly', 9, 0, 1, 'every', [5, 1, 3], 1, '')).toBe('0 9 * * 1,3,5');
    });

    it('passes the advanced expression through untouched', () => {
      expect(buildCron('advanced', 9, 0, 1, 'every', [1], 1, '*/7 * * * *')).toBe('*/7 * * * *');
    });
  });

  describe('describeCron', () => {
    it('describes the common schedules', () => {
      expect(describeCron('30 2 * * *')).toBe('Daily at 2:30 AM');
      expect(describeCron('0 0 * * *')).toBe('Daily at 12:00 AM');
      expect(describeCron('0 13 * * *')).toBe('Daily at 1:00 PM');
      expect(describeCron('0 6 * * 1,2,3,4,5')).toBe('Weekdays at 6:00 AM');
      expect(describeCron('0 10 * * 0,6')).toBe('Weekends at 10:00 AM');
      expect(describeCron('0 7 * * 1,3')).toBe('Mon, Wed at 7:00 AM');
      expect(describeCron('0 3 15 * *')).toBe('Monthly on day 15 at 3:00 AM');
      expect(describeCron('0 */4 * * *')).toBe('Every 4 hour(s) at minute 0');
    });

    it('never renders the string "undefined" for out-of-range days', () => {
      // A hand-typed advanced expression can contain day 9; the day-name lookup
      // used to yield `undefined` and render it literally.
      const result = describeCron('0 9 * * 9');
      expect(result).not.toContain('undefined');
    });

    it('reports a malformed expression instead of throwing', () => {
      expect(describeCron('nope')).toBe('Invalid expression');
    });
  });
});
