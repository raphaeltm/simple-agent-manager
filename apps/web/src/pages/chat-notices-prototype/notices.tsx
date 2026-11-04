/**
 * PROTOTYPE ONLY — proposed SAM Glass versions of the chat's notification-style elements.
 * Not wired to real state. Do not merge to main.
 *
 * Two shapes:
 *  - NoticeSlab: a slab in the conversation column (gutter-separated, like the header slab).
 *    Used for anything persistent or actionable: provisioning, errors, guidance.
 *    The tone shows as a lit lower edge + a soft glow from the icon side, the same way the
 *    failure card already lights its lower edge red.
 *  - StatusCapsule: a small floating overlay pill at the top of the conversation pane for
 *    transient "working on it" states (connecting, reconnecting, waking). It does not push the
 *    transcript around while it comes and goes.
 */
import { buttonClassName, paneClassName, Spinner } from '@simple-agent-manager/ui';
import type { ReactNode } from 'react';

export type NoticeTone = 'progress' | 'info' | 'warning' | 'danger' | 'success';

const TONE: Record<NoticeTone, { edge: string; fg: string; glow: string }> = {
  progress: {
    edge: 'var(--sam-success-edge)',
    fg: 'var(--sam-status-success-fg)',
    glow: 'rgb(74 222 128 / 0.14)',
  },
  success: {
    edge: 'var(--sam-success-edge)',
    fg: 'var(--sam-status-success-fg)',
    glow: 'rgb(74 222 128 / 0.14)',
  },
  info: {
    edge: 'var(--sam-info-edge)',
    fg: 'var(--sam-status-info-fg)',
    glow: 'rgb(96 165 250 / 0.14)',
  },
  warning: {
    edge: 'var(--sam-warning-edge)',
    fg: 'var(--sam-status-warning-fg)',
    glow: 'rgb(251 191 36 / 0.13)',
  },
  danger: {
    edge: 'var(--sam-danger-edge)',
    fg: 'var(--sam-status-danger-fg)',
    glow: 'rgb(248 113 113 / 0.15)',
  },
};

/** Solid round badge holding the notice's icon; solid, never glass. */
export function ToneBadge({ tone, children }: { tone: NoticeTone; children: ReactNode }) {
  const t = TONE[tone];
  return (
    <span
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-[var(--sam-chip-bg)]"
      style={{ borderColor: t.edge, color: t.fg, boxShadow: `0 0 18px -4px ${t.glow}` }}
    >
      {children}
    </span>
  );
}

/** Mono meta chip (elapsed time, branch). */
export function MetaChip({ children, mono = true }: { children: ReactNode; mono?: boolean }) {
  return (
    <span
      className={`inline-flex min-w-0 max-w-full items-center rounded-full border border-[var(--sam-chip-edge)] bg-[var(--sam-chip-bg)] px-2 py-0.5 text-[11.5px] text-fg-muted ${mono ? 'font-mono' : ''}`}
    >
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

export function NoticeSlab({
  tone,
  icon,
  title,
  detail,
  meta,
  actions,
  children,
  role = 'status',
  compact = false,
  inlineActions = false,
}: {
  tone: NoticeTone;
  icon: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  role?: 'status' | 'alert';
  compact?: boolean;
  /** Keep short actions beside the title on phones instead of a row under the text. */
  inlineActions?: boolean;
}) {
  const t = TONE[tone];
  return (
    <div
      role={role}
      className={`${paneClassName('slab')} relative shrink-0 overflow-hidden ${compact ? 'px-3 py-2.5' : 'px-4 py-3.5'}`}
      style={{
        boxShadow: `inset 0 1px 0 var(--sam-glass-v2-bevel), inset 0 -1px 0 ${t.edge}, var(--sam-glass-v2-depth-slab)`,
      }}
    >
      {/* Tone glow, from the badge side, under the content */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-[inherit]"
        style={{ background: `radial-gradient(90% 160% at 0% 0%, ${t.glow}, transparent 60%)` }}
      />
      <div className="relative flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <ToneBadge tone={tone}>{icon}</ToneBadge>
          <div className="flex min-w-0 flex-1 flex-col gap-1 pt-[5px]">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[14px] font-semibold leading-tight text-fg-primary">{title}</span>
              {meta}
            </div>
            {detail && (
              <div className="break-words text-[13px] leading-snug text-fg-muted [overflow-wrap:anywhere]">
                {detail}
              </div>
            )}
          </div>
          {actions && (
            <div
              className={`shrink-0 items-center gap-2 ${inlineActions ? 'flex self-start sm:self-center' : 'hidden self-center sm:flex'}`}
            >
              {actions}
            </div>
          )}
        </div>
        {children}
        {actions && !inlineActions && (
          <div className="flex flex-wrap items-center gap-2 pl-11 sm:hidden">{actions}</div>
        )}
      </div>
    </div>
  );
}

export function RaisedButton({ children }: { children: ReactNode }) {
  return (
    <button type="button" className={buttonClassName({ variant: 'raised', size: 'sm' })}>
      {children}
    </button>
  );
}

export function AccentButton({ children }: { children: ReactNode }) {
  return (
    <button type="button" className={buttonClassName({ variant: 'accent', size: 'sm' })}>
      {children}
    </button>
  );
}

export function GhostButton({ children }: { children: ReactNode }) {
  return (
    <button
      type="button"
      className="min-h-9 cursor-pointer rounded-[var(--sam-radius-control)] border-0 bg-transparent px-3 text-sm font-medium text-fg-muted hover:text-fg-primary"
    >
      {children}
    </button>
  );
}

/**
 * Stage track: a well with one segment per stage. Done segments are lit solid green, the current
 * one is lit partway with a moving sheen, pending ones are bare well.
 */
export function StageTrack({
  stages,
  current,
  failed = false,
}: {
  stages: string[];
  current: number;
  failed?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 sm:pl-11">
      <div className="sam-well flex gap-[3px] rounded-full p-[3px]">
        {stages.map((stage, i) => {
          const done = i < current;
          const isCurrent = i === current;
          return (
            <div key={stage} className="relative h-[6px] flex-1 overflow-hidden rounded-full">
              {(done || isCurrent) && (
                <div
                  className={`absolute inset-y-0 left-0 rounded-full ${isCurrent && !failed ? 'chat-notice-shimmer' : ''}`}
                  style={{
                    width: done ? '100%' : failed ? '100%' : '45%',
                    background: failed && isCurrent
                      ? 'linear-gradient(180deg, #f87171, #dc2626)'
                      : 'linear-gradient(180deg, var(--sam-accent-top), var(--sam-accent-bottom))',
                    boxShadow: failed && isCurrent
                      ? '0 0 10px rgb(248 113 113 / 0.55)'
                      : '0 0 10px rgb(74 222 128 / 0.5)',
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="hidden gap-[3px] sm:flex">
        {stages.map((stage, i) => (
          <div
            key={stage}
            className={`min-w-0 flex-1 truncate px-1 text-[11.5px] ${
              i === current
                ? failed
                  ? 'font-medium text-[var(--sam-status-danger-fg)]'
                  : 'font-medium text-fg-primary'
                : i < current
                  ? 'text-[var(--sam-status-success-fg)]'
                  : 'text-fg-muted'
            }`}
          >
            {i < current ? '✓ ' : ''}
            {stage}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Floating overlay pill for transient connection / wake states. */
export function StatusCapsule({
  tone,
  label,
  elapsed,
  action,
  spinner = true,
}: {
  tone: NoticeTone;
  label: ReactNode;
  elapsed?: string;
  action?: ReactNode;
  spinner?: boolean;
}) {
  const t = TONE[tone];
  return (
    <div
      role="status"
      className={`${paneClassName('overlay', { rounded: false })} inline-flex max-w-full min-w-0 items-center gap-2 rounded-full py-1.5 pl-2 pr-2`}
      style={{
        boxShadow: `inset 0 1px 0 var(--sam-glass-v2-bevel), inset 0 0 0 1px ${t.edge}, 0 10px 30px -10px rgb(0 0 0 / 0.6), 0 0 24px -8px ${t.glow}`,
      }}
    >
      <span
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--sam-chip-bg)]"
        style={{ color: t.fg }}
      >
        {spinner ? (
          <Spinner size="sm" />
        ) : (
          <span className="h-2 w-2 rounded-full" style={{ background: t.fg, boxShadow: `0 0 8px ${t.fg}` }} />
        )}
      </span>
      <span className="min-w-0 truncate text-[13px] font-medium text-fg-primary">{label}</span>
      {elapsed && <span className="shrink-0 font-mono text-[11.5px] text-fg-muted">{elapsed}</span>}
      {action}
    </div>
  );
}

/** A row inside the message-box slab (footer), above the input, split off by a hairline. */
export function FooterNoticeRow({
  tone,
  children,
  action,
}: {
  tone: NoticeTone;
  children: ReactNode;
  action?: ReactNode;
}) {
  const t = TONE[tone];
  return (
    <div className="flex items-center gap-2.5 border-b border-[var(--sam-hairline)] px-4 py-2.5">
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: t.fg, boxShadow: `0 0 8px ${t.fg}` }}
      />
      <span className="min-w-0 flex-1 text-[13px] text-fg-primary">{children}</span>
      {action}
    </div>
  );
}
