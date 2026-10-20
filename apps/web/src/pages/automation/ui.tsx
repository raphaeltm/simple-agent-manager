/**
 * Building blocks for the Automation page.
 *
 * Layout rule: vertical rhythm comes from `flex flex-col gap-*`, never `space-y-*` (Tailwind
 * v4's space utilities lose to `m-0` on children, which collapsed the old Events cards to zero
 * gaps). Every control is at least 44 px tall. Status pills appear only for states worth
 * noticing; a running automation stays quiet.
 */
import {
  AlarmClock,
  Ban,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Github,
  LoaderCircle,
  Radio,
  ShieldAlert,
  SkipForward,
  Webhook,
} from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { Link } from 'react-router';

import type { Outcome } from './describe';
import type { AutomationItem, StartKind } from './model';

type IconType = ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>;

// ---------------------------------------------------------------------------
// Kinds, states and outcomes
// ---------------------------------------------------------------------------

const tint = (color: string, percent = 14) =>
  `color-mix(in srgb, ${color} ${percent}%, transparent)`;

export const START_META: Record<StartKind, { label: string; Icon: IconType; color: string }> = {
  schedule: { label: 'Schedule', Icon: CalendarClock, color: 'var(--sam-color-success-fg)' },
  once: { label: 'One time', Icon: AlarmClock, color: 'var(--sam-color-info-fg)' },
  github: { label: 'GitHub', Icon: Github, color: 'var(--sam-color-fg-primary)' },
  webhook: { label: 'Webhook', Icon: Webhook, color: 'var(--sam-color-purple)' },
  event: { label: 'SAM event', Icon: Radio, color: 'var(--sam-color-warning-fg)' },
  incident: { label: 'Admin', Icon: ShieldAlert, color: 'var(--sam-color-fg-muted)' },
};

export function KindIcon({ start, size = 'md' }: { start: StartKind; size?: 'sm' | 'md' | 'lg' }) {
  const meta = START_META[start];
  const box =
    size === 'lg'
      ? 'h-12 w-12 rounded-xl'
      : size === 'sm'
        ? 'h-8 w-8 rounded-lg'
        : 'h-10 w-10 rounded-lg';
  return (
    <span
      className={`${box} inline-flex shrink-0 items-center justify-center`}
      style={{ background: tint(meta.color), color: meta.color }}
      aria-hidden
    >
      <meta.Icon size={size === 'lg' ? 22 : size === 'sm' ? 15 : 18} />
    </span>
  );
}

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'muted';
const TONE_CLASS: Record<Tone, string> = {
  success: 'bg-success-tint text-success-fg',
  warning: 'bg-warning-tint text-warning-fg',
  danger: 'bg-danger-tint text-danger-fg',
  info: 'bg-info-tint text-info-fg',
  muted: 'bg-surface-hover text-fg-muted',
};

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${TONE_CLASS[tone]}`}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

const STATE_PILLS: Record<AutomationItem['state'], [Tone, string]> = {
  on: ['success', 'On'],
  paused: ['warning', 'Paused'],
  off: ['muted', 'Off'],
  scheduled: ['info', 'Scheduled'],
  late: ['info', 'Waiting to start'],
  starting: ['info', 'Starting'],
  done: ['muted', 'Done'],
  cancelled: ['muted', 'Cancelled'],
  ended: ['muted', 'Ended'],
};

/**
 * The pill for an item, or null. Lists show one only when the state is worth noticing (a running
 * automation stays quiet); detail headers (`always`) always name the state.
 */
function pillFor(item: AutomationItem, always: boolean): [Tone, string] | null {
  if (item.attention && (item.state === 'done' || item.state === 'ended'))
    return ['warning', 'Check'];
  if (always) return STATE_PILLS[item.state];
  if (item.state === 'on' || item.state === 'scheduled')
    return item.attention ? ['warning', 'Check'] : null;
  return STATE_PILLS[item.state];
}

export const hasStatePill = (item: AutomationItem) => pillFor(item, false) !== null;

export function StatePill({ item, always = false }: { item: AutomationItem; always?: boolean }) {
  const pill = pillFor(item, always);
  return pill ? <Pill tone={pill[0]}>{pill[1]}</Pill> : null;
}

export const OUTCOME_META: Record<Outcome, { Icon: IconType; color: string; label: string }> = {
  ok: { Icon: CircleCheck, color: 'var(--sam-color-success-fg)', label: 'Worked' },
  failed: { Icon: CircleX, color: 'var(--sam-color-danger-fg)', label: 'Failed' },
  skipped: { Icon: SkipForward, color: 'var(--sam-color-fg-muted)', label: 'Skipped' },
  ignored: { Icon: Ban, color: 'var(--sam-color-fg-muted)', label: 'Ignored' },
  running: { Icon: LoaderCircle, color: 'var(--sam-color-info-fg)', label: 'In progress' },
  unknown: { Icon: CircleAlert, color: 'var(--sam-color-warning-fg)', label: 'Unconfirmed' },
};

export function OutcomeIcon({ outcome, size = 18 }: { outcome: Outcome; size?: number }) {
  const meta = OUTCOME_META[outcome];
  return (
    <span className="inline-flex shrink-0" style={{ color: meta.color }}>
      <meta.Icon size={size} aria-hidden />
      <span className="sr-only">{meta.label}</span>
    </span>
  );
}

/** A prompt with its {{variables}} shown as small chips instead of raw braces. */
export function PromptText({ text }: { text: string }) {
  const parts = text.split(/(\{\{[^}]+\}\})/g);
  return (
    <>
      {parts.map((part, index) =>
        /^\{\{[^}]+\}\}$/.test(part) ? (
          <span
            key={index}
            className="mx-0.5 inline-flex items-center rounded-md border border-border-default bg-surface-hover px-1.5 py-px font-mono text-[12px] text-fg-muted"
          >
            {part.slice(2, -2).trim().replace('.', ' ')}
          </span>
        ) : (
          <span key={index}>{part}</span>
        )
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Containers and navigation
// ---------------------------------------------------------------------------

export function Panel({
  children,
  className = '',
  tone,
  label,
}: {
  children: ReactNode;
  className?: string;
  tone?: 'danger' | 'warning';
  label?: string;
}) {
  const toneClass =
    tone === 'danger'
      ? 'border-danger/35 bg-danger-tint'
      : tone === 'warning'
        ? 'border-warning/35 bg-warning-tint'
        : 'glass-surface border-border-default';
  return (
    <section aria-label={label} className={`min-w-0 rounded-xl border ${toneClass} ${className}`}>
      {children}
    </section>
  );
}

export function SectionTitle({
  title,
  count,
  action,
  hint,
  level = 2,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  hint?: string;
  level?: 2 | 3;
}) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div className="flex min-h-11 items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col">
        <Heading className="m-0 flex items-center gap-2 text-[15px] font-semibold text-fg-primary">
          {title}
          {count !== undefined && (
            <span className="rounded-full bg-surface-hover px-2 py-0.5 text-xs font-semibold text-fg-muted">
              {count}
            </span>
          )}
        </Heading>
        {hint && <p className="m-0 text-[13px] text-fg-muted">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

/** A text link that still meets the 44 px target height. */
export function TextLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md px-2 text-sm font-semibold text-accent no-underline hover:bg-[var(--sam-color-accent-primary-tint)]"
    >
      {children}
      <ChevronRight size={16} aria-hidden />
    </Link>
  );
}

const BUTTON_LINK: Record<'primary' | 'ghost', string> = {
  primary: 'bg-accent text-fg-on-accent border border-transparent',
  ghost:
    'bg-transparent text-fg-primary border border-border-default hover:bg-[var(--sam-form-focus-inset)]',
};

/** A link that looks like the design-system Button, for actions that navigate. */
export function ButtonLink({
  to,
  children,
  variant = 'ghost',
  className = '',
}: {
  to: string;
  children: ReactNode;
  variant?: 'primary' | 'ghost';
  className?: string;
}) {
  return (
    <Link
      to={to}
      className={`inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-md px-4 text-[0.95rem] font-semibold no-underline transition-all duration-150 ${BUTTON_LINK[variant]} ${className}`}
    >
      {children}
    </Link>
  );
}

const ROW =
  'group flex w-full min-w-0 items-center gap-3 border-0 border-b border-solid border-border-default bg-transparent px-4 py-3 text-left no-underline last:border-b-0 hover:bg-surface-hover';

/**
 * Full-width row that opens something: leading icon, two lines, a status badge, chevron. On
 * phones the badge sits under the text, so a long label never squeezes the title.
 */
export function RowLink({
  to,
  leading,
  title,
  subtitle,
  meta,
  badge,
  muted,
  testId,
}: {
  to: string;
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  badge?: ReactNode;
  muted?: boolean;
  testId?: string;
}) {
  return (
    <Link to={to} className={`${ROW} min-h-16 ${muted ? 'opacity-70' : ''}`} data-testid={testId}>
      {leading}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="line-clamp-2 break-words text-[15px] font-semibold leading-snug text-fg-primary">
          {title}
        </span>
        {subtitle && (
          <span className="line-clamp-2 break-words text-[13px] text-fg-muted">{subtitle}</span>
        )}
        {meta && <span className="break-words text-xs text-fg-muted">{meta}</span>}
        {badge && <span className="mt-1 flex sm:hidden">{badge}</span>}
      </span>
      {badge && <span className="hidden shrink-0 sm:flex">{badge}</span>}
      <ChevronRight
        size={18}
        aria-hidden
        className="shrink-0 text-fg-muted transition-transform group-hover:translate-x-0.5"
      />
    </Link>
  );
}

/** Native details/summary disclosure: full power when needed, out of the way otherwise. */
export function Disclosure({
  title,
  hint,
  defaultOpen,
  children,
  testId,
  onToggle,
}: {
  title: string;
  hint?: string;
  defaultOpen?: boolean;
  children: ReactNode;
  testId?: string;
  /** Lets a caller mount expensive children only once the disclosure has been opened. */
  onToggle?: (open: boolean) => void;
}) {
  return (
    <details
      open={defaultOpen}
      data-testid={testId}
      onToggle={onToggle ? (event) => onToggle(event.currentTarget.open) : undefined}
      className="group min-w-0 rounded-xl border border-border-default glass-surface"
    >
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 flex-col">
          <span className="text-[15px] font-semibold text-fg-primary">{title}</span>
          {hint && <span className="text-[13px] text-fg-muted">{hint}</span>}
        </span>
        <ChevronDown
          size={18}
          aria-hidden
          className="shrink-0 text-fg-muted transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="flex flex-col gap-4 border-0 border-t border-solid border-border-default px-4 py-4">
        {children}
      </div>
    </details>
  );
}

export function KeyValues({ rows, mono }: { rows: Array<[string, ReactNode]>; mono?: boolean }) {
  return (
    <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-[minmax(140px,max-content)_minmax(0,1fr)] sm:gap-y-3">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="pt-2 text-[13px] text-fg-muted first:pt-0 sm:pt-0">{label}</dt>
          <dd
            className={`m-0 min-w-0 break-words text-[13px] text-fg-primary [overflow-wrap:anywhere] ${mono ? 'font-mono' : ''}`}
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Filter chips that scroll sideways on phones instead of wrapping into a wall (unless `wrap`). */
export function Chips<T extends string>({
  options,
  value,
  onChange,
  label,
  wrap = false,
}: {
  options: Array<{ id: T; label: string; count?: number }>;
  value: T;
  onChange: (id: T) => void;
  label: string;
  /** Wrap on phones too: for form choices, where a hidden option is easy to miss. */
  wrap?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={
        wrap
          ? 'flex flex-wrap gap-2'
          : '-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 sm:mx-0 sm:flex-wrap sm:px-0'
      }
    >
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.id)}
            className={`inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-full border px-4 text-sm font-semibold transition-colors ${
              active
                ? 'border-accent bg-[var(--sam-color-accent-primary-tint)] text-fg-primary'
                : 'border-border-default bg-transparent text-fg-muted hover:text-fg-primary'
            }`}
          >
            {option.label}
            {option.count !== undefined && (
              <span className="text-xs font-semibold opacity-70">{option.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
