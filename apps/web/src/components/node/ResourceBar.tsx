import type { FC } from 'react';

interface ResourceBarProps {
  label: string;
  percent: number;
  detail?: string;
}

function getBarColor(percent: number): string {
  if (percent >= 85) return 'var(--sam-color-danger-fg)';
  if (percent >= 60) return 'var(--sam-color-warning-fg)';
  return 'var(--sam-color-success-fg)';
}

export const ResourceBar: FC<ResourceBarProps> = ({ label, percent, detail }) => {
  const clampedPercent = Math.min(100, Math.max(0, percent));
  const color = getBarColor(clampedPercent);

  return (
    <div className="flex-1 min-w-40">
      <div className="flex justify-between items-baseline mb-1">
        <span className="text-fg-muted" style={{ fontSize: 'var(--sam-type-caption-size)' }}>{label}</span>
        <span className="text-fg-primary font-semibold" style={{ fontSize: 'var(--sam-type-caption-size)' }}>
          {clampedPercent.toFixed(1)}%
        </span>
      </div>
      <div
        role="meter"
        aria-valuenow={clampedPercent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label}: ${clampedPercent.toFixed(1)}%`}
        className="h-2 rounded-full bg-inset overflow-hidden"
      >
        <div
          className="h-full rounded-full transition-[width] duration-300 ease-in-out"
          style={{
            width: `${clampedPercent}%`,
            backgroundColor: color,
          }}
        />
      </div>
      {detail && (
        <div className="text-fg-muted mt-0.5" style={{ fontSize: '0.6875rem' }}>
          {detail}
        </div>
      )}
    </div>
  );
};
