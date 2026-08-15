const statusConfig: Record<string, { label: string; bg: string; fg: string }> = {
  // Workspace / node statuses
  pending: { label: 'Pending', bg: 'var(--sam-status-muted-bg)', fg: 'var(--sam-status-muted-fg)' },
  creating: { label: 'Creating', bg: 'var(--sam-status-info-bg)', fg: 'var(--sam-status-info-fg)' },
  running: { label: 'Running', bg: 'var(--sam-status-success-bg)', fg: 'var(--sam-status-success-fg)' },
  recovery: { label: 'Recovery', bg: 'var(--sam-status-warning-bg)', fg: 'var(--sam-status-warning-fg)' },
  stopping: { label: 'Stopping', bg: 'var(--sam-status-warning-bg)', fg: 'var(--sam-status-warning-fg)' },
  stopped: { label: 'Stopped', bg: 'var(--sam-status-muted-bg)', fg: 'var(--sam-status-muted-fg)' },
  deleted: { label: 'Deleted', bg: 'var(--sam-status-neutral-bg)', fg: 'var(--sam-status-neutral-fg)' },
  error: { label: 'Error', bg: 'var(--sam-status-danger-bg)', fg: 'var(--sam-status-danger-fg)' },
  healthy: { label: 'Healthy', bg: 'var(--sam-status-success-bg)', fg: 'var(--sam-status-success-fg)' },
  stale: { label: 'Stale', bg: 'var(--sam-status-warning-bg)', fg: 'var(--sam-status-warning-fg)' },
  unhealthy: { label: 'Unhealthy', bg: 'var(--sam-status-danger-bg)', fg: 'var(--sam-status-danger-fg)' },
  connected: { label: 'Connected', bg: 'var(--sam-status-success-bg)', fg: 'var(--sam-status-success-fg)' },
  disconnected: { label: 'Disconnected', bg: 'var(--sam-status-danger-bg)', fg: 'var(--sam-status-danger-fg)' },
  // Task statuses
  draft: { label: 'Draft', bg: 'var(--sam-status-muted-bg)', fg: 'var(--sam-status-muted-fg)' },
  ready: { label: 'Ready', bg: 'var(--sam-status-info-bg)', fg: 'var(--sam-status-info-fg)' },
  queued: { label: 'Queued', bg: 'var(--sam-status-indigo-bg)', fg: 'var(--sam-status-indigo-fg)' },
  delegated: { label: 'Delegated', bg: 'var(--sam-status-purple-bg)', fg: 'var(--sam-status-purple-fg)' },
  in_progress: { label: 'In Progress', bg: 'var(--sam-status-success-bg)', fg: 'var(--sam-status-success-fg)' },
  completed: { label: 'Completed', bg: 'var(--sam-status-success-strong-bg)', fg: 'var(--sam-status-success-strong-fg)' },
  failed: { label: 'Failed', bg: 'var(--sam-status-danger-bg)', fg: 'var(--sam-status-danger-fg)' },
  cancelled: { label: 'Cancelled', bg: 'var(--sam-status-muted-bg)', fg: 'var(--sam-status-muted-fg)' },
  // ACP session statuses (spec 027)
  assigned: { label: 'Assigned', bg: 'var(--sam-status-indigo-bg)', fg: 'var(--sam-status-indigo-fg)' },
  interrupted: { label: 'Interrupted', bg: 'var(--sam-status-warning-bg)', fg: 'var(--sam-status-warning-fg)' },
  // Trigger statuses. Without these, `<StatusBadge status="active"/>` rendered
  // "Unknown" — and still pulsed, because the pulse keys off the raw status
  // string rather than off a resolved config entry.
  active: { label: 'Active', bg: 'var(--sam-status-success-bg)', fg: 'var(--sam-status-success-fg)' },
  paused: { label: 'Paused', bg: 'var(--sam-status-warning-bg)', fg: 'var(--sam-status-warning-fg)' },
  disabled: { label: 'Disabled', bg: 'var(--sam-status-muted-bg)', fg: 'var(--sam-status-muted-fg)' },
};

interface StatusBadgeProps {
  status: string;
  label?: string;
  /**
   * Overrides the default pulse for this status. Trigger lists opt out: an
   * armed trigger is steady-state configuration, not live activity, and a page
   * of glowing badges reads as noise rather than signal.
   */
  pulse?: boolean;
}

const pulsingStatuses = new Set(['active', 'connected', 'healthy', 'in_progress', 'running']);

export function StatusBadge({ status, label, pulse }: StatusBadgeProps) {
  const config = statusConfig[status] ?? { label: 'Unknown', bg: 'var(--sam-status-unknown-bg)', fg: 'var(--sam-status-unknown-fg)' };
  const shouldPulse = pulse ?? pulsingStatuses.has(status);
  const pulseClass = shouldPulse ? ' sam-status-pulse' : '';

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold${pulseClass}`}
      style={{ backgroundColor: config.bg, color: config.fg }}
    >
      {label ?? config.label}
    </span>
  );
}
