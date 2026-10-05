import type {
  CredentialLimitCredentialSummary,
  CredentialLimitLevel,
  CredentialLimitWindowSummary,
} from '@simple-agent-manager/shared';
import {
  credentialLimitFamilyLabel,
  credentialLimitWindowLabel,
} from '@simple-agent-manager/shared';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How many windows the compact chip spells out before collapsing to "+N". */
export const CHIP_MAX_WINDOWS = 3;

export const LEVEL_STYLES: Record<CredentialLimitLevel, { background: string; color: string }> = {
  ok: {
    background: 'var(--sam-color-success-tint, rgba(34, 197, 94, 0.12))',
    color: 'var(--sam-color-success, #22c55e)',
  },
  warning: {
    background: 'var(--sam-color-warning-tint, rgba(245, 158, 11, 0.12))',
    color: 'var(--sam-color-warning, #f59e0b)',
  },
  critical: {
    background: 'var(--sam-color-danger-tint, rgba(239, 68, 68, 0.12))',
    color: 'var(--sam-color-danger, #ef4444)',
  },
  rejected: {
    background: 'var(--sam-color-danger-tint, rgba(239, 68, 68, 0.12))',
    color: 'var(--sam-color-danger, #ef4444)',
  },
};

export const LEVEL_LABELS: Record<CredentialLimitLevel, string> = {
  ok: 'OK',
  warning: 'Warning',
  critical: 'Critical',
  rejected: 'Limit reached',
};

export function formatUtilizationPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${Math.round(value)}%`;
}

function formatSpan(ms: number): string {
  if (ms >= DAY_MS) {
    const days = Math.floor(ms / DAY_MS);
    const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (ms >= HOUR_MS) {
    const hours = Math.floor(ms / HOUR_MS);
    const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${Math.max(1, Math.ceil(ms / MINUTE_MS))}m`;
}

/** "resets in 2h 10m", "reset due" once the time has passed, null when unknown. */
export function formatResetCountdown(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return null;
  const remaining = resetsAt - now;
  if (remaining <= 0) return 'reset due';
  return `resets in ${formatSpan(remaining)}`;
}

/** "sampled 3m ago" — how old the newest provider sample is. */
export function formatSampledAgo(observedAt: number, now: number): string {
  const age = now - observedAt;
  if (age < MINUTE_MS) return 'sampled just now';
  return `sampled ${formatSpan(age)} ago`;
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
