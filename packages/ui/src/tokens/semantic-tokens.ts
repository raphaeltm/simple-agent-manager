export type SemanticTokenMode = 'default' | 'high-contrast' | 'reduced-motion';

export interface TypographyTier {
  size: string;
  weight: number;
  lineHeight: number;
}

export interface SemanticTokenSet {
  backgroundCanvas: string;
  backgroundSurface: string;
  backgroundSurfaceHover: string;
  backgroundOverlay: string;
  backgroundInset: string;
  foregroundPrimary: string;
  foregroundMuted: string;
  borderDefault: string;
  accentPrimary: string;
  accentPrimaryHover: string;
  success: string;
  warning: string;
  danger: string;
  focusRing: string;
  accentPrimaryTint: string;
  successTint: string;
  warningTint: string;
  dangerTint: string;
  infoTint: string;
  shadowDropdown: string;
  shadowOverlay: string;
  shadowTooltip: string;
  // Tokyo Night palette (workspace/terminal)
  tnBg: string;
  tnBgDark: string;
  tnSurface: string;
  tnSelected: string;
  tnActive: string;
  tnFg: string;
  tnFgBright: string;
  tnFgMuted: string;
  tnFgDim: string;
  tnFgDimmer: string;
  tnGreen: string;
  tnYellow: string;
  tnRed: string;
  tnPurple: string;
  tnBlue: string;
  tnOrange: string;
  tnBorder: string;
  tnBorderHighlight: string;
  // Additional semantic
  info: string;
  fgOnAccent: string;
  successFg: string;
  dangerFg: string;
  warningFg: string;
  infoFg: string;
  purple: string;
  warningSurface: string;
}

export const typographyScale: Record<string, TypographyTier> = {
  pageTitle: { size: '1.5rem', weight: 700, lineHeight: 1.2 },
  sectionHeading: { size: '1.125rem', weight: 600, lineHeight: 1.3 },
  cardTitle: { size: '1rem', weight: 600, lineHeight: 1.4 },
  body: { size: '0.9375rem', weight: 400, lineHeight: 1.5 },
  secondary: { size: '0.875rem', weight: 400, lineHeight: 1.5 },
  caption: { size: '0.75rem', weight: 400, lineHeight: 1.4 },
};

export const zIndexScale = {
  sticky: 10,
  dropdown: 20,
  drawerBackdrop: 40,
  drawer: 41,
  dialogBackdrop: 50,
  dialog: 51,
  panel: 60,
  commandPalette: 61,
} as const;

export const samSemanticTokens: Record<SemanticTokenMode, SemanticTokenSet> = {
  default: {
    backgroundCanvas: '#0b1110',
    backgroundSurface: '#13201d',
    backgroundSurfaceHover: '#1a2e29',
    backgroundOverlay: 'rgba(0, 0, 0, 0.6)',
    backgroundInset: '#0e1a17',
    foregroundPrimary: '#e6f2ee',
    foregroundMuted: '#9fb7ae',
    borderDefault: '#29423b',
    accentPrimary: '#16a34a',
    accentPrimaryHover: '#15803d',
    success: '#22c55e',
    warning: '#f59e0b',
    danger: '#ef4444',
    focusRing: '#34d399',
    accentPrimaryTint: 'rgba(22, 163, 74, 0.1)',
    successTint: 'rgba(34, 197, 94, 0.1)',
    warningTint: 'rgba(245, 158, 11, 0.1)',
    dangerTint: 'rgba(239, 68, 68, 0.1)',
    infoTint: 'rgba(122, 162, 247, 0.1)',
    shadowDropdown: '0 4px 16px rgba(0, 0, 0, 0.3)',
    shadowOverlay: '0 8px 32px rgba(0, 0, 0, 0.4)',
    shadowTooltip: '0 2px 8px rgba(0, 0, 0, 0.3)',
    tnBg: '#1a1b26',
    tnBgDark: '#16171e',
    tnSurface: '#1e2030',
    tnSelected: '#292e42',
    tnActive: '#33467c',
    tnFg: '#a9b1d6',
    tnFgBright: '#c0caf5',
    tnFgMuted: '#787c99',
    tnFgDim: '#565f89',
    tnFgDimmer: '#545868',
    tnGreen: '#9ece6a',
    tnYellow: '#e0af68',
    tnRed: '#f7768e',
    tnPurple: '#bb9af7',
    tnBlue: '#7aa2f7',
    tnOrange: '#ff9e64',
    tnBorder: '#2a2d3a',
    tnBorderHighlight: '#3b4261',
    info: '#60a5fa',
    fgOnAccent: '#ffffff',
    successFg: '#4ade80',
    dangerFg: '#f87171',
    warningFg: '#fbbf24',
    infoFg: '#93c5fd',
    purple: '#c084fc',
    warningSurface: '#2e2a1f',
  },
  'high-contrast': {
    backgroundCanvas: '#050807',
    backgroundSurface: '#0f1614',
    backgroundSurfaceHover: '#162320',
    backgroundOverlay: 'rgba(0, 0, 0, 0.75)',
    backgroundInset: '#0a1210',
    foregroundPrimary: '#f5fffb',
    foregroundMuted: '#c8dbd4',
    borderDefault: '#37534a',
    accentPrimary: '#22c55e',
    accentPrimaryHover: '#16a34a',
    success: '#4ade80',
    warning: '#fbbf24',
    danger: '#f87171',
    focusRing: '#6ee7b7',
    accentPrimaryTint: 'rgba(34, 197, 94, 0.15)',
    successTint: 'rgba(74, 222, 128, 0.15)',
    warningTint: 'rgba(251, 191, 36, 0.15)',
    dangerTint: 'rgba(248, 113, 113, 0.15)',
    infoTint: 'rgba(122, 162, 247, 0.15)',
    shadowDropdown: '0 4px 16px rgba(0, 0, 0, 0.5)',
    shadowOverlay: '0 8px 32px rgba(0, 0, 0, 0.6)',
    shadowTooltip: '0 2px 8px rgba(0, 0, 0, 0.5)',
    tnBg: '#1a1b26',
    tnBgDark: '#16171e',
    tnSurface: '#1e2030',
    tnSelected: '#292e42',
    tnActive: '#33467c',
    tnFg: '#a9b1d6',
    tnFgBright: '#c0caf5',
    tnFgMuted: '#787c99',
    tnFgDim: '#565f89',
    tnFgDimmer: '#545868',
    tnGreen: '#9ece6a',
    tnYellow: '#e0af68',
    tnRed: '#f7768e',
    tnPurple: '#bb9af7',
    tnBlue: '#7aa2f7',
    tnOrange: '#ff9e64',
    tnBorder: '#2a2d3a',
    tnBorderHighlight: '#3b4261',
    info: '#60a5fa',
    fgOnAccent: '#ffffff',
    successFg: '#4ade80',
    dangerFg: '#f87171',
    warningFg: '#fbbf24',
    infoFg: '#93c5fd',
    purple: '#c084fc',
    warningSurface: '#2e2a1f',
  },
  'reduced-motion': {
    backgroundCanvas: '#0b1110',
    backgroundSurface: '#13201d',
    backgroundSurfaceHover: '#1a2e29',
    backgroundOverlay: 'rgba(0, 0, 0, 0.6)',
    backgroundInset: '#0e1a17',
    foregroundPrimary: '#e6f2ee',
    foregroundMuted: '#9fb7ae',
    borderDefault: '#29423b',
    accentPrimary: '#16a34a',
    accentPrimaryHover: '#15803d',
    success: '#22c55e',
    warning: '#f59e0b',
    danger: '#ef4444',
    focusRing: '#34d399',
    accentPrimaryTint: 'rgba(22, 163, 74, 0.1)',
    successTint: 'rgba(34, 197, 94, 0.1)',
    warningTint: 'rgba(245, 158, 11, 0.1)',
    dangerTint: 'rgba(239, 68, 68, 0.1)',
    infoTint: 'rgba(122, 162, 247, 0.1)',
    shadowDropdown: '0 4px 16px rgba(0, 0, 0, 0.3)',
    shadowOverlay: '0 8px 32px rgba(0, 0, 0, 0.4)',
    shadowTooltip: '0 2px 8px rgba(0, 0, 0, 0.3)',
    tnBg: '#1a1b26',
    tnBgDark: '#16171e',
    tnSurface: '#1e2030',
    tnSelected: '#292e42',
    tnActive: '#33467c',
    tnFg: '#a9b1d6',
    tnFgBright: '#c0caf5',
    tnFgMuted: '#787c99',
    tnFgDim: '#565f89',
    tnFgDimmer: '#545868',
    tnGreen: '#9ece6a',
    tnYellow: '#e0af68',
    tnRed: '#f7768e',
    tnPurple: '#bb9af7',
    tnBlue: '#7aa2f7',
    tnOrange: '#ff9e64',
    tnBorder: '#2a2d3a',
    tnBorderHighlight: '#3b4261',
    info: '#60a5fa',
    fgOnAccent: '#ffffff',
    successFg: '#4ade80',
    dangerFg: '#f87171',
    warningFg: '#fbbf24',
    infoFg: '#93c5fd',
    purple: '#c084fc',
    warningSurface: '#2e2a1f',
  },
};

export const defaultSamTokens = samSemanticTokens.default;
