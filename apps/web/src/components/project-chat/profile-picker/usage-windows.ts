/**
 * The windows an account's usage is measured over, read the way the picker shows them:
 * the session window (5h) the ring's arc measures, the week whose health colours the
 * ring, and every window for the labelled meters.
 *
 * A window's kind comes from its length (`credentialLimitWindowSortMinutes`), never its
 * position: Codex plans order their windows differently (rule 74).
 */
import type { CredentialLimitWindowSummary } from '@simple-agent-manager/shared';
import {
  credentialLimitWindowLabel,
  credentialLimitWindowSortMinutes,
} from '@simple-agent-manager/shared';

import { formatMsSpan } from '../../../lib/time-utils';

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/**
 * Health bands on what is LEFT (approved 2026-11-13): above `calm` is green and quiet,
 * from `low` to `calm` amber, below `low` red. Words appear once a window is at or
 * below `calm`; the nudge offers another account below `low`.
 */
export const USAGE_HEALTH = { calm: 50, low: 25 } as const;

export const USAGE_COLORS = {
  calm: 'var(--sam-status-success-fg)',
  low: 'var(--sam-status-warning-fg)',
  urgent: 'var(--sam-status-danger-fg)',
} as const;

/** Colour for a window with `left` percent remaining; refused reads as urgent. */
export function healthColor(left: number | null): string {
  if (left === null) return USAGE_COLORS.calm;
  if (left > USAGE_HEALTH.calm) return USAGE_COLORS.calm;
  if (left >= USAGE_HEALTH.low) return USAGE_COLORS.low;
  return USAGE_COLORS.urgent;
}

export interface UsageWindowReading {
  windowType: string;
  /** "5h", "Week", "Opus week", "Month". */
  label: string;
  /** For tight spots: "5h", "Wk", "Opus", "Mo". */
  shortLabel: string;
  /** Percent left; 0 when refused; null when the provider gave no reading. */
  left: number | null;
  /** The provider refused prompts on this window. */
  refused: boolean;
  /** "52m", "2d 4h": until it resets; null when unknown or passed. */
  resetIn: string | null;
  /** Length used to sort and classify; null when unknown. */
  minutes: number | null;
  /** The window reset since its last sample, so the reading is a fresh window's. */
  resetElapsed: boolean;
}

const SHORT_LABELS: Record<string, string> = { Week: 'Wk', Month: 'Mo', Rolling: 'Roll' };

function shortLabel(label: string): string {
  return SHORT_LABELS[label] ?? label.replace(/ week$/, '');
}

export function readUsageWindow(
  window: CredentialLimitWindowSummary,
  now: number
): UsageWindowReading {
  const label = credentialLimitWindowLabel(window.windowType, window.windowMinutes);
  const refused = window.level === 'rejected';
  const used = window.utilizationPercent;
  return {
    windowType: window.windowType,
    label,
    shortLabel: shortLabel(label),
    left: refused ? 0 : used === null ? null : Math.max(0, Math.min(100, Math.round(100 - used))),
    refused,
    resetIn:
      window.resetsAt !== null && window.resetsAt > now
        ? formatMsSpan(window.resetsAt - now)
        : null,
    minutes: credentialLimitWindowSortMinutes(window.windowType, window.windowMinutes),
    resetElapsed: window.resetElapsed === true,
  };
}

/** Lower is tighter: refused first, then least left; an unknown reading last. */
function tightness(reading: UsageWindowReading): number {
  if (reading.refused) return -1;
  return reading.left ?? Number.POSITIVE_INFINITY;
}

function tightest(readings: UsageWindowReading[]): UsageWindowReading | null {
  return readings.reduce<UsageWindowReading | null>(
    (best, reading) => (!best || tightness(reading) < tightness(best) ? reading : best),
    null
  );
}

/**
 * Split windows into the session window (an hour to a day: Claude's 5h, Codex's 5h,
 * OpenCode's rolling) and the long one (a day or more: the week, a model's week, a month),
 * tightest of each. Per-minute API rate windows and windows of unknown length are neither:
 * they appear only in the meters.
 */
export function classifyUsageWindows(readings: UsageWindowReading[]): {
  session: UsageWindowReading | null;
  week: UsageWindowReading | null;
} {
  const session = readings.filter(
    (reading) =>
      reading.minutes !== null &&
      reading.minutes >= MINUTES_PER_HOUR &&
      reading.minutes < MINUTES_PER_DAY
  );
  const long = readings.filter(
    (reading) => reading.minutes !== null && reading.minutes >= MINUTES_PER_DAY
  );
  return { session: tightest(session), week: tightest(long) };
}

/** Readings shortest first, unknown lengths last, for the labelled meters. */
export function sortUsageWindows(readings: UsageWindowReading[]): UsageWindowReading[] {
  return [...readings].sort(
    (a, b) =>
      (a.minutes ?? Number.POSITIVE_INFINITY) - (b.minutes ?? Number.POSITIVE_INFINITY) ||
      a.label.localeCompare(b.label)
  );
}
