import { paneClassName, Spinner } from '@simple-agent-manager/ui';
import type { ReactNode } from 'react';

import { NOTICE_TONES, type NoticeTone } from './notice-tones';

export interface StatusCapsuleProps {
  tone: NoticeTone;
  /** A spinner while something is in progress; a lit dot for a settled state. */
  indicator?: 'spinner' | 'dot';
  /**
   * The label. Callers own its live-region semantics, so a ticking `trailing` timer
   * beside it is never re-announced with every tick.
   */
  children: ReactNode;
  /** Elapsed time, outside the label. */
  trailing?: ReactNode;
  action?: ReactNode;
  role?: 'alert';
  'data-testid'?: string;
}

/**
 * A small floating capsule for transient states (connecting, waking): a pill on one line, and
 * long labels wrap. It sits over the top of the conversation rather than in the column, so the
 * transcript does not jump as it comes and goes. Place it with `StatusCapsuleSlot`.
 */
export function StatusCapsule({
  tone,
  indicator = 'spinner',
  children,
  trailing,
  action,
  role,
  'data-testid': testId,
}: Readonly<StatusCapsuleProps>) {
  const t = NOTICE_TONES[tone];
  return (
    <div
      role={role}
      data-testid={testId}
      data-tone={tone}
      className={`${paneClassName('overlay', { rounded: false })} pointer-events-auto inline-flex min-w-0 max-w-full items-center gap-2 rounded-[18px] py-1.5 pl-2 pr-3`}
      style={{
        // Nearly solid: the capsule sits over transcript text, which must not read through it.
        background: 'color-mix(in srgb, var(--sam-chip-bg) 90%, transparent)',
        boxShadow: `inset 0 1px 0 var(--sam-glass-v2-bevel), inset 0 0 0 1px ${t.edge}, 0 10px 30px -10px rgb(0 0 0 / 0.6), 0 0 24px -8px ${t.glow}`,
      }}
    >
      <span
        aria-hidden="true"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--sam-chip-bg)]"
        style={{ color: t.fg }}
      >
        {indicator === 'spinner' ? (
          <Spinner size="sm" />
        ) : (
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: t.fg, boxShadow: `0 0 8px ${t.fg}` }}
          />
        )}
      </span>
      <span className="min-w-0 break-words text-[13px] font-medium leading-snug text-fg-primary [overflow-wrap:anywhere]">
        {children}
      </span>
      {trailing != null && (
        <span className="shrink-0 font-mono text-[11.5px] text-fg-muted">{trailing}</span>
      )}
      {action}
    </div>
  );
}

/**
 * Centres capsules at the top of the conversation pane. The pane must be positioned. The side
 * padding keeps a capsule clear of the phone tool rail on the pane's right edge (below `md`).
 */
export function StatusCapsuleSlot({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex flex-col items-center gap-2 px-14 md:px-4">
      {children}
    </div>
  );
}
