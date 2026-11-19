/** The status tones a chat notice can carry. Progress is green, like work running now. */
export type NoticeTone = 'progress' | 'success' | 'info' | 'warning' | 'danger';

export interface NoticeToneTokens {
  /** Lit edge: the slab's lower edge, the badge ring and the capsule outline. */
  edge: string;
  /** Icon and dot colour. */
  fg: string;
  /** Soft glow cast from the icon side. */
  glow: string;
}

export const NOTICE_TONES: Record<NoticeTone, NoticeToneTokens> = {
  progress: {
    edge: 'var(--sam-success-edge)',
    fg: 'var(--sam-status-success-fg)',
    glow: 'var(--sam-notice-glow-success)',
  },
  success: {
    edge: 'var(--sam-success-edge)',
    fg: 'var(--sam-status-success-fg)',
    glow: 'var(--sam-notice-glow-success)',
  },
  info: {
    edge: 'var(--sam-info-edge)',
    fg: 'var(--sam-status-info-fg)',
    glow: 'var(--sam-notice-glow-info)',
  },
  warning: {
    edge: 'var(--sam-warning-edge)',
    fg: 'var(--sam-status-warning-fg)',
    glow: 'var(--sam-notice-glow-warning)',
  },
  danger: {
    edge: 'var(--sam-danger-edge)',
    fg: 'var(--sam-status-danger-fg)',
    glow: 'var(--sam-notice-glow-danger)',
  },
};
