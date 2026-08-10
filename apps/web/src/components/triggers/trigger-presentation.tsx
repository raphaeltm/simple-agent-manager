/**
 * Shared presentation helpers for the trigger surfaces.
 *
 * These were previously copy-pasted across `TriggerCard`, `ProjectTriggerDetail`,
 * `ExecutionHistory` and `TriggerConfiguration` — and had drifted, so the same
 * trigger described itself differently on three screens (e.g. the card appended
 * `· token ••••1234` to a webhook label while the detail header did not, and
 * "next run" rendered as "overdue" on one screen and "5m ago" on another).
 */
import type { TriggerResponse } from '@simple-agent-manager/shared';
import { Clock, Github, Webhook } from 'lucide-react';
import type { ReactNode } from 'react';

/** Shared focus ring. Also exported from `trigger-form-support` for form fields. */
export const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

/**
 * Trigger status → the key understood by the shared `StatusBadge`. Keeping this
 * a lookup (rather than passing `trigger.status` straight through) means an
 * unrecognised status degrades to a visible "Disabled" rather than "Unknown".
 */
export function statusBadgeKey(status: string): 'active' | 'paused' | 'disabled' {
  if (status === 'active' || status === 'paused') return status;
  return 'disabled';
}

/** Source-type icon, consistent across card, detail header and dropdown. */
export function sourceIcon(trigger: TriggerResponse, size = 14): ReactNode {
  if (trigger.sourceType === 'github') return <Github size={size} aria-hidden="true" />;
  if (trigger.sourceType === 'webhook') return <Webhook size={size} aria-hidden="true" />;
  return <Clock size={size} aria-hidden="true" />;
}

/**
 * Short human label for what makes this trigger fire — a schedule, a GitHub
 * event, or a webhook source.
 */
export function formatTriggerSource(trigger: TriggerResponse): string {
  if (trigger.sourceType === 'github') {
    const eventLabel = trigger.githubConfig?.eventType?.replace(/_/g, ' ') ?? 'event';
    const commandPrefix = trigger.githubConfig?.filters.commandPrefix;
    return commandPrefix ? `GitHub ${eventLabel}: ${commandPrefix}` : `GitHub ${eventLabel}`;
  }
  if (trigger.sourceType === 'webhook') {
    // A blank sourceLabel stays blank by project policy — do not substitute the
    // trigger name or a "Generic webhook" fallback.
    const label = trigger.webhookConfig?.sourceLabel ?? '';
    const suffix = trigger.webhookConfig?.tokenLastFour;
    if (label && suffix) return `${label} · token ••••${suffix}`;
    if (label) return label;
    return suffix ? `Webhook · token ••••${suffix}` : 'Webhook';
  }
  return trigger.cronHumanReadable ?? trigger.cronExpression ?? 'No schedule';
}

/** Relative time until a future fire, e.g. "in 4h". Past times read "overdue". */
export function formatNextRun(dateStr: string): string {
  const diffMs = new Date(dateStr).getTime() - Date.now();
  if (Number.isNaN(diffMs)) return 'unknown';
  if (diffMs < 0) return 'overdue';

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'in <1m';
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

/** Wall-clock duration between two ISO timestamps, e.g. "1m 5s". */
export function formatDuration(startedAt?: string | null, completedAt?: string | null): string {
  if (!startedAt || !completedAt) return '—';
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (Number.isNaN(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Absolute timestamp for detail views, in the viewer's locale. */
export function formatDateFull(dateStr?: string | null): string {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
