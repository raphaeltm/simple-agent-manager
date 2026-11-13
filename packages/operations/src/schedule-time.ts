/**
 * Turns the run time a person or model asks for into the UTC instant a one-off schedule
 * stores, and shows stored instants in a time zone.
 *
 * The ProjectData DO stores `dueAt` as epoch milliseconds and treats `displayTimezone` as
 * display metadata only, so wall-clock conversion is the caller's job (the web app does it in
 * `apps/web/src/pages/automation/time.ts`). Near a daylight-saving change a wall time can be
 * missing or happen twice, and a silent shift there runs work an hour early or late. So a
 * missing time is refused with the first valid minute after the gap, and a repeated one
 * resolves to the occurrence the caller chose and says it was ambiguous.
 */
import { OperationError } from './errors';

export type ScheduleDisambiguation = 'earlier' | 'later';

export interface ResolvedScheduleTime {
  /** UTC epoch milliseconds. */
  dueAt: number;
  dueAtIso: string;
  /** Canonical IANA name. Once the instant is fixed it only says how to show it. */
  timezone: string;
  /** Wall-clock time in `timezone`, `YYYY-MM-DDTHH:mm:ss`. */
  localTime: string;
  utcOffsetMinutes: number;
  /** True when the local time happens twice (clocks went back) and `resolvedAs` chose one. */
  ambiguousLocalTime: boolean;
  resolvedAs: ScheduleDisambiguation | null;
}

export interface ScheduleTimeRequest {
  /** The input field being resolved, named in error messages. */
  field: string;
  value: string;
  /** IANA name. Required for a local time; display metadata for an instant (default UTC). */
  timezone?: string;
  disambiguation?: ScheduleDisambiguation;
}

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

type CalendarFields = readonly [number, number, number, number, number, number];

function invalid(message: string): OperationError {
  return new OperationError('invalid_input', message);
}

/**
 * The canonical IANA name for `value`. A UTC offset is refused because it cannot follow a
 * daylight-saving change: "+01:00" chosen in winter is the wrong zone all summer. This is the
 * rule the DO's `normalizeScheduleTimezone` applies, and the DO re-checks every write.
 */
export function canonicalTimezone(value: string, field = 'timezone'): string {
  const zone = value.trim();
  if (zone && !/^[+-]/.test(zone)) {
    try {
      return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
    } catch {
      // An unknown name is reported below, with the offset case.
    }
  }
  throw invalid(
    `${field} must be an IANA time zone name such as Europe/Paris or America/New_York, not a UTC offset`
  );
}

/** Reads an instant off the wall clock of `zone`, as the epoch of a UTC date with those fields. */
function wallClock(zone: string): (instant: number) => number {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  return (instant) => {
    const parts = format.formatToParts(instant);
    const field = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value);
    return Date.UTC(
      field('year'),
      field('month') - 1,
      field('day'),
      field('hour'),
      field('minute'),
      field('second')
    );
  };
}

/** UTC offset of `zone` at an instant, in milliseconds (whole seconds, as the zone data is). */
function offsetIn(zone: string): (instant: number) => number {
  const wall = wallClock(zone);
  return (instant) => wall(instant) - Math.floor(instant / SECOND_MS) * SECOND_MS;
}

function wallString(wall: number, seconds = true): string {
  return new Date(wall).toISOString().slice(0, seconds ? 19 : 16);
}

/** `instant` as wall-clock time and UTC offset in `zone`, for showing a stored time. */
export function zonedTime(
  instant: number,
  zone: string
): { localTime: string; utcOffsetMinutes: number } {
  const offset = offsetIn(zone)(instant);
  return {
    localTime: wallString(Math.floor(instant / SECOND_MS) * SECOND_MS + offset),
    utcOffsetMinutes: Math.round(offset / MINUTE_MS),
  };
}

/** Epoch of the calendar fields read as UTC, refusing fields `Date.UTC` would roll over. */
function calendarMs(field: string, value: string, fields: CalendarFields): number {
  const [year, month, day, hour, minute, second] = fields;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(ms);
  if (
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw invalid(`${field} "${value}" is not a valid calendar date and time`);
  }
  return ms;
}

function numbers(groups: Array<string | undefined>): CalendarFields {
  const [year, month, day, hour, minute, second] = groups.map((group) => Number(group ?? 0));
  return [year ?? 0, month ?? 0, day ?? 0, hour ?? 0, minute ?? 0, second ?? 0];
}

/**
 * The error for a local time inside a spring-forward gap. The transition lies between the two
 * failed candidates, so a minute-granular search between them finds the first minute on the new
 * offset; reading that minute with the old and new offsets gives the wall times the clock jumps
 * between.
 */
function gapError(
  request: ScheduleTimeRequest,
  zone: string,
  naive: number,
  offsets: { before: number; after: number; at: (instant: number) => number }
): OperationError {
  const { before, after, at } = offsets;
  if (after <= before) {
    return invalid(
      `${request.field} "${request.value}" cannot be resolved in ${zone}; supply an instant with Z or ±HH:MM`
    );
  }
  let lo = Math.floor((naive - after) / MINUTE_MS) * MINUTE_MS;
  let hi = Math.ceil((naive - before) / MINUTE_MS) * MINUTE_MS;
  while (hi - lo > MINUTE_MS) {
    const mid = lo + Math.floor((hi - lo) / (2 * MINUTE_MS)) * MINUTE_MS;
    if (at(mid) === after) hi = mid;
    else lo = mid;
  }
  const firstValid = wallString(hi + after, false);
  return invalid(
    `${request.field} "${request.value}" does not exist in ${zone}: clocks move forward from ` +
      `${wallString(hi + before, false)} to ${firstValid}. The first valid time after the gap is ` +
      `${firstValid} (${new Date(hi).toISOString()}).`
  );
}

/**
 * Resolves `request.value`: an ISO-8601 instant with `Z` or `±HH:MM` (then `timezone` is display
 * metadata only), or a local `YYYY-MM-DDTHH:mm[:ss]` read on the wall clock of `timezone`.
 *
 * A local time is matched against the offsets in force a day either side of it, which is how
 * the Temporal reference implementation finds every instant a wall time names: none means a
 * gap, two means an overlap.
 */
export function resolveScheduleTime(request: ScheduleTimeRequest): ResolvedScheduleTime {
  const value = request.value.trim();
  const instant = INSTANT.exec(value);
  if (instant) {
    const zone = canonicalTimezone(request.timezone ?? 'UTC');
    const [, year, month, day, hour, minute, second, fraction, sign, offsetHours, offsetMinutes] =
      instant;
    const wall = calendarMs(
      request.field,
      value,
      numbers([year, month, day, hour, minute, second])
    );
    if (Number(offsetHours ?? 0) > 23 || Number(offsetMinutes ?? 0) > 59) {
      throw invalid(`${request.field} "${value}" has an invalid UTC offset`);
    }
    const offset =
      (sign === '-' ? -1 : 1) * (Number(offsetHours ?? 0) * 60 + Number(offsetMinutes ?? 0));
    const dueAt = wall + Number((fraction ?? '0').padEnd(3, '0')) - offset * MINUTE_MS;
    return {
      dueAt,
      dueAtIso: new Date(dueAt).toISOString(),
      timezone: zone,
      ...zonedTime(dueAt, zone),
      ambiguousLocalTime: false,
      resolvedAs: null,
    };
  }
  const local = LOCAL_TIME.exec(value);
  if (!local) {
    throw invalid(
      `${request.field} must be an ISO-8601 instant with Z or ±HH:MM, such as 2026-11-02T09:00:00Z, ` +
        'or a local time YYYY-MM-DDTHH:mm[:ss] together with timezone'
    );
  }
  if (request.timezone === undefined) {
    throw invalid(
      `${request.field} "${value}" has no UTC offset: supply timezone as an IANA name such as ` +
        'Europe/Paris, or add Z or ±HH:MM'
    );
  }
  const zone = canonicalTimezone(request.timezone);
  const naive = calendarMs(request.field, value, numbers(local.slice(1)));
  const at = offsetIn(zone);
  const before = at(naive - DAY_MS);
  const after = at(naive + DAY_MS);
  const candidates = [...new Set([before, after])]
    .map((offset) => naive - offset)
    .filter((candidate) => at(candidate) === naive - candidate)
    .sort((left, right) => left - right);
  const earliest = candidates[0];
  if (earliest === undefined) throw gapError(request, zone, naive, { before, after, at });
  const ambiguous = candidates.length > 1;
  const resolvedAs = ambiguous ? (request.disambiguation ?? 'earlier') : null;
  const dueAt = resolvedAs === 'later' ? (candidates[candidates.length - 1] ?? earliest) : earliest;
  return {
    dueAt,
    dueAtIso: new Date(dueAt).toISOString(),
    timezone: zone,
    localTime: wallString(naive),
    utcOffsetMinutes: Math.round((naive - dueAt) / MINUTE_MS),
    ambiguousLocalTime: ambiguous,
    resolvedAs,
  };
}
