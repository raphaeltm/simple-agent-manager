import type { CSSProperties } from 'react';

const statusConfig: Record<string, { label: string; bg: string; fg: string }> = {
  // Workspace / node statuses
  pending: { label: 'Pending', bg: 'rgba(159, 183, 174, 0.15)', fg: '#9fb7ae' },
  creating: { label: 'Creating', bg: 'rgba(59, 130, 246, 0.15)', fg: '#60a5fa' },
  running: { label: 'Running', bg: 'rgba(34, 197, 94, 0.15)', fg: '#4ade80' },
  recovery: { label: 'Recovery', bg: 'rgba(245, 158, 11, 0.15)', fg: '#fbbf24' },
  stopping: { label: 'Stopping', bg: 'rgba(245, 158, 11, 0.15)', fg: '#fbbf24' },
  stopped: { label: 'Stopped', bg: 'rgba(159, 183, 174, 0.15)', fg: '#9fb7ae' },
  error: { label: 'Error', bg: 'rgba(239, 68, 68, 0.15)', fg: '#f87171' },
  healthy: { label: 'Healthy', bg: 'rgba(34, 197, 94, 0.15)', fg: '#4ade80' },
  stale: { label: 'Stale', bg: 'rgba(245, 158, 11, 0.15)', fg: '#fbbf24' },
  unhealthy: { label: 'Unhealthy', bg: 'rgba(239, 68, 68, 0.15)', fg: '#f87171' },
  connected: { label: 'Connected', bg: 'rgba(34, 197, 94, 0.15)', fg: '#4ade80' },
  disconnected: { label: 'Disconnected', bg: 'rgba(239, 68, 68, 0.15)', fg: '#f87171' },
  // Task statuses
  draft: { label: 'Draft', bg: 'rgba(159, 183, 174, 0.15)', fg: '#9fb7ae' },
  ready: { label: 'Ready', bg: 'rgba(59, 130, 246, 0.15)', fg: '#60a5fa' },
  queued: { label: 'Queued', bg: 'rgba(99, 102, 241, 0.15)', fg: '#a5b4fc' },
  delegated: { label: 'Delegated', bg: 'rgba(139, 92, 246, 0.15)', fg: '#c4b5fd' },
  in_progress: { label: 'In Progress', bg: 'rgba(34, 197, 94, 0.15)', fg: '#4ade80' },
  completed: { label: 'Completed', bg: 'rgba(34, 197, 94, 0.2)', fg: '#22c55e' },
  failed: { label: 'Failed', bg: 'rgba(239, 68, 68, 0.15)', fg: '#f87171' },
  cancelled: { label: 'Cancelled', bg: 'rgba(159, 183, 174, 0.15)', fg: '#9fb7ae' },
};

interface StatusBadgeProps {
  status: string;
  label?: string;
}

export function StatusBadge({ status, label }: StatusBadgeProps) {
  const config = statusConfig[status] ?? { label: 'Unknown', bg: '#e5e7eb', fg: '#1f2937' };
  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '2px 10px',
    borderRadius: '9999px',
    fontSize: '0.75rem',
    fontWeight: 600,
    backgroundColor: config.bg,
    color: config.fg,
  };

  return <span style={style}>{label ?? config.label}</span>;
}
