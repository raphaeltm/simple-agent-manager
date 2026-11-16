/** Formatting and labels for Admin Health & cost. Pure functions, unit tested. */
import type { InstallationHealthWindow } from '@simple-agent-manager/shared';
import { PROVIDER_LABELS } from '@simple-agent-manager/shared';

const PROVIDER_NAMES: Record<string, string> = PROVIDER_LABELS;

export function providerLabel(provider: string): string {
  return (
    PROVIDER_NAMES[provider] ??
    (provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'Unknown')
  );
}

export function formatUsd(usd: number): string {
  if (usd >= 1000) return `$${Math.round(usd).toLocaleString('en-US')}`;
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  return `$${usd.toFixed(2)}`;
}

/** "38s", "4m 40s", "2h 05m". */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function formatPercent(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

const STATE_LABELS: Record<string, string> = {
  'workspace.pending': 'Workspace waiting to start',
  'workspace.creating': 'Create a workspace',
  'workspace.recovery': 'Recover a workspace',
  'workspace.stopping': 'Stop a workspace',
  'node.pending': 'Machine waiting to start',
  'node.creating': 'Start a machine',
  'node.recovery': 'Recover a machine',
  'node.stopping': 'Stop a machine',
  'session_sleep.preparing': 'Prepare a chat for sleep',
  'session_sleep.stopping': 'Put a chat to sleep',
  'session_recovery.waking': 'Wake a sleeping chat',
};

export function lifecycleStateLabel(entityType: string, status: string): string {
  return STATE_LABELS[`${entityType}.${status}`] ?? `${entityType.replace(/_/g, ' ')} ${status}`;
}

/** "Last 7 days", "Last 30 days", "November so far". */
export function rangeLabel(window: Pick<InstallationHealthWindow, 'range' | 'start'>): string {
  if (window.range === '7d') return 'Last 7 days';
  if (window.range === '30d') return 'Last 30 days';
  const month = new Date(window.start).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return `${month} so far`;
}

/** "Nov 9" for a week starting on that Monday (UTC). */
export function weekLabel(weekStart: string): string {
  return new Date(weekStart).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
