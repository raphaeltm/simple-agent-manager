/**
 * Shared building blocks for the Automation prototype.
 *
 * Layout rule used everywhere: vertical rhythm comes from `flex flex-col gap-*`, never from
 * `space-y-*` (Tailwind v4's space utilities lose to `m-0` on children, which is what made
 * the current Events cards collapse to 0 px gaps). Every tappable control is at least 44 px.
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

import type { Action, Automation, Kind, Outcome, State } from './mock-data';
import { chatTitle, PROFILES } from './mock-data';

export { clock, dayHeading, relative, whenLabel } from './time';

// ---------------------------------------------------------------------------
// Kinds, states, outcomes
// ---------------------------------------------------------------------------

type IconType = ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>;

export const KIND_META: Record<
  Kind,
  { label: string; Icon: IconType; color: string; tint: string }
> = {
  schedule: {
    label: 'Schedule',
    Icon: CalendarClock,
    color: 'var(--sam-color-success-fg)',
    tint: 'var(--sam-color-success-tint)',
  },
  once: {
    label: 'One time',
    Icon: AlarmClock,
    color: 'var(--sam-color-info-fg)',
    tint: 'var(--sam-color-info-tint)',
  },
  github: {
    label: 'GitHub',
    Icon: Github,
    color: 'var(--sam-color-fg-primary)',
    tint: 'rgba(230, 242, 238, 0.08)',
  },
  webhook: {
    label: 'Webhook',
    Icon: Webhook,
    color: 'var(--sam-color-purple)',
    tint: 'rgba(192, 132, 252, 0.12)',
  },
  event: {
    label: 'SAM event',
    Icon: Radio,
    color: 'var(--sam-color-warning-fg)',
    tint: 'var(--sam-color-warning-tint)',
  },
  incident: {
    label: 'Admin',
    Icon: ShieldAlert,
    color: 'var(--sam-color-fg-muted)',
    tint: 'rgba(159, 183, 174, 0.12)',
  },
};

export function KindIcon({ kind, size = 'md' }: { kind: Kind; size?: 'sm' | 'md' | 'lg' }) {
  const meta = KIND_META[kind];
  const box =
    size === 'lg'
      ? 'h-12 w-12 rounded-xl'
      : size === 'sm'
        ? 'h-8 w-8 rounded-lg'
        : 'h-10 w-10 rounded-lg';
  const icon = size === 'lg' ? 22 : size === 'sm' ? 15 : 18;
  return (
    <span
      className={`${box} inline-flex shrink-0 items-center justify-center`}
      style={{ background: meta.tint, color: meta.color }}
      aria-hidden
    >
      <meta.Icon size={icon} />
    </span>
  );
}

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'muted';
const TONE_CLASS: Record<Tone, string> = {
  success: 'bg-success-tint text-success-fg',
  warning: 'bg-warning-tint text-warning-fg',
  danger: 'bg-danger-tint text-danger-fg',
  info: 'bg-info-tint text-info-fg',
  muted: 'bg-[rgba(159,183,174,0.14)] text-fg-muted',
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

/** Status pill, shown only when the state is worth noticing; normal running items get none. */
export function statePill(a: Automation, { always = false }: { always?: boolean } = {}) {
  if (a.attention && a.state === 'finished') return <Pill tone="warning">Check</Pill>;
  const map: Record<State, [Tone, string]> = {
    on: ['success', 'On'],
    paused: ['warning', 'Paused'],
    off: ['muted', 'Off'],
    scheduled: ['info', 'Scheduled'],
    retrying: ['info', 'Retrying'],
    finished: ['muted', 'Done'],
    cancelled: ['muted', 'Cancelled'],
  };
  if (!always && (a.state === 'on' || a.state === 'scheduled')) return null;
  const [tone, label] = map[a.state];
  return <Pill tone={tone}>{label}</Pill>;
}

/** Renders a prompt with {{variables}} shown as small chips instead of raw braces. */
export function PromptText({ text }: { text: string }) {
  const parts = text.split(/(\{\{[^}]+\}\})/g);
  return (
    <>
      {parts.map((part, i) =>
        /^\{\{[^}]+\}\}$/.test(part) ? (
          <span
            key={i}
            className="mx-0.5 inline-flex items-center rounded-md border border-border-default bg-[rgba(159,183,174,0.10)] px-1.5 py-px font-mono text-[12px] text-fg-muted"
          >
            {part.slice(2, -2).replace('.', ' ')}
          </span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

export const OUTCOME_META: Record<Outcome, { Icon: IconType; color: string; label: string }> = {
  ok: { Icon: CircleCheck, color: 'var(--sam-color-success-fg)', label: 'Done' },
  delivered: { Icon: CircleCheck, color: 'var(--sam-color-success-fg)', label: 'Delivered' },
  failed: { Icon: CircleX, color: 'var(--sam-color-danger-fg)', label: 'Failed' },
  skipped: { Icon: SkipForward, color: 'var(--sam-color-fg-muted)', label: 'Skipped' },
  ignored: { Icon: Ban, color: 'var(--sam-color-fg-muted)', label: 'Ignored' },
  running: { Icon: LoaderCircle, color: 'var(--sam-color-info-fg)', label: 'In progress' },
  unknown: { Icon: CircleAlert, color: 'var(--sam-color-warning-fg)', label: 'Unconfirmed' },
};

export function OutcomeIcon({ outcome, size = 18 }: { outcome: Outcome; size?: number }) {
  const meta = OUTCOME_META[outcome];
  return (
    <span className="inline-flex shrink-0" style={{ color: meta.color }} title={meta.label}>
      <meta.Icon size={size} aria-hidden />
      <span className="sr-only">{meta.label}</span>
    </span>
  );
}

/** "Start a new chat · Codex 5.5 High Chat" / "Message · PR #2387 release shepherd". */
export function actionLabel(action: Action) {
  if (action.type === 'start') {
    const profile = PROFILES.find((p) => p.id === action.profileId)?.name ?? 'project default';
    return { verb: 'Start a new chat', object: profile };
  }
  return { verb: 'Message', object: chatTitle(action.chatId) };
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export function Panel({
  children,
  className = '',
  tone,
}: {
  children: ReactNode;
  className?: string;
  tone?: 'danger' | 'warning';
}) {
  const toneClass =
    tone === 'danger'
      ? 'border-[rgba(239,68,68,0.35)] bg-[linear-gradient(180deg,rgba(239,68,68,0.10),rgba(239,68,68,0.03))]'
      : tone === 'warning'
        ? 'border-[rgba(245,158,11,0.35)] bg-[linear-gradient(180deg,rgba(245,158,11,0.10),rgba(245,158,11,0.03))]'
        : 'glass-surface border-border-default';
  return (
    <section className={`min-w-0 rounded-xl border ${toneClass} ${className}`}>{children}</section>
  );
}

export function SectionTitle({
  title,
  count,
  action,
  hint,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col">
        <h2 className="m-0 flex items-center gap-2 text-[15px] font-semibold text-fg-primary">
          {title}
          {count !== undefined && (
            <span className="rounded-full bg-[rgba(159,183,174,0.14)] px-2 py-0.5 text-xs font-semibold text-fg-muted">
              {count}
            </span>
          )}
        </h2>
        {hint && <p className="m-0 text-[13px] text-fg-muted">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

/** A text-style link button that still meets the 44 px target height. */
export function LinkButton({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md bg-transparent px-2 text-sm font-semibold text-accent hover:bg-[var(--sam-color-accent-primary-tint)]"
    >
      {children}
      <ChevronRight size={16} aria-hidden />
    </button>
  );
}

/** Full-width list row: icon, two lines of text, trailing slot, chevron. */
export function ListRow({
  leading,
  title,
  subtitle,
  meta,
  trailing,
  onClick,
  muted,
}: {
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex w-full min-w-0 items-center gap-3 border-0 border-b border-solid border-border-default bg-transparent px-4 py-3 text-left last:border-b-0 hover:bg-surface-hover ${muted ? 'opacity-70' : ''}`}
      style={{ minHeight: 64 }}
    >
      {leading}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="line-clamp-2 break-words text-[15px] font-semibold leading-snug text-fg-primary">
          {title}
        </span>
        {subtitle && (
          <span className="line-clamp-2 break-words text-[13px] text-fg-muted">{subtitle}</span>
        )}
        {meta && <span className="text-xs text-fg-muted">{meta}</span>}
      </span>
      {trailing}
      <ChevronRight
        size={18}
        aria-hidden
        className="shrink-0 text-fg-muted transition-transform group-hover:translate-x-0.5"
      />
    </button>
  );
}

/** Native details/summary disclosure: "full power when needed". */
export function Disclosure({
  title,
  hint,
  defaultOpen,
  children,
}: {
  title: string;
  hint?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
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
      <div className="border-0 border-t border-solid border-border-default px-4 py-4">
        {children}
      </div>
    </details>
  );
}

export function KeyValues({ rows, mono }: { rows: Array<[string, ReactNode]>; mono?: boolean }) {
  return (
    <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[minmax(140px,max-content)_1fr]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[13px] text-fg-muted">{k}</dt>
          <dd
            className={`m-0 -mt-2 min-w-0 break-words text-[13px] text-fg-primary sm:mt-0 ${mono ? 'font-mono' : ''}`}
          >
            {v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Horizontal filter chips that scroll on phones instead of wrapping into a wall. */
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
      className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0"
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
            className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-semibold transition-colors ${
              active
                ? 'border-accent bg-[var(--sam-color-accent-primary-tint)] text-fg-primary'
                : 'border-border-default bg-transparent text-fg-muted hover:text-fg-primary'
            }`}
          >
            {o.label}
            {o.count !== undefined && (
              <span className="text-xs font-semibold opacity-70">{o.count}</span>
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
  back?: { label: string; onClick: () => void };
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-2">
      {back && (
        <button
          type="button"
          onClick={back.onClick}
          className="-ml-2 inline-flex min-h-11 w-fit items-center gap-1 rounded-md bg-transparent px-2 text-sm font-medium text-fg-muted hover:text-fg-primary"
        >
          <ChevronRight size={16} aria-hidden className="rotate-180" />
          {back.label}
        </button>
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="m-0 break-words text-[26px] font-bold leading-tight tracking-[-0.01em] text-fg-primary">
            {title}
          </h1>
          {subtitle && <p className="m-0 text-[15px] text-fg-muted">{subtitle}</p>}
        </div>
        {action}
      </div>
    </header>
  );
}
