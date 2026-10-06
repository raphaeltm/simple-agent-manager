import type { ProjectSchedule } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { useState } from 'react';
import { Link } from 'react-router';

import { reconcileSchedule } from '../../lib/project-events-api';
import { dateLabel, Feedback, linkClass, StateBadge, useEventAction } from './EventUi';

export function ScheduleExecution({
  schedule,
  projectId,
  canWrite,
  onChanged,
}: {
  schedule: ProjectSchedule;
  projectId: string;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const operation = useEventAction();
  const [confirmVersion, setConfirmVersion] = useState<number | null>(null);
  const execution = schedule.execution;
  const canRetry =
    schedule.action.kind === 'start_session' && execution?.retrySubmissionAllowed === true;
  const recover = (retrySubmission: boolean) =>
    void operation.run(async () => {
      const result = await reconcileSchedule(projectId, schedule.id, {
        expectedVersion: retrySubmission ? (confirmVersion ?? schedule.version) : schedule.version,
        ...(retrySubmission ? { retrySubmission: true } : {}),
      });
      setConfirmVersion(null);
      onChanged();
      return (
        result.recovery?.message ?? 'Receipt checked. Refresh the schedule for current status.'
      );
    });

  return (
    <section
      aria-label="Action execution"
      className="min-w-0 border-t border-border-default pt-3 space-y-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="m-0 text-sm font-semibold">Action execution</h4>
        <StateBadge state={execution?.status ?? 'unavailable'} />
      </div>
      <p className="m-0 text-xs text-fg-muted">
        Schedule state tracks admission. Execution tracks the{' '}
        {schedule.action.kind === 'message_session' ? 'session message receipt' : 'resulting task'};
        acceptance does not confirm completed work.
      </p>
      {execution ? (
        <>
          <p className="m-0 text-xs text-fg-muted break-words">
            Checked {dateLabel(execution.checkedAt)}
            {execution.receiptState
              ? ` · Submission receipt: ${execution.receiptState.replaceAll('_', ' ')}`
              : ''}
          </p>
          {execution.error && (
            <p className="m-0 text-sm text-danger break-words">
              Execution error: {execution.error}
            </p>
          )}
          {execution.sessionId && execution.sessionId !== schedule.resultSessionId && (
            <Link className={linkClass} to={`/projects/${projectId}/chat/${execution.sessionId}`}>
              Open execution session
            </Link>
          )}
          {execution.taskId && (
            <p className="m-0 text-xs text-fg-muted break-words">Task: {execution.taskId}</p>
          )}
        </>
      ) : (
        <p className="m-0 text-sm text-fg-muted">
          Execution evidence is unavailable. Refresh to check again.
        </p>
      )}
      <Feedback error={operation.error} message={operation.message} />
      {Boolean(operation.error) && (
        <p className="m-0 text-xs text-fg-muted">
          The request outcome may be unknown. Reconcile the receipt before deciding whether to retry
          submission.
        </p>
      )}
      {canWrite && (
        <div className="space-y-3">
          <Button variant="secondary" loading={operation.busy} onClick={() => recover(false)}>
            Reconcile receipt
          </Button>
          <p className="m-0 text-xs text-fg-muted">
            Checks existing evidence without waking a session or replaying its message.
          </p>
          {canRetry &&
            (confirmVersion === null ? (
              <Button
                variant="secondary"
                disabled={operation.busy}
                onClick={() => setConfirmVersion(schedule.version)}
              >
                Retry task submission
              </Button>
            ) : (
              <div className="space-y-2">
                <p className="m-0 text-sm">
                  Retry submitting this task? This may start a session and consume compute. It uses
                  the same task identity and original deadline
                  {execution?.submissionDeadline
                    ? ` (${dateLabel(execution.submissionDeadline)})`
                    : ''}
                  .
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button loading={operation.busy} onClick={() => recover(true)}>
                    Confirm task submission retry
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={operation.busy}
                    onClick={() => setConfirmVersion(null)}
                  >
                    Keep current submission
                  </Button>
                </div>
              </div>
            ))}
        </div>
      )}
    </section>
  );
}
