import {
  appendDictatedText,
  VoiceButton,
  type VoiceButtonState,
} from '@simple-agent-manager/acp-client';
import type { CommentMention } from '@simple-agent-manager/shared';
import { Button, Textarea } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { getTranscribeApiUrl } from '../../../lib/api/agents';
import type { MessageCommentAction } from '../../../lib/api/comments';
import { QuotedAnchor } from './CommentPrimitives';
import {
  MemberMentionPalette,
  MentionCandidatesSource,
  type MentionCandidatesState,
} from './MemberMentionPalette';
import { useMemberMentions } from './useMemberMentions';

/** Resting height, matching the 3-row size this composer had before auto-grow. */
const TEXTAREA_MIN_HEIGHT_PX = 76;
/** Ceiling before the field scrolls internally, mirroring ProjectChatComposer. */
const TEXTAREA_MAX_HEIGHT_PX = 200;

/** Shown to a viewer who can comment on a session but cannot drive its agent. */
export const READER_COMMENT_HINT =
  "Visible to everyone in this project. Doesn't message the agent.";

const NO_MENTION_CANDIDATES: MentionCandidatesState = { candidates: [], loading: false };

export interface CommentComposerProps {
  quote?: string;
  placeholder?: string;
  submitLabel?: string;
  autoFocus?: boolean;
  /** The surface has no agent at all (library files): no Send-to-agent choice and no hint. */
  hideSendToAgent?: boolean;
  /**
   * The viewer may send this comment to the session's agent (owner or grantee). When false a
   * reader sees a one-line note that comments never reach the agent instead of the choice.
   * Defaults to false so a surface that forgets to say cannot offer the agent to a reader.
   */
  canSendToAgent?: boolean;
  /** Project whose active members can be @mentioned. Omit where mentions are unsupported. */
  mentionProjectId?: string;
  onSubmit: (
    body: string,
    action: MessageCommentAction,
    mentions: CommentMention[]
  ) => Promise<unknown> | unknown;
  onCancel: () => void;
}

export function CommentComposer({
  quote,
  placeholder = 'Add a comment…',
  submitLabel = 'Comment',
  autoFocus = true,
  hideSendToAgent = false,
  canSendToAgent = false,
  mentionProjectId,
  onSubmit,
  onCancel,
}: CommentComposerProps) {
  const textareaId = useId();
  const [body, setBody] = useState('');
  const [action, setAction] = useState<MessageCommentAction>('note');
  const [submitting, setSubmitting] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceButtonState>('idle');
  const [mentionSource, setMentionSource] = useState(NO_MENTION_CANDIDATES);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const offerSendToAgent = !hideSendToAgent && canSendToAgent;
  const showReaderHint = !hideSendToAgent && !canSendToAgent;
  // Derived, not reset in an effect: if access is revoked while "Send to agent" is selected,
  // the submit must fall back to a note in the same render the choice disappears.
  const effectiveAction: MessageCommentAction = offerSendToAgent ? action : 'note';
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
  const mentions = useMemberMentions({
    enabled: Boolean(mentionProjectId),
    candidates: mentionSource.candidates,
    loading: mentionSource.loading,
    body,
    setBody,
    textareaRef,
  });

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

  const submit = async (overrideAction = effectiveAction) => {
    const trimmed = body.trim();
    // Guard here too, not just on the button: ⌘⏎ and form submit bypass it.
    if (!trimmed || submitting || voiceBusy) return;
    setSubmitting(true);
    try {
      // Only picks whose `@Name` survived editing are sent; the rest notify nobody.
      await onSubmit(trimmed, overrideAction, mentions.mentionsFor(trimmed));
      setBody('');
      setAction('note');
      mentions.reset();
    } catch {
      // Keep the draft so the user can retry without retyping, and stop the
      // rejection escaping as an unhandled promise — callers submit via
      // `void submit()`. Reporting the failure is the caller's job; it has the
      // context to say what went wrong.
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
      {mentionProjectId && (
        <MentionCandidatesSource projectId={mentionProjectId} onChange={setMentionSource} />
      )}
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
          {...mentions.fieldProps}
          onChange={(event) => {
            setBody(event.target.value);
            mentions.syncCaret(event.target);
          }}
          onSelect={(event) => mentions.syncCaret(event.currentTarget)}
          onKeyDown={(event) => {
            if (mentions.handleKeyDown(event)) return;
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
      {mentions.open && (
        <MemberMentionPalette
          anchorRef={textareaRef}
          listboxId={mentions.listboxId}
          optionId={mentions.optionId}
          options={mentions.options}
          activeIndex={mentions.activeIndex}
          loading={mentionSource.loading}
          onPick={mentions.pick}
          onHover={mentions.setActiveIndex}
        />
      )}
      {offerSendToAgent && (
        <>
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
        </>
      )}
      {showReaderHint && (
        <p className="m-0 text-[0.6875rem] text-fg-muted">{READER_COMMENT_HINT}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" type="submit" disabled={!canSubmit} loading={submitting}>
          {effectiveAction === 'send_to_agent' ? 'Comment & send' : submitLabel}
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
