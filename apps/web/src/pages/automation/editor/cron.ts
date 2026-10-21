/**
 * Cron checks the editor can do before saving: whether an expression fires more often than the
 * API allows, and the next few times a preset will run, shown in the viewer's own time.
 */
import { DEFAULT_CRON_MIN_INTERVAL_MINUTES } from '@simple-agent-manager/shared';

import { buildCron, parseDayList } from '../../../components/triggers/schedule-cron';
import { instantToZonedInput, nextOccurrence, zonedInputToInstant } from '../time';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** The values a cron field allows (`*`, `*\/n`, `a-b`, `a-b/n`, lists), or null if unreadable. */
export function expandField(field: string, min: number, max: number): number[] | null {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) return null;
    const step = match[4] ? Number(match[4]) : 1;
    if (step < 1) return null;
    const from = match[1] === '*' ? min : Number(match[2]);
    const to = match[1] === '*' ? max : match[3] ? Number(match[3]) : match[4] ? max : from;
    if (from < min || to > max || from > to) return null;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * The shortest gap in minutes between two fires within a day, or null when the expression is
 * not a plain five-field cron this can read. Day fields only ever widen the gap, so they are
 * ignored; the API does the full check on save.
 */
export function shortestGapMinutes(expression: string): number | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minutes = expandField(parts[0] ?? '', 0, 59);
  const hours = expandField(parts[1] ?? '', 0, 23);
  if (!minutes || !hours) return null;
  const times = hours.flatMap((hour) => minutes.map((minute) => hour * 60 + minute));
  if (times.length < 2) return 24 * 60;
  let gap = (times[0] ?? 0) + 24 * 60 - (times.at(-1) ?? 0);
  for (let index = 1; index < times.length; index++)
    gap = Math.min(gap, (times[index] ?? 0) - (times[index - 1] ?? 0));
  return gap;
}

export function cronError(
  expression: string,
  minMinutes = DEFAULT_CRON_MIN_INTERVAL_MINUTES
): string | null {
  if (!expression.trim()) return 'Enter a cron expression, like 0 9 * * 1-5.';
  const gap = shortestGapMinutes(expression);
  if (gap === null && expression.trim().split(/\s+/).length !== 5)
    return 'A cron expression has five parts: minute, hour, day of month, month, day of week.';
  if (gap !== null && gap < minMinutes)
    return `Automations can run at most every ${minMinutes} minutes.`;
  return null;
}

/** The schedule shapes the editor offers before falling back to a typed expression. */
export type SchedulePreset =
  'daily' | 'weekdays' | 'weekends' | 'weekly' | 'monthly' | 'hourly' | 'custom';

export interface ScheduleChoice {
  preset: SchedulePreset;
  /** "09:00", the wall-clock time in `zone`. */
  time: string;
  weeklyDays: number[];
  monthDay: number;
  everyHours: number;
  /** Minute past the hour, for "every few hours". */
  minute: number;
  custom: string;
  zone: string;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** The next `count` runs of a preset after `from`; empty for a typed expression. */
export function nextRuns(choice: ScheduleChoice, from: number, count = 3): number[] {
  const [hour = 9, minute = 0] = choice.time.split(':').map(Number);
  const { zone } = choice;
  switch (choice.preset) {
    case 'custom':
      return [];
    case 'hourly': {
      // `M */N * * *` fires at hours 0, N, 2N… of each day, on the zone's wall clock.
      const step = Math.max(1, choice.everyHours);
      const found = new Set<number>();
      for (let day = 0; day < 3; day++) {
        const date = instantToZonedInput(from + day * DAY, zone).slice(0, 10);
        for (let wallHour = 0; wallHour < 24; wallHour += step) {
          const at = zonedInputToInstant(`${date}T${pad(wallHour)}:${pad(choice.minute)}`, zone);
          if (at !== null && at > from) found.add(at);
        }
      }
      return [...found].sort((a, b) => a - b).slice(0, count);
    }
    case 'monthly': {
      const [year = 1970, month = 1] = instantToZonedInput(from, zone).split('-').map(Number);
      const runs: number[] = [];
      for (let offset = 0; runs.length < count && offset < 24; offset++) {
        const index = month - 1 + offset;
        const y = year + Math.floor(index / 12);
        const m = (index % 12) + 1;
        // A month without that day (e.g. the 31st in April) is skipped, as cron does.
        if (choice.monthDay > new Date(Date.UTC(y, m, 0)).getUTCDate()) continue;
        const at = zonedInputToInstant(
          `${y}-${pad(m)}-${pad(choice.monthDay)}T${pad(hour)}:${pad(minute)}`,
          zone
        );
        if (at !== null && at > from) runs.push(at);
      }
      return runs;
    }
    default: {
      const days =
        choice.preset === 'weekdays'
          ? [1, 2, 3, 4, 5]
          : choice.preset === 'weekends'
            ? [0, 6]
            : choice.preset === 'weekly'
              ? choice.weeklyDays
              : [0, 1, 2, 3, 4, 5, 6];
      if (!days.length) return [];
      const runs: number[] = [];
      let cursor = from;
      while (runs.length < count) {
        const at = nextOccurrence(cursor, hour, minute, days, zone);
        runs.push(at);
        cursor = at;
      }
      return runs;
    }
  }
}

/** Day-of-week lists compared as sets, so `1-5` and `1,2,3,4,5` are the same schedule. */
export function canonicalCron(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression.trim();
  const days = parseDayList(parts[4] ?? '');
  return [...parts.slice(0, 4), days ? days.join(',') : parts[4]].join(' ');
}

const [h0, m0] = [9, 0];

/** The cron expression for the editor's schedule choice. */
export function toCron(choice: ScheduleChoice): string {
  const [hour = h0, minute = m0] = choice.time.split(':').map(Number);
  switch (choice.preset) {
    case 'custom':
      return choice.custom.trim();
    case 'hourly':
      return buildCron('hourly', 0, choice.minute, choice.everyHours, 'every', [], 1, '');
    case 'monthly':
      return buildCron('monthly', hour, minute, 1, 'every', [], choice.monthDay, '');
    case 'weekly':
      return buildCron('weekly', hour, minute, 1, 'every', choice.weeklyDays, 1, '');
    case 'weekdays':
      return buildCron('daily', hour, minute, 1, 'weekday', [], 1, '');
    case 'weekends':
      return buildCron('daily', hour, minute, 1, 'weekend', [], 1, '');
    default:
      return buildCron('daily', hour, minute, 1, 'every', [], 1, '');
  }
}
