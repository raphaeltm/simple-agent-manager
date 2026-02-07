import type { CSSProperties } from 'react';

const statusConfig: Record<string, { label: string; bg: string; fg: string }> = {
  pending: { label: 'Pending', bg: '#e5e7eb', fg: '#1f2937' },
  creating: { label: 'Creating', bg: '#dbeafe', fg: '#1e3a8a' },
  running: { label: 'Running', bg: '#dcfce7', fg: '#166534' },
  stopping: { label: 'Stopping', bg: '#fef3c7', fg: '#854d0e' },
  stopped: { label: 'Stopped', bg: '#e5e7eb', fg: '#1f2937' },
  error: { label: 'Error', bg: '#fee2e2', fg: '#991b1b' },
  connected: { label: 'Connected', bg: '#dcfce7', fg: '#166534' },
  disconnected: { label: 'Disconnected', bg: '#fee2e2', fg: '#991b1b' },
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
