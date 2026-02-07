export type SemanticTokenMode = 'default' | 'high-contrast' | 'reduced-motion';

export interface SemanticTokenSet {
  backgroundCanvas: string;
  backgroundSurface: string;
  foregroundPrimary: string;
  foregroundMuted: string;
  borderDefault: string;
  accentPrimary: string;
  accentPrimaryHover: string;
  success: string;
  warning: string;
  danger: string;
  focusRing: string;
}

export const samSemanticTokens: Record<SemanticTokenMode, SemanticTokenSet> = {
  default: {
    backgroundCanvas: '#0b1110',
    backgroundSurface: '#13201d',
    foregroundPrimary: '#e6f2ee',
    foregroundMuted: '#9fb7ae',
    borderDefault: '#29423b',
    accentPrimary: '#16a34a',
    accentPrimaryHover: '#15803d',
    success: '#22c55e',
    warning: '#f59e0b',
    danger: '#ef4444',
    focusRing: '#34d399',
  },
  'high-contrast': {
    backgroundCanvas: '#050807',
    backgroundSurface: '#0f1614',
    foregroundPrimary: '#f5fffb',
    foregroundMuted: '#c8dbd4',
    borderDefault: '#37534a',
    accentPrimary: '#22c55e',
    accentPrimaryHover: '#16a34a',
    success: '#4ade80',
    warning: '#fbbf24',
    danger: '#f87171',
    focusRing: '#6ee7b7',
  },
  'reduced-motion': {
    backgroundCanvas: '#0b1110',
    backgroundSurface: '#13201d',
    foregroundPrimary: '#e6f2ee',
    foregroundMuted: '#9fb7ae',
    borderDefault: '#29423b',
    accentPrimary: '#16a34a',
    accentPrimaryHover: '#15803d',
    success: '#22c55e',
    warning: '#f59e0b',
    danger: '#ef4444',
    focusRing: '#34d399',
  },
};

export const defaultSamTokens = samSemanticTokens.default;
