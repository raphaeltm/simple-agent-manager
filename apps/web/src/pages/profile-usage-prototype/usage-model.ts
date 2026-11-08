/**
 * One question per profile: how much is left before it stops, and when does it come
 * back. "Left" is 100 minus the fullest window (the one that will stop the profile
 * first), which is the existing `profileHeadroom` rule from the profile list.
 */
import type { AgentProfile, CredentialLimitLevel } from '@simple-agent-manager/shared';
import { credentialLimitSummaryAsOf, credentialLimitWindowLabel } from '@simple-agent-manager/shared';

import { profileHeadroom } from '../../components/agent-profiles/ProfileUsageStrip';
import type { ProfileBudget } from '../../components/agent-profiles/useProfileBudgets';
import { LEVEL_STYLES } from '../../components/credential-limits/credential-limit-format';
import { formatMsSpan } from '../../lib/time-utils';

export type UsageState = 'ok' | 'low' | 'out' | 'unknown' | 'platform' | 'none' | 'paused';

export interface ProfileUsage {
  state: UsageState;
  /** Percent left on the fullest window; null when unknown. */
  left: number | null;
  level: CredentialLimitLevel;
  color: string;
  /** "5h", "Week" — the window that will stop the profile first. */
  bindingLabel: string | null;
  /** "52m", "2h 10m" — until the binding window resets. */
  resetIn: string | null;
  accountLabel: string | null;
}

const MUTED = 'var(--sam-color-fg-muted)';

export function profileUsage(budget: ProfileBudget | undefined, now: number): ProfileUsage {
  const base = { left: null, level: 'ok' as const, color: MUTED, bindingLabel: null, resetIn: null };
  if (!budget) return { ...base, state: 'unknown', accountLabel: null };
  if (budget.kind === 'platform') return { ...base, state: 'platform', accountLabel: 'SAM platform' };
  if (budget.kind === 'none') return { ...base, state: 'none', accountLabel: null };
  if (budget.kind === 'paused') return { ...base, state: 'paused', accountLabel: budget.label };
  if (!budget.usage) return { ...base, state: 'unknown', accountLabel: budget.label };

  const current = credentialLimitSummaryAsOf(budget.usage, now);
  const left = profileHeadroom(budget, now);
  const binding = [...current.windows].sort((a, b) => {
    if (a.level === 'rejected') return -1;
    if (b.level === 'rejected') return 1;
    return (b.utilizationPercent ?? -1) - (a.utilizationPercent ?? -1);
  })[0];
  const level = binding?.level ?? 'ok';
  const state: UsageState =
    left === null ? 'unknown' : left <= 0 ? 'out' : level === 'ok' ? 'ok' : 'low';
  return {
    state,
    left,
    level,
    color: state === 'unknown' ? MUTED : LEVEL_STYLES[level].color,
    bindingLabel: binding ? credentialLimitWindowLabel(binding.windowType, binding.windowMinutes) : null,
    resetIn:
      binding?.resetsAt != null && binding.resetsAt > now ? formatMsSpan(binding.resetsAt - now) : null,
    accountLabel: budget.label,
  };
}

/** Short words for places with no room for a meter. */
export function usageWords(usage: ProfileUsage): string {
  switch (usage.state) {
    case 'ok':
      return `${usage.left}% left`;
    case 'low':
      return `${usage.left}% left`;
    case 'out':
      return usage.resetIn ? `Out · back in ${usage.resetIn}` : 'Out for now';
    case 'unknown':
      return 'No usage yet';
    case 'platform':
      return 'SAM platform';
    case 'none':
      return 'No account connected';
    case 'paused':
      return `${usage.accountLabel ?? 'Account'} paused`;
  }
}

/**
 * Another profile that runs the same model on an account with more room, for the
 * "running low" nudge. Same agent and model, so switching changes only whose quota pays.
 */
export function betterAlternative(
  selected: AgentProfile,
  profiles: readonly AgentProfile[],
  usageOf: (profile: AgentProfile) => ProfileUsage
): { profile: AgentProfile; usage: ProfileUsage } | null {
  const mine = usageOf(selected);
  let best: { profile: AgentProfile; usage: ProfileUsage } | null = null;
  for (const candidate of profiles) {
    if (candidate.id === selected.id) continue;
    if (candidate.agentType !== selected.agentType || candidate.model !== selected.model) continue;
    const usage = usageOf(candidate);
    if (usage.state !== 'ok' || usage.left === null) continue;
    if (usage.accountLabel === mine.accountLabel) continue;
    if (!best || usage.left > (best.usage.left ?? 0)) best = { profile: candidate, usage };
  }
  return best;
}
