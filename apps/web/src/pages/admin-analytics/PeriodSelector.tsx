import { type FC } from 'react';

const PERIODS = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];

export const PeriodSelector: FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => (
  <div className="flex gap-1">
    {PERIODS.map((p) => (
      <button
        key={p.value}
        onClick={() => onChange(p.value)}
        className={`px-3 py-1 text-xs rounded-sm border transition-colors ${
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
