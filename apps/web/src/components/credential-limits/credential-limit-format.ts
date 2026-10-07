import type {
  CredentialLimitCredentialSummary,
  CredentialLimitLevel,
  CredentialLimitWindowSummary,
} from '@simple-agent-manager/shared';
import {
  credentialLimitFamilyLabel,
  credentialLimitWindowLabel,
} from '@simple-agent-manager/shared';

import { formatMsSpan } from '../../lib/time-utils';

const MINUTE_MS = 60_000;

/** How many windows the compact chip spells out before collapsing to "+N". */
export const CHIP_MAX_WINDOWS = 3;

/**
 * Level colours come from the shared status tokens (the same family
 * `StatusBadge` uses), so the chip reads like every other status surface and
 * both themes stay in sync. Four distinct tiers: green / amber / orange / red.
 */
export const LEVEL_STYLES: Record<CredentialLimitLevel, { background: string; color: string }> = {
  ok: { background: 'var(--sam-status-success-bg)', color: 'var(--sam-status-success-fg)' },
  warning: { background: 'var(--sam-status-warning-bg)', color: 'var(--sam-status-warning-fg)' },
  critical: { background: 'var(--sam-status-critical-bg)', color: 'var(--sam-status-critical-fg)' },
  rejected: { background: 'var(--sam-status-danger-bg)', color: 'var(--sam-status-danger-fg)' },
};

export const LEVEL_LABELS: Record<CredentialLimitLevel, string> = {
  ok: 'OK',
  warning: 'Warning',
  critical: 'Critical',
  rejected: 'Limit reached',
};

/**
 * Value label for one window. A missing sample on a window the provider has
 * already flagged (warning/critical/rejected) must say so rather than "unknown".
 */
export function windowValueLabel(
  window: Pick<CredentialLimitWindowSummary, 'utilizationPercent' | 'level'>
): string {
  if (window.utilizationPercent === null) {
    return window.level === 'ok' ? 'usage unknown' : LEVEL_LABELS[window.level];
  }
  return `${formatUtilizationPercent(window.utilizationPercent)} used`;
}

export function formatUtilizationPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${Math.round(value)}%`;
}

/** "resets in 2h 10m", "reset due" once the time has passed, null when unknown. */
export function formatResetCountdown(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return null;
  const remaining = resetsAt - now;
  if (remaining <= 0) return 'reset due';
  return `resets in ${formatMsSpan(remaining)}`;
}

/**
 * "sampled 3m ago" — how old the newest provider sample is. Ages floor to whole
 * minutes (a sample taken 5m 01s ago reads "5m ago"), whereas countdowns round up.
 */
export function formatSampledAgo(observedAt: number, now: number): string {
  const age = now - observedAt;
  if (age < MINUTE_MS) return 'sampled just now';
  return `sampled ${formatMsSpan(Math.floor(age / MINUTE_MS) * MINUTE_MS)} ago`;
}

/** Family label for a credential, taken from its first window ("Claude", "Codex", …). */
export function credentialFamilyLabel(credential: CredentialLimitCredentialSummary): string {
  const first = credential.windows[0];
  return first ? credentialLimitFamilyLabel(first.windowType) : credential.provider;
}

export function windowChipText(window: CredentialLimitWindowSummary): string {
  return `${credentialLimitWindowLabel(window.windowType, window.windowMinutes)} ${formatUtilizationPercent(window.utilizationPercent)}`;
}

/** "Claude · 5h 72% · Week 31%" (collapsing beyond CHIP_MAX_WINDOWS to "+N"). */
export function credentialChipText(credential: CredentialLimitCredentialSummary): string {
  const parts = [credentialFamilyLabel(credential)];
  const shown = credential.windows.slice(0, CHIP_MAX_WINDOWS);
  for (const window of shown) parts.push(windowChipText(window));
  const hidden = credential.windows.length - shown.length;
  if (hidden > 0) parts.push(`+${hidden}`);
  return parts.join(' · ');
}
