import { describe, expect, it } from 'vitest';

import { OperationError } from '../../../src/operations/errors';
import {
  canonicalTimezone,
  resolveScheduleTime,
  zonedTime,
} from '../../../src/operations/schedule-time';

const runAt = (value: string, timezone?: string, disambiguation?: 'earlier' | 'later') =>
  resolveScheduleTime({ field: 'runAt', value, timezone, disambiguation });

function refusal(value: string, timezone?: string): OperationError {
  try {
    runAt(value, timezone);
  } catch (error) {
    if (error instanceof OperationError) return error;
    throw error;
  }
  throw new Error(`expected ${value} in ${timezone ?? 'no zone'} to be refused`);
}

describe('resolveScheduleTime', () => {
  it('reads an ordinary local time on the wall clock of its zone', () => {
    expect(runAt('2026-11-02T09:00', 'Europe/Paris')).toEqual({
      dueAt: Date.parse('2026-11-02T08:00:00.000Z'),
      dueAtIso: '2026-11-02T08:00:00.000Z',
      timezone: 'Europe/Paris',
      localTime: '2026-11-02T09:00:00',
      utcOffsetMinutes: 60,
      ambiguousLocalTime: false,
      resolvedAs: null,
    });
    // The same wall time in summer is two hours ahead of UTC.
    expect(runAt('2026-07-01T09:00', 'Europe/Paris').dueAtIso).toBe('2026-07-01T07:00:00.000Z');
  });

  it('keeps the seconds of a local time and of an instant', () => {
    expect(runAt('2026-11-02T09:00:30', 'America/New_York')).toMatchObject({
      dueAtIso: '2026-11-02T14:00:30.000Z',
      localTime: '2026-11-02T09:00:30',
      utcOffsetMinutes: -300,
    });
    expect(runAt('2026-11-02T09:00:30.25Z').dueAtIso).toBe('2026-11-02T09:00:30.250Z');
    expect(runAt('2026-11-02T09:00Z').localTime).toBe('2026-11-02T09:00:00');
  });

  it('refuses a Paris time skipped by the spring-forward gap and names the first valid minute', () => {
    const error = refusal('2026-03-29T02:30', 'Europe/Paris');
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('does not exist in Europe/Paris');
    expect(error.message).toContain('from 2026-03-29T02:00 to 2026-03-29T03:00');
    expect(error.message).toContain('first valid time after the gap is 2026-03-29T03:00');
    expect(error.message).toContain('2026-03-29T01:00:00.000Z');
    // The suggested minute itself resolves.
    expect(runAt('2026-03-29T03:00', 'Europe/Paris').dueAtIso).toBe('2026-03-29T01:00:00.000Z');
  });

  it('refuses a New York time skipped by the spring-forward gap', () => {
    const error = refusal('2026-03-08T02:30', 'America/New_York');
    expect(error.message).toContain('from 2026-03-08T02:00 to 2026-03-08T03:00');
    expect(error.message).toContain('first valid time after the gap is 2026-03-08T03:00');
    expect(error.message).toContain('2026-03-08T07:00:00.000Z');
  });

  it('resolves a Paris time that happens twice to the chosen occurrence and says so', () => {
    expect(runAt('2026-10-25T02:30', 'Europe/Paris')).toMatchObject({
      dueAtIso: '2026-10-25T00:30:00.000Z',
      utcOffsetMinutes: 120,
      ambiguousLocalTime: true,
      resolvedAs: 'earlier',
    });
    expect(runAt('2026-10-25T02:30', 'Europe/Paris', 'earlier').dueAtIso).toBe(
      '2026-10-25T00:30:00.000Z'
    );
    expect(runAt('2026-10-25T02:30', 'Europe/Paris', 'later')).toMatchObject({
      dueAtIso: '2026-10-25T01:30:00.000Z',
      localTime: '2026-10-25T02:30:00',
      utcOffsetMinutes: 60,
      ambiguousLocalTime: true,
      resolvedAs: 'later',
    });
  });

  it('resolves a New York time that happens twice', () => {
    expect(runAt('2026-11-01T01:30', 'America/New_York')).toMatchObject({
      dueAtIso: '2026-11-01T05:30:00.000Z',
      utcOffsetMinutes: -240,
      resolvedAs: 'earlier',
    });
    expect(runAt('2026-11-01T01:30', 'America/New_York', 'later')).toMatchObject({
      dueAtIso: '2026-11-01T06:30:00.000Z',
      utcOffsetMinutes: -300,
      resolvedAs: 'later',
    });
    // Outside the overlap a disambiguation changes nothing and is not reported.
    expect(runAt('2026-11-01T03:30', 'America/New_York', 'later')).toMatchObject({
      dueAtIso: '2026-11-01T08:30:00.000Z',
      ambiguousLocalTime: false,
      resolvedAs: null,
    });
  });

  it('takes an instant with an offset exactly, with the zone as display only', () => {
    expect(runAt('2026-10-25T02:30:00+02:00', 'America/New_York')).toEqual({
      dueAt: Date.parse('2026-10-25T00:30:00.000Z'),
      dueAtIso: '2026-10-25T00:30:00.000Z',
      timezone: 'America/New_York',
      localTime: '2026-10-24T20:30:00',
      utcOffsetMinutes: -240,
      ambiguousLocalTime: false,
      resolvedAs: null,
    });
    expect(runAt('2026-10-25T02:30:00-05:30', undefined, 'later')).toMatchObject({
      dueAtIso: '2026-10-25T08:00:00.000Z',
      timezone: 'UTC',
      localTime: '2026-10-25T08:00:00',
      resolvedAs: null,
    });
  });

  it('takes a Z instant inside a gap or overlap without consulting the zone rules', () => {
    // 01:30Z falls on Paris' fall-back day; the instant is exact, so nothing is ambiguous.
    expect(runAt('2026-10-25T01:30:00Z', 'Europe/Paris')).toMatchObject({
      dueAtIso: '2026-10-25T01:30:00.000Z',
      localTime: '2026-10-25T02:30:00',
      utcOffsetMinutes: 60,
      ambiguousLocalTime: false,
    });
  });

  it('refuses malformed values, impossible dates and local times without a zone', () => {
    expect(refusal('tomorrow at 9').message).toContain('ISO-8601');
    expect(refusal('2026-11-02 09:00', 'Europe/Paris').message).toContain('ISO-8601');
    expect(refusal('2026-02-30T09:00', 'Europe/Paris').message).toContain('not a valid calendar');
    expect(refusal('2026-11-02T24:00', 'Europe/Paris').message).toContain('not a valid calendar');
    expect(refusal('2026-11-02T09:00:60Z').message).toContain('not a valid calendar');
    expect(refusal('2026-11-02T09:00+24:00').message).toContain('invalid UTC offset');
    expect(refusal('2026-11-02T09:00').message).toContain('has no UTC offset');
  });

  it('refuses an unknown zone and a UTC offset given as the zone', () => {
    expect(refusal('2026-11-02T09:00', 'Mars/Olympus').message).toContain('IANA time zone');
    expect(refusal('2026-11-02T09:00', '+01:00').message).toContain('not a UTC offset');
    expect(refusal('2026-11-02T09:00:00Z', '-05:00').message).toContain('not a UTC offset');
    expect(refusal('2026-11-02T09:00', ' ').code).toBe('invalid_input');
  });
});

describe('canonicalTimezone and zonedTime', () => {
  it('canonicalizes case the way the DO does', () => {
    expect(canonicalTimezone('europe/paris')).toBe('Europe/Paris');
    expect(canonicalTimezone(' UTC ')).toBe('UTC');
  });

  it('shows a stored instant in its zone on either side of a change', () => {
    expect(zonedTime(Date.parse('2026-10-25T00:30:00Z'), 'Europe/Paris')).toEqual({
      localTime: '2026-10-25T02:30:00',
      utcOffsetMinutes: 120,
    });
    expect(zonedTime(Date.parse('2026-10-25T01:30:00Z'), 'Europe/Paris')).toEqual({
      localTime: '2026-10-25T02:30:00',
      utcOffsetMinutes: 60,
    });
    expect(zonedTime(Date.parse('2026-03-08T07:00:00Z'), 'America/New_York')).toEqual({
      localTime: '2026-03-08T03:00:00',
      utcOffsetMinutes: -240,
    });
  });
});
