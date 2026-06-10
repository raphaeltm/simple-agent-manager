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
