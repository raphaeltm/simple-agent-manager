/**
 * Small visual primitives for the accounts prototype. PROTOTYPE ONLY.
 */
import { AlertTriangle, CircleDashed, CircleDot, Pin, Star, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';

import type { Account, AccountHealth, Provider, UsageWindow } from './mock-data';
import { roleOf } from './mock-data';

export function ProviderMark({ provider, size = 36 }: { provider: Provider; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-md font-bold tracking-tight"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.36,
        color: provider.hue,
        background: `color-mix(in srgb, ${provider.hue} 16%, transparent)`,
        border: `1px solid color-mix(in srgb, ${provider.hue} 40%, transparent)`,
      }}
    >
      {provider.glyph}
    </span>
  );
}

const ROLE_STYLES = {
  default: {
    label: 'Default',
    icon: Star,
    className:
      'bg-accent-tint text-success-fg border-[color-mix(in_srgb,var(--sam-color-accent-primary)_45%,transparent)]',
  },
  pinned: {
    label: 'Pinned',
    icon: Pin,
    className:
      'bg-info-tint text-info-fg border-[color-mix(in_srgb,var(--sam-color-info)_40%,transparent)]',
  },
  unattached: {
    label: 'Unattached',
    icon: CircleDashed,
    className: 'bg-transparent text-fg-muted border-dashed border-border-default',
  },
} as const;

export function RoleBadge({ account, compact = false }: { account: Account; compact?: boolean }) {
  const role = roleOf(account);
  const style = ROLE_STYLES[role];
  const Icon = style.icon;
  const label =
    role === 'pinned' && !compact ? `Pinned · ${account.pinnedProjectIds.length}` : style.label;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${style.className}`}
    >
      <Icon size={11} aria-hidden="true" fill={role === 'default' ? 'currentColor' : 'none'} />
      {label}
    </span>
  );
}

const HEALTH = {
  healthy: { label: 'Healthy', icon: CircleDot, className: 'text-success-fg' },
  warning: { label: 'Needs attention', icon: AlertTriangle, className: 'text-warning-fg' },
  error: { label: 'Broken', icon: XCircle, className: 'text-danger-fg' },
  unused: { label: 'Unused', icon: CircleDashed, className: 'text-fg-muted' },
} as const;

export function HealthPill({ health, detail }: { health: AccountHealth; detail?: string }) {
  const h = HEALTH[health];
  const Icon = h.icon;
  return (
    <span className={`inline-flex min-w-0 items-start gap-1 text-xs ${h.className}`}>
      <Icon size={13} aria-hidden="true" className="mt-px shrink-0" />
      <span className="min-w-0 break-words">{detail ?? h.label}</span>
    </span>
  );
}

export function UsageMeters({ usage }: { usage: UsageWindow[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {usage.map((u) => {
        const tone =
          u.pct >= 90
            ? 'var(--sam-color-danger)'
            : u.pct >= 75
              ? 'var(--sam-color-warning)'
              : 'var(--sam-color-accent-primary)';
        return (
          <div key={u.label} className="flex items-center gap-1.5 text-[11px] text-fg-muted">
            <span className="w-9 shrink-0">{u.label}</span>
            <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-inset">
              <span
                className="absolute inset-y-0 left-0 rounded-full"
                style={{ width: `${u.pct}%`, background: tone }}
              />
            </span>
            <span className="tabular-nums">{u.pct}%</span>
          </div>
        );
      })}
    </div>
  );
}

export function Chip({
  children,
  swatch,
  muted = false,
  title,
}: {
  children: ReactNode;
  swatch?: string;
  muted?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border border-border-default px-2 py-1 text-xs ${
        muted ? 'text-fg-muted' : 'text-fg-primary'
      } bg-inset`}
    >
      {swatch && (
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: swatch }}
        />
      )}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 max-w-2xl">
        {eyebrow && (
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-accent">
            {eyebrow}
          </div>
        )}
        <h2 className="m-0 text-lg font-semibold text-fg-primary">{title}</h2>
        {description && <p className="m-0 mt-1 text-sm text-fg-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'md',
}: {
  options: Array<{ id: T; label: ReactNode }>;
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex max-w-full flex-wrap gap-0.5 rounded-md border border-border-default bg-inset p-0.5"
    >
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.id)}
            className={`cursor-pointer rounded-sm border-none font-medium transition-colors ${
              size === 'sm' ? 'px-2 py-1 text-[11px]' : 'px-3 py-1.5 text-xs'
            } ${active ? 'bg-surface text-fg-primary shadow-sm' : 'bg-transparent text-fg-muted hover:text-fg-primary'}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Visual stand-in for a native select — looks like the app's form controls. */
export function FauxSelect({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  options: Array<{ id: string; label: string }>;
  onChange: (v: string) => void;
  hint?: ReactNode;
}) {
  const id = `sel-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <label htmlFor={id} className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
        {label}
      </span>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-10 w-full rounded-sm border border-border-default bg-inset px-3 text-sm text-fg-primary outline-none focus-visible:outline-2 focus-visible:outline-focus-ring"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <span className="text-[11px] text-fg-muted">{hint}</span>}
    </label>
  );
}
