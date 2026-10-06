import type { DebugDiagnosis, DebugDiagnosisRun, PlatformError } from '@simple-agent-manager/shared';
import { Body, Button, Card, Spinner } from '@simple-agent-manager/ui';
import { type FC, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { useAdminErrors } from '../../hooks/useAdminErrors';
import {
  fetchAdminDebugDiagnoses,
  retryAdminDebugDiagnosisRun,
  runAdminDebugDiagnosis,
} from '../../lib/api';
import { DebugDiagnosisPanel } from './DebugDiagnosisPanel';
import { ObservabilityFilters } from './ObservabilityFilters';
import { ObservabilityLogEntry } from './ObservabilityLogEntry';

export const ErrorList: FC = () => {
  const navigate = useNavigate();
  const [diagnosis, setDiagnosis] = useState<DebugDiagnosis | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosisError, setDiagnosisError] = useState<string | null>(null);
  const [savedDiagnoses, setSavedDiagnoses] = useState<DebugDiagnosis[]>([]);
  const [diagnosisRuns, setDiagnosisRuns] = useState<DebugDiagnosisRun[]>([]);
  const [diagnosisPickerOpen, setDiagnosisPickerOpen] = useState(false);
  const {
    errors,
    loading,
    error,
    hasMore,
    total,
    filter,
    setSource,
    setLevel,
    setSearch,
    setTimeRange,
    setNodeId,
    setWorkspaceId,
    setTaskId,
    setSessionId,
    setUserId,
    loadMore,
    refresh,
    autoRefresh,
    setAutoRefresh,
  } = useAdminErrors();

  useEffect(() => {
    fetchAdminDebugDiagnoses({})
      .then(({ diagnoses, runs }) => {
        setSavedDiagnoses(diagnoses);
        setDiagnosisRuns(runs ?? []);
      })
      .catch(() => {});
  }, []);

  const diagnosedErrorIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of diagnosisRuns) {
      if (run.errorId) ids.add(run.errorId);
    }
    for (const d of savedDiagnoses) {
      if (d.errorId) ids.add(d.errorId);
    }
    return ids;
  }, [diagnosisRuns, savedDiagnoses]);

  const diagnose = useCallback(
    async (body: { errorId?: string; startTime?: string; endTime?: string }) => {
      setDiagnosing(true);
      setDiagnosis(null);
      setDiagnosisError(null);
      try {
        const response = await runAdminDebugDiagnosis(body);
        const run = response.run;
        const completedDiagnosis = response.diagnosis;
        if (run) {
          setDiagnosisRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
          navigate('/admin/diagnoses/' + run.id);
        } else if (completedDiagnosis) {
          setDiagnosis(completedDiagnosis);
          setSavedDiagnoses((current) => [
            completedDiagnosis,
            ...current.filter((item) => item.id !== completedDiagnosis.id),
          ]);
        }
      } catch (cause) {
        setDiagnosisError(cause instanceof Error ? cause.message : 'Diagnosis failed');
      } finally {
        setDiagnosing(false);
      }
    },
    [navigate],
  );

  const diagnoseError = useCallback(
    (entry: PlatformError) => {
      void diagnose({ errorId: entry.id });
    },
    [diagnose],
  );

  const diagnoseWindow = useCallback(() => {
    const hours = { '1h': 1, '24h': 24, '7d': 24 * 7, '30d': 24 * 30 }[filter.timeRange];
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - Math.min(hours, 24) * 60 * 60 * 1000);
    void diagnose({ startTime: startTime.toISOString(), endTime: endTime.toISOString() });
  }, [filter.timeRange, diagnose]);

  const diagnosisWindowLabel =
    filter.timeRange === '7d' || filter.timeRange === '30d'
      ? 'Diagnose latest 24h'
      : 'Diagnose window';

  const retryRun = useCallback(
    async (runId: string) => {
      setDiagnosisError(null);
      try {
        const result = (await retryAdminDebugDiagnosisRun(runId)).run;
        if (result) navigate('/admin/diagnoses/' + result.id);
      } catch (cause) {
        setDiagnosisError(cause instanceof Error ? cause.message : 'Retry failed');
      }
    },
    [navigate],
  );

  const openRun = useCallback(
    (run: DebugDiagnosisRun) => navigate('/admin/diagnoses/' + run.id),
    [navigate],
  );

  return (
    <div>
      <DebugDiagnosisPanel
        diagnosis={diagnosis}
        loading={diagnosing}
        error={diagnosisError}
        onClose={() => {
          setDiagnosis(null);
          setDiagnosisError(null);
        }}
      />
      {diagnosisRuns.length > 0 && (
        <Card className="mb-4">
          <div className="border-b border-border-default px-4 py-3 text-sm font-medium text-fg-primary">
            Recent diagnosis runs
          </div>
          <div className="divide-y divide-border-default">
            {diagnosisRuns.slice(0, 8).map((run) => (
              <div
                key={run.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
              >
                <button
                  className="min-w-0 text-left text-fg-primary hover:underline"
                  onClick={() => openRun(run)}
                >
                  <span className="font-medium">{run.status}</span>
                  <span className="ml-2 text-fg-muted">
                    {run.errorId
                      ? `Error ${run.errorId}`
                      : `${run.startTime} → ${run.endTime}`}
                  </span>
                </button>
                <div className="flex items-center gap-2">
                  {(run.status === 'queued' || run.status === 'running') && (
                    <span className="text-xs text-fg-muted">Durable execution active</span>
                  )}
                  {run.status === 'failed' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        void retryRun(run.id);
                      }}
                    >
                      Retry
                    </Button>
                  )}
                  {run.diagnosis && (
                    <Button size="sm" variant="ghost" onClick={() => openRun(run)}>
                      Open
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
      {error && (
        <div className="mb-4 flex items-center justify-between rounded-sm bg-danger-tint p-3 text-sm text-danger-fg">
          <span>{error}</span>
          <Button size="sm" variant="ghost" onClick={refresh}>
            Retry
          </Button>
        </div>
      )}
      <Card>
        <ObservabilityFilters
          source={filter.source}
          level={filter.level}
          search={filter.search}
          timeRange={filter.timeRange}
          nodeId={filter.nodeId}
          workspaceId={filter.workspaceId}
          taskId={filter.taskId}
          sessionId={filter.sessionId}
          userId={filter.userId}
          autoRefresh={autoRefresh}
          onSourceChange={setSource}
          onLevelChange={setLevel}
          onSearchChange={setSearch}
          onTimeRangeChange={setTimeRange}
          onNodeIdChange={setNodeId}
          onWorkspaceIdChange={setWorkspaceId}
          onTaskIdChange={setTaskId}
          onSessionIdChange={setSessionId}
          onUserIdChange={setUserId}
          onAutoRefreshChange={setAutoRefresh}
        />
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-default px-4 py-2 text-xs text-fg-muted">
          <span>
            {total > 0 ? `Showing ${errors.length} of ${total} errors` : 'No errors found'}
            {autoRefresh && ' · auto-refreshing'}
          </span>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
            {savedDiagnoses.length > 0 && (
              <div className="relative">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDiagnosisPickerOpen(!diagnosisPickerOpen)}
                >
                  Saved diagnoses ({savedDiagnoses.length})
                </Button>
                {diagnosisPickerOpen && (
                  <DiagnosisPicker
                    diagnoses={savedDiagnoses}
                    onSelect={(d) => {
                      setDiagnosis(d);
                      setDiagnosisPickerOpen(false);
                    }}
                    onClose={() => setDiagnosisPickerOpen(false)}
                  />
                )}
              </div>
            )}
            <Button
              size="sm"
              variant="secondary"
              onClick={diagnoseWindow}
              disabled={loading || diagnosing}
            >
              {diagnosisWindowLabel}
            </Button>
            <Button size="sm" variant="ghost" onClick={refresh} disabled={loading}>
              Refresh
            </Button>
          </div>
        </div>
        {loading && errors.length === 0 ? (
          <div className="flex justify-center p-8">
            <Spinner size="lg" />
          </div>
        ) : errors.length === 0 ? (
          <div className="p-8 text-center">
            <Body className="text-fg-muted">No errors match the current filters.</Body>
          </div>
        ) : (
          <>
            {errors.map((entry) => (
              <ObservabilityLogEntry
                key={entry.id}
                error={entry}
                onDiagnose={diagnoseError}
                diagnosed={diagnosedErrorIds.has(entry.id)}
              />
            ))}
            {hasMore && (
              <div className="flex justify-center p-4">
                <Button size="sm" variant="secondary" onClick={loadMore} disabled={loading}>
                  {loading ? 'Loading...' : 'Load More'}
                </Button>
              </div>
            )}
            {loading && errors.length > 0 && (
              <div className="flex justify-center p-3">
                <Spinner size="sm" />
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
};

const DiagnosisPicker: FC<{
  diagnoses: DebugDiagnosis[];
  onSelect: (d: DebugDiagnosis) => void;
  onClose: () => void;
}> = ({ diagnoses, onSelect, onClose }) => {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-diagnosis-picker]')) {
        onClose();
      }
    };
    document.addEventListener('click', handler, true);
    return () => document.removeEventListener('click', handler, true);
  }, [onClose]);

  return (
    <div
      data-diagnosis-picker
      className="absolute right-0 top-full z-10 mt-1 max-h-64 w-72 overflow-auto rounded-sm border border-border-default bg-surface-primary shadow-lg"
    >
      {diagnoses.map((d) => (
        <button
          key={d.id}
          type="button"
          onClick={() => onSelect(d)}
          className="block w-full px-3 py-2 text-left text-sm text-fg-primary hover:bg-surface-hover"
        >
          <div className="truncate font-medium">
            {d.errorId ? `Error ${d.errorId.slice(0, 8)}…` : 'Window diagnosis'}
          </div>
          <div className="truncate text-xs text-fg-muted">
            {d.diagnosis?.slice(0, 80) ?? 'No summary'}
          </div>
        </button>
      ))}
    </div>
  );
};
