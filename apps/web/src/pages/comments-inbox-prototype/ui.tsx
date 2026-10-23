/**
 * Shared pieces for the comments inbox prototype. Vertical rhythm uses `flex flex-col gap-*`
 * (Tailwind v4's `space-y-*` loses to `m-0` on children).
 */
import { Button } from '@simple-agent-manager/ui';
import { Bot, FileText, MessageSquare, Mic } from 'lucide-react';
import { type FormEvent, Fragment, type ReactNode, useEffect, useRef, useState } from 'react';

import type { Excerpt } from './model';

/** Inline formatting shared by comment bodies and whole messages: `code` and @Raphaël. */
export function renderInline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|@Raphaël)/g).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={index}
          className="rounded border border-border-default bg-inset px-1 py-px font-mono text-[0.8125rem]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part === '@Raphaël') {
      return (
        <span key={index} className="font-semibold text-accent">
          {part}
        </span>
      );
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}

/** One line of preview text: line breaks folded into spaces so a clamp shows words, not gaps. */
export function flatten(text: string): string {
  return text.replace(/\s*\n+\s*/g, ' ').trim();
}

/** A comment body: keeps line breaks, shows `code` as code and @Raphaël as a mention. */
export function RichText({ text, className = '' }: { text: string; className?: string }) {
  return (
    <p
      className={`m-0 whitespace-pre-wrap text-sm leading-relaxed text-fg-primary [overflow-wrap:anywhere] ${className}`}
    >
      {renderInline(text)}
    </p>
  );
}

/** The commented text with the quoted passage highlighted in place. */
export function ExcerptText({ excerpt, className = '' }: { excerpt: Excerpt; className?: string }) {
  return (
    <p
      className={`m-0 text-[0.8125rem] leading-relaxed text-fg-muted [overflow-wrap:anywhere] ${className}`}
    >
      {excerpt.leadingEllipsis && '…\u00a0'}
      {excerpt.before}
      {excerpt.quote && (
        <mark className="rounded-[3px] bg-[color-mix(in_srgb,var(--sam-color-warning)_24%,transparent)] px-0.5 text-fg-primary [box-decoration-break:clone]">
          {excerpt.quote}
        </mark>
      )}
      {excerpt.after}
      {excerpt.trailingEllipsis && '\u00a0…'}
    </p>
  );
}

/** Which chat or file a comment lives in. */
export function SourceIcon({ kind, size = 13 }: { kind: 'chat' | 'file'; size?: number }) {
  const Icon = kind === 'file' ? FileText : MessageSquare;
  return <Icon size={size} className="shrink-0" aria-hidden />;
}

export function UnreadDot() {
  return (
    <span
      aria-label="Needs you"
      className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
      style={{ background: 'var(--sam-color-warning)' }}
    />
  );
}

/** Small text action on a card: compact, but with a comfortable hit area. */
export function CardAction({
  icon,
  children,
  onClick,
  pressed,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[0.8125rem] font-medium transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring ${
        pressed ? 'bg-surface-hover text-fg-primary' : 'text-fg-muted hover:text-fg-primary'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

/**
 * Reply field. "Reply" keeps the answer among people; "Send to agent" also delivers the
 * thread to the chat's agent, and only appears for chats you control.
 */
export function ReplyBox({
  canSendToAgent,
  readerHint,
  focusOnMount = false,
  placeholder = 'Reply…',
  onSubmit,
  onCancel,
}: {
  canSendToAgent: boolean;
  /** Shown instead of Send to agent, e.g. on a teammate's chat or a file. */
  readerHint?: string;
  focusOnMount?: boolean;
  placeholder?: string;
  onSubmit: (body: string, sendToAgent: boolean) => void;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const canSubmit = body.trim().length > 0;

  useEffect(() => {
    if (focusOnMount) ref.current?.focus({ preventScroll: true });
  }, [focusOnMount]);

  const submit = (sendToAgent: boolean) => {
    if (!canSubmit) return;
    onSubmit(body.trim(), sendToAgent);
    setBody('');
  };

  return (
    <form
      className="flex min-w-0 flex-col gap-2"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        submit(false);
      }}
    >
      <div className="relative min-w-0">
        <textarea
          ref={ref}
          value={body}
          rows={2}
          aria-label={placeholder}
          placeholder={placeholder}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              submit(false);
            }
          }}
          className="block min-h-[56px] w-full resize-none rounded-lg border border-border-default bg-inset px-3 py-2 pr-11 text-sm leading-relaxed text-fg-primary outline-none transition-colors placeholder:text-fg-muted focus:border-focus-ring"
        />
        <button
          type="button"
          aria-label="Dictate"
          className="absolute right-1.5 bottom-1.5 flex h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:bg-surface-hover hover:text-fg-primary"
        >
          <Mic size={16} aria-hidden />
        </button>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button size="sm" type="submit" disabled={!canSubmit}>
          Reply
        </Button>
        {canSendToAgent && (
          <Button
            size="sm"
            variant="secondary"
            type="button"
            disabled={!canSubmit}
            onClick={() => submit(true)}
            title="Posts your reply and sends this thread to the chat's agent"
          >
            <Bot size={15} aria-hidden />
            Send to agent
          </Button>
        )}
        {!canSendToAgent && readerHint && (
          <span className="min-w-0 text-xs text-fg-muted">{readerHint}</span>
        )}
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="ml-auto h-8 rounded-md px-2 text-xs text-fg-muted hover:text-fg-primary"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
