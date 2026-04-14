import { Button, Dialog } from '@simple-agent-manager/ui';
import { useEffect, useState } from 'react';

import type { ChatSessionResponse, SessionSummaryResponse } from '../../lib/api';
import { summarizeSession } from '../../lib/api';
import { stripMarkdown } from '../../lib/text-utils';

/** Template pre-filled in the fork dialog message field. */
export const FORK_MESSAGE_TEMPLATE = `Use the SAM MCP tools (get_session_messages, search_messages) to review the previous session for full context about what was done and what needs to happen next.

`;

interface ForkDialogProps {
  open: boolean;
  session: ChatSessionResponse | null;
  projectId: string;
  onClose: () => void;
  onFork: (message: string, contextSummary: string, parentTaskId: string) => Promise<void>;
}

export function ForkDialog({
  open,
  session,
  projectId,
  onClose,
  onFork,
}: ForkDialogProps) {
  const [summary, setSummary] = useState('');
  const [summaryMeta, setSummaryMeta] = useState<SessionSummaryResponse | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [forkError, setForkError] = useState<string | null>(null);

  // Load summary and pre-fill message template when dialog opens
  useEffect(() => {
    if (!open || !session) {
      setSummary('');
      setSummaryMeta(null);
      setSummaryError(null);
      setMessage('');
      setForkError(null);
      return;
    }

    // Pre-fill with MCP reference template including session context
    const sessionLabel = session.topic ? stripMarkdown(session.topic) : `Chat ${session.id.slice(0, 8)}`;
    setMessage(`${FORK_MESSAGE_TEMPLATE}Previous session: "${sessionLabel}" (${session.id.slice(0, 8)})\n\n`);

    let cancelled = false;
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

    setForkError(null);
    setSubmitting(true);
    try {
      await onFork(trimmed, summary, session.task.id);
      onClose();
    } catch (err) {
      setForkError(err instanceof Error ? err.message : 'Failed to start task');
    } finally {
      setSubmitting(false);
    }
  };

  const parentBranch = session?.task?.outputBranch;

  return (
    <Dialog isOpen={open && !!session} onClose={onClose} maxWidth="md">
      <div className="grid gap-3">
        <h3 id="dialog-title" className="text-fg-primary text-base font-semibold m-0">
          Continue from previous session
        </h3>

        {/* Parent session info */}
        <section className="p-3 rounded-md bg-info-tint border border-info/20 grid gap-1.5">
          <div className="text-xs font-semibold text-fg-muted uppercase tracking-wide">
            Continuing from
          </div>
          <div className="font-semibold text-fg-primary text-sm">
            {session?.topic || `Chat ${session?.id.slice(0, 8)}`}
          </div>
          {parentBranch && (
            <div className="text-xs text-fg-muted font-mono">
              Branch: {parentBranch}
            </div>
          )}
        </section>

        {/* Context summary */}
        <div className="grid gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-sm text-fg-muted">Context summary</span>
            {summaryMeta && (
              <span className="text-xs text-fg-muted" title={`Method: ${summaryMeta.method}`}>
                ({summaryMeta.filteredCount} of {summaryMeta.messageCount} messages)
              </span>
            )}
          </div>
          {loadingSummary ? (
            <div className="rounded-md border border-border-default bg-surface p-4 text-sm text-fg-muted text-center" role="status" aria-live="polite">
              Generating context summary...
            </div>
          ) : summaryError ? (
            <div className="rounded-md border border-warning/30 bg-warning-tint p-3 text-sm text-fg-muted" role="alert">
              {summaryError}
            </div>
          ) : (
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={8}
              aria-label="Context summary"
              className="rounded-md border border-border-default bg-surface text-fg-primary p-3 text-sm font-mono resize-y min-h-[120px]"
              placeholder="Context from previous session..."
            />
          )}
        </div>

        {/* New task message */}
        <label className="grid gap-1.5">
          <span className="text-sm text-fg-muted">What should the agent do next?</span>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            className="rounded-md border border-border-default bg-surface text-fg-primary p-3 text-sm resize-y min-h-[80px]"
            placeholder="Describe the next task..."
            autoFocus
          />
        </label>

        {/* Error display */}
        {forkError && (
          <div className="rounded-md border border-danger/30 bg-danger-tint p-3 text-sm text-danger" role="alert">
            {forkError}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            disabled={!message.trim() || loadingSummary || submitting || !session?.task?.id}
            onClick={handleSubmit}
          >
            {submitting ? 'Starting...' : 'Continue'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
