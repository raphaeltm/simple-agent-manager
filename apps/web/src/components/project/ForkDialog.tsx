import { useEffect, useState } from 'react';
import { Button, Dialog } from '@simple-agent-manager/ui';
import type { ChatSessionResponse, SessionSummaryResponse } from '../../lib/api';
import { summarizeSession } from '../../lib/api';

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

  // Load summary when dialog opens
  useEffect(() => {
    if (!open || !session) {
      setSummary('');
      setSummaryMeta(null);
      setSummaryError(null);
      setMessage('');
      return;
    }

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

    setSubmitting(true);
    try {
      await onFork(trimmed, summary, session.task.id);
      onClose();
    } catch {
      // Error handled by parent
    } finally {
      setSubmitting(false);
    }
  };

  const parentBranch = session?.task?.outputBranch;

  return (
    <Dialog isOpen={open && !!session} onClose={onClose} maxWidth="md">
      <div className="grid gap-3">
        <strong className="text-fg-primary text-base">
          Continue from previous session
        </strong>

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
        <label className="grid gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-sm text-fg-muted">Context summary</span>
            {summaryMeta && (
              <span className="text-xs text-fg-muted">
                ({summaryMeta.filteredCount} of {summaryMeta.messageCount} messages, {summaryMeta.method})
              </span>
            )}
          </div>
          {loadingSummary ? (
            <div className="rounded-md border border-border-default bg-surface p-4 text-sm text-fg-muted text-center">
              Generating context summary...
            </div>
          ) : summaryError ? (
            <div className="rounded-md border border-warning/30 bg-warning-tint p-3 text-sm text-fg-muted">
              {summaryError}
            </div>
          ) : (
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={8}
              className="rounded-md border border-border-default bg-surface text-fg-primary p-3 text-sm font-mono resize-y min-h-[120px]"
              placeholder="Context from previous session..."
            />
          )}
        </label>

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
