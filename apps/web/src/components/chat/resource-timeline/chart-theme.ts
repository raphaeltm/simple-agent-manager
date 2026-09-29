import { useMemo } from 'react';

import { type ResolvedTheme, useTheme } from '../../../contexts/ThemeContext';
import type { ToolKind } from './types';

/**
 * Canvas cannot read CSS custom properties, so the timeline resolves the design
 * tokens to concrete colours once per theme.
 */
export interface ChartTheme {
  text: string;
  mutedText: string;
  grid: string;
  cpu: string;
  memory: string;
  memoryCache: string;
  ioRead: string;
  ioWrite: string;
  danger: string;
  reservation: string;
  cursor: string;
  sleep: string;
  tools: Record<ToolKind, string>;
}

/** Token name, then fallbacks for dark and light in case a token is missing. */
const TOKENS = {
  text: ['--sam-color-fg-primary', '#e6f2ee', '#0f2a20'],
  mutedText: ['--sam-color-fg-muted', '#9fb7ae', '#4b665c'],
  grid: ['--sam-color-border-default', '#29423b', '#cfe0d8'],
  cpu: ['--sam-color-success', '#22c55e', '#15803d'],
  memory: ['--sam-color-purple', '#c084fc', '#7c3aed'],
  ioRead: ['--sam-color-info', '#60a5fa', '#2563eb'],
  ioWrite: ['--sam-color-warning', '#f59e0b', '#b45309'],
  danger: ['--sam-color-danger', '#ef4444', '#dc2626'],
  cyan: ['--sam-admin-chart-series-9', '#06b6d4', '#0e7490'],
} as const;

type Token = (typeof TOKENS)[keyof typeof TOKENS];

function readToken([name, darkFallback, lightFallback]: Token, theme: ResolvedTheme): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || (theme === 'dark' ? darkFallback : lightFallback);
}

/** `#rrggbb` or `rgb(...)` with the given alpha; other colour syntaxes pass through. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex?.[1]) {
    const value = parseInt(hex[1], 16);
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color);
  if (rgb?.[1]) {
    const [r, g, b] = rgb[1].split(',').map((part) => part.trim());
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

function resolveChartTheme(theme: ResolvedTheme): ChartTheme {
  const muted = readToken(TOKENS.mutedText, theme);
  const text = readToken(TOKENS.text, theme);
  const memory = readToken(TOKENS.memory, theme);
  const ioRead = readToken(TOKENS.ioRead, theme);
  const ioWrite = readToken(TOKENS.ioWrite, theme);
  const cpu = readToken(TOKENS.cpu, theme);
  return {
    text,
    mutedText: muted,
    grid: withAlpha(readToken(TOKENS.grid, theme), 0.75),
    cpu,
    memory,
    memoryCache: withAlpha(memory, 0.3),
    ioRead,
    ioWrite,
    danger: readToken(TOKENS.danger, theme),
    reservation: withAlpha(muted, 0.9),
    cursor: withAlpha(text, 0.5),
    sleep: withAlpha(muted, theme === 'dark' ? 0.1 : 0.14),
    tools: {
      execute: ioWrite,
      edit: cpu,
      read: ioRead,
      search: memory,
      fetch: readToken(TOKENS.cyan, theme),
      think: withAlpha(muted, 0.7),
      other: withAlpha(muted, 0.9),
    },
  };
}

/**
 * Theme colours for canvas drawing. `ThemeProvider` applies the theme attribute in
 * the same effect that publishes `resolvedTheme`, so the tokens are current here.
 */
export function useChartTheme(): ChartTheme {
  const { resolvedTheme } = useTheme();
  return useMemo(() => resolveChartTheme(resolvedTheme), [resolvedTheme]);
}
