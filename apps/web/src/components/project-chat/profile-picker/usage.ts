/**
 * How much is left on the account a profile runs on, in the words the picker shows:
 * nothing while there is room, "6% left · resets 52m" when a limit is close and
 * "Out · back in 2h 10m" when one is used up. "Left" is the room on the window that
 * will stop the profile first (`profileHeadroom`, as on the Profiles page), and the
 * levels are the server's, so the picker cannot disagree with the usage dialog.
 */
import type { AgentProfile, CredentialLimitLevel } from '@simple-agent-manager/shared';
import { credentialLimitSummaryAsOf } from '@simple-agent-manager/shared';
import { useMemo } from 'react';

import { formatMsSpan } from '../../../lib/time-utils';
import { profileHeadroom } from '../../agent-profiles/ProfileUsageStrip';
import { type ProfileBudget, useProfileBudgets } from '../../agent-profiles/useProfileBudgets';
import { LEVEL_STYLES } from '../../credential-limits/credential-limit-format';

export type ProfileUsageState = 'ok' | 'low' | 'out' | 'unknown' | 'platform' | 'none' | 'paused';

export interface ProfileUsage {
  state: ProfileUsageState;
  /** Percent left on the fullest window; null when there is no reading. */
  left: number | null;
  /** Status colour of that window. */
  color: string;
  /** "52m", "2h 10m": until that window resets; null when unknown or passed. */
  resetIn: string | null;
  /** The account's name in Settings, or null when there is none to show. */
  accountLabel: string | null;
  /** The account's credential reference: its identity (names are not unique). */
  accountKey: string | null;
}

const ORDER: CredentialLimitLevel[] = ['ok', 'warning', 'critical', 'rejected'];

export function profileUsage(budget: ProfileBudget | undefined, now: number): ProfileUsage {
  const quiet = { left: null, color: LEVEL_STYLES.ok.color, resetIn: null, accountKey: null };
  if (!budget) return { ...quiet, state: 'unknown', accountLabel: null };
  if (budget.kind === 'platform') return { ...quiet, state: 'platform', accountLabel: null };
  if (budget.kind === 'none') return { ...quiet, state: 'none', accountLabel: null };
  if (budget.kind === 'paused') return { ...quiet, state: 'paused', accountLabel: budget.label };
  if (!budget.usage) return { ...quiet, state: 'unknown', accountLabel: budget.label };

  const left = profileHeadroom(budget, now);
  if (left === null) return { ...quiet, state: 'unknown', accountLabel: budget.label };
  // The window that stops the profile first: a refused one, else the fullest.
  const windows = credentialLimitSummaryAsOf(budget.usage, now).windows;
  const binding = windows.reduce<(typeof windows)[number] | undefined>((worst, window) => {
    if (!worst) return window;
    const rank = ORDER.indexOf(window.level) - ORDER.indexOf(worst.level);
    if (rank !== 0) return rank > 0 ? window : worst;
    return (window.utilizationPercent ?? -1) > (worst.utilizationPercent ?? -1) ? window : worst;
  }, undefined);
  const level = binding?.level ?? 'ok';
  const resetsAt = binding?.resetsAt ?? null;
  return {
    state: left <= 0 ? 'out' : level === 'ok' ? 'ok' : 'low',
    left,
    color: LEVEL_STYLES[left <= 0 ? 'rejected' : level].color,
    resetIn: resetsAt !== null && resetsAt > now ? formatMsSpan(resetsAt - now) : null,
    accountLabel: budget.label,
    accountKey: budget.usage.credentialReference,
  };
}

/** The ring shows only when there is a reading to draw. */
export function hasUsageReading(usage: ProfileUsage | undefined): usage is ProfileUsage {
  return usage?.state === 'ok' || usage?.state === 'low' || usage?.state === 'out';
}

/** Visible words: null while there is room, so calm profiles stay quiet. */
export function usageNotice(usage: ProfileUsage | undefined): string | null {
  switch (usage?.state) {
    case 'low':
      return usage.resetIn
        ? `${usage.left}% left · resets ${usage.resetIn}`
        : `${usage.left}% left`;
    case 'out':
      return usage.resetIn ? `Out · back in ${usage.resetIn}` : 'Out for now';
    case 'paused':
      return `${usage.accountLabel ?? 'Account'} paused`;
    case 'none':
      return 'No account connected';
    default:
      return null;
  }
}

/** Spoken with the profile's name, including the calm case the eye reads off the ring. */
export function usageSpoken(usage: ProfileUsage | undefined): string | null {
  if (usage?.state === 'ok') return `${usage.left}% left`;
  return usageNotice(usage);
}

/**
 * Another visible profile that runs the same agent and model on a different account
 * with room, so switching changes only whose limits pay for the chat.
 */
export function roomierProfile(
  selected: AgentProfile,
  candidates: readonly AgentProfile[],
  usageFor: (profileId: string) => ProfileUsage | undefined
): { profile: AgentProfile; usage: ProfileUsage } | null {
  const mine = usageFor(selected.id);
  let best: { profile: AgentProfile; usage: ProfileUsage } | null = null;
  for (const profile of candidates) {
    if (profile.id === selected.id) continue;
    if (profile.agentType !== selected.agentType || profile.model !== selected.model) continue;
    const usage = usageFor(profile.id);
    if (usage?.state !== 'ok' || usage.left === null) continue;
    if (usage.accountKey === mine?.accountKey) continue;
    if (!best || usage.left > (best.usage.left ?? 0)) best = { profile, usage };
  }
  return best;
}

/**
 * Usage for every profile, keyed by profile id; null until the accounts load. `enabled`
 * false skips the account requests entirely (the picker is not on screen).
 */
export function useProfileUsages(
  profiles: readonly AgentProfile[],
  enabled: boolean
): ReadonlyMap<string, ProfileUsage> | null {
  const budgets = useProfileBudgets(profiles, { enabled });
  // Recomputed when a limits poll lands, which also refreshes the reset countdowns.
  return useMemo(() => {
    if (!budgets) return null;
    const now = Date.now();
    return new Map(
      profiles.map((profile) => [profile.id, profileUsage(budgets.get(profile.id), now)])
    );
  }, [budgets, profiles]);
}
