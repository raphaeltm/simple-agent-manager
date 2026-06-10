import { AlertCircle, CheckCircle2, CirclePause, Loader2, XCircle } from 'lucide-react';

export const STATUS_CONFIG: Record<
  string,
  { icon: typeof CheckCircle2; colorVar: string; label: string }
> = {
  completed: { icon: CheckCircle2, colorVar: 'var(--sam-color-success)', label: 'Completed' },
  in_progress: { icon: Loader2, colorVar: 'var(--sam-color-success)', label: 'Running' },
  failed: { icon: XCircle, colorVar: 'var(--sam-color-danger)', label: 'Failed' },
  cancelled: { icon: XCircle, colorVar: 'var(--sam-color-danger)', label: 'Cancelled' },
  queued: { icon: CirclePause, colorVar: 'var(--sam-color-warning)', label: 'Queued' },
  delegated: { icon: Loader2, colorVar: 'var(--sam-color-info)', label: 'Delegated' },
  ready: { icon: CirclePause, colorVar: 'var(--sam-color-warning)', label: 'Ready' },
  draft: { icon: CirclePause, colorVar: 'var(--sam-color-fg-muted)', label: 'Draft' },
};

const DEFAULT_CONFIG = { icon: AlertCircle, colorVar: 'var(--sam-color-fg-muted)', label: '' };

export function getStatusConfig(status: string) {
  return STATUS_CONFIG[status] ?? { ...DEFAULT_CONFIG, label: status };
}

export function getStatusColorVar(status: string) {
  return STATUS_CONFIG[status]?.colorVar ?? 'var(--sam-color-fg-muted)';
}

/** Shared style for status badge pills (used in card + children group). */
export function statusBadgeStyle(colorVar: string): React.CSSProperties {
  return {
    fontSize: 9,
    padding: '0 4px',
    background: `color-mix(in srgb, ${colorVar} 15%, transparent)`,
    color: colorVar,
  };
}

/** Shared style for icon-only buttons (close, back, expand/collapse). */
export const iconButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  minHeight: 44,
  minWidth: 44,
  borderRadius: 6,
  background: 'transparent',
  border: 'none',
  color: 'var(--sam-color-fg-muted)',
  cursor: 'pointer',
  padding: 0,
};
