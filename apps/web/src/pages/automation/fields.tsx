/**
 * Form fields shared by the Automation editor and the detail pages' small forms. Text inputs,
 * selects and textareas get the app's form styling from `index.css`; number, time and
 * date-time inputs are not covered there, so they use {@link INPUT_CLASS}.
 */
import { type ReactNode, useId, useMemo } from 'react';

import { useRadioKeys } from './radio-keys';
import { viewerZone, zoneOptions } from './time';

export const INPUT_CLASS =
  'block w-full min-w-0 min-h-11 rounded-[var(--sam-radius-sm)] border border-solid border-[var(--sam-form-border)] bg-[var(--sam-form-bg)] px-3 py-2 text-sm text-fg-primary';

export function Field({
  label,
  hint,
  error,
  children,
  optional,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  children: (props: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold text-fg-primary">
        {label}
        {optional && <span className="font-normal text-fg-muted"> (optional)</span>}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint && (
        <p id={hintId} className="m-0 text-[13px] text-fg-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="m-0 text-[13px] font-medium text-danger-fg">
          {error}
        </p>
      )}
    </div>
  );
}

/** Every time zone the browser knows, the viewer's first, plus a stored zone it may not know. */
export function ZoneSelect({
  id,
  value,
  onChange,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (zone: string) => void;
  describedBy?: string;
}) {
  const zones = useMemo(() => {
    const all = zoneOptions();
    return all.includes(value) ? all : [value, ...all];
  }, [value]);
  const local = viewerZone();
  return (
    <select
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-describedby={describedBy}
    >
      {zones.map((zone) => (
        <option key={zone} value={zone}>
          {zone === local ? `${zone} (your time zone)` : zone}
        </option>
      ))}
    </select>
  );
}

/** A choice between a few options, drawn as large cards (radio semantics). */
export function ChoiceCards<T extends string>({
  label,
  value,
  onChange,
  options,
  columns = 2,
}: {
  label: string;
  value: T | null;
  onChange: (value: T) => void;
  options: Array<{ id: T; title: string; text?: string; icon?: ReactNode; disabled?: boolean }>;
  columns?: 1 | 2 | 3;
}) {
  const grid = columns === 3 ? 'sm:grid-cols-3' : columns === 2 ? 'sm:grid-cols-2' : '';
  const keys = useRadioKeys(options, value, onChange);
  return (
    <div role="radiogroup" aria-label={label} className={`grid grid-cols-1 gap-3 ${grid}`}>
      {options.map((option, index) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            {...keys(index)}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={option.disabled}
            onClick={() => onChange(option.id)}
            className={`flex min-h-16 w-full min-w-0 cursor-pointer items-start gap-3 rounded-xl border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
              selected
                ? 'border-accent bg-[var(--sam-color-accent-primary-tint)]'
                : 'glass-surface border-border-default hover:bg-surface-hover'
            }`}
          >
            {option.icon}
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[15px] font-semibold text-fg-primary">{option.title}</span>
              {option.text && <span className="text-[13px] text-fg-muted">{option.text}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A labelled checkbox with a 44 px row. */
export function CheckRow({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3 py-2">
      <input
        type="checkbox"
        className="mt-0.5 h-5 w-5 shrink-0"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm text-fg-primary">{label}</span>
        {hint && <span className="text-[13px] text-fg-muted">{hint}</span>}
      </span>
    </label>
  );
}
