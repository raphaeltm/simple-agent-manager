/**
 * How much is left on the account a chat runs on, in the words and ring the picker shows.
 *
 * The ring (approved 2026-11-13): its arc is what is left of the session window (5h), its
 * colour is the week's health. Words appear only once a window is at or below half: the
 * session window first, in neutral text, then the week in its health colour. "Left" overall
 * is still the room on the window that will stop the account first (`profileHeadroom`, as on
 * the Profiles page), so ordering and "Out for now" cannot disagree with the usage dialog.
 */
import type { AgentProfile } from '@simple-agent-manager/shared';
import {
  credentialLimitSummaryAsOf,
  worstCredentialLimitLevel,
} from '@simple-agent-manager/shared';
import { useMemo } from 'react';

import { formatMsSpan } from '../../../lib/time-utils';
import { profileHeadroom } from '../../agent-profiles/ProfileUsageStrip';
import { type ProfileBudget, useProfileBudgets } from '../../agent-profiles/useProfileBudgets';
import { LEVEL_STYLES } from '../../credential-limits/credential-limit-format';
import {
  classifyUsageWindows,
  healthColor,
  readUsageWindow,
  sortUsageWindows,
  USAGE_COLORS,
  USAGE_HEALTH,
  type UsageWindowReading,
} from './usage-windows';

export type ProfileUsageState = 'ok' | 'low' | 'out' | 'unknown' | 'platform' | 'none' | 'paused';

export interface ProfileUsage {
  state: ProfileUsageState;
  /** Percent left on the fullest window; null when there is no reading. */
  left: number | null;
  /** The ring's colour: the week's health (the session's when there is no week; red once the week is used up). */
  color: string;
  /** "52m", "2h 10m": until the fullest window resets (when out: until it is back). */
  resetIn: string | null;
  /** The account's name in Settings, or null when there is none to show. */
  accountLabel: string | null;
  /** The account's credential reference: its identity (names are not unique). */
  accountKey: string | null;
  /** The account's id (`cc_configurations.id`), what a run account is chosen by. */
  accountId: string | null;
  /** The session window (5h) the arc measures; null when the account has none. */
  session: UsageWindowReading | null;
  /** The tightest window of a day or longer (week, Opus week); null when none. */
  week: UsageWindowReading | null;
  /** Every window, shortest first, for labelled meters. */
  windows: UsageWindowReading[];
  /** Low enough that the nudge should offer another account. */
  urgent: boolean;
}

const QUIET: Omit<ProfileUsage, 'state' | 'accountLabel'> = {
  left: null,
  color: USAGE_COLORS.calm,
  resetIn: null,
  accountKey: null,
  accountId: null,
  session: null,
  week: null,
  windows: [],
  urgent: false,
};

function isSpent(reading: UsageWindowReading | null): boolean {
  return Boolean(reading && (reading.refused || reading.left === 0));
}

export function profileUsage(budget: ProfileBudget | undefined, now: number): ProfileUsage {
  if (!budget) return { ...QUIET, state: 'unknown', accountLabel: null };
  if (budget.kind === 'platform') return { ...QUIET, state: 'platform', accountLabel: null };
  if (budget.kind === 'none') return { ...QUIET, state: 'none', accountLabel: null };
  if (budget.kind === 'paused') return { ...QUIET, state: 'paused', accountLabel: budget.label };
  const accountId = budget.accountId ?? null;
  if (!budget.usage) return { ...QUIET, state: 'unknown', accountLabel: budget.label, accountId };

  const left = profileHeadroom(budget, now);
  if (left === null) return { ...QUIET, state: 'unknown', accountLabel: budget.label, accountId };
  const current = credentialLimitSummaryAsOf(budget.usage, now).windows;
  const readings = current.map((window) => readUsageWindow(window, now));
  const { session, week } = classifyUsageWindows(readings);
  const level = worstCredentialLimitLevel(current.map((window) => window.level));

  // The countdown describes the number shown. Out: back only when every refused window has
  // reset, so the latest of them (unknown if any is unknown). Otherwise: the fullest window.
  const refused = current.filter((window) => window.level === 'rejected');
  let resetsAt: number | null;
  if (left <= 0 && refused.length > 0) {
    resetsAt = refused.some((window) => window.resetsAt === null)
      ? null
      : Math.max(...refused.map((window) => window.resetsAt ?? 0));
  } else {
    const fullest = current.reduce<(typeof current)[number] | undefined>(
      (best, window) =>
        !best || (window.utilizationPercent ?? -1) > (best.utilizationPercent ?? -1)
          ? window
          : best,
      undefined
    );
    resetsAt = fullest?.resetsAt ?? null;
  }

  const out = left <= 0 || isSpent(week);
  const classified = session !== null || week !== null;
  const below = (reading: UsageWindowReading | null, bound: number) =>
    (reading?.left ?? Number.POSITIVE_INFINITY) <= bound;
  const low = classified
    ? below(session, USAGE_HEALTH.calm) || below(week, USAGE_HEALTH.calm) || level !== 'ok'
    : level !== 'ok';
  const urgent =
    out ||
    (classified
      ? below(session, USAGE_HEALTH.low - 1) || below(week, USAGE_HEALTH.low - 1)
      : level !== 'ok');
  // A week with no reading cannot colour the ring; the session then does.
  const ringReading = week && week.left !== null ? week : session;
  return {
    state: out ? 'out' : low ? 'low' : 'ok',
    left,
    // The colour is the week (approved): a used-up 5h on a healthy week is an empty arc with
    // a green or amber dot. Only a used-up week, or an out reading no window explains, is red.
    color: isSpent(week)
      ? USAGE_COLORS.urgent
      : ringReading
        ? healthColor(ringReading.left)
        : out
          ? USAGE_COLORS.urgent
          : LEVEL_STYLES[level].color,
    resetIn: resetsAt !== null && resetsAt > now ? formatMsSpan(resetsAt - now) : null,
    accountLabel: budget.label,
    accountKey: budget.usage.credentialReference,
    accountId,
    session,
    week,
    windows: sortUsageWindows(readings),
    urgent,
  };
}

/**
 * How full the ring's arc is: the session window. A used-up week empties it whatever the
 * session says, since nothing can run. A weekly-only account draws the week.
 */
export function ringLeft(usage: ProfileUsage): number {
  if (isSpent(usage.week)) return 0;
  return usage.session?.left ?? usage.week?.left ?? usage.left ?? 0;
}

/** The ring shows only when there is a reading to draw. */
export function hasUsageReading(usage: ProfileUsage | null | undefined): usage is ProfileUsage {
  return usage?.state === 'ok' || usage?.state === 'low' || usage?.state === 'out';
}

export interface UsageWord {
  text: string;
  /** Null: neutral text (the session window). A colour: the week's health. */
  color: string | null;
}

function windowWord(reading: UsageWindowReading, color: string | null): UsageWord {
  if (isSpent(reading)) {
    const back = reading.resetIn ? ` · back in ${reading.resetIn}` : '';
    return { text: `${reading.label} used up${back}`, color };
  }
  const resets = reading.resetIn ? ` · resets ${reading.resetIn}` : '';
  return { text: `${reading.label} ${reading.left}% left${resets}`, color };
}

/** The words beside the ring: none while both windows have more than half left. */
export function usageWords(usage: ProfileUsage | null | undefined): UsageWord[] {
  if (!usage || (usage.state !== 'low' && usage.state !== 'out')) return [];
  const { session, week } = usage;
  if (isSpent(week) && week) return [windowWord(week, USAGE_COLORS.urgent)];
  const words: UsageWord[] = [];
  const shows = (reading: UsageWindowReading | null): reading is UsageWindowReading =>
    reading !== null &&
    (isSpent(reading) || (reading.left !== null && reading.left <= USAGE_HEALTH.calm));
  if (shows(session)) words.push(windowWord(session, null));
  if (shows(week)) words.push(windowWord(week, healthColor(week.left)));
  if (words.length > 0) return words;
  // No session or week window explains it (API-rate windows, an unknown length).
  if (usage.state === 'out') {
    return [
      { text: usage.resetIn ? `Out · back in ${usage.resetIn}` : 'Out for now', color: null },
    ];
  }
  const resets = usage.resetIn ? ` · resets ${usage.resetIn}` : '';
  return [{ text: `${usage.left}% left${resets}`, color: usage.color }];
}

/** Visible words as one line: null while there is room, so calm profiles stay quiet. */
export function usageNotice(usage: ProfileUsage | null | undefined): string | null {
  switch (usage?.state) {
    case 'low':
    case 'out':
      return usageWords(usage)
        .map((word) => word.text)
        .join(' · ');
    case 'paused':
      return `${usage.accountLabel ?? 'Account'} paused`;
    case 'none':
      return 'No account connected';
    default:
      return null;
  }
}

/** Spoken with the profile's name, including the calm case the eye reads off the ring. */
export function usageSpoken(usage: ProfileUsage | null | undefined): string | null {
  if (usage?.state === 'ok') {
    return usage.session && usage.week
      ? `${usage.session.label} ${usage.session.left}% left, ${usage.week.label} ${usage.week.left}% left`
      : `${usage.left}% left`;
  }
  return usageNotice(usage);
}

/**
 * Usage for every profile, keyed by profile id; null until the accounts load. `enabled`
 * false skips the account requests entirely (the picker is not on screen).
 */
export function useProfileUsages(
  profiles: readonly AgentProfile[],
  projectId: string,
  enabled: boolean
): ReadonlyMap<string, ProfileUsage> | null {
  // The chat runs in this project, so a profile shared across projects resolves to this
  // project's account when it has no pin of its own.
  const budgets = useProfileBudgets(profiles, { enabled, projectId });
  // Recomputed when a limits poll lands, which also refreshes the reset countdowns.
  return useMemo(() => {
    // Disabled means off screen: cached rows from an earlier visit are not shown either.
    if (!enabled || !budgets) return null;
    const now = Date.now();
    return new Map(
      profiles.map((profile) => [profile.id, profileUsage(budgets.get(profile.id), now)])
    );
  }, [budgets, enabled, profiles]);
}

/**
 * One profile's entry for the ring: `undefined` where the surface has no usage map (plain
 * glyph), `null` while it loads or for a profile it doesn't cover (reserve the footprint).
 */
export function usageEntry(
  usages: ReadonlyMap<string, ProfileUsage> | null | undefined,
  profileId: string
): ProfileUsage | null | undefined {
  if (usages === undefined) return undefined;
  return usages?.get(profileId) ?? null;
}
