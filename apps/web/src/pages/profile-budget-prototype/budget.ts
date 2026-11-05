/**
 * Reset-aware budget math for the prototype.
 *
 * The proposed production fix lives in `effectiveWindow`: a sample taken before
 * the window's `resetsAt` says nothing about usage after it, so once the reset
 * has passed the window reads 0% and its level drops to OK until a new sample
 * arrives. Today `credential-limit-format.ts` keeps the stale percent and only
 * swaps the countdown for "reset due".
 */
import type {
  CredentialLimitCredentialSummary,
  CredentialLimitLevel,
  CredentialLimitWindowSummary,
} from '@simple-agent-manager/shared';
import { credentialLimitWindowLabel, credentialLimitWindowSortMinutes } from '@simple-agent-manager/shared';
import type { ChipTone } from '@simple-agent-manager/ui';

import { formatMsSpan } from '../../lib/time-utils';

export interface EffectiveWindow {
  label: string;
  percent: number | null;
  level: CredentialLimitLevel;
  /** The provider's window rolled over after our last sample. */
  resetElapsed: boolean;
  resetText: string | null;
  raw: CredentialLimitWindowSummary;
}

export function effectiveWindow(w: CredentialLimitWindowSummary, now: number): EffectiveWindow {
  const label = credentialLimitWindowLabel(w.windowType, w.windowMinutes);
  const resetElapsed = w.resetsAt !== null && w.resetsAt <= now && w.observedAt < w.resetsAt;
  if (resetElapsed && w.resetsAt !== null) {
    return {
      label,
      percent: 0,
      level: 'ok',
      resetElapsed,
      resetText: `reset ${formatMsSpan(now - w.resetsAt)} ago`,
      raw: w,
    };
  }
  return {
    label,
    percent: w.utilizationPercent,
    level: w.level,
    resetElapsed: false,
    resetText: w.resetsAt === null ? null : `resets in ${formatMsSpan(w.resetsAt - now)}`,
    raw: w,
  };
}

export function effectiveWindows(
  account: CredentialLimitCredentialSummary,
  now: number
): EffectiveWindow[] {
  return [...account.windows]
    .sort(
      (a, b) =>
        (credentialLimitWindowSortMinutes(a.windowType, a.windowMinutes) ?? Infinity) -
        (credentialLimitWindowSortMinutes(b.windowType, b.windowMinutes) ?? Infinity)
    )
    .map((w) => effectiveWindow(w, now));
}

export type Readiness = 'ready' | 'tight' | 'low' | 'blocked' | 'unknown';

export interface AccountBudget {
  readiness: Readiness;
  /** The window closest to its limit — the one that will stop you first. */
  binding: EffectiveWindow | null;
  windows: EffectiveWindow[];
  /** 0-100 headroom on the binding window. */
  headroom: number | null;
}

export function accountBudget(
  account: CredentialLimitCredentialSummary | null,
  now: number
): AccountBudget {
  if (!account || account.windows.length === 0) {
    return { readiness: 'unknown', binding: null, windows: [], headroom: null };
  }
  const windows = effectiveWindows(account, now);
  let binding: EffectiveWindow | null = null;
  for (const w of windows) {
    if (w.level === 'rejected') {
      binding = w;
      break;
    }
    if ((w.percent ?? -1) > (binding?.percent ?? -1)) binding = w;
  }
  const pct = binding?.percent ?? null;
  let readiness: Readiness = 'unknown';
  if (binding?.level === 'rejected') readiness = 'blocked';
  else if (pct === null) readiness = 'unknown';
  else if (pct >= 90) readiness = 'low';
  else if (pct >= 70) readiness = 'tight';
  else readiness = 'ready';
  return { readiness, binding, windows, headroom: pct === null ? null : Math.max(0, 100 - pct) };
}

export const READINESS: Record<Readiness, { label: string; tone: ChipTone; color: string }> = {
  ready: { label: 'Plenty left', tone: 'success', color: 'var(--sam-status-success-fg)' },
  tight: { label: 'Getting tight', tone: 'warning', color: 'var(--sam-status-warning-fg)' },
  low: { label: 'Nearly out', tone: 'danger', color: 'var(--sam-status-critical-fg)' },
  blocked: { label: 'Limit reached', tone: 'danger', color: 'var(--sam-status-danger-fg)' },
  unknown: { label: 'No plan limits', tone: 'muted', color: 'var(--sam-color-fg-muted)' },
};

export const READINESS_ORDER: Readiness[] = ['ready', 'tight', 'unknown', 'low', 'blocked'];

export function levelColor(level: CredentialLimitLevel): string {
  return {
    ok: 'var(--sam-status-success-fg)',
    warning: 'var(--sam-status-warning-fg)',
    critical: 'var(--sam-status-critical-fg)',
    rejected: 'var(--sam-status-danger-fg)',
  }[level];
}
