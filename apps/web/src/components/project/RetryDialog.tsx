import { Button, Dialog } from '@simple-agent-manager/ui';
import { useEffect, useState } from 'react';

import type { ChatSessionResponse, SessionSummaryResponse } from '../../lib/api';
import { getProjectTask, summarizeSession } from '../../lib/api';
import { stripMarkdown } from '../../lib/text-utils';

interface RetryDialogProps {
  open: boolean;
  session: ChatSessionResponse | null;
  projectId: string;
  onClose: () => void;
  onRetry: (message: string, contextSummary: string, parentTaskId: string) => Promise<void>;
}

export function RetryDialog({
  open,
  session,
  projectId,
  onClose,
  onRetry,
}: RetryDialogProps) {
  const [message, setMessage] = useState('');
  const [loadingMessage, setLoadingMessage] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [summary, setSummary] = useState('');
  const [summaryMeta, setSummaryMeta] = useState<SessionSummaryResponse | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  // Fetch original message and summary when dialog opens
  useEffect(() => {
    if (!open || !session) {
      setMessage('');
      setSummary('');
      setSummaryMeta(null);
      setSummaryError(null);
      setRetryError(null);
      setLoadingMessage(false);
      return;
    }

    let cancelled = false;

    // Fetch the original task description
    if (session.task?.id) {
      setLoadingMessage(true);
      void getProjectTask(projectId, session.task.id)
        .then((task) => {
          if (cancelled) return;
          setMessage(task.description ?? '');
        })
        .catch(() => {
          if (cancelled) return;
          setMessage('');
        })
        .finally(() => {
          if (!cancelled) setLoadingMessage(false);
        });
    }

    // Load context summary
    setLoadingSummary(true);
    setSummaryError(null);

    void summarizeSession(projectId, session.id)
      .then((result) => {
        if (cancelled) return;
        setSummary(result.summary);
        setSummaryMeta(result);
      })
      .catch((err) => {
        if (cancelled) return;
        setSummaryError(err instanceof Error ? err.message : 'Failed to generate summary');
      })
      .finally(() => {
        if (!cancelled) setLoadingSummary(false);
      });

    return () => { cancelled = true; };
  }, [open, session, projectId]);

  const handleSubmit = async () => {
    const trimmed = message.trim();
    if (!trimmed || !session?.task?.id) return;

    setRetryError(null);
    setSubmitting(true);
    try {
      const sessionLabel = session.topic ? stripMarkdown(session.topic) : session.id;
      // Build a retry context summary that references the original session
      const retryContext = [
        `## Retry Context`,
        `This is a retry of a previous task that may have failed or produced unsatisfactory results.`,
        `Previous session: ${sessionLabel}`,
        `Previous session ID: ${session.id}`,
        `Previous task ID: ${session.task.id}`,
        '',
        summary ? `## Previous Session Summary\n${summary}` : '',
      ].filter(Boolean).join('\n');

      await onRetry(trimmed, retryContext, session.task.id);
      onClose();
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : 'Failed to start retry');
    } finally {
      setSubmitting(false);
    }
  };

  const sessionTitle = session?.topic ? stripMarkdown(session.topic) : session ? `Chat ${session.id.slice(0, 8)}` : '';

  return (
    <Dialog isOpen={open && !!session} onClose={onClose} maxWidth="md">
      <div className="grid gap-3">
        <h3 id="dialog-title" className="text-fg-primary text-base font-semibold m-0">
          Retry task
        </h3>

        {/* Original session reference */}
        <section className="p-3 rounded-md bg-warning-tint border border-warning/20 grid gap-1.5">
          <div className="text-xs font-semibold text-fg-muted uppercase tracking-wide">
            Retrying
          </div>
          <div className="font-semibold text-fg-primary text-sm">
            {sessionTitle}
          </div>
          {session?.task?.id && (
            <div className="text-xs text-fg-muted font-mono">
              Session: {session.id.slice(0, 8)}
            </div>
          )}
          {session?.task?.errorMessage && (
            <div className="text-xs text-danger mt-1">
              Error: {session.task.errorMessage}
            </div>
          )}
        </section>

        {/* Context summary (collapsible) */}
        {(loadingSummary || summary || summaryError) && (
          <details className="grid gap-1.5">
            <summary className="text-sm text-fg-muted cursor-pointer select-none flex items-center gap-2">
              Previous session context
              {summaryMeta && (
                <span className="text-xs text-fg-muted">
                  ({summaryMeta.filteredCount} of {summaryMeta.messageCount} messages)
                </span>
              )}
            </summary>
            {loadingSummary ? (
              <div className="rounded-md border border-border-default bg-surface p-4 text-sm text-fg-muted text-center" role="status" aria-live="polite">
                Generating context summary...
              </div>
            ) : summaryError ? (
              <div className="rounded-md border border-warning/30 bg-warning-tint p-3 text-sm text-fg-muted" role="alert">
                {summaryError}
              </div>
            ) : (
              <div className="rounded-md border border-border-default bg-surface p-3 text-sm text-fg-muted font-mono whitespace-pre-wrap max-h-[200px] overflow-y-auto">
                {summary}
              </div>
            )}
          </details>
        )}

        {/* Editable task message */}
        <label className="grid gap-1.5">
          <span className="text-sm text-fg-muted">Task message</span>
          {loadingMessage ? (
            <div className="rounded-md border border-border-default bg-surface p-4 text-sm text-fg-muted text-center" role="status">
              Loading original message...
            </div>
          ) : (
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              className="rounded-md border border-border-default bg-surface text-fg-primary p-3 text-sm resize-y min-h-[80px]"
              placeholder="Task description..."
              autoFocus
            />
          )}
        </label>

        {/* Error display */}
        {retryError && (
          <div className="rounded-md border border-danger/30 bg-danger-tint p-3 text-sm text-danger" role="alert">
            {retryError}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            disabled={!message.trim() || submitting || !session?.task?.id || loadingSummary || loadingMessage}
            onClick={handleSubmit}
          >
            {submitting ? 'Starting...' : 'Retry'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
