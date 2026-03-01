import type { FC } from 'react';

interface MiniMetricBadgeProps {
  label: string;
  value: number;
  suffix?: string;
  /** Decimal places for display (default: 0) */
  precision?: number;
  /** Threshold for yellow/warning color (default: 60) */
  warnAt?: number;
  /** Threshold for red/critical color (default: 85) */
  critAt?: number;
}

function getBadgeColor(value: number, warnAt: number, critAt: number): { bg: string; fg: string } {
  if (value >= critAt) return { bg: 'var(--sam-color-danger-tint)', fg: 'var(--sam-color-danger-fg)' };
  if (value >= warnAt) return { bg: 'var(--sam-color-warning-tint)', fg: 'var(--sam-color-warning-fg)' };
  return { bg: 'var(--sam-color-success-tint)', fg: 'var(--sam-color-success-fg)' };
}

export const MiniMetricBadge: FC<MiniMetricBadgeProps> = ({
  label,
  value,
  suffix = '%',
  precision = 0,
  warnAt = 60,
  critAt = 85,
}) => {
  const { bg, fg } = getBadgeColor(value, warnAt, critAt);

  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-full whitespace-nowrap"
      style={{
        padding: '1px 6px',
        backgroundColor: bg,
        fontSize: '0.6875rem',
        fontWeight: 500,
        color: fg,
      }}
    >
      <span className="opacity-70">{label}</span>
      {value.toFixed(precision)}{suffix}
    </span>
  );
};
