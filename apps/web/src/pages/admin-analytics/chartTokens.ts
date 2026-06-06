import type { CSSProperties } from 'react';

export const chartTooltipStyle: CSSProperties = {
  background: 'var(--sam-admin-chart-tooltip-bg, rgba(8, 15, 12, 0.78))',
  border: '1px solid var(--sam-admin-chart-tooltip-border, rgba(34, 197, 94, 0.10))',
  borderRadius: 6,
  fontSize: 12,
  WebkitBackdropFilter: 'blur(var(--sam-glass-blur-surface)) saturate(calc(100% + var(--sam-glass-saturate-boost)))',
  backdropFilter: 'blur(var(--sam-glass-blur-surface)) saturate(calc(100% + var(--sam-glass-saturate-boost)))',
};

export const chartGridStroke = 'var(--sam-admin-chart-grid, var(--sam-color-border-default))';
export const chartAxisStroke = 'var(--sam-admin-chart-axis, var(--sam-color-border-default))';
export const chartCursor = { fill: 'var(--sam-admin-chart-cursor, var(--sam-color-bg-surface-hover))', opacity: 0.5 };
export const chartTick = { fontSize: 11, fill: 'var(--sam-color-fg-muted)' };
export const chartCategoryTick = { fontSize: 12, fill: 'var(--sam-color-fg-secondary)' };

// Series tokens keep the dark palette unchanged and use darker light-theme
// overrides for contrast on pale admin surfaces. See theme.css for ratios.
export const adminChartSeries = [
  'var(--sam-admin-chart-series-1, var(--sam-color-accent-primary))',
  'var(--sam-admin-chart-series-2, #60a5fa)',
  'var(--sam-admin-chart-series-3, #a78bfa)',
  'var(--sam-admin-chart-series-4, var(--sam-color-warning))',
  'var(--sam-admin-chart-series-5, #f97316)',
  'var(--sam-admin-chart-series-6, #ec4899)',
  'var(--sam-admin-chart-series-7, #14b8a6)',
  'var(--sam-admin-chart-series-8, #8b5cf6)',
  'var(--sam-admin-chart-series-9, #06b6d4)',
  'var(--sam-admin-chart-series-10, #84cc16)',
  'var(--sam-admin-chart-series-11, #f43f5e)',
  'var(--sam-admin-chart-series-12, #6366f1)',
] as const;
