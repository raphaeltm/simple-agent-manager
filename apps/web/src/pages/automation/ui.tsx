/**
 * Building blocks for the Automation page.
 *
 * Layout rule: vertical rhythm comes from `flex flex-col gap-*`, never `space-y-*` (Tailwind
 * v4's space utilities lose to `m-0` on children, which collapsed the old Events cards to zero
 * gaps). Every control is at least 44 px tall. Status pills appear only for states worth
 * noticing; a running automation stays quiet.
 */
import { Button, Spinner } from '@simple-agent-manager/ui';
import {
  AlarmClock,
  Ban,
  CalendarClock,
  ChevronDown,
  ChevronLeft,
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

/** A pill only when the state is worth noticing, unless `always` (detail headers). */
export function StatePill({ item, always = false }: { item: AutomationItem; always?: boolean }) {
  if (item.attention && (item.state === 'done' || item.state === 'ended'))
    return <Pill tone="warning">Check</Pill>;
  if (!always && (item.state === 'on' || item.state === 'scheduled')) return null;
  const [tone, label] = STATE_PILLS[item.state];
  return <Pill tone={tone}>{label}</Pill>;
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

const ROW =
  'group flex w-full min-w-0 items-center gap-3 border-0 border-b border-solid border-border-default bg-transparent px-4 py-3 text-left no-underline last:border-b-0 hover:bg-surface-hover';

/** Full-width row that opens something: leading icon, two lines, trailing slot, chevron. */
export function RowLink({
  to,
  leading,
  title,
  subtitle,
  meta,
  trailing,
  muted,
  testId,
}: {
  to: string;
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  muted?: boolean;
  testId?: string;
}) {
  return (
    <Link
      to={to}
      className={`${ROW} min-h-16 ${muted ? 'opacity-70' : ''}`}
      data-testid={testId}
    >
      {leading}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="line-clamp-2 break-words text-[15px] font-semibold leading-snug text-fg-primary">
          {title}
        </span>
        {subtitle && (
          <span className="line-clamp-2 break-words text-[13px] text-fg-muted">{subtitle}</span>
        )}
        {meta && <span className="break-words text-xs text-fg-muted">{meta}</span>}
      </span>
      {trailing}
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
}: {
  title: string;
  hint?: string;
  defaultOpen?: boolean;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <details
      open={defaultOpen}
      data-testid={testId}
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

/** Filter chips that scroll sideways on phones instead of wrapping into a wall. */
export function Chips<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ id: T; label: string; count?: number }>;
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 sm:mx-0 sm:flex-wrap sm:px-0"
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

/** Page header shared by every view: optional back link, title, subtitle, trailing action. */
export function PageHeader({
  title,
  subtitle,
  back,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  back?: { label: string; to: string };
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-2">
      {back && (
        <Link
          to={back.to}
          className="-ml-2 inline-flex min-h-11 w-fit items-center gap-1 rounded-md px-2 text-sm font-medium text-fg-muted no-underline hover:text-fg-primary"
        >
          <ChevronLeft size={16} aria-hidden />
          {back.label}
        </Link>
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="m-0 break-words text-[26px] font-bold leading-tight tracking-[-0.01em] text-fg-primary [overflow-wrap:anywhere]">
            {title}
          </h1>
          {subtitle && <div className="m-0 text-[15px] text-fg-muted">{subtitle}</div>}
        </div>
        {action}
      </div>
    </header>
  );
}

/** The page column: same width and rhythm on every Automation view. */
export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div
      className={`mx-auto flex w-full min-w-0 flex-col gap-6 pb-16 ${wide ? 'max-w-[1180px]' : 'max-w-[860px]'}`}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="flex min-h-11 items-center gap-2 p-4 text-sm text-fg-muted">
      <Spinner size="sm" /> {label}
    </div>
  );
}

/** A failed read, with the reason and a retry. Shown next to whatever did load. */
export function LoadError({
  what,
  error,
  onRetry,
}: {
  what: string;
  error?: unknown;
  onRetry?: () => void;
}) {
  const reason = error instanceof Error ? error.message : null;
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-xl border border-danger/35 bg-danger-tint p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="m-0 min-w-0 text-sm text-fg-primary [overflow-wrap:anywhere]">
        Could not load {what}.{reason ? ` ${reason}` : ''}
      </p>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry} className="shrink-0">
          Try again
        </Button>
      )}
    </div>
  );
}

/** A quiet one-line notice (read-only access, partial data). */
export function Notice({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'info' }) {
  return (
    <p
      role="status"
      className={`m-0 rounded-lg px-4 py-3 text-sm ${tone === 'info' ? 'bg-info-tint text-info-fg' : 'bg-surface-hover text-fg-muted'}`}
    >
      {children}
    </p>
  );
}

export const errorText = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;
