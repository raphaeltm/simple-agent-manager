/**
 * Small building blocks the design system does not have yet.
 *
 * PROTOTYPE ONLY. `packages/ui` currently ships no Avatar, no Textarea, and no
 * anchored Popover (only `Tooltip` with a string `content`, and `Dialog`). If
 * commenting ships, these three are the concrete additions to `packages/ui`.
 * Everything else on this surface reuses existing exports.
 */

import { Button } from '@simple-agent-manager/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import type { CommentAuthor, CommentStatus } from './comment-types';

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------

const AGENT_AVATAR_BG = 'var(--sam-color-info-tint, rgba(122,162,247,0.1))';
const AGENT_AVATAR_FG = 'var(--sam-color-tn-blue, #7aa2f7)';

export function CommentAvatar({ author, size = 24 }: { author: CommentAuthor; size?: number }) {
  const isAgent = author.kind === 'agent';
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold select-none"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        backgroundColor: isAgent
          ? AGENT_AVATAR_BG
          : 'var(--sam-color-accent-primary-tint, rgba(22,163,74,0.1))',
        color: isAgent ? AGENT_AVATAR_FG : 'var(--sam-color-success-fg, #4ade80)',
        border: `1px solid ${isAgent ? AGENT_AVATAR_FG : 'var(--sam-color-success-fg, #4ade80)'}`,
      }}
    >
      {author.initials}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Status pill
// ---------------------------------------------------------------------------

const STATUS_STYLE: Record<CommentStatus, { label: string; fg: string; bg: string }> = {
  open: {
    label: 'Open',
    fg: 'var(--sam-color-warning-fg, #fbbf24)',
    bg: 'var(--sam-color-warning-tint, rgba(245,158,11,0.1))',
  },
  sent: {
    label: 'Sent to agent',
    fg: 'var(--sam-color-tn-blue, #7aa2f7)',
    bg: 'var(--sam-color-info-tint, rgba(122,162,247,0.1))',
  },
  resolved: {
    label: 'Resolved',
    fg: 'var(--sam-color-success-fg, #4ade80)',
    bg: 'var(--sam-color-success-tint, rgba(34,197,94,0.1))',
  },
};

export function CommentStatusPill({ status }: { status: CommentStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium whitespace-nowrap"
      style={{ color: s.fg, backgroundColor: s.bg }}
    >
      {status === 'sent' && (
        <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      )}
      {s.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Comment count marker — the affordance that says "there is a thread here"
// ---------------------------------------------------------------------------

export function CommentCountMarker({
  count,
  hasUnresolved,
  onClick,
  label,
}: {
  count: number;
  hasUnresolved: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      style={{
        color: hasUnresolved
          ? 'var(--sam-color-warning-fg, #fbbf24)'
          : 'var(--sam-color-fg-muted, #9fb7ae)',
        borderColor: hasUnresolved
          ? 'var(--sam-color-warning-fg, #fbbf24)'
          : 'var(--sam-color-border-default, #29423b)',
        backgroundColor: hasUnresolved
          ? 'var(--sam-color-warning-tint, rgba(245,158,11,0.1))'
          : 'transparent',
        outlineColor: 'var(--sam-color-focus-ring, #34d399)',
      }}
    >
      <CommentGlyph />
      {count}
    </button>
  );
}

export function CommentGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 9.5A1.5 1.5 0 0 1 12.5 11H5l-3 3V3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Quoted anchor — shows WHAT the comment is about
// ---------------------------------------------------------------------------

export function QuotedAnchor({ quote }: { quote: string }) {
  return (
    <blockquote
      className="mb-2 border-l-2 pl-2 text-xs italic"
      style={{
        borderColor: 'var(--sam-color-tn-blue, #7aa2f7)',
        color: 'var(--sam-color-fg-muted, #9fb7ae)',
        // Agent output and doc prose both contain unbroken URLs and identifiers.
        overflowWrap: 'anywhere',
      }}
    >
      {quote}
    </blockquote>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export interface CommentComposerProps {
  placeholder?: string;
  submitLabel?: string;
  /** When set, renders the "also send to agent" toggle. */
  allowSendToAgent?: boolean;
  autoFocus?: boolean;
  onSubmit: (body: string, sendToAgent: boolean) => void;
  onCancel: () => void;
  quote?: string;
}

export function CommentComposer({
  placeholder = 'Add a comment…',
  submitLabel = 'Comment',
  allowSendToAgent = true,
  autoFocus = true,
  onSubmit,
  onCancel,
  quote,
}: CommentComposerProps) {
  const [body, setBody] = useState('');
  const [sendToAgent, setSendToAgent] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const canSubmit = body.trim().length > 0;

  function submit() {
    if (!canSubmit) return;
    onSubmit(body.trim(), sendToAgent);
    setBody('');
    setSendToAgent(false);
  }

  return (
    <div className="flex flex-col gap-2">
      {quote && <QuotedAnchor quote={quote} />}
      <textarea
        ref={ref}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter submits — matches the chat composer.
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        rows={3}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full min-w-0 resize-y rounded-md border px-2.5 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-0"
        style={{
          backgroundColor: 'var(--sam-color-bg-inset, #0e1a17)',
          borderColor: 'var(--sam-color-border-default, #29423b)',
          color: 'var(--sam-color-fg-primary, #e6f2ee)',
          outlineColor: 'var(--sam-color-focus-ring, #34d399)',
        }}
      />
      {allowSendToAgent && (
        <label
          className="flex cursor-pointer items-start gap-2 text-xs"
          style={{ color: 'var(--sam-color-fg-muted, #9fb7ae)' }}
        >
          <input
            type="checkbox"
            checked={sendToAgent}
            onChange={(e) => setSendToAgent(e.target.checked)}
            className="mt-0.5 shrink-0"
            style={{ accentColor: 'var(--sam-color-accent-primary, #16a34a)' }}
          />
          <span className="min-w-0">
            Send to agent as an instruction
            <span className="block opacity-70">
              The agent picks this up as a follow-up turn with the quoted context attached.
            </span>
          </span>
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" onClick={submit} disabled={!canSubmit}>
          {sendToAgent ? 'Comment & send' : submitLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <span
          className="ml-auto hidden text-[0.6875rem] sm:inline"
          style={{ color: 'var(--sam-color-fg-muted, #9fb7ae)' }}
        >
          ⌘⏎ to submit
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Selection popover — the "comment on what I highlighted" affordance
// ---------------------------------------------------------------------------

export interface SelectionPopoverProps {
  x: number;
  y: number;
  onComment: () => void;
  children?: ReactNode;
}

/**
 * Touch variant: a fixed bottom bar rather than a chip beside the selection.
 *
 * On iOS/Android a long-press draws the OS callout (Copy / Look Up / Share)
 * directly above the selection — exactly where the chip would go — and it sits
 * above page content, so the chip is either covered or competing for the same
 * tap. The bottom bar avoids that entirely and lands in the thumb zone.
 *
 * It shows the quote so the user can confirm what they captured before committing,
 * which matters more on touch where selection precision is worse.
 */
export function SelectionActionBar({
  quote,
  onComment,
  onDismiss,
}: {
  quote: string;
  onComment: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="fixed right-0 bottom-0 left-0 z-50 border-t px-3 pt-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))]"
      style={{
        backgroundColor: 'var(--sam-color-bg-surface, #13201d)',
        borderColor: 'var(--sam-color-border-default, #29423b)',
        boxShadow: '0 -6px 20px rgba(0,0,0,0.35)',
      }}
      role="dialog"
      aria-label="Comment on selection"
    >
      <p
        className="m-0 mb-2 line-clamp-2 border-l-2 pl-2 text-xs italic"
        style={{
          borderColor: 'var(--sam-color-tn-blue, #7aa2f7)',
          color: 'var(--sam-color-fg-muted, #9fb7ae)',
          overflowWrap: 'anywhere',
        }}
      >
        {quote}
      </p>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" onClick={onComment}>
          Comment on selection
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

export function SelectionPopover({ x, y, onComment }: SelectionPopoverProps) {
  return (
    <div
      className="fixed z-50 -translate-x-1/2 -translate-y-full"
      style={{ left: x, top: y - 8 }}
      role="dialog"
      aria-label="Comment on selection"
    >
      <button
        type="button"
        onMouseDown={(e) => {
          // Prevent the mousedown from collapsing the selection before we read it.
          e.preventDefault();
        }}
        onClick={onComment}
        className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium shadow-lg focus-visible:outline focus-visible:outline-2"
        style={{
          backgroundColor: 'var(--sam-color-bg-surface, #13201d)',
          borderColor: 'var(--sam-color-border-default, #29423b)',
          color: 'var(--sam-color-fg-primary, #e6f2ee)',
          outlineColor: 'var(--sam-color-focus-ring, #34d399)',
        }}
      >
        <CommentGlyph />
        Comment
      </button>
    </div>
  );
}
