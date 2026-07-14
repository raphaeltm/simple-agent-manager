import type {
  TriggerExecutionResponse,
  TriggerResponse,
  UpdateTriggerRequest,
} from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import {
  ArrowLeft,
  Calendar,
  CheckCircle,
  Clock,
  Pause,
  Pencil,
  Play,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { ExecutionHistory } from '../components/triggers/ExecutionHistory';
import { TriggerConfiguration } from '../components/triggers/TriggerConfiguration';
import { TriggerCredentialWarning } from '../components/triggers/TriggerCredentialWarning';
import { TriggerForm } from '../components/triggers/TriggerForm';
import { WebhookTriggerPanel } from '../components/triggers/WebhookTriggerPanel';
import { useToast } from '../hooks/useToast';
import {
  deleteTrigger,
  getTrigger,
  listTriggerExecutions,
  runTrigger,
  updateTrigger,
} from '../lib/api';
import { useProjectContext } from './ProjectContext';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

const STATUS_CONFIG: Record<string, { color: string; label: string }> = {
  active: { color: 'var(--sam-color-success)', label: 'Active' },
  paused: { color: 'var(--sam-color-warning)', label: 'Paused' },
  disabled: { color: 'var(--sam-color-fg-muted)', label: 'Disabled' },
};

const EXECUTIONS_PER_PAGE = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDateFull(dateStr: string): string {
  return new Date(dateStr).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt || !completedAt) return '—';
  const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (durationMs < 1000) return '<1s';
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ProjectTriggerDetail() {
  const { projectId } = useProjectContext();
  const { triggerId } = useParams<{ triggerId: string }>();
  const navigate = useNavigate();
  const toast = useToast();

  const [trigger, setTrigger] = useState<TriggerResponse | null>(null);
  const [executions, setExecutions] = useState<TriggerExecutionResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [execLoading, setExecLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextExecutionCursor, setNextExecutionCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadTrigger = useCallback(async () => {
    if (!triggerId) return;
    try {
      const resp = await getTrigger(projectId, triggerId);
      setTrigger(resp);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trigger');
    } finally {
      setLoading(false);
    }
  }, [projectId, triggerId]);

  const [execError, setExecError] = useState<string | null>(null);

  const loadExecutions = useCallback(
    async (cursor: string | null = null) => {
      if (!triggerId) return;
      const offset = cursor ? Number.parseInt(cursor, 10) : 0;
      setExecLoading(true);
      setExecError(null);
      try {
        const resp = await listTriggerExecutions(projectId, triggerId, {
          limit: EXECUTIONS_PER_PAGE,
          offset: Number.isFinite(offset) ? offset : 0,
        });
        if (cursor) {
          setExecutions((prev) => [...prev, ...resp.executions]);
        } else {
          setExecutions(resp.executions);
        }
        setNextExecutionCursor(resp.nextCursor ?? null);
        setHasMore(Boolean(resp.nextCursor));
      } catch (err) {
        setExecError(err instanceof Error ? err.message : 'Failed to load executions');
      } finally {
        setExecLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps -- toast removed per stale-while-revalidate rule
    },
    [projectId, triggerId]
  );

  useEffect(() => {
    loadTrigger().catch(() => undefined);
    loadExecutions(null).catch(() => undefined);
  }, [loadTrigger, loadExecutions]);

  const handleRunNow = useCallback(async () => {
    if (!triggerId) return;
    try {
      await runTrigger(projectId, triggerId);
      toast.success('Trigger fired');
      loadTrigger().catch(() => undefined);
      loadExecutions(null).catch(() => undefined);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to run trigger');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toast removed per stale-while-revalidate rule
  }, [projectId, triggerId, loadTrigger, loadExecutions]);

  const handleTogglePause = useCallback(async () => {
    if (!trigger || !triggerId) return;
    const newStatus = trigger.status === 'paused' ? 'active' : 'paused';
    try {
      const data: UpdateTriggerRequest = { status: newStatus };
      await updateTrigger(projectId, triggerId, data);
      toast.success(newStatus === 'active' ? 'Trigger resumed' : 'Trigger paused');
      loadTrigger().catch(() => undefined);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update trigger');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toast removed per stale-while-revalidate rule
  }, [trigger, projectId, triggerId, loadTrigger]);

  const handleDelete = useCallback(async () => {
    if (!triggerId) return;
    try {
      await deleteTrigger(projectId, triggerId);
      toast.success('Trigger deleted');
      navigate(`/projects/${projectId}/triggers`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete trigger');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toast removed per stale-while-revalidate rule
  }, [projectId, triggerId, navigate]);

  // Compute success rate from loaded executions
  const successRate = useMemo(() => {
    const completed = executions.filter((e) => e.status === 'completed' || e.status === 'failed');
    if (completed.length === 0) return null;
    const successes = completed.filter((e) => e.status === 'completed').length;
    return Math.round((successes / completed.length) * 100);
  }, [executions]);

  // Last run info
  const lastRun = useMemo(() => {
    const finished = executions.find((e) => e.status === 'completed' || e.status === 'failed');
    return finished ?? null;
  }, [executions]);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error || !trigger) {
    return (
      <div className="text-center py-16">
        <p className="text-danger mb-4">{error ?? 'Trigger not found'}</p>
        <button
          onClick={() => navigate(`/projects/${projectId}/triggers`)}
          className={`px-4 py-2 text-sm font-medium text-accent bg-transparent border border-border-default rounded-md cursor-pointer ${FOCUS_RING}`}
        >
          Back to triggers
        </button>
      </div>
    );
  }

  const statusCfg = STATUS_CONFIG[trigger.status] ?? {
    color: 'var(--sam-color-fg-muted)',
    label: 'Disabled',
  };
  const handleLoadMore = () => {
    loadExecutions(nextExecutionCursor).catch(() => undefined);
  };
  const handleExecutionsMutated = () => {
    loadExecutions(null).catch(() => undefined);
  };
  const handleFormSaved = () => {
    loadTrigger().catch(() => undefined);
    loadExecutions(null).catch(() => undefined);
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      {/* Back link */}
      <button
        onClick={() => navigate(`/projects/${projectId}/triggers`)}
        className={`inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg-primary mb-4 bg-transparent border-none cursor-pointer p-0 ${FOCUS_RING}`}
      >
        <ArrowLeft size={14} aria-hidden="true" />
        Back to triggers
      </button>

      {/* Header */}
      <div className="flex flex-col gap-4 mb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-2">
            <span
              className="mt-2 inline-block w-3 h-3 rounded-full shrink-0"
              style={{ backgroundColor: statusCfg.color }}
              aria-label={`Status: ${statusCfg.label}`}
            />
            <h1 className="sam-type-page-title m-0 min-w-0 max-w-full whitespace-normal [overflow-wrap:anywhere]">
              {trigger.name}
            </h1>
          </div>
          {trigger.description && (
            <p className="sam-type-secondary text-fg-muted mt-1 mb-0 [overflow-wrap:anywhere]">
              {trigger.description}
            </p>
          )}
          <p className="text-sm text-fg-muted mt-2 mb-0 flex flex-wrap items-center gap-1.5">
            <Clock size={14} aria-hidden="true" />
            {trigger.sourceType === 'webhook'
              ? trigger.webhookConfig?.sourceLabel || 'Generic webhook'
              : trigger.sourceType === 'github'
                ? `GitHub ${trigger.githubConfig?.eventType?.replace(/_/g, ' ') ?? 'event'}`
                : (trigger.cronHumanReadable ?? trigger.cronExpression)}
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleRunNow}
            disabled={trigger.status === 'disabled'}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md bg-transparent border border-border-default text-fg-primary hover:bg-surface-hover cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS_RING}`}
            aria-label="Run now"
          >
            <Play size={14} aria-hidden="true" />
            <span className="hidden sm:inline">Run Now</span>
          </button>
          <button
            onClick={handleTogglePause}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md bg-transparent border border-border-default text-fg-primary hover:bg-surface-hover cursor-pointer ${FOCUS_RING}`}
            aria-label={trigger.status === 'paused' ? 'Resume' : 'Pause'}
          >
            <Pause size={14} aria-hidden="true" />
            <span className="hidden sm:inline">
              {trigger.status === 'paused' ? 'Resume' : 'Pause'}
            </span>
          </button>
          <button
            onClick={() => setFormOpen(true)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md bg-transparent border border-border-default text-fg-primary hover:bg-surface-hover cursor-pointer ${FOCUS_RING}`}
            aria-label="Edit trigger"
          >
            <Pencil size={14} aria-hidden="true" />
            <span className="hidden sm:inline">Edit</span>
          </button>
          <button
            onClick={() => setConfirmDelete(true)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md bg-transparent border border-danger/30 text-danger hover:bg-danger/10 cursor-pointer ${FOCUS_RING}`}
            aria-label="Delete trigger"
          >
            <Trash2 size={14} aria-hidden="true" />
            <span className="hidden sm:inline">Delete</span>
          </button>
        </div>
      </div>

      {trigger.credentialAttribution?.multiplayerActive &&
        trigger.credentialAttribution.hasPersonalWarning && (
          <div className="mb-6">
            <TriggerCredentialWarning trigger={trigger} />
          </div>
        )}

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-8">
        {/* Next run */}
        <div className="border border-border-default rounded-lg p-4">
          <p className="text-xs font-medium text-fg-muted uppercase tracking-wider m-0 mb-1">
            {trigger.sourceType === 'cron' ? 'Next Run' : 'Source'}
          </p>
          <p className="text-sm text-fg-primary m-0 flex items-center gap-1.5">
            <Calendar size={14} aria-hidden="true" />
            {trigger.sourceType === 'cron'
              ? trigger.nextFireAt
                ? formatDateFull(trigger.nextFireAt)
                : 'Not scheduled'
              : trigger.sourceType === 'webhook'
                ? 'Incoming webhook'
                : 'GitHub event'}
          </p>
        </div>

        {/* Last run */}
        <div className="border border-border-default rounded-lg p-4">
          <p className="text-xs font-medium text-fg-muted uppercase tracking-wider m-0 mb-1">
            Last Run
          </p>
          {lastRun ? (
            <div className="flex items-center gap-1.5 text-sm">
              {lastRun.status === 'completed' ? (
                <CheckCircle size={14} className="text-success" aria-hidden="true" />
              ) : (
                <XCircle size={14} className="text-danger" aria-hidden="true" />
              )}
              <span className="text-fg-primary">{formatDateFull(lastRun.scheduledAt)}</span>
              <span className="text-fg-muted">
                ({formatDuration(lastRun.startedAt, lastRun.completedAt)})
              </span>
            </div>
          ) : (
            <p className="text-sm text-fg-muted m-0">Never run</p>
          )}
        </div>

        {/* Success rate */}
        <div className="border border-border-default rounded-lg p-4">
          <p className="text-xs font-medium text-fg-muted uppercase tracking-wider m-0 mb-1">
            Success Rate
          </p>
          {successRate !== null ? (
            <div>
              <p className="text-sm text-fg-primary m-0 mb-1">{successRate}%</p>
              <div className="h-1.5 bg-surface-hover rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${successRate}%`,
                    backgroundColor:
                      successRate >= 80
                        ? 'var(--sam-color-success)'
                        : successRate >= 50
                          ? 'var(--sam-color-warning)'
                          : 'var(--sam-color-danger)',
                  }}
                />
              </div>
            </div>
          ) : (
            <p className="text-sm text-fg-muted m-0">No data</p>
          )}
        </div>
      </div>

      {/* Execution history */}
      <div>
        <h2 className="sam-type-section-heading mb-4">Execution History</h2>
        {execError && <div className="text-xs text-danger mb-2">{execError}</div>}
        <ExecutionHistory
          executions={executions}
          loading={execLoading}
          hasMore={hasMore}
          onLoadMore={handleLoadMore}
          projectId={projectId}
          triggerId={triggerId!}
          onMutated={handleExecutionsMutated}
        />
      </div>

      <TriggerConfiguration trigger={trigger} />

      {trigger.sourceType === 'webhook' && (
        <WebhookTriggerPanel
          projectId={projectId}
          trigger={trigger}
          onRotated={() => void loadTrigger()}
        />
      )}

      {/* Edit form */}
      <TriggerForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        editTrigger={trigger}
        onSaved={handleFormSaved}
      />

      {/* Delete confirmation */}
      {confirmDelete && (
        <>
          <div
            className="fixed inset-0 glass-backdrop-dim z-[var(--sam-z-dialog-backdrop)]"
            onClick={() => setConfirmDelete(false)}
            aria-hidden="true"
          />
          <div
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 glass-modal glass-panel-container glass-composited rounded-lg shadow-lg p-6 z-[var(--sam-z-dialog)] w-full max-w-sm"
            role="alertdialog"
            aria-modal="true"
            aria-label="Confirm delete"
          >
            <h3 className="sam-type-card-title m-0 mb-2">Delete trigger?</h3>
            <p className="text-sm text-fg-muted mb-4">
              This will permanently delete &ldquo;{trigger.name}&rdquo; and all its execution
              history. This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmDelete(false)}
                className={`px-4 py-2 text-sm font-medium text-fg-muted hover:text-fg-primary bg-transparent border border-border-default rounded-md cursor-pointer ${FOCUS_RING}`}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setConfirmDelete(false);
                  void handleDelete();
                }}
                className={`px-4 py-2 text-sm font-medium text-fg-on-accent bg-danger hover:bg-danger/90 border-none rounded-md cursor-pointer ${FOCUS_RING}`}
              >
                Delete
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
