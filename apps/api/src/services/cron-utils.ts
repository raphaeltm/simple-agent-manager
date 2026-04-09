import type { CronValidationResult } from '@simple-agent-manager/shared';
import {
  DEFAULT_CRON_MIN_INTERVAL_MINUTES,
} from '@simple-agent-manager/shared';

// =============================================================================
// Lightweight 5-field Cron Parser (no external dependencies)
// Format: minute hour dayOfMonth month dayOfWeek
// Supports: numbers, ranges (1-5), steps (*/15), lists (1,3,5), wildcards (*)
// =============================================================================

interface CronField {
  /** Sorted set of valid values for this field. */
  values: number[];
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

const FIELD_RANGES: Record<string, { min: number; max: number }> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 6 }, // 0 = Sunday
};

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function replaceNames(field: string, fieldName: string): string {
  let result = field.toLowerCase();
  const names = fieldName === 'month' ? MONTH_NAMES : fieldName === 'dayOfWeek' ? DOW_NAMES : null;
  if (names) {
    for (const [name, value] of Object.entries(names)) {
      result = result.replaceAll(name, String(value));
    }
  }
  return result;
}

function parseField(field: string, fieldName: string): CronField {
  const { min, max } = FIELD_RANGES[fieldName]!;
  const resolved = replaceNames(field, fieldName);
  const values = new Set<number>();

  for (const part of resolved.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) {
      throw new Error(`Empty value in ${fieldName} field`);
    }

    // Handle step: */2, 1-10/3, or just a range/value
    const stepMatch = trimmed.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2]!, 10) : 1;
    const base = stepMatch ? stepMatch[1]! : trimmed;

    if (step < 1) {
      throw new Error(`Invalid step value in ${fieldName}: ${trimmed}`);
    }

    if (base === '*') {
      for (let i = min; i <= max; i += step) {
        values.add(i);
      }
    } else if (base.includes('-')) {
      const rangeParts = base.split('-');
      const start = parseInt(rangeParts[0]!, 10);
      const end = parseInt(rangeParts[1]!, 10);
      if (isNaN(start) || isNaN(end) || start < min || end > max || start > end) {
        throw new Error(`Invalid range in ${fieldName}: ${base} (valid: ${min}-${max})`);
      }
      for (let i = start; i <= end; i += step) {
        values.add(i);
      }
    } else {
      const num = parseInt(base, 10);
      if (isNaN(num) || num < min || num > max) {
        throw new Error(`Invalid value in ${fieldName}: ${base} (valid: ${min}-${max})`);
      }
      values.add(num);
    }
  }

  return { values: [...values].sort((a, b) => a - b) };
}

function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Expected 5 fields (minute hour dayOfMonth month dayOfWeek), got ${parts.length}`);
  }

  return {
    minute: parseField(parts[0]!, 'minute'),
    hour: parseField(parts[1]!, 'hour'),
    dayOfMonth: parseField(parts[2]!, 'dayOfMonth'),
    month: parseField(parts[3]!, 'month'),
    dayOfWeek: parseField(parts[4]!, 'dayOfWeek'),
  };
}

/**
 * Estimate the minimum interval in minutes between consecutive fires.
 * For complex expressions this is an approximation — it checks consecutive
 * minute values within the same hour first, then across hours.
 */
function estimateMinIntervalMinutes(parsed: ParsedCron): number {
  // If both dayOfMonth and dayOfWeek are restricted, schedule is very sparse
  const domRestricted = parsed.dayOfMonth.values.length < 31;
  const dowRestricted = parsed.dayOfWeek.values.length < 7;

  // Monthly or weekly schedules are always >= 15 min apart
  if (domRestricted || dowRestricted) {
    if (parsed.hour.values.length <= 2 && parsed.minute.values.length <= 4) {
      // Even with restricted days, if it fires many times per hour we should check
      // but typically restricted days means sparse schedules
      const minuteGaps = getMinGap(parsed.minute.values, 60);
      const hourGaps = getMinGap(parsed.hour.values, 24);
      if (parsed.minute.values.length > 1) return minuteGaps;
      return hourGaps * 60 + minuteGaps;
    }
    return 60; // at most once per hour per day
  }

  // For unrestricted day schedules, check minute-level frequency
  if (parsed.hour.values.length === 24) {
    // Fires every hour — minimum gap is between consecutive minutes
    return getMinGap(parsed.minute.values, 60);
  }

  if (parsed.minute.values.length > 1 && parsed.hour.values.length >= 1) {
    return getMinGap(parsed.minute.values, 60);
  }

  // Different hours: compute gap between last minute of hour N and first minute of hour N+1
  const hourGap = getMinGap(parsed.hour.values, 24);
  return hourGap * 60;
}

/** Get the minimum gap between consecutive sorted values, wrapping around `wrap`. */
function getMinGap(values: number[], wrap: number): number {
  if (values.length <= 1) return wrap;
  let minGap = wrap;
  for (let i = 1; i < values.length; i++) {
    minGap = Math.min(minGap, values[i]! - values[i - 1]!);
  }
  // Wrap-around gap
  minGap = Math.min(minGap, values[0]! + wrap - values[values.length - 1]!);
  return minGap;
}

// =============================================================================
// Timezone-aware next-fire computation
// =============================================================================

/**
 * Get date components in a specific timezone using Intl.DateTimeFormat.
 * Available in Cloudflare Workers runtime.
 */
function getDatePartsInTimezone(
  date: Date,
  timezone: string
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';

  const weekdayStr = get('weekday').toLowerCase();
  const weekday = DOW_NAMES[weekdayStr.slice(0, 3)] ?? date.getUTCDay();

  // Intl hour12:false returns "24" for midnight in some implementations
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0;

  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    hour,
    minute: parseInt(get('minute'), 10),
    weekday,
  };
}

/** Find the next value >= target in sorted values, or the first value (wrapping). */
function nextValue(values: number[], target: number): { value: number; wrapped: boolean } {
  for (const v of values) {
    if (v >= target) return { value: v, wrapped: false };
  }
  return { value: values[0]!, wrapped: true };
}

/**
 * Compute the next fire time for a cron expression in a specific timezone.
 * Returns an ISO 8601 string.
 *
 * @param expression - Standard 5-field cron expression
 * @param timezone - IANA timezone string (e.g., "America/New_York")
 * @param after - Start searching after this date (default: now)
 */
export function cronToNextFire(expression: string, timezone: string, after?: Date): string {
  const parsed = parseCron(expression);
  // Start 1 minute after `after` to avoid matching the current minute
  const start = after ?? new Date();
  let candidate = new Date(start.getTime() + 60_000);
  // Zero out seconds/ms
  candidate.setUTCSeconds(0, 0);

  // Safety limit to prevent infinite loops (scan up to ~2 years of minutes)
  const maxIterations = 525600 * 2;

  for (let i = 0; i < maxIterations; i++) {
    const p = getDatePartsInTimezone(candidate, timezone);

    // Check month
    if (!parsed.month.values.includes(p.month)) {
      // Advance to next valid month
      const nm = nextValue(parsed.month.values, p.month + 1);
      if (nm.wrapped) {
        candidate = buildDateInTimezone(p.year + 1, nm.value, 1, 0, 0, timezone);
      } else {
        candidate = buildDateInTimezone(p.year, nm.value, 1, 0, 0, timezone);
      }
      continue;
    }

    // Check day (dayOfMonth AND dayOfWeek)
    const domMatch = parsed.dayOfMonth.values.includes(p.day);
    const dowMatch = parsed.dayOfWeek.values.includes(p.weekday);
    // Standard cron behavior: if both dom and dow are restricted (not *), match either
    const domIsWild = parsed.dayOfMonth.values.length === 31;
    const dowIsWild = parsed.dayOfWeek.values.length === 7;
    let dayMatch: boolean;
    if (domIsWild && dowIsWild) {
      dayMatch = true;
    } else if (domIsWild) {
      dayMatch = dowMatch;
    } else if (dowIsWild) {
      dayMatch = domMatch;
    } else {
      // Both restricted: OR logic (standard cron behavior)
      dayMatch = domMatch || dowMatch;
    }

    if (!dayMatch) {
      // Advance to next day
      candidate = buildDateInTimezone(p.year, p.month, p.day + 1, 0, 0, timezone);
      continue;
    }

    // Check hour
    if (!parsed.hour.values.includes(p.hour)) {
      const nh = nextValue(parsed.hour.values, p.hour + 1);
      if (nh.wrapped) {
        candidate = buildDateInTimezone(p.year, p.month, p.day + 1, nh.value, parsed.minute.values[0]!, timezone);
      } else {
        candidate = buildDateInTimezone(p.year, p.month, p.day, nh.value, parsed.minute.values[0]!, timezone);
      }
      continue;
    }

    // Check minute
    if (!parsed.minute.values.includes(p.minute)) {
      const nm = nextValue(parsed.minute.values, p.minute + 1);
      if (nm.wrapped) {
        // Advance to next valid hour
        const nh = nextValue(parsed.hour.values, p.hour + 1);
        if (nh.wrapped) {
          candidate = buildDateInTimezone(p.year, p.month, p.day + 1, nh.value, nm.value, timezone);
        } else {
          candidate = buildDateInTimezone(p.year, p.month, p.day, nh.value, nm.value, timezone);
        }
      } else {
        candidate = buildDateInTimezone(p.year, p.month, p.day, p.hour, nm.value, timezone);
      }
      continue;
    }

    // All fields match
    return candidate.toISOString();
  }

  throw new Error('Could not find next fire time within 2 years');
}

/**
 * Build a Date object from timezone-local components.
 * Uses Intl to resolve the correct UTC offset for the given timezone and local time.
 */
function buildDateInTimezone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string
): Date {
  // Handle day overflow by using a temporary date
  const tempDate = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  const tempYear = tempDate.getUTCFullYear();
  const tempMonth = tempDate.getUTCMonth() + 1;
  const tempDay = tempDate.getUTCDate();
  const tempHour = tempDate.getUTCHours();
  const tempMinute = tempDate.getUTCMinutes();

  // Create a date string in ISO format and use the timezone to find the offset
  const isoStr = `${tempYear}-${String(tempMonth).padStart(2, '0')}-${String(tempDay).padStart(2, '0')}T${String(tempHour).padStart(2, '0')}:${String(tempMinute).padStart(2, '0')}:00`;

  // Estimate: create as UTC, then adjust based on timezone offset
  const utcEstimate = new Date(isoStr + 'Z');
  const parts = getDatePartsInTimezone(utcEstimate, timezone);

  // Calculate the difference between what we want and what we got
  const wantMinutes = tempHour * 60 + tempMinute;
  const gotMinutes = parts.hour * 60 + parts.minute;
  let diffMinutes = wantMinutes - gotMinutes;

  // Handle day boundary
  if (parts.day !== tempDay) {
    if (parts.day < tempDay || (parts.month < tempMonth)) {
      diffMinutes += 24 * 60;
    } else {
      diffMinutes -= 24 * 60;
    }
  }

  return new Date(utcEstimate.getTime() + diffMinutes * 60_000);
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate a 5-field cron expression.
 * Rejects expressions that would fire more frequently than the minimum interval.
 *
 * @param expression - The cron expression to validate
 * @param minIntervalMinutes - Minimum allowed interval (default: CRON_MIN_INTERVAL_MINUTES)
 */
export function validateCronExpression(
  expression: string,
  minIntervalMinutes: number = DEFAULT_CRON_MIN_INTERVAL_MINUTES
): CronValidationResult {
  try {
    const parsed = parseCron(expression);
    const interval = estimateMinIntervalMinutes(parsed);

    if (interval < minIntervalMinutes) {
      return {
        valid: false,
        error: `Schedule fires too frequently (every ~${interval} minutes). Minimum interval is ${minIntervalMinutes} minutes.`,
      };
    }

    const humanReadable = buildHumanReadable(parsed);
    return { valid: true, humanReadable };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : 'Invalid cron expression',
    };
  }
}

// =============================================================================
// Human-readable description
// =============================================================================

/**
 * Convert a cron expression to a human-readable description.
 *
 * @param expression - Standard 5-field cron expression
 * @param timezone - IANA timezone for display (default: "UTC")
 */
export function cronToHumanReadable(expression: string, timezone: string = 'UTC'): string {
  try {
    const parsed = parseCron(expression);
    const desc = buildHumanReadable(parsed);
    if (timezone !== 'UTC') {
      return `${desc} (${timezone})`;
    }
    return desc;
  } catch {
    return expression; // fallback to raw expression
  }
}

function buildHumanReadable(parsed: ParsedCron): string {
  const parts: string[] = [];

  // Time description
  const minutes = parsed.minute.values;
  const hours = parsed.hour.values;

  if (minutes.length === 1 && hours.length === 1) {
    // Safe: length checks above guarantee indices exist
    parts.push(`At ${formatTime(hours[0]!, minutes[0]!)}`);
  } else if (minutes.length === 1 && hours.length === 24) {
    parts.push(`Every hour at minute ${minutes[0]!}`);
  } else if (hours.length === 1) {
    if (isStep(minutes, 0, 59)) {
      const step = minutes[1]! - minutes[0]!;
      parts.push(`Every ${step} minutes during hour ${formatHour(hours[0]!)}`);
    } else {
      parts.push(`At ${minutes.map((m) => formatTime(hours[0]!, m)).join(', ')}`);
    }
  } else if (hours.length === 24 && minutes.length > 1) {
    if (isStep(minutes, 0, 59)) {
      const step = minutes[1]! - minutes[0]!;
      parts.push(`Every ${step} minutes`);
    } else {
      parts.push(`At minutes ${minutes.join(', ')} of every hour`);
    }
  } else {
    parts.push(`At ${minutes.join(',')} minutes past hours ${hours.join(',')}`);
  }

  // Day description
  const domIsWild = parsed.dayOfMonth.values.length === 31;
  const dowIsWild = parsed.dayOfWeek.values.length === 7;
  const monthIsWild = parsed.month.values.length === 12;

  if (!dowIsWild && domIsWild) {
    const days = parsed.dayOfWeek.values.map((d) => DAY_NAMES[d]);
    if (days.length === 5 && !parsed.dayOfWeek.values.includes(0) && !parsed.dayOfWeek.values.includes(6)) {
      parts.push('on weekdays');
    } else if (days.length === 2 && parsed.dayOfWeek.values.includes(0) && parsed.dayOfWeek.values.includes(6)) {
      parts.push('on weekends');
    } else {
      parts.push(`on ${days.join(', ')}`);
    }
  } else if (!domIsWild && dowIsWild) {
    parts.push(`on day ${parsed.dayOfMonth.values.join(', ')} of the month`);
  } else if (!domIsWild && !dowIsWild) {
    const days = parsed.dayOfWeek.values.map((d) => DAY_NAMES[d]);
    parts.push(`on day ${parsed.dayOfMonth.values.join(', ')} or ${days.join(', ')}`);
  }

  if (!monthIsWild) {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const months = parsed.month.values.map((m) => monthNames[m - 1]);
    parts.push(`in ${months.join(', ')}`);
  }

  return parts.join(' ');
}

function formatTime(hour: number, minute: number): string {
  const h = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const ampm = hour < 12 ? 'AM' : 'PM';
  return `${h}:${String(minute).padStart(2, '0')} ${ampm}`;
}

function formatHour(hour: number): string {
  const h = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const ampm = hour < 12 ? 'AM' : 'PM';
  return `${h} ${ampm}`;
}

/** Check if values form a regular step sequence. */
function isStep(values: number[], min: number, max: number): boolean {
  if (values.length < 2) return false;
  const first = values[0]!;
  const second = values[1]!;
  const step = second - first;
  if (step < 1) return false;
  for (let i = 2; i < values.length; i++) {
    if (values[i]! - values[i - 1]! !== step) return false;
  }
  // Verify it covers the full range
  return first === min && values[values.length - 1]! <= max;
}
