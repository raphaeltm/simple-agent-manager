/**
 * Centralized UI tokens for the terminal tab components.
 *
 * Keeps colors, dimensions, and status indicators in one auditable location
 * instead of scattering them as inline literals across TabItem, TabBar,
 * TabOverflowMenu, and MultiTerminal.
 */

import type React from 'react';

// ── Color palette (Tokyo Night–inspired) ──

export const colors = {
  /** Primary background (terminal pane, active tab) */
  bg: '#1a1b26',
  /** Tab-bar / chrome background */
  bgChrome: '#16171e',
  /** Elevated surface (hover, menus, inputs) */
  bgSurface: '#1e2030',
  /** Selection / highlight background */
  bgHighlight: '#33467c',

  /** Primary foreground text */
  fg: '#a9b1d6',
  /** Muted / secondary text */
  fgMuted: '#787c99',
  /** Dimmed text (paths, metadata) */
  fgDim: '#444b6a',

  /** Accent / active indicator */
  accent: '#7aa2f7',
  /** Cursor / selection foreground */
  cursor: '#c0caf5',
  /** Error / destructive */
  error: '#f7768e',

  /** Border between chrome elements */
  border: '#2a2d3a',
  /** Shadow for elevated surfaces */
  shadow: 'rgba(0, 0, 0, 0.4)',
} as const;

// ── Status indicator colors ──

export const statusColors: Record<string, string> = {
  connected: '#9ece6a',
  connecting: '#e0af68',
  reconnecting: '#e0af68',
  disconnected: colors.fgMuted,
  error: colors.error,
};

/** Look up status dot color, defaulting to muted. */
export function getStatusColor(status: string): string {
  return statusColors[status] ?? colors.fgMuted;
}

// ── Dimensions ──

export const dimensions = {
  /** Tab bar height in px */
  tabBarHeight: 38,
  /** Scroll button width in px */
  scrollBtnWidth: 24,
  /** New-tab button width in px */
  newTabBtnWidth: 36,
  /** Overflow button width in px */
  overflowBtnWidth: 32,
  /** Tab min/max widths */
  tabMinWidth: 100,
  tabMaxWidth: 180,
  /** Close button size */
  closeBtnSize: 20,
  /** Overflow menu min-width / max-height */
  menuMinWidth: 220,
  menuMaxHeight: 320,
} as const;

// ── xterm.js theme ──

export const xtermTheme = {
  background: colors.bg,
  foreground: colors.fg,
  cursor: colors.cursor,
  selectionBackground: colors.bgHighlight,
  black: '#32344a',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#ad8ee6',
  cyan: '#449dab',
  white: '#787c99',
  brightBlack: '#444b6a',
  brightRed: '#ff7a93',
  brightGreen: '#b9f27c',
  brightYellow: '#ff9e64',
  brightBlue: '#7da6ff',
  brightMagenta: '#bb9af7',
  brightCyan: '#0db9d7',
  brightWhite: '#acb0d0',
} as const;

// ── Shared typography ──

export const fonts = {
  terminal: 'JetBrains Mono, Menlo, Monaco, monospace',
  ui: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
} as const;

// ── Shared hover handlers ──

/** Standard hover-in: elevate to surface bg + primary fg. */
export function applyHoverIn(el: HTMLElement): void {
  el.style.backgroundColor = colors.bgSurface;
  el.style.color = colors.fg;
}

/** Standard hover-out: transparent bg + muted fg. */
export function applyHoverOut(el: HTMLElement): void {
  el.style.backgroundColor = 'transparent';
  el.style.color = colors.fgMuted;
}

// ── Shared style fragments ──

/** Reusable style for chrome buttons (scroll, new-tab, overflow). */
export const chromeButtonBase: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'none',
  border: 'none',
  color: colors.fgMuted,
  cursor: 'pointer',
  flexShrink: 0,
  padding: 0,
};

/** Reusable style for text that overflows with ellipsis. */
export const ellipsisText: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
