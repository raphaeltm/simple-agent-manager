/**
 * A trigger's runs, newest first, with the two clean-up actions the API offers: delete one
 * finished run, and clear runs stuck in the queue. Both ask first.
 */
import type { TriggerExecutionResponse, TriggerResponse } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatDuration } from '../../components/triggers/trigger-presentation';
import { useQueryScope } from '../../hooks/useQueryScope';
import { cleanupStuckExecutions, deleteExecution } from '../../lib/api/triggers';
import { projectChatPath } from '../../lib/automation-routes';
import { runPagesQueryOptions } from '../../lib/query-options';
import { formatTimeFromNow } from '../../lib/time-utils';
import { useProjectContext } from '../ProjectContext';
import { executionChat } from './activity';
import { executionOutcome, executionText } from './describe';
import { useAutomationAction } from './detail-parts';
import { LoadError, Loading } from './page';
import { fullDate } from './time';
import { OutcomeIcon, Panel, SectionTitle } from './ui';

/** Completed outcomes and unbound startup reservations the API permits deleting. */
const DELETABLE = new Set(['queued', 'failed', 'skipped', 'completed', 'routed', 'dropped']);

const runTime = (run: TriggerExecutionResponse) =>
  run.completedAt ?? run.startedAt ?? run.scheduledAt;

export function useTriggerRuns(triggerId: string) {
  const { projectId } = useProjectContext();
  const queryScope = useQueryScope();
  return useInfiniteQuery({
    ...runPagesQueryOptions(queryScope, projectId, triggerId),
    enabled: Boolean(queryScope),
  });
}

export function TriggerRuns({
  trigger,
  canWrite,
  runs,
}: {
  trigger: TriggerResponse;
  canWrite: boolean;
  runs: ReturnType<typeof useTriggerRuns>;
}) {
  const { projectId } = useProjectContext();
  const [confirmDelete, setConfirmDelete] = useState<TriggerExecutionResponse | null>(null);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const list = runs.data?.pages.flatMap((page) => page.executions) ?? [];
  const stats = trigger.queueStats;
  const retained = [
    trigger.githubConfig?.subjectAffinity && stats?.routed ? `${stats.routed} delivered` : '',
    stats?.dropped ? `${stats.dropped} dropped` : '',
    stats?.unconfirmed ? `${stats.unconfirmed} unconfirmed` : '',
  ].filter(Boolean);
  const queueSummary = [
    stats?.queued ? `${stats.queued} waiting now` : '',
    retained.length ? `Retained history: ${retained.join(' · ')}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const hasQueued = list.some((run) => run.status === 'queued' && !run.queueExpiresAt);

  const remove = useAutomationAction(
    (run: TriggerExecutionResponse) => deleteExecution(projectId, trigger.id, run.id),
    { success: 'Run deleted', failure: 'Could not delete the run' }
  );
  const cleanup = useAutomationAction(() => cleanupStuckExecutions(projectId, trigger.id), {
    success: (result) =>
      result.cleaned === 1 ? 'Cleared 1 stuck run' : `Cleared ${result.cleaned} stuck runs`,
    failure: 'Could not clear the stuck runs',
  });

  return (
    <div className="flex flex-col gap-2" id="runs">
      <SectionTitle
        title="Recent runs"
        count={trigger.triggerCount || undefined}
        hint="Events can start a chat, wait for capacity, or reach an existing chat."
        action={
          canWrite && hasQueued ? (
            <Button
              variant="ghost"
              onClick={() => setConfirmCleanup(true)}
              loading={cleanup.isPending}
            >
              Clear stuck runs
            </Button>
          ) : undefined
        }
      />
      {trigger.sourceType === 'github' && queueSummary && (
        <p className="m-0 text-sm text-fg-muted" data-testid="github-event-queue">
          GitHub events: {queueSummary}
        </p>
      )}
      {runs.isError && list.length === 0 ? (
        <LoadError what="runs" error={runs.error} onRetry={() => void runs.refetch()} />
      ) : runs.isPending ? (
        <Loading label="Loading runs…" />
      ) : (
        <Panel className="overflow-hidden" label="Runs">
          {list.length === 0 ? (
            <p className="m-0 p-4 text-sm text-fg-muted">
              Nothing yet. Runs show up here with what happened and a link to the chat.
            </p>
          ) : (
            <ul className="m-0 list-none p-0">
              {list.map((run) => {
                const chat = executionChat(run);
                return (
                  <li
                    key={run.id}
                    className="flex items-start gap-3 border-0 border-b border-solid border-border-default px-4 py-3 last:border-b-0"
                    data-testid="trigger-run"
                  >
                    <span className="pt-0.5">
                      <OutcomeIcon outcome={executionOutcome(run)} />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="whitespace-pre-wrap text-sm font-semibold text-fg-primary [overflow-wrap:anywhere]">
                        {executionText(run)}
                      </span>
                      {run.subjectKey && (
                        <span className="text-xs text-fg-muted">
                          Issue/PR #{run.subjectKey.split(':').at(-1)}
                        </span>
                      )}
                      <span
                        className="text-xs text-fg-muted"
                        title={fullDate(Date.parse(runTime(run)))}
                      >
                        {formatTimeFromNow(Date.parse(runTime(run)))}
                        {run.startedAt && run.completedAt
                          ? ` · took ${formatDuration(run.startedAt, run.completedAt)}`
                          : ''}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {chat && (
                        <Link
                          to={
                            chat.sessionId
                              ? projectChatPath(projectId, chat.sessionId)
                              : `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(chat.taskId ?? '')}`
                          }
                          aria-label={`Open chat for event ${run.sequenceNumber ?? run.id}`}
                          className="inline-flex min-h-11 items-center rounded-md border border-border-default px-3 text-sm font-semibold text-fg-primary no-underline hover:bg-surface-hover"
                        >
                          Chat
                        </Link>
                      )}
                      {canWrite &&
                        DELETABLE.has(run.status) &&
                        !(run.status === 'queued' && run.queueExpiresAt) && (
                          <button
                            type="button"
                            onClick={() => setConfirmDelete(run)}
                            disabled={remove.isPending}
                            aria-label={`Delete the run from ${fullDate(Date.parse(runTime(run)))}`}
                            className="inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-md border border-border-default bg-transparent text-fg-muted hover:text-danger-fg"
                          >
                            <Trash2 size={16} aria-hidden />
                          </button>
                        )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      )}
      {runs.hasNextPage && (
        <Button
          variant="ghost"
          className="w-fit"
          loading={runs.isFetchingNextPage}
          onClick={() => void runs.fetchNextPage()}
        >
          Show older runs
        </Button>
      )}
      <ConfirmDialog
        isOpen={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) remove.mutate(confirmDelete);
          setConfirmDelete(null);
        }}
        title="Delete this run?"
        message="It disappears from this list. The chat it started, if any, stays."
        confirmLabel="Delete run"
        loading={remove.isPending}
      />
      <ConfirmDialog
        isOpen={confirmCleanup}
        onClose={() => setConfirmCleanup(false)}
        onConfirm={() => {
          cleanup.mutate();
          setConfirmCleanup(false);
        }}
        title="Clear stuck runs?"
        message="Stale startup reservations are marked failed. GitHub events waiting for capacity, durable retry reservations, and active chats are preserved."
        confirmLabel="Clear stuck runs"
        variant="warning"
        loading={cleanup.isPending}
      />
    </div>
  );
}
