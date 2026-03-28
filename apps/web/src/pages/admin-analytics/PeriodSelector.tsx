import { type FC } from 'react';

const PERIODS = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
];

export const PeriodSelector: FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => (
  <div className="flex gap-1" role="group" aria-label="Time period">
    {PERIODS.map((p) => (
      <button
        key={p.value}
        onClick={() => onChange(p.value)}
        aria-pressed={value === p.value}
        className={`px-3 py-2 text-xs rounded-sm border transition-colors min-h-[36px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1 focus-visible:ring-offset-bg-canvas ${
          value === p.value
            ? 'bg-accent-emphasis text-white border-accent-emphasis'
            : 'border-border-default text-fg-secondary hover:bg-surface-secondary'
        }`}
      >
        {p.label}
      </button>
    ))}
  </div>
);
