import { Button } from '@simple-agent-manager/ui';
import { PenLine } from 'lucide-react';
import { useId, useState } from 'react';

import { resolveAttentionAnswer } from '../../lib/api';

/** Above this many options the choices become a scrollable radio list with one Send button. */
const ATTENTION_OPTION_BUTTON_LIMIT = 5;

export interface AttentionAnswerResult {
  answer: string;
  /** False while the answer is still being delivered to the agent. */
  resolved: boolean;
}

/**
 * Answer controls for an agent question. One implementation, two layouts: `inline` inside the
 * chat card and `pinned` as the slim control area at the bottom of an inbox item.
 *
 * - Up to five options are buttons; more become a scrollable radio list with a pinned Send.
 * - With `allowCustom`, "Type a different answer" sits beside the options (or the text box
 *   shows directly when there are no options).
 * - `submit` replaces the default marker answer route (the inbox answers through its own route,
 *   which reaches the same record).
 */
export function AttentionAnswerControls({
  projectId,
  sessionId,
  markerId,
  options,
  onResolved,
  allowCustom = false,
  submit,
  layout = 'inline',
}: {
  projectId: string;
  sessionId: string;
  markerId: string;
  options: string[];
  onResolved?: (result: AttentionAnswerResult) => void;
  allowCustom?: boolean;
  submit?: (answer: string) => Promise<AttentionAnswerResult>;
  layout?: 'inline' | 'pinned';
}) {
  const baseId = useId();
  const [answering, setAnswering] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<AttentionAnswerResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typing, setTyping] = useState(options.length === 0);
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const pinned = layout === 'pinned';
  const radioList = options.length > ATTENTION_OPTION_BUTTON_LIMIT;

  const answer = async (value: string) => {
    const trimmed = value.trim();
    if (answering !== null || outcome || !trimmed) return;
    setAnswering(trimmed);
    setError(null);
    try {
      const result = submit
        ? await submit(trimmed)
        : await resolveAttentionAnswer(projectId, sessionId, markerId, trimmed);
      const settled = { answer: result.answer, resolved: result.resolved };
      setOutcome(settled);
      onResolved?.(settled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send this answer');
    } finally {
      setAnswering(null);
    }
  };

  if (outcome) {
    return (
      <p role="status" className="m-0 text-sm text-success-fg [overflow-wrap:anywhere]">
        {outcome.resolved ? 'Answered' : 'Answer is being delivered'}: {outcome.answer}
      </p>
    );
  }

  const busy = answering !== null;
  const textBox = allowCustom && typing && (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void answer(text);
      }}
      className="flex min-w-0 flex-col gap-2"
    >
      <label htmlFor={`${baseId}-text`} className="text-xs text-fg-muted">
        Your answer
      </label>
      <textarea
        id={`${baseId}-text`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
        rows={2}
        // eslint-disable-next-line jsx-a11y/no-autofocus -- opened by an explicit "Type a different answer" tap
        autoFocus={options.length > 0}
        className="w-full min-w-0 rounded-md border border-border-default bg-inset p-2 text-base text-fg-primary sm:text-sm"
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!text.trim() || busy} type="submit" className="min-h-11">
          {busy ? 'Sending…' : 'Send answer'}
        </Button>
        {options.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            type="button"
            disabled={busy}
            onClick={() => setTyping(false)}
            className="min-h-11"
          >
            Back to options
          </Button>
        )}
      </div>
    </form>
  );

  const typeDifferent = allowCustom && options.length > 0 && (
    <button
      type="button"
      disabled={busy}
      onClick={() => setTyping(true)}
      className="flex min-h-11 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed whitespace-nowrap border-border-default bg-transparent px-3 text-sm text-fg-secondary hover:text-fg-primary disabled:cursor-not-allowed disabled:opacity-60"
    >
      <PenLine size={15} aria-hidden="true" />
      Type a different answer
    </button>
  );

  return (
    <div role="group" aria-label="Answer options" className="flex min-w-0 flex-col gap-2">
      {typing ? (
        textBox
      ) : radioList ? (
        <form
          className="flex min-h-0 min-w-0 flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (picked) void answer(picked);
          }}
        >
          <fieldset
            className={`relative m-0 min-w-0 overflow-y-auto border-0 p-0 ${pinned ? 'max-h-[min(32vh,12.5rem)]' : 'max-h-72'}`}
            data-testid="attention-option-list"
          >
            {/* About 4.5 rows show, so the half row says the list scrolls. */}
            <legend className="sr-only">Choose one of {options.length} answers</legend>
            {options.map((option, index) => (
              <label
                key={option}
                htmlFor={`${baseId}-opt-${index}`}
                className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-[var(--sam-hairline)] py-2 text-[15px] text-fg-primary last:border-b-0"
              >
                <input
                  id={`${baseId}-opt-${index}`}
                  type="radio"
                  name={`${baseId}-options`}
                  value={option}
                  checked={picked === option}
                  disabled={busy}
                  onChange={() => setPicked(option)}
                  className="h-5 w-5 shrink-0 accent-[var(--sam-color-accent)]"
                />
                <span className="min-w-0 break-words [overflow-wrap:anywhere]">{option}</span>
              </label>
            ))}
          </fieldset>
          <div className="flex min-w-0 flex-wrap gap-2">
            <Button
              type="submit"
              disabled={!picked || busy}
              className="min-h-11 min-w-[6rem] flex-1"
            >
              {busy ? 'Sending…' : 'Send'}
            </Button>
            {typeDifferent}
          </div>
        </form>
      ) : (
        <>
          <div className="flex min-w-0 flex-wrap gap-2">
            {options.map((option) => (
              <Button
                key={option}
                size={pinned ? 'md' : 'sm'}
                variant="secondary"
                disabled={busy}
                onClick={() => void answer(option)}
                className="min-h-11 min-w-11 max-w-full break-words !whitespace-normal text-left [overflow-wrap:anywhere]"
              >
                {answering === option ? 'Sending…' : option}
              </Button>
            ))}
          </div>
          {typeDifferent && <div className="flex">{typeDifferent}</div>}
        </>
      )}
      {error && (
        <p role="alert" className="m-0 text-sm text-danger-fg [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
    </div>
  );
}
