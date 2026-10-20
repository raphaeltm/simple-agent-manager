import {
  appendDictatedText,
  VoiceButton,
  type VoiceButtonState,
} from '@simple-agent-manager/acp-client';
import { Alert, Button } from '@simple-agent-manager/ui';
import { Square } from 'lucide-react';
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useLayoutEffect,
  useState,
} from 'react';

import { useIsMobile } from '../../hooks/useIsMobile';
import { getTranscribeApiUrl } from '../../lib/api/agents';
import {
  getSendButtonTitle,
  getSendShortcutAriaKey,
  getSendShortcutHint,
} from '../../lib/platform-shortcuts';

/** The textarea grows with its content up to this height, then scrolls. */
const COMPOSER_MAX_HEIGHT_PX = 160;

interface SamComposerProps {
  message: string;
  setMessage: Dispatch<SetStateAction<string>>;
  onSend: () => void;
  onStop: () => void;
  /** A SAM turn is running: the primary button stops it instead of sending. */
  active: boolean;
  sending: boolean;
  cancelling: boolean;
  /** An unconfirmed submission is held in this tab; only an identical retry is allowed. */
  pending: boolean;
  /** History is loading or failed, so the conversation state is unknown. */
  blocked: boolean;
  error: string | null;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

export function SamComposer({
  message,
  setMessage,
  onSend,
  onStop,
  active,
  sending,
  cancelling,
  pending,
  blocked,
  error,
  textareaRef,
}: SamComposerProps) {
  const isMobile = useIsMobile();
  const [voiceState, setVoiceState] = useState<VoiceButtonState>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const onTranscription = useCallback(
    (text: string) => setMessage((previous) => appendDictatedText(previous, text)),
    [setMessage]
  );
  const onVoiceState = useCallback((state: VoiceButtonState) => {
    setVoiceState(state);
    if (state === 'recording') setVoiceError(null);
  }, []);
  const onVoiceError = useCallback(
    ({ message: reason }: { message: string }) => setVoiceError(reason),
    []
  );
  const voiceBusy = voiceState === 'recording' || voiceState === 'processing';
  const sendDisabled = sending || blocked || voiceBusy || !message.trim();

  // Re-measure when the text changes or the button beside it changes width (Send ↔ Stop/Retry).
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
  }, [message, textareaRef, active, pending, sending, cancelling]);

  const shownError = error ?? voiceError;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!active && !sendDisabled) onSend();
      }}
      className="relative shrink-0 glass-chrome border-x-0 border-b-0"
    >
      <div className="mx-auto w-full max-w-3xl space-y-2 px-4 py-3">
        {shownError && <Alert variant="error">{shownError}</Alert>}
        {pending && (
          <p className="text-xs text-fg-muted">
            Not confirmed yet. Your message is saved in this tab, and Retry sends the same request.
          </p>
        )}
        <label htmlFor="sam-message" className="sr-only">
          Message SAM
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id="sam-message"
            ref={textareaRef}
            rows={1}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
              event.preventDefault();
              if (!active && !sendDisabled) onSend();
            }}
            readOnly={sending || pending}
            aria-keyshortcuts={getSendShortcutAriaKey()}
            placeholder="Message SAM"
            className="min-h-11 min-w-0 flex-1 resize-none overflow-y-auto rounded-md border border-border-default bg-[var(--sam-form-bg)] px-3 py-2.5 text-base leading-normal text-fg-primary outline-none transition-colors placeholder:text-fg-muted focus:border-accent focus-visible:ring-2 focus-visible:ring-focus-ring"
          />
          <VoiceButton
            apiUrl={getTranscribeApiUrl()}
            onTranscription={onTranscription}
            onStateChange={onVoiceState}
            onError={onVoiceError}
            disabled={sending || pending}
          />
          {active ? (
            <Button
              type="button"
              variant="secondary"
              aria-label="Stop SAM turn"
              disabled={cancelling}
              onClick={onStop}
            >
              <Square size={14} aria-hidden="true" className="fill-current" />
              {cancelling ? 'Stopping…' : 'Stop'}
            </Button>
          ) : (
            <Button
              type="submit"
              disabled={sendDisabled}
              title={pending ? undefined : getSendButtonTitle()}
              aria-label={pending && !sending ? 'Retry message' : undefined}
            >
              {sending ? 'Sending…' : pending ? 'Retry' : 'Send'}
            </Button>
          )}
        </div>
        {active ? (
          <p className="text-xs text-fg-muted">
            Stopping SAM won’t cancel project work it already started.
          </p>
        ) : (
          !isMobile && <p className="text-xs text-fg-muted">{getSendShortcutHint()}</p>
        )}
      </div>
    </form>
  );
}
