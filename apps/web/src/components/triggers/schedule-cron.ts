/**
 * Pure cron <-> friendly-schedule conversion used by `SchedulePicker`.
 *
 * Extracted from the component so the round-trip is unit-testable on its own —
 * it previously had zero test coverage, which is how the "editing a trigger
 * shows the wrong schedule" bug shipped.
 */

export type ScheduleMode = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'advanced';
export type DailyVariant = 'every' | 'weekday' | 'weekend';

export interface ParsedSchedule {
  mode: ScheduleMode;
  hour: number;
  minute: number;
  everyNHours: number;
  dailyVariant: DailyVariant;
  weeklyDays: number[];
  monthDay: number;
}

/** Schedule a brand-new trigger defaults to. */
export const DEFAULT_CRON_EXPRESSION = '0 9 * * *';

export const DAY_ABBREVIATIONS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const WEEKDAY_SET = [1, 2, 3, 4, 5];
const WEEKEND_SET = [0, 6];

const SCHEDULE_DEFAULTS = {
  hour: 9,
  minute: 0,
  everyNHours: 1,
  dailyVariant: 'every' as DailyVariant,
  weeklyDays: [1],
  monthDay: 1,
};

function isWeekdaySet(days: number[]): boolean {
  return days.length === 5 && WEEKDAY_SET.every((d) => days.includes(d));
}

function isWeekendSet(days: number[]): boolean {
  return days.length === 2 && WEEKEND_SET.every((d) => days.includes(d));
}

/** Reads a 5-field cron expression back into the friendly picker state. */
export function parseCronToMode(cron: string): ParsedSchedule {
  if (!cron.trim()) return { mode: 'hourly', ...SCHEDULE_DEFAULTS };

  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { mode: 'advanced', ...SCHEDULE_DEFAULTS };

  const [minStr, hourStr, domStr, , dowStr] = parts;

  const min = parseInt(minStr!, 10);
  const minute = isNaN(min) ? 0 : min;

  // Hourly: `M */N * * *`
  if (hourStr!.startsWith('*/') && domStr === '*' && dowStr === '*') {
    const n = parseInt(hourStr!.slice(2), 10);
    return {
      ...SCHEDULE_DEFAULTS,
      mode: 'hourly',
      hour: 0,
      minute,
      everyNHours: isNaN(n) ? 1 : n,
    };
  }

  const hour = parseInt(hourStr!, 10);
  if (isNaN(hour)) return { mode: 'advanced', ...SCHEDULE_DEFAULTS };

  // Monthly: `M H D * *`
  if (domStr !== '*' && dowStr === '*') {
    const dom = parseInt(domStr!, 10);
    return {
      ...SCHEDULE_DEFAULTS,
      mode: 'monthly',
      hour,
      minute,
      monthDay: isNaN(dom) ? 1 : dom,
    };
  }

  // Weekly: `M H * * 1,3,5`
  if (domStr === '*' && dowStr !== '*') {
    const days = dowStr!
      .split(',')
      .map(Number)
      .filter((n) => !isNaN(n));

    if (isWeekdaySet(days)) {
      return {
        ...SCHEDULE_DEFAULTS,
        mode: 'daily',
        hour,
        minute,
        dailyVariant: 'weekday',
        weeklyDays: days,
      };
    }
    if (isWeekendSet(days)) {
      return {
        ...SCHEDULE_DEFAULTS,
        mode: 'daily',
        hour,
        minute,
        dailyVariant: 'weekend',
        weeklyDays: days,
      };
    }
    return { ...SCHEDULE_DEFAULTS, mode: 'weekly', hour, minute, weeklyDays: days };
  }

  // Daily: `M H * * *`
  if (domStr === '*' && dowStr === '*') {
    return { ...SCHEDULE_DEFAULTS, mode: 'daily', hour, minute };
  }

  return { mode: 'advanced', ...SCHEDULE_DEFAULTS };
}

/** Builds the 5-field cron expression for the current picker state. */
export function buildCron(
  mode: ScheduleMode,
  hour: number,
  minute: number,
  everyNHours: number,
  dailyVariant: DailyVariant,
  weeklyDays: number[],
  monthDay: number,
  advancedCron: string
): string {
  switch (mode) {
    case 'hourly':
      return `${minute} */${everyNHours} * * *`;
    case 'daily':
      if (dailyVariant === 'weekday') return `${minute} ${hour} * * 1,2,3,4,5`;
      if (dailyVariant === 'weekend') return `${minute} ${hour} * * 0,6`;
      return `${minute} ${hour} * * *`;
    case 'weekly':
      // Copy before sorting — `Array.sort` mutates, and `weeklyDays` is the
      // caller's React state array.
      return `${minute} ${hour} * * ${[...weeklyDays].sort((a, b) => a - b).join(',')}`;
    case 'monthly':
      return `${minute} ${hour} ${monthDay} * *`;
    case 'advanced':
      return advancedCron;
  }
}

function formatTime(hour: number, minute: number): string {
  const display = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${display}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** Human-readable summary of a cron expression, for the picker's preview line. */
export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return 'Invalid expression';

  const [minStr, hourStr, domStr, , dowStr] = parts;
  const min = parseInt(minStr!, 10);

  if (hourStr!.startsWith('*/')) {
    const n = parseInt(hourStr!.slice(2), 10);
    if (isNaN(n) || isNaN(min)) return cron;
    return `Every ${n} hour(s) at minute ${min}`;
  }

  const hour = parseInt(hourStr!, 10);
  if (isNaN(hour) || isNaN(min)) return cron;

  const timeStr = formatTime(hour, min);

  if (domStr !== '*' && dowStr === '*') {
    return `Monthly on day ${domStr} at ${timeStr}`;
  }

  if (dowStr !== '*' && domStr === '*') {
    const days = dowStr!.split(',').map(Number);
    if (isWeekdaySet(days)) return `Weekdays at ${timeStr}`;
    if (isWeekendSet(days)) return `Weekends at ${timeStr}`;
    // A hand-typed advanced expression can contain out-of-range or non-numeric
    // days; those used to render the literal string "undefined".
    const names = days.map((d) => DAY_ABBREVIATIONS[d]).filter((n) => Boolean(n));
    if (names.length === 0) return cron;
    return `${names.join(', ')} at ${timeStr}`;
  }

  if (domStr === '*' && dowStr === '*') {
    return `Daily at ${timeStr}`;
  }

  return cron;
}
