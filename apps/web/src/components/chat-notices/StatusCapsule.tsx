import { Spinner } from '@simple-agent-manager/ui';
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
 * A small capsule for transient states (connecting, waking): a pill on one line; long labels
 * wrap. It sits inside the conversation pane rather than as a strip in the column, so the
 * session header and message box stay put as it comes and goes. An element on glass, so solid.
 * Place it with `StatusCapsuleSlot`.
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
      className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-[18px] bg-[var(--sam-chip-bg)] py-1.5 pl-2 pr-3"
      style={{
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
 * Centres capsules at the top of the conversation pane, in its flow above the messages, so a
 * capsule never covers the transcript (on a phone a short chat starts right under the pane's
 * top edge).
 */
export function StatusCapsuleSlot({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="flex shrink-0 flex-col items-center gap-2 px-3 pt-3">{children}</div>;
}
