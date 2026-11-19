import { type ReactNode, useState } from 'react';

interface SectionProps {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function Section({ title, summary, defaultOpen = false, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-t border-border-default">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 py-3 text-left"
        aria-expanded={open}
      >
        <svg
          className={`h-4 w-4 shrink-0 text-fg-muted transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
          viewBox="0 0 16 16"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.5 3.5a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 0 1-1.06-1.06L9.44 8 6.22 4.78a.75.75 0 0 1 0-1.06Z" />
        </svg>
        <span className="text-xs font-medium text-fg-muted uppercase tracking-wide">{title}</span>
        {!open && summary && (
          <span className="ml-auto text-xs text-fg-muted truncate max-w-[60%] text-right">
            {summary}
          </span>
        )}
      </button>
      <div className={open ? 'pb-3 grid gap-3' : 'hidden'}>{children}</div>
    </div>
  );
}

export const SELECT_CLASSES = 'w-full rounded-md text-fg-primary py-2.5 px-3 min-h-11';

interface SelectFieldProps {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  options: readonly { readonly value: string; readonly label: string }[];
  disabled?: boolean;
}

export function SelectField({ label, value, onChange, options, disabled }: SelectFieldProps) {
  return (
    <label className="grid gap-1.5">
      <span className="text-sm text-fg-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={SELECT_CLASSES}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
