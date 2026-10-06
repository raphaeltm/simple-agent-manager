import type { DebugDiagnosisRun } from '@simple-agent-manager/shared';
import { Body, Button, Card, Spinner } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import { fetchAdminDebugDiagnoses, retryAdminDebugDiagnosisRun } from '../lib/api';

function formatTime(value: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  completed: { bg: 'var(--sam-color-success-tint)', text: 'var(--sam-color-success)' },
  running: { bg: 'var(--sam-color-info-tint)', text: 'var(--sam-color-info-fg)' },
  queued: { bg: 'var(--sam-color-info-tint)', text: 'var(--sam-color-info-fg)' },
  failed: { bg: 'var(--sam-color-danger-tint)', text: 'var(--sam-color-danger-fg)' },
  cancelled: { bg: 'var(--sam-color-warning-tint)', text: 'var(--sam-color-warning-fg)' },
};

export function AdminDiagnoses() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<DebugDiagnosisRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const { runs: r } = await fetchAdminDebugDiagnoses({});
      setRuns(r ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load diagnoses');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRetry = useCallback(
    async (runId: string) => {
      try {
        const result = (await retryAdminDebugDiagnosisRun(runId)).run;
        if (result) navigate('/admin/diagnoses/' + result.id);
      } catch {
        /* retry errors shown on the detail page */
      }
    },
    [navigate],
  );

  return (
    <Card>
      <div className="flex items-center justify-between border-b border-border-default px-4 py-3">
        <span className="text-sm font-medium text-fg-primary">All diagnosis runs</span>
        <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
          Refresh
        </Button>
      </div>

      {loading && runs.length === 0 ? (
        <div className="flex justify-center p-8">
          <Spinner size="lg" />
        </div>
      ) : error ? (
        <div className="p-6 text-center">
          <Body className="text-danger-fg">{error}</Body>
          <Button size="sm" variant="secondary" className="mt-3" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : runs.length === 0 ? (
        <div className="p-8 text-center">
          <Body className="text-fg-muted">
            No diagnosis runs yet. Start one from the Errors tab.
          </Body>
        </div>
      ) : (
        <div className="divide-y divide-border-default">
          {runs.map((run) => {
            const style = STATUS_STYLES[run.status] ?? { bg: 'var(--sam-color-info-tint)', text: 'var(--sam-color-info-fg)' };
            return (
              <div
                key={run.id}
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <button
                  type="button"
                  className="min-w-0 text-left text-sm text-fg-primary hover:underline"
                  onClick={() => navigate('/admin/diagnoses/' + run.id)}
                >
                  <span
                    className="mr-2 inline-flex items-center rounded-full px-2 py-0.5 text-[0.65rem] font-semibold uppercase"
                    style={{ backgroundColor: style.bg, color: style.text }}
                  >
                    {run.status}
                  </span>
                  <span className="text-fg-muted">
                    {run.errorId
                      ? `Error ${run.errorId.slice(0, 10)}…`
                      : `${formatTime(run.startTime)} → ${formatTime(run.endTime)}`}
                  </span>
                </button>
                <div className="flex items-center gap-2">
                  {run.currentStep && (
                    <span className="text-xs text-fg-muted">{run.currentStep}</span>
                  )}
                  {run.status === 'failed' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void handleRetry(run.id)}
                    >
                      Retry
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => navigate('/admin/diagnoses/' + run.id)}
                  >
                    Open
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
