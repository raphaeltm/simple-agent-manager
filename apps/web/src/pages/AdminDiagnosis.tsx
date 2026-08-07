import { DEFAULT_DEBUG_DIAGNOSIS_POLL_INTERVAL_MS } from '@simple-agent-manager/shared';
import { Button, Card, Spinner } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { DiagnosticIncidentCard } from '../components/admin/DiagnosticIncidentCard';
import {
  cancelAdminDebugDiagnosisRun,
  fetchAdminDebugDiagnosisRun,
  retryAdminDebugDiagnosisRun,
} from '../lib/api';

const ACTIVE = new Set(['queued', 'running']);

function formatTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'Not yet';
}

export function AdminDiagnosis() {
  const { runId = '' } = useParams();
  const navigate = useNavigate();
  const [pendingAction, setPendingAction] = useState<'cancel' | 'retry' | 'copy' | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelAcceptedRunId, setCancelAcceptedRunId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['admin-diagnosis', runId],
    queryFn: () => fetchAdminDebugDiagnosisRun(runId),
    enabled: Boolean(runId),
    refetchInterval: ({ state }) =>
      ACTIVE.has(state.data?.run.status ?? '') || state.data?.run.incident?.status === 'pending'
        ? DEFAULT_DEBUG_DIAGNOSIS_POLL_INTERVAL_MS
        : false,
    retry: (failureCount, error) =>
      !(
        error instanceof Error &&
        error.message.startsWith('Diagnosis event pagination did not make bounded forward progress')
      ) && failureCount < 3,
  });
  const run = query.data?.run;
  const events = query.data?.events ?? [];

  if (query.isLoading)
    return (
      <div className="flex justify-center p-12">
        <Spinner size="lg" />
      </div>
    );
  if (query.error || !run) {
    return (
      <Card className="p-5">
        <h1 className="text-lg font-semibold">Diagnosis unavailable</h1>
        <p className="mt-2 text-sm text-fg-muted">
          {query.error instanceof Error ? query.error.message : 'The run could not be loaded.'}
        </p>
        <Button className="mt-4" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </Card>
    );
  }

  const retry = async () => {
    setPendingAction('retry');
    setActionError(null);
    setActionMessage(null);
    try {
      const next = (await retryAdminDebugDiagnosisRun(run.id)).run;
      if (!next) throw new Error('The retry was accepted without a new run');
      setActionMessage('Retry accepted. Opening the new run.');
      navigate(`/admin/diagnoses/${next.id}`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Retry failed');
    } finally {
      setPendingAction(null);
    }
  };
  const cancel = async () => {
    setPendingAction('cancel');
    setActionError(null);
    setActionMessage(null);
    try {
      await cancelAdminDebugDiagnosisRun(run.id);
      setCancelAcceptedRunId(run.id);
      setActionMessage(
        'Cancellation requested. The durable runner will stop at the next checkpoint.'
      );
      await query.refetch();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Cancellation failed');
    } finally {
      setPendingAction(null);
    }
  };
  const copy = async () => {
    setPendingAction('copy');
    setActionError(null);
    setActionMessage(null);
    try {
      await navigator.clipboard.writeText(
        [
          `Diagnosis run ${run.id}`,
          `Status: ${run.status}`,
          run.errorMessage ?? run.diagnosis?.diagnosis ?? '',
        ].join('\n')
      );
      setActionMessage('Diagnosis copied.');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Copy failed');
    } finally {
      setPendingAction(null);
    }
  };

  const systems = new Map<string, string>();
  for (const event of events) if (event.sourceName) systems.set(event.sourceName, event.status);
  const cancelAccepted = cancelAcceptedRunId === run.id;

  return (
    <div className="mx-auto max-w-6xl space-y-4 pb-8">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (window.history.length > 1) {
                navigate(-1);
              } else {
                navigate('/admin/diagnoses');
              }
            }}
          >
            ← Back
          </Button>
          <h1 className="mt-2 text-xl font-semibold text-fg-primary">Diagnostic run</h1>
          <p className="mt-1 break-all font-mono text-xs text-fg-muted">{run.id}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={pendingAction !== null}
            onClick={() => void copy()}
          >
            {pendingAction === 'copy' ? 'Copying…' : 'Copy'}
          </Button>
          {ACTIVE.has(run.status) && (
            <Button
              size="sm"
              variant="secondary"
              disabled={pendingAction !== null || cancelAccepted}
              onClick={() => void cancel()}
            >
              {pendingAction === 'cancel'
                ? 'Cancelling…'
                : cancelAccepted
                  ? 'Cancellation requested'
                  : 'Cancel'}
            </Button>
          )}
          {['failed', 'cancelled'].includes(run.status) && (
            <Button size="sm" disabled={pendingAction !== null} onClick={() => void retry()}>
              {pendingAction === 'retry' ? 'Retrying…' : 'Retry'}
            </Button>
          )}
        </div>
      </div>
      {(actionMessage || actionError) && (
        <div
          role={actionError ? 'alert' : 'status'}
          aria-live="polite"
          className={actionError ? 'text-sm text-danger-fg' : 'text-sm text-fg-muted'}
        >
          {actionError ?? actionMessage}
        </div>
      )}

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-surface-secondary px-2.5 py-1 text-xs font-semibold uppercase text-fg-primary">
            {run.status}
          </span>
          <span className="text-sm text-fg-muted">
            {run.errorId
              ? `Error ${run.errorId}`
              : `${formatTime(run.startTime)} – ${formatTime(run.endTime)}`}
          </span>
        </div>
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="text-xs text-fg-muted">Current step</div>
            <div className="mt-1 font-medium">{run.currentStep ?? 'Accepted'}</div>
          </div>
          <div>
            <div className="text-xs text-fg-muted">Heartbeat</div>
            <div className="mt-1">{formatTime(run.heartbeatAt)}</div>
          </div>
          <div>
            <div className="text-xs text-fg-muted">Deadline</div>
            <div className="mt-1">{formatTime(run.deadlineAt)}</div>
          </div>
          <div>
            <div className="text-xs text-fg-muted">Usage</div>
            <div className="mt-1">
              {run.usage.turns} turns · {run.usage.totalTokens} tokens
            </div>
          </div>
        </div>
      </Card>

      <DiagnosticIncidentCard errorId={run.errorId} incident={run.incident ?? null} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Card className="overflow-hidden">
          <h2 className="border-b border-border-default px-4 py-3 text-sm font-semibold">
            Timeline
          </h2>
          {events.length === 0 ? (
            <p className="p-4 text-sm text-fg-muted">
              Accepted. Waiting for the durable executor’s first checkpoint.
            </p>
          ) : (
            <ol aria-label="Diagnosis event timeline" className="divide-y divide-border-default">
              {events.map((event) => (
                <li key={event.id} className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="text-sm">
                      {event.sourceName ?? event.eventType.replaceAll('_', ' ')}
                    </strong>
                    <span className="text-xs uppercase text-fg-muted">{event.status}</span>
                  </div>
                  <div className="mt-1 text-xs text-fg-muted">
                    {formatTime(event.createdAt)}
                    {event.durationMs !== null ? ` · ${event.durationMs}ms` : ''}
                    {event.retryAttempt ? ` · retry ${event.retryAttempt}` : ''}
                  </div>
                  {event.argumentsPreview && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-fg-muted">
                        Redacted scope
                      </summary>
                      <pre className="mt-2 max-w-full overflow-auto whitespace-pre-wrap break-words rounded bg-surface-secondary p-2 text-xs">
                        {event.argumentsPreview}
                      </pre>
                    </details>
                  )}
                  {event.evidencePreview && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-fg-muted">
                        Redacted evidence preview
                      </summary>
                      <pre className="mt-2 max-w-full overflow-auto whitespace-pre-wrap break-words rounded bg-surface-secondary p-2 text-xs">
                        {event.evidencePreview}
                      </pre>
                    </details>
                  )}
                  {event.errorMessage && (
                    <p className="mt-2 break-words text-sm text-danger-fg">{event.errorMessage}</p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </Card>
        <Card className="h-fit p-4">
          <h2 className="text-sm font-semibold">Systems examined</h2>
          {systems.size ? (
            <ul className="mt-3 space-y-2">
              {[...systems].map(([name, status]) => (
                <li key={name} className="flex justify-between gap-3 text-sm">
                  <span className="break-words">{name.replaceAll('_', ' ')}</span>
                  <span className="text-xs uppercase text-fg-muted">{status}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-fg-muted">No evidence source has completed yet.</p>
          )}
        </Card>
      </div>

      {run.errorMessage && (
        <Card className="border-danger-border p-4">
          <h2 className="font-semibold text-danger-fg">Run failed safely</h2>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm">{run.errorMessage}</p>
        </Card>
      )}
      {run.diagnosis && (
        <Card className="p-4">
          <h2 className="text-base font-semibold">Completed diagnosis</h2>
          <div className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">
            {run.diagnosis.diagnosis}
          </div>
        </Card>
      )}
      {query.isFetching && !ACTIVE.has(run.status) && run.incident?.status !== 'pending' && (
        <p className="text-xs text-fg-muted">Refreshing…</p>
      )}
    </div>
  );
}
