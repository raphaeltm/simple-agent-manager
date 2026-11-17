/**
 * Number formatting for Insights. Every helper takes `null` for "not recorded" and says so,
 * rather than printing a zero the records cannot support.
 */
import type { FlowRunsBucket } from '@simple-agent-manager/shared';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "22 min", "3.4 h", "1.6 days". */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < HOUR) return `${Math.max(0, Math.round(ms / MINUTE))} min`;
  if (ms < DAY) return `${trim(ms / HOUR)} h`;
  return `${trim(ms / DAY)} ${ms / DAY < 1.05 ? 'day' : 'days'}`;
}

/** The short form for tight spaces: "22m", "3.4h", "1.6d". */
export function formatDurationShort(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < HOUR) return `${Math.max(0, Math.round(ms / MINUTE))}m`;
  if (ms < DAY) return `${trim(ms / HOUR)}h`;
  return `${trim(ms / DAY)}d`;
}

function trim(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
}

export function formatPercent(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

export type DeltaTone = 'better' | 'worse' | 'flat';

/**
 * Colour for a change. Green means better; a worse change stays muted (the arrow says which
 * way), because amber means "waiting on you" in SAM Glass and red means broken.
 */
export const DELTA_TONE_CLASS: Record<DeltaTone, string> = {
  better: 'text-[var(--sam-status-success-fg)]',
  worse: 'text-fg-muted',
  flat: 'text-fg-muted',
};

/**
 * Change against the previous range, worded for the reader: "▼ 0.4 days vs previous 30 days".
 * `lowerIsBetter` decides the tone. Returns null when either side is missing.
 */
export function durationDelta(
  current: number | null,
  previous: number | null,
  lowerIsBetter = true
): { text: string; tone: DeltaTone } | null {
  if (current === null || previous === null) return null;
  const diff = current - previous;
  if (Math.abs(diff) < MINUTE) return { text: 'Same as before', tone: 'flat' };
  const arrow = diff < 0 ? '▼' : '▲';
  const better = lowerIsBetter ? diff < 0 : diff > 0;
  return { text: `${arrow} ${formatDuration(Math.abs(diff))}`, tone: better ? 'better' : 'worse' };
}

/** Percentage-point change: "▲ 6 points". */
export function rateDelta(
  current: number | null,
  previous: number | null,
  higherIsBetter = true
): { text: string; tone: DeltaTone } | null {
  if (current === null || previous === null) return null;
  const points = Math.round((current - previous) * 100);
  if (points === 0) return { text: 'Same as before', tone: 'flat' };
  const better = higherIsBetter ? points > 0 : points < 0;
  return {
    text: `${points > 0 ? '▲' : '▼'} ${Math.abs(points)} ${Math.abs(points) === 1 ? 'point' : 'points'}`,
    tone: better ? 'better' : 'worse',
  };
}

export function countDelta(current: number, previous: number): { text: string; tone: DeltaTone } {
  const diff = current - previous;
  if (diff === 0) return { text: 'Same as before', tone: 'flat' };
  return {
    text: `${diff > 0 ? '▲' : '▼'} ${Math.abs(diff)}`,
    tone: diff > 0 ? 'better' : 'worse',
  };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** "W46" for a week bucket, "Mon 16" for a day bucket (UTC, the server's bucket clock). */
export function bucketLabel(start: string, bucket: 'day' | 'week'): string {
  const date = new Date(`${start}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return start;
  if (bucket === 'day') return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()}`;
  return `W${isoWeek(date)}`;
}

function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / DAY + 1) / 7);
}

export function bucketTotal(bucket: FlowRunsBucket): number {
  return bucket.merged + bucket.closed + bucket.failed;
}

/** Whole days since an ISO time, for "9 d" in the ideas list. */
export function daysSince(iso: string, now: number): number {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / DAY)) : 0;
}
