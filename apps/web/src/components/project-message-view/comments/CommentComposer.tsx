import {
  appendDictatedText,
  VoiceButton,
  type VoiceButtonState,
} from '@simple-agent-manager/acp-client';
import { Button, Textarea } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { getTranscribeApiUrl } from '../../../lib/api/agents';
import type { MessageCommentAction } from '../../../lib/api/comments';
import { QuotedAnchor } from './CommentPrimitives';

/** Resting height, matching the 3-row size this composer had before auto-grow. */
const TEXTAREA_MIN_HEIGHT_PX = 76;
/** Ceiling before the field scrolls internally, mirroring ProjectChatComposer. */
const TEXTAREA_MAX_HEIGHT_PX = 200;

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
  const [voiceState, setVoiceState] = useState<VoiceButtonState>('idle');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Submitting unmounts this composer, so a submit landing mid-dictation would
  // post the comment WITHOUT the words still being recorded or transcribed, with
  // no signal to the user. Hold submission until the mic is back to idle.
  const voiceBusy = voiceState === 'recording' || voiceState === 'processing';
  const canSubmit = body.trim().length > 0 && !submitting && !voiceBusy;
  // Resolved here rather than threaded down as a prop: it is a pure derivation
  // of a build-time constant, so relaying it through CommentThread and
  // MessageCommentPanels would add a pass-through prop carrying no information.
  const transcribeApiUrl = useMemo(() => getTranscribeApiUrl(), []);
  const recording = voiceState === 'recording';

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  // The mic overlay covers the native resize grip, so the field grows itself
  // instead — same scrollHeight technique ProjectChatComposer already uses.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const fitted = Math.max(textarea.scrollHeight, TEXTAREA_MIN_HEIGHT_PX);
    textarea.style.height = `${Math.min(fitted, TEXTAREA_MAX_HEIGHT_PX)}px`;
  }, [body]);

  const handleTranscription = useCallback((text: string) => {
    setBody((current) => appendDictatedText(current, text));
    textareaRef.current?.focus();
  }, []);

  const submit = async (overrideAction = action) => {
    const trimmed = body.trim();
    // Guard here too, not just on the button: ⌘⏎ and form submit bypass it.
    if (!trimmed || submitting || voiceBusy) return;
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
      <div className="relative min-w-0">
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
          // pr-14 reserves the mic's footprint so dictated text never runs under it.
          className="pr-14 text-sm transition-colors"
          // Inline: both properties lose the Tailwind cascade to the base class's
          // `resize-y` / `border-border-default`. `resize` is off because the mic
          // overlay sits exactly on the native resize grip.
          style={{
            resize: 'none',
            ...(recording ? { borderColor: 'var(--sam-color-danger)' } : {}),
          }}
        />
        <div className="absolute bottom-1 right-1">
          <VoiceButton
            onTranscription={handleTranscription}
            onStateChange={setVoiceState}
            disabled={submitting}
            apiUrl={transcribeApiUrl}
          />
        </div>
      </div>
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
        <span className="ml-auto hidden text-[0.6875rem] text-fg-muted sm:inline">
          ⌘⏎ to submit
        </span>
      </div>
    </form>
  );
}
