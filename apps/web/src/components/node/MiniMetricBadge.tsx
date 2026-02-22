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
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        padding: '1px 6px',
        borderRadius: 9999,
        backgroundColor: bg,
        fontSize: '0.6875rem',
        fontWeight: 500,
        color: fg,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ opacity: 0.7 }}>{label}</span>
      {value.toFixed(precision)}{suffix}
    </span>
  );
};
