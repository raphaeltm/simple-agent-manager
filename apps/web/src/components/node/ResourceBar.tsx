import type { FC } from 'react';

interface ResourceBarProps {
  label: string;
  percent: number;
  detail?: string;
}

function getBarColor(percent: number): string {
  if (percent >= 85) return '#f87171';
  if (percent >= 60) return '#fbbf24';
  return '#4ade80';
}

export const ResourceBar: FC<ResourceBarProps> = ({ label, percent, detail }) => {
  const clampedPercent = Math.min(100, Math.max(0, percent));
  const color = getBarColor(clampedPercent);

  return (
    <div style={{ flex: 1, minWidth: 160 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 'var(--sam-space-1)',
        }}
      >
        <span style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)' }}>{label}</span>
        <span style={{ fontSize: 'var(--sam-type-caption-size)', fontWeight: 600, color: 'var(--sam-color-fg-primary)' }}>
          {clampedPercent.toFixed(1)}%
        </span>
      </div>
      <div
        role="meter"
        aria-valuenow={clampedPercent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label}: ${clampedPercent.toFixed(1)}%`}
        style={{
          height: 8,
          borderRadius: 4,
          backgroundColor: 'var(--sam-color-bg-inset)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${clampedPercent}%`,
            backgroundColor: color,
            borderRadius: 4,
            transition: 'width 0.3s ease',
          }}
        />
      </div>
      {detail && (
        <div style={{ fontSize: '0.6875rem', color: 'var(--sam-color-fg-muted)', marginTop: 2 }}>
          {detail}
        </div>
      )}
    </div>
  );
};
