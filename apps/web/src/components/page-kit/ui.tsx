/**
 * Page building blocks shared by full-page features (Automation, Deployments): panels,
 * section titles, links, a disclosure, key/value rows, chips and a copy button.
 *
 * Layout rule: vertical rhythm comes from `flex flex-col gap-*`, never `space-y-*` (Tailwind
 * v4's space utilities lose to `m-0` on children). Every control is at least 44 px tall.
 */
import { buttonClassName } from '@simple-agent-manager/ui';
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import { useToast } from '../../hooks/useToast';
import { useRadioKeys } from './radio-keys';

export function Panel({
  children,
  className = '',
  tone,
  label,
}: {
  children: ReactNode;
  className?: string;
  /**
   * The exceptions a panel may signal. `success` is the quietest of the three: the Ideas
   * list's "a pull request merged — is this done?" card is a question, not an alarm.
   */
  tone?: 'danger' | 'warning' | 'success';
  label?: string;
}) {
  const toneClass =
    tone === 'danger'
      ? 'border-danger/35 bg-danger-tint'
      : tone === 'warning'
        ? 'border-warning/35 bg-warning-tint'
        : tone === 'success'
          ? 'border-success/30 bg-success-tint'
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
    <Link to={to} className={`${buttonClassName({ variant })} no-underline ${className}`}>
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
  const keys = useRadioKeys(options, value, onChange);
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
      {options.map((option, index) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            {...keys(index)}
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

/** How long the copy button shows its check mark (as the shared log CopyButton does). */
export const COPIED_FEEDBACK_MS = 1500;

/**
 * A labelled copy-to-clipboard button for a short value shown in a `<code>` chip. `quiet`
 * drops the box, for a copy icon that sits beside an address or a log line.
 */
export function CopyButton({
  label,
  value,
  quiet = false,
}: {
  label: string;
  value: string;
  quiet?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      onClick={() => {
        navigator.clipboard.writeText(value).then(
          () => setCopied(true),
          () => toast.error('Copy failed. Select the text and copy it instead.')
        );
      }}
      className={`inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-md bg-transparent hover:bg-surface-hover ${
        quiet
          ? 'border-0 text-fg-muted hover:text-fg-primary'
          : 'border border-border-default text-fg-primary'
      }`}
    >
      {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
    </button>
  );
}
