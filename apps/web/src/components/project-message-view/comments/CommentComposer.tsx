import { Button, Textarea } from '@simple-agent-manager/ui';
import { useEffect, useId, useRef, useState } from 'react';

import type { MessageCommentAction } from '../../../lib/api/comments';
import { QuotedAnchor } from './CommentPrimitives';

export interface CommentComposerProps {
  quote?: string;
  placeholder?: string;
  submitLabel?: string;
  autoFocus?: boolean;
  onSubmit: (body: string, action: MessageCommentAction) => Promise<unknown> | unknown;
  onCancel: () => void;
}

export function CommentComposer({
  quote,
  placeholder = 'Add a comment…',
  submitLabel = 'Comment',
  autoFocus = true,
  onSubmit,
  onCancel,
}: CommentComposerProps) {
  const textareaId = useId();
  const [body, setBody] = useState('');
  const [action, setAction] = useState<MessageCommentAction>('note');
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSubmit = body.trim().length > 0 && !submitting;

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const submit = async (overrideAction = action) => {
    const trimmed = body.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(trimmed, overrideAction);
      setBody('');
      setAction('note');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border-default bg-inset/60 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {quote && <QuotedAnchor quote={quote} />}
      <label htmlFor={textareaId} className="sr-only">
        {placeholder}
      </label>
      <Textarea
        ref={textareaRef}
        id={textareaId}
        value={body}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            void submit();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        className="text-sm"
      />
      <fieldset className="flex flex-wrap gap-2" aria-label="Comment action">
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border-default px-2 py-1 text-xs text-fg-muted">
          <input
            type="radio"
            name={`${textareaId}-action`}
            value="note"
            checked={action === 'note'}
            onChange={() => setAction('note')}
            className="accent-accent"
          />
          Add note
        </label>
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border-default px-2 py-1 text-xs text-fg-muted">
          <input
            type="radio"
            name={`${textareaId}-action`}
            value="send_to_agent"
            checked={action === 'send_to_agent'}
            onChange={() => setAction('send_to_agent')}
            className="accent-accent"
          />
          Send to agent
        </label>
      </fieldset>
      <p className="text-[0.6875rem] text-fg-muted">
        Send to agent creates a follow-up instruction with the quoted message context.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" type="submit" disabled={!canSubmit} loading={submitting}>
          {action === 'send_to_agent' ? 'Comment & send' : submitLabel}
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <span className="ml-auto hidden text-[0.6875rem] text-fg-muted sm:inline">⌘⏎ to submit</span>
      </div>
    </form>
  );
}
