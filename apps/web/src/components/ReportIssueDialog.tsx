import type { ReportIssueRefs, ReportIssueResponse } from '@simple-agent-manager/shared';
import { DEFAULT_REPORT_ISSUE_DESCRIPTION_MAX_LENGTH, DEFAULT_REPORT_ISSUE_TITLE_MAX_LENGTH } from '@simple-agent-manager/shared';
import { Button, Dialog } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

import { submitReportIssue } from '../lib/api';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  refs?: ReportIssueRefs;
}

const REF_LABELS: Record<string, string> = {
  sessionId: 'Chat session',
  taskId: 'Task',
  nodeId: 'Node',
  errorId: 'Error',
  diagnosisId: 'Diagnosis',
};

type DialogState =
  | { step: 'form' }
  | { step: 'submitting' }
  | { step: 'success'; result: ReportIssueResponse }
  | { step: 'error'; message: string };

export function ReportIssueDialog({ isOpen, onClose, refs }: Props) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [consentToAttachRefs, setConsentToAttachRefs] = useState(false);
  const [state, setState] = useState<DialogState>({ step: 'form' });
  const titleRef = useRef<HTMLInputElement>(null);

  const availableRefs = refs
    ? Object.entries(refs).filter(([, v]) => !!v)
    : [];

  const reset = useCallback(() => {
    setTitle('');
    setDescription('');
    setConsentToAttachRefs(false);
    setState({ step: 'form' });
  }, []);

  useEffect(() => {
    if (isOpen) {
      reset();
      requestAnimationFrame(() => titleRef.current?.focus());
    }
  }, [isOpen, reset]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !description.trim()) return;

    setState({ step: 'submitting' });
    try {
      const result = await submitReportIssue({
        title: title.trim(),
        description: description.trim(),
        consentToAttachRefs,
        refs: consentToAttachRefs ? refs : undefined,
      });
      setState({ step: 'success', result });
    } catch (err) {
      setState({
        step: 'error',
        message: err instanceof Error && err.message ? err.message : 'Failed to submit report',
      });
    }
  };

  const isSubmitting = state.step === 'submitting';

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  return (
    <Dialog isOpen={isOpen} onClose={handleClose} maxWidth="md" aria-label="Report an issue">
      <div className="p-5">
        {state.step === 'success' ? (
          <div className="space-y-4" role="alert">
            <h2 className="m-0 text-base font-semibold text-fg-primary">Report submitted</h2>
            <div className="rounded-md bg-success-tint p-3 text-sm text-success-fg">
              {state.result.message}
            </div>
            <dl className="space-y-1.5 text-sm">
              <div className="flex gap-2">
                <dt className="font-medium text-fg-muted">Report ID:</dt>
                <dd className="font-mono text-fg-secondary">{state.result.ideaId}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-medium text-fg-muted">Status:</dt>
                <dd className="text-fg-secondary">{state.result.status}</dd>
              </div>
              {state.result.attachedRefKeys.length > 0 && (
                <div className="flex gap-2">
                  <dt className="font-medium text-fg-muted">Refs attached:</dt>
                  <dd className="text-fg-secondary">
                    {state.result.attachedRefKeys.map((k) => REF_LABELS[k] || k).join(', ')}
                  </dd>
                </div>
              )}
            </dl>
            <div className="flex justify-end pt-2">
              <Button size="sm" variant="secondary" onClick={handleClose}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <h2 className="m-0 text-base font-semibold text-fg-primary">Report an issue</h2>
            <p className="m-0 text-sm text-fg-muted">
              Describe what went wrong. Your report will be reviewed by the platform team.
            </p>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-fg-muted">Title</span>
              <input
                ref={titleRef}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Brief summary of the issue"
                maxLength={DEFAULT_REPORT_ISSUE_TITLE_MAX_LENGTH}
                required
                className="w-full rounded-md border border-border-default bg-surface px-3 py-2.5 text-sm text-fg-primary placeholder:text-fg-muted min-h-11"
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-fg-muted">Description</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What happened? What did you expect?"
                maxLength={DEFAULT_REPORT_ISSUE_DESCRIPTION_MAX_LENGTH}
                required
                rows={4}
                className="w-full rounded-md border border-border-default bg-surface px-3 py-2.5 text-sm text-fg-primary placeholder:text-fg-muted resize-y"
              />
            </label>

            {availableRefs.length > 0 && (
              <div className="space-y-2 rounded-md border border-border-default p-3">
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={consentToAttachRefs}
                    onChange={(e) => setConsentToAttachRefs(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-border-default accent-accent-primary"
                  />
                  <span className="text-sm text-fg-secondary">
                    Attach technical references to help diagnose this issue
                  </span>
                </label>
                {consentToAttachRefs && (
                  <ul className="ml-7 space-y-0.5 text-xs text-fg-muted">
                    {availableRefs.map(([key, value]) => (
                      <li key={key}>
                        <span className="font-medium">{REF_LABELS[key] || key}:</span>{' '}
                        <code className="rounded bg-inset px-1 py-0.5 font-mono text-[11px]">
                          {value}
                        </code>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {state.step === 'error' && (
              <div className="rounded-md bg-danger-tint p-3 text-sm text-danger-fg" role="alert">
                {state.message}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" size="sm" variant="ghost" onClick={handleClose} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                variant="primary"
                disabled={isSubmitting || !title.trim() || !description.trim()}
              >
                {isSubmitting ? 'Submitting…' : 'Submit report'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}
