import { Button } from '@simple-agent-manager/ui';
import { useState } from 'react';

import { resolveAttentionAnswer } from '../../lib/api';

/** Same authoritative answer path for the inbox and the full question reader. */
export function AttentionAnswerControls({
  projectId,
  sessionId,
  markerId,
  options,
  onResolved,
  allowCustom = false,
}: {
  projectId: string;
  sessionId: string;
  markerId: string;
  options: string[];
  onResolved: () => void;
  allowCustom?: boolean;
}) {
  const [answering, setAnswering] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ answer: string; resolved: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const answer = async (value: string) => {
    if (answering !== null || outcome || !value.trim()) return;
    setAnswering(value);
    setError(null);
    try {
      const result = await resolveAttentionAnswer(projectId, sessionId, markerId, value);
      setOutcome({ answer: result.answer, resolved: result.resolved });
      onResolved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send this answer');
    } finally {
      setAnswering(null);
    }
  };
  return (
    <div role="group" aria-label="Answer options" className="min-w-0">
      {outcome ? (
        <p role="status" className="text-sm text-success-fg [overflow-wrap:anywhere]">
          {outcome.resolved ? 'Answered' : 'Answer is being delivered'}: {outcome.answer}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {options.map((option) => (
              <Button
                key={option}
                size="sm"
                variant="secondary"
                disabled={answering !== null}
                onClick={() => void answer(option)}
                className="min-h-11 min-w-11 max-w-full break-words !whitespace-normal text-left [overflow-wrap:anywhere]"
              >
                {answering === option ? 'Sending…' : option}
              </Button>
            ))}
          </div>
          {allowCustom && options.length === 0 && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void answer(text.trim());
              }}
              className="flex flex-col gap-2"
            >
              <label htmlFor={`answer-${markerId}`} className="text-xs text-fg-muted">
                Your answer
              </label>
              <textarea
                id={`answer-${markerId}`}
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={answering !== null}
                rows={2}
                className="w-full rounded-md border border-border-default bg-inset p-2 text-sm text-fg-primary"
              />
              <Button size="sm" disabled={!text.trim() || answering !== null} type="submit">
                {answering !== null ? 'Sending…' : 'Send answer'}
              </Button>
            </form>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger-fg [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
    </div>
  );
}
