/**
 * SAM Glass notices for the chat column. Guide: docs/guides/sam-glass-design-system.md
 *
 * - `NoticeSlab`: a slab in the conversation column, for states that stay up or need the reader
 *   to act (provisioning, errors, guidance). Its tone lights the slab's lower edge, the way the
 *   failure card lights its edge red, and glows softly from a solid icon badge.
 * - `StatusCapsule` (./StatusCapsule): transient states that float over the conversation.
 * - `FooterNoticeRow`: a row inside the message-box slab, above the input.
 */
import { paneClassName } from '@simple-agent-manager/ui';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { NOTICE_TONES, type NoticeTone } from './notice-tones';

/** Solid round badge holding a notice's icon: an element on glass, so never translucent. */
export function NoticeBadge({ tone, children }: { tone: NoticeTone; children: ReactNode }) {
  const t = NOTICE_TONES[tone];
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-[var(--sam-chip-bg)]"
      style={{ borderColor: t.edge, color: t.fg, boxShadow: `0 0 18px -4px ${t.glow}` }}
    >
      {children}
    </span>
  );
}

/** Small mono chip for a notice's metadata (elapsed time, branch name). */
export function NoticeMeta({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex min-w-0 max-w-full items-center rounded-full border border-[var(--sam-chip-edge)] bg-[var(--sam-chip-bg)] px-2 py-0.5 font-mono text-[11.5px] text-fg-muted ${className}`}
    >
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

/** Phones get 44px targets (SAM Glass); `sm` Buttons are 36px. */
export const NOTICE_ACTION_CLASS = 'max-sm:min-h-11';

/** The quiet action on a notice (Dismiss): text only, so the raised or accent action leads. */
export function NoticeTextButton({
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      {...props}
      className={`min-h-11 shrink-0 cursor-pointer sm:min-h-9 rounded-[var(--sam-radius-control)] border-0 bg-transparent px-3 text-sm font-medium text-fg-muted hover:text-fg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary ${className}`}
    />
  );
}

export interface NoticeSlabProps {
  tone: NoticeTone;
  icon: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  /** Chips beside the title. */
  meta?: ReactNode;
  /** One accent or raised action at most, plus an optional text action. */
  actions?: ReactNode;
  /** Short actions stay beside the title on phones instead of moving under the text. */
  inlineActions?: boolean;
  /** Content under the header row, such as a stage track. */
  children?: ReactNode;
  role?: 'status' | 'alert';
  'data-testid'?: string;
  className?: string;
}

export function NoticeSlab({
  tone,
  icon,
  title,
  detail,
  meta,
  actions,
  inlineActions = false,
  children,
  role,
  'data-testid': testId,
  className = '',
}: Readonly<NoticeSlabProps>) {
  const t = NOTICE_TONES[tone];
  return (
    <div
      role={role}
      data-testid={testId}
      data-tone={tone}
      className={`${paneClassName('slab')} relative shrink-0 overflow-hidden px-4 py-3.5 ${className}`}
      style={{
        boxShadow: `inset 0 1px 0 var(--sam-glass-v2-bevel), inset 0 -1px 0 ${t.edge}, var(--sam-glass-v2-depth-slab)`,
      }}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-[inherit]"
        style={{ background: `radial-gradient(90% 160% at 0% 0%, ${t.glow}, transparent 60%)` }}
      />
      <div className="relative flex flex-col gap-3">
        {/* One copy of the actions: beside the text from `sm`, wrapped under it on phones
            (the text column claims the rest of the first line) unless `inlineActions`. */}
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2.5">
          <NoticeBadge tone={tone}>{icon}</NoticeBadge>
          <div
            className={`flex min-w-0 flex-1 flex-col gap-1 pt-[5px] ${
              inlineActions || !actions ? '' : 'basis-[calc(100%-44px)] sm:basis-0'
            }`}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 break-words text-sm font-semibold leading-tight text-fg-primary [overflow-wrap:anywhere]">
                {title}
              </span>
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
              className={`flex items-center gap-2 sm:self-center ${
                inlineActions ? 'shrink-0' : 'w-full flex-wrap pl-11 sm:w-auto sm:shrink-0 sm:pl-0'
              }`}
            >
              {actions}
            </div>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

/** A notice row inside the message-box slab, above the input, split off by a hairline. */
export function FooterNoticeRow({
  tone,
  children,
  action,
  role = 'status',
}: Readonly<{
  tone: NoticeTone;
  children: ReactNode;
  action?: ReactNode;
  role?: 'status' | 'alert';
}>) {
  const t = NOTICE_TONES[tone];
  return (
    <div
      role={role}
      data-tone={tone}
      className="flex shrink-0 items-center gap-2.5 border-b border-[var(--sam-hairline)] py-1.5 pl-4 pr-2"
    >
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: t.fg, boxShadow: `0 0 8px ${t.fg}` }}
      />
      <span className="min-w-0 flex-1 text-[13px] text-fg-primary">{children}</span>
      {action}
    </div>
  );
}
