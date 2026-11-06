import {
  Button,
  buttonClassName,
  Chip,
  type ChipTone,
  Dialog,
  Spinner,
} from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, ListTodo } from 'lucide-react';
import { useId } from 'react';
import { Link } from 'react-router';

import { useQueryScope } from '../../../hooks/useQueryScope';
import { taskDetailQueryOptions } from '../../../lib/query-options/tasks';

const STATUS_LABEL: Record<string, { label: string; tone: ChipTone }> = {
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
  in_progress: { label: 'Running', tone: 'info' },
  sleeping: { label: 'Asleep', tone: 'muted' },
  queued: { label: 'Queued', tone: 'neutral' },
};

function statusChip(status: string) {
  const known = STATUS_LABEL[status] ?? {
    label: status.replace(/_/g, ' '),
    tone: 'neutral' as const,
  };
  return (
    <Chip size="sm" tone={known.tone} dot>
      {known.label}
    </Chip>
  );
}

/** A task a notice points at, read live from the task API (the notice only has a snapshot). */
export function TaskQuickLookDialog({
  projectId,
  taskId,
  onClose,
}: {
  projectId: string;
  taskId: string | null;
  onClose: () => void;
}) {
  const queryScope = useQueryScope();
  const titleId = useId();
  const task = useQuery({
    ...taskDetailQueryOptions(queryScope, projectId, taskId ?? ''),
    enabled: taskId !== null,
  });
  const data = task.data;
  // Agents write outputPrUrl; only link it when it is a web URL.
  const prUrl =
    data?.outputPrUrl && /^https?:\/\//i.test(data.outputPrUrl) ? data.outputPrUrl : null;

  return (
    <Dialog isOpen={taskId !== null} onClose={onClose} aria-labelledby={titleId} maxWidth="lg">
      <div className="p-5" data-testid="sam-notice-task-dialog">
        <div className="mb-1 flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-wide text-fg-muted">
          <ListTodo size={13} aria-hidden="true" /> Task
        </div>
        {task.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-fg-muted">
            <Spinner size="sm" /> Loading task…
          </div>
        ) : !data ? (
          <p id={titleId} className="m-0 py-4 text-sm text-fg-muted">
            This task could not be loaded. It may have been deleted.
          </p>
        ) : (
          <>
            <h2 id={titleId} className="m-0 mb-3 break-words text-lg font-semibold text-fg-primary">
              {data.title}
            </h2>
            <div className="mb-4 flex flex-wrap gap-2">{statusChip(data.status)}</div>
            {data.outputBranch && (
              <dl className="m-0 mb-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
                <dt className="text-fg-muted">Branch</dt>
                <dd className="m-0 break-all font-mono text-fg-primary">{data.outputBranch}</dd>
              </dl>
            )}
            {(data.outputSummary || data.errorMessage) && (
              <>
                <h3 className="m-0 mb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">
                  {data.errorMessage && data.status === 'failed'
                    ? 'What went wrong'
                    : 'What it did'}
                </h3>
                <p className="m-0 mb-5 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-fg-primary">
                  {data.status === 'failed' && data.errorMessage
                    ? data.errorMessage
                    : data.outputSummary}
                </p>
              </>
            )}
          </>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="raised" size="sm" onClick={onClose}>
            Close
          </Button>
          {taskId && (
            <Link
              to={`/projects/${projectId}/tasks/${taskId}`}
              onClick={onClose}
              className={buttonClassName({ variant: 'raised', size: 'sm' })}
            >
              Open its chat
            </Link>
          )}
          {prUrl && (
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClassName({ variant: 'accent', size: 'sm' })}
            >
              View pull request <ExternalLink size={13} aria-hidden="true" />
            </a>
          )}
        </div>
      </div>
    </Dialog>
  );
}
