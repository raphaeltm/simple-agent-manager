import type { DebugDiagnosis, PlatformError } from '@simple-agent-manager/shared';
import { Body, Button, Card, Spinner } from '@simple-agent-manager/ui';
import { type FC, useEffect, useState } from 'react';

import { useAdminErrors } from '../../hooks/useAdminErrors';
import { fetchAdminDebugDiagnoses, runAdminDebugDiagnosis } from '../../lib/api';
import { DebugDiagnosisPanel } from './DebugDiagnosisPanel';
import { ObservabilityFilters } from './ObservabilityFilters';
import { ObservabilityLogEntry } from './ObservabilityLogEntry';

export const ErrorList: FC = () => {
  const [diagnosis, setDiagnosis] = useState<DebugDiagnosis | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosisError, setDiagnosisError] = useState<string | null>(null);
  const [savedDiagnoses, setSavedDiagnoses] = useState<DebugDiagnosis[]>([]);
  const {
    errors, loading, error, hasMore, total, filter, setSource, setLevel,
    setSearch, setTimeRange, loadMore, refresh,
  } = useAdminErrors();

  useEffect(() => {
    fetchAdminDebugDiagnoses({})
      .then(({ diagnoses }) => setSavedDiagnoses(diagnoses))
      .catch(() => { /* A history failure must not hide current errors. */ });
  }, []);

  const diagnose = async (body: { errorId?: string; startTime?: string; endTime?: string }) => {
    setDiagnosing(true);
    setDiagnosis(null);
    setDiagnosisError(null);
    try {
      const result = (await runAdminDebugDiagnosis(body)).diagnosis;
      setDiagnosis(result);
      setSavedDiagnoses((current) => [result, ...current.filter((item) => item.id !== result.id)]);
    } catch (cause) {
      setDiagnosisError(cause instanceof Error ? cause.message : 'Diagnosis failed');
    } finally {
      setDiagnosing(false);
    }
  };

  const diagnoseError = (entry: PlatformError) => { void diagnose({ errorId: entry.id }); };
  const diagnoseWindow = () => {
    const hours = { '1h': 1, '24h': 24, '7d': 24 * 7, '30d': 24 * 30 }[filter.timeRange];
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - Math.min(hours, 24) * 60 * 60 * 1000);
    void diagnose({ startTime: startTime.toISOString(), endTime: endTime.toISOString() });
  };
  const diagnosisWindowLabel = filter.timeRange === '7d' || filter.timeRange === '30d'
    ? 'Diagnose latest 24h'
    : 'Diagnose window';

  return (
    <div>
      <DebugDiagnosisPanel
        diagnosis={diagnosis}
        loading={diagnosing}
        error={diagnosisError}
        onClose={() => { setDiagnosis(null); setDiagnosisError(null); }}
      />
      {error && (
        <div className="p-3 mb-4 rounded-sm bg-danger-tint text-danger-fg text-sm flex justify-between items-center">
          <span>{error}</span>
          <Button size="sm" variant="ghost" onClick={refresh}>Retry</Button>
        </div>
      )}
      <Card>
        <ObservabilityFilters
          source={filter.source}
          level={filter.level}
          search={filter.search}
          timeRange={filter.timeRange}
          onSourceChange={setSource}
          onLevelChange={setLevel}
          onSearchChange={setSearch}
          onTimeRangeChange={setTimeRange}
        />
        <div className="flex flex-wrap justify-between gap-2 items-center px-4 py-2 border-b border-border-default text-xs text-fg-muted">
          <span>{total > 0 ? `Showing ${errors.length} of ${total} errors` : 'No errors found'}</span>
          <div className="flex items-center gap-1">
            {savedDiagnoses.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setDiagnosis(savedDiagnoses[0] ?? null)}>
                Saved diagnoses ({savedDiagnoses.length})
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={diagnoseWindow} disabled={loading || diagnosing}>
              {diagnosisWindowLabel}
            </Button>
            <Button size="sm" variant="ghost" onClick={refresh} disabled={loading}>Refresh</Button>
          </div>
        </div>
        {loading && errors.length === 0 ? (
          <div className="flex justify-center p-8"><Spinner size="lg" /></div>
        ) : errors.length === 0 ? (
          <div className="p-8 text-center"><Body className="text-fg-muted">No errors match the current filters.</Body></div>
        ) : (
          <>
            {errors.map((entry) => (
              <ObservabilityLogEntry key={entry.id} error={entry} onDiagnose={diagnoseError} />
            ))}
            {hasMore && (
              <div className="flex justify-center p-4">
                <Button size="sm" variant="secondary" onClick={loadMore} disabled={loading}>
                  {loading ? 'Loading...' : 'Load More'}
                </Button>
              </div>
            )}
            {loading && errors.length > 0 && <div className="flex justify-center p-3"><Spinner size="sm" /></div>}
          </>
        )}
      </Card>
    </div>
  );
};
